import { Hono } from "hono";
import { cache } from "hono/cache";
import { basicAuth } from "hono/basic-auth";

type Bindings = {
  BUCKET: R2Bucket;
  USERNAME: string;
  PASSWORD: string;
};

const CACHE_DURATION = 60 * 60 * 24;
const FILENAME_LENGTH = 8;

function randomFileName() {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < FILENAME_LENGTH; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

const app = new Hono<{ Bindings: Bindings }>();

app.get(
  "*",
  cache({
    cacheName: "r2-image-worker",
  })
);

app.post("/_upload", async (c, next) => {
  const auth = basicAuth({
    username: c.env.USERNAME,
    password: c.env.PASSWORD,
  });
  await auth(c, next);
});

app.post("/_upload", async (c, next) => {
  const body = await c.req.parseBody();

  const maybeFile = body.file;
  if (!maybeFile || !(maybeFile instanceof File))
    return c.body("Missing file", 400);

  const getFileName = async () => {
    if (body.name) {
      return body.name;
    }
    let attempts = 0;
    while (attempts < 10) {
      const fileName = randomFileName();
      const object = await c.env.BUCKET.head(fileName);
      if (!object) return fileName;
      attempts++;
    }
  };

  const parts = maybeFile.name.split(".");
  const extension = parts[parts.length - 1];

  const fileName = await getFileName();
  const withExtension = `${fileName}.${extension}`;
  const file = await maybeFile.arrayBuffer();

  await c.env.BUCKET.put(withExtension, file, {
    httpMetadata: { contentType: maybeFile.type },
  });

  const baseUrl = new URL(c.req.url).origin;

  return c.body(`${baseUrl}/${withExtension}`);
});

app.get("/:key", async (c) => {
  const key = c.req.param("key");

  const object = await c.env.BUCKET.get(key);
  console.log(object);
  if (!object) return c.notFound();
  const data = await object.arrayBuffer();
  let contentType = object.httpMetadata?.contentType || "";

  if (contentType === "application/octet-stream" && key.endsWith(".mp4")) {
    contentType = "video/mp4";
  }

  return c.body(data, 200, {
    "Cache-Control": `public max-age=${CACHE_DURATION}`,
    "Content-Type": contentType,
  });
});

app.delete("/:key", async (c, next) => {
  const auth = basicAuth({
    username: c.env.USERNAME,
    password: c.env.PASSWORD,
  });
  await auth(c, next);
});

app.delete("/:key", async (c) => {
  const key = c.req.param("key");
  await c.env.BUCKET.delete(key);
  return c.body("OK");
});

export default app;
