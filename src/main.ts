import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import pg from "pg";
import { buildApp } from "./app.js";
import { wechatExchange } from "./wechat.js";
const production = process.env.NODE_ENV === "production";
const driver = process.env.DATA_DRIVER || "postgres";
if (production && driver !== "postgres")
  throw Error("生产环境必须使用 PostgreSQL");
if (
  production &&
  (!process.env.JWT_SECRET ||
    process.env.JWT_SECRET.length < 32 ||
    !process.env.WX_APP_SECRET)
)
  throw Error("生产环境缺少 JWT_SECRET 或 WX_APP_SECRET");
let pool: pg.Pool;
if (driver === "memory") {
  const { newDb } = await import("pg-mem");
  pool = new (newDb().adapters.createPg().Pool)();
  console.warn(
    "本地临时内存数据库：重启即清空；不能用于生产或保存真实照片记录。",
  );
} else {
  if (!process.env.DATABASE_URL)
    throw Error("请配置 DATABASE_URL，或本地使用 DATA_DRIVER=memory");
  pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 5000,
  });
}
const app = await buildApp({
  pool,
  uploads: resolve(process.env.UPLOAD_DIR || "uploads"),
  jwtSecret: process.env.JWT_SECRET || randomBytes(48).toString("hex"),
  appId: process.env.WX_APP_ID || "wxa2a5f23a2973420e",
  exchange: wechatExchange(
    process.env.WX_APP_ID || "wxa2a5f23a2973420e",
    process.env.WX_APP_SECRET || "",
  ),
  logger: true,
});
if (!process.env.WX_APP_SECRET)
  app.log.warn("WX_APP_SECRET 未配置：微信登录暂不可用；没有测试账号入口。");
await app.listen({
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || "127.0.0.1",
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
