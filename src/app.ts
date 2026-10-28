import Fastify from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { migrate, readGarden, writeGarden, type Database } from "./database.js";
import {
  gardenSchema,
  revisionSchema,
  emptyGarden,
  taskAction,
  type Garden,
} from "./garden.js";
declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; sid: string };
    user: { sub: string; sid: string };
  }
}
interface Options {
  pool: Database;
  uploads: string;
  jwtSecret: string;
  appId: string;
  exchange: (code: string) => Promise<string>;
  logger?: boolean;
}
export async function buildApp(o: Options) {
  if (o.jwtSecret.length < 32) throw Error("JWT_SECRET 至少32个字符");
  await migrate(o.pool);
  await mkdir(o.uploads, { recursive: true });
  const app = Fastify({
    logger: o.logger
      ? {
          redact: [
            "req.headers.authorization",
            "req.body.code",
            "token",
            "openid",
            "session_key",
          ],
        }
      : false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: ["127.0.0.1", "::1"],
  });
  await app.register(jwt, {
    secret: o.jwtSecret,
    sign: { expiresIn: "7d", iss: "sprout-diary", aud: "sprout-miniapp" },
    verify: { allowedIss: "sprout-diary", allowedAud: "sprout-miniapp" },
  });
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (err instanceof z.ZodError)
      return reply
        .code(400)
        .send({
          error: "INVALID_INPUT",
          message: err.issues[0]?.message || "输入无效",
        });
    const status = e.statusCode || 500;
    if (status >= 500)
      req.log.error({ err: { message: e.message } }, "服务请求失败");
    return reply
      .code(status)
      .send({
        error: status >= 500 ? "SERVER_ERROR" : "REQUEST_REJECTED",
        message: status >= 500 ? "服务暂不可用" : e.message,
      });
  });
  const fail = (status: number, message: string): never => {
    throw Object.assign(Error(message), { statusCode: status });
  };
  const auth = async (req: any) => {
    try {
      await req.jwtVerify();
    } catch {
      fail(401, "请先登录或重新登录");
    }
    const r = await o.pool.query(
      "SELECT id FROM sessions WHERE id=$1 AND user_id=$2",
      [req.user.sid, req.user.sub],
    );
    if (!r.rows.length) fail(401, "登录已失效");
  };
  async function validatePhotos(user: string, state: Garden) {
    const refs = new Set(
      [
        ...state.plants.map((p) => p.cover),
        ...state.entries.flatMap((e) => e.photos),
      ]
        .filter((p) => p.startsWith("media:"))
        .map((p) => p.slice(6)),
    );
    if (!refs.size) return;
    const owned = await o.pool.query("SELECT id FROM media WHERE user_id=$1", [
      user,
    ]);
    const ids = new Set(owned.rows.map((r) => r.id));
    if ([...refs].some((id) => !ids.has(id)))
      fail(400, "照片不存在或不属于当前账号");
  }
  async function save(user: string, state: unknown, revision: number) {
    const valid = gardenSchema.parse(state);
    await validatePhotos(user, valid);
    const next = await writeGarden(o.pool, user, valid, revision);
    if (next === undefined)
      fail(409, "云端记录已变化，请先读取最新数据再选择备份或恢复");
    return { state: valid, revision: next };
  }
  app.get("/health", async () => ({ ok: true }));
  app.get("/ready", async () => {
    await o.pool.query("SELECT 1");
    return { ok: true };
  });
  app.post(
    "/v1/auth/wechat",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { code } = z
        .object({ code: z.string().min(1).max(256) })
        .strict()
        .parse(req.body);
      let openid: string;
      try {
        openid = await o.exchange(code);
      } catch {
        return reply
          .code(401)
          .send({
            error: "WECHAT_LOGIN_FAILED",
            message: "微信登录失败，请稍后重新登录",
          });
      }
      const r = await o.pool.query(
        "INSERT INTO users(id,openid) VALUES($1,$2) ON CONFLICT(openid) DO UPDATE SET openid=EXCLUDED.openid RETURNING id",
        [randomUUID(), openid],
      );
      const user = r.rows[0]!.id,
        sid = randomUUID();
      await o.pool.query(
        "INSERT INTO gardens(user_id,state) VALUES($1,$2) ON CONFLICT(user_id) DO NOTHING",
        [user, JSON.stringify(emptyGarden())],
      );
      await o.pool.query("INSERT INTO sessions(id,user_id) VALUES($1,$2)", [
        sid,
        user,
      ]);
      reply.header("Cache-Control", "no-store");
      return {
        token: app.jwt.sign({ sub: user, sid }),
        expiresIn: 604800,
        user: { id: user },
      };
    },
  );
  app.get("/v1/me", { preHandler: auth }, async (req) => ({
    id: req.user.sub,
  }));
  app.post("/v1/auth/logout", { preHandler: auth }, async (req) => {
    await o.pool.query("DELETE FROM sessions WHERE id=$1 AND user_id=$2", [
      req.user.sid,
      req.user.sub,
    ]);
    return { ok: true };
  });
  app.get("/v1/garden", { preHandler: auth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return readGarden(o.pool, req.user.sub);
  });
  app.put("/v1/garden", { preHandler: auth }, async (req) => {
    const b = z
      .object({ revision: revisionSchema, state: gardenSchema })
      .strict()
      .parse(req.body);
    return save(req.user.sub, b.state, b.revision);
  });
  for (const collection of ["plants", "entries", "tasks"] as const) {
    app.get("/v1/" + collection, { preHandler: auth }, async (req) => {
      const g = await readGarden(o.pool, req.user.sub);
      return { items: g.state[collection], revision: g.revision };
    });
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      app.route({
        method,
        url: "/v1/" + collection + (method === "POST" ? "" : "/:id"),
        preHandler: auth,
        handler: async (req) => {
          const b = z
            .object({ revision: revisionSchema, item: z.unknown().optional() })
            .strict()
            .parse(req.body);
          const { state } = await readGarden(o.pool, req.user.sub);
          const id = (req.params as { id?: string }).id;
          const rows = state[collection] as Array<{ id: string }>;
          if (method === "POST") {
            const item = z
              .object({ id: z.string() })
              .passthrough()
              .parse(b.item);
            if (rows.some((r) => r.id === item.id)) fail(409, "记录ID已存在");
            rows.push(item);
          } else {
            const index = rows.findIndex((r) => r.id === id);
            if (index < 0) fail(404, "记录不存在");
            if (method === "PUT") {
              const item = z
                .object({ id: z.literal(id!) })
                .passthrough()
                .parse(b.item);
              rows[index] = item;
            } else {
              rows.splice(index, 1);
              if (collection === "plants") {
                state.entries = state.entries.filter((e) => e.plantId !== id);
                state.tasks = state.tasks.filter((t) => t.plantId !== id);
              }
            }
          }
          return save(req.user.sub, state, b.revision);
        },
      });
    }
  }
  for (const action of ["complete", "skip", "postpone"])
    app.post("/v1/tasks/:id/" + action, { preHandler: auth }, async (req) => {
      const { revision } = z
        .object({ revision: revisionSchema })
        .strict()
        .parse(req.body);
      const { state } = await readGarden(o.pool, req.user.sub);
      try {
        taskAction(state, (req.params as { id: string }).id, action);
      } catch {
        fail(400, "任务不存在或已经处理");
      }
      return save(req.user.sub, state, revision);
    });
  app.post(
    "/v1/media",
    {
      preHandler: auth,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      const file = await req.file();
      if (!file) fail(400, "请选择照片");
      const bytes = await file!.toBuffer();
      let image: Buffer;
      try {
        const decoder = sharp(bytes, {
          limitInputPixels: 24_000_000,
          animated: false,
        });
        const meta = await decoder.metadata();
        if (!["jpeg", "png", "webp"].includes(meta.format || ""))
          throw Error("不支持的图片格式");
        image = await decoder
          .rotate()
          .resize({
            width: 1600,
            height: 1600,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality: 82 })
          .toBuffer();
      } catch {
        fail(400, "照片无法读取，请上传有效图片");
      }
      const digest = createHash("sha256").update(image!).digest("hex");
      const existing = await o.pool.query(
        "SELECT id FROM media WHERE user_id=$1 AND digest=$2",
        [req.user.sub, digest],
      );
      if (existing.rows[0])
        return reply
          .code(201)
          .send({
            id: existing.rows[0].id,
            ref: "media:" + existing.rows[0].id,
          });
      const total = await o.pool.query(
        "SELECT size FROM media WHERE user_id=$1",
        [req.user.sub],
      );
      if (
        total.rows.length >= 2000 ||
        total.rows.reduce((n, r) => n + r.size, 0) + image!.length >
          200 * 1024 * 1024
      )
        fail(413, "账号照片额度已满，请联系服务维护人员");
      const id = randomUUID(),
        path = join(o.uploads, id + ".jpg");
      await writeFile(path, image!, { flag: "wx" });
      let stored: string;
      try {
        const result = await o.pool.query(
          "INSERT INTO media(id,user_id,size,digest) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,digest) DO UPDATE SET digest=EXCLUDED.digest RETURNING id",
          [id, req.user.sub, image!.length, digest],
        );
        stored = result.rows[0]!.id;
      } catch (err) {
        await unlink(path);
        throw err;
      }
      if (stored !== id) await unlink(path);
      return reply.code(201).send({ id: stored, ref: "media:" + stored });
    },
  );
  app.get("/v1/media/:id", { preHandler: auth }, async (req, reply) => {
    const id = z.uuid().parse((req.params as { id: string }).id);
    const r = await o.pool.query(
      "SELECT id FROM media WHERE id=$1 AND user_id=$2",
      [id, req.user.sub],
    );
    if (!r.rows.length) fail(404, "照片不存在");
    reply
      .header("Cache-Control", "private, no-store")
      .header("X-Content-Type-Options", "nosniff");
    return reply
      .type("image/jpeg")
      .send(await readFile(join(o.uploads, id + ".jpg")));
  });
  await app.ready();
  return app;
}
