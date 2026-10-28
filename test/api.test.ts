import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDb } from "pg-mem";
import sharp from "sharp";
import { buildApp } from "../src/app.js";

const garden = {
  version: 1,
  plants: [
    {
      id: "p1",
      name: "薄荷",
      date: "2026-01-01",
      species: "",
      location: "",
      cover: "plant:mint",
    },
  ],
  entries: [],
  tasks: [],
};
async function fixture(t: any) {
  const pool = new (newDb().adapters.createPg().Pool)();
  const uploads = await mkdtemp(join(tmpdir(), "sprout-api-"));
  const app = await buildApp({
    pool,
    uploads,
    jwtSecret: "test-only-secret-with-at-least-32-characters",
    appId: "wxa2a5f23a2973420e",
    exchange: async (code) => {
      if (code === "invalid") throw Error("微信拒绝凭证");
      return "openid-" + code;
    },
    logger: false,
  });
  t.after(async () => {
    await app.close();
    await pool.end();
    await rm(uploads, { recursive: true, force: true });
  });
  const login = async (code: string) => {
    const r = await app.inject({
      method: "POST",
      url: "/v1/auth/wechat",
      payload: { code },
    });
    assert.equal(r.statusCode, 200);
    return { authorization: "Bearer " + r.json().token };
  };
  return { app, login, pool };
}
test("登录凭证必须经微信校验，重复身份稳定，响应不泄漏微信凭据", async (t) => {
  const { app, login } = await fixture(t);
  const a = await login("alice"),
    b = await login("alice");
  const me = (h: any) => app.inject({ url: "/v1/me", headers: h });
  assert.equal((await me(a)).json().id, (await me(b)).json().id);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/auth/wechat",
        payload: { code: "invalid" },
      })
    ).statusCode,
    401,
  );
  assert.equal((await app.inject({ url: "/v1/garden" })).statusCode, 401);
  assert.equal(JSON.stringify((await me(a)).json()).includes("openid"), false);
});
test("花园隔离、revision 冲突及无效关联均不会覆盖记录", async (t) => {
  const { app, login } = await fixture(t);
  const a = await login("a"),
    b = await login("b");
  const save = (h: any, state: any, revision: number) =>
    app.inject({
      method: "PUT",
      url: "/v1/garden",
      headers: h,
      payload: { state, revision },
    });
  assert.equal((await save(a, garden, 0)).json().revision, 1);
  assert.equal(
    (await app.inject({ url: "/v1/garden", headers: b })).json().state.plants
      .length,
    0,
  );
  assert.equal((await save(a, { ...garden, plants: [] }, 0)).statusCode, 409);
  assert.equal(
    (
      await save(
        a,
        {
          ...garden,
          entries: [
            {
              id: "e",
              plantId: "other",
              date: "2026-01-02",
              title: "",
              text: "记录",
              stage: "长叶",
              kind: "diary",
              photos: [],
            },
          ],
        },
        1,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: "/v1/garden", headers: a })).json().state.plants
      .length,
    1,
  );
});
test("CRUD 关联校验与周期任务完成原子生成记录及下一次任务", async (t) => {
  const { app, login } = await fixture(t),
    h = await login("a");
  await app.inject({
    method: "PUT",
    url: "/v1/garden",
    headers: h,
    payload: { state: garden, revision: 0 },
  });
  const task = await app.inject({
    method: "POST",
    url: "/v1/tasks",
    headers: h,
    payload: {
      revision: 1,
      item: {
        id: "t",
        plantId: "p1",
        type: "浇水",
        due: "2026-01-02",
        repeat: 3,
        status: "pending",
      },
    },
  });
  assert.equal(task.statusCode, 200);
  const done = await app.inject({
    method: "POST",
    url: "/v1/tasks/t/complete",
    headers: h,
    payload: { revision: 2 },
  });
  assert.equal(done.statusCode, 200);
  assert.equal(done.json().state.tasks.length, 2);
  assert.equal(done.json().state.entries[0].kind, "care");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/tasks/t/complete",
        headers: h,
        payload: { revision: 3 },
      })
    ).statusCode,
    400,
  );
});
function multipart(bytes: Buffer) {
  return Buffer.concat([
    Buffer.from(
      '--testboundary\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n',
    ),
    bytes,
    Buffer.from("\r\n--testboundary--\r\n"),
  ]);
}
test("照片解码转码、鉴权隔离，拒绝伪图片和外部照片引用", async (t) => {
  const { app, login } = await fixture(t),
    a = await login("a"),
    b = await login("b");
  const upload = (bytes: Buffer) =>
    app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...a,
        "content-type": "multipart/form-data; boundary=testboundary",
      },
      payload: multipart(bytes),
    });
  assert.equal((await upload(Buffer.from("not an image"))).statusCode, 400);
  assert.equal(
    (
      await upload(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ),
      )
    ).statusCode,
    400,
  );
  const original = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#426b48" },
  })
    .png()
    .toBuffer();
  const photo = await upload(original);
  assert.equal(photo.statusCode, 201);
  const id = photo.json().id;
  assert.equal(
    (await app.inject({ url: "/v1/media/" + id, headers: b })).statusCode,
    404,
  );
  const read = await app.inject({ url: "/v1/media/" + id, headers: a });
  assert.equal(read.headers["content-type"], "image/jpeg");
  assert.equal((await sharp(read.rawPayload).metadata()).format, "jpeg");
  const state = {
    ...garden,
    plants: [{ ...garden.plants[0], cover: "media:" + id }],
  };
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/v1/garden",
        headers: b,
        payload: { state, revision: 0 },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/v1/garden",
        headers: a,
        payload: { state, revision: 0 },
      })
    ).statusCode,
    200,
  );
});
test("退出后令牌不可继续访问，非法日期不能入库", async (t) => {
  const { app, login } = await fixture(t),
    h = await login("a");
  const state = {
    ...garden,
    plants: [{ ...garden.plants[0], date: "2026-02-30" }],
  };
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/v1/garden",
        headers: h,
        payload: { revision: 0, state },
      })
    ).statusCode,
    400,
  );
  await app.inject({ method: "POST", url: "/v1/auth/logout", headers: h });
  assert.equal(
    (await app.inject({ url: "/v1/garden", headers: h })).statusCode,
    401,
  );
});
test("超过20张照片可以连续上传，相同内容重试不会占用新额度", async (t) => {
  const { app, login, pool } = await fixture(t),
    h = await login("photos");
  const send = (bytes: Buffer) =>
    app.inject({
      method: "POST",
      url: "/v1/media",
      headers: {
        ...h,
        "content-type": "multipart/form-data; boundary=testboundary",
      },
      payload: multipart(bytes),
    });
  const first = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#000000" },
  })
    .png()
    .toBuffer();
  const a = await send(first),
    b = await send(first);
  assert.equal(a.json().id, b.json().id);
  for (let i = 1; i <= 21; i++) {
    const bytes = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: i * 10, g: 70, b: 40 },
      },
    })
      .png()
      .toBuffer();
    assert.equal((await send(bytes)).statusCode, 201);
  }
  assert.equal((await pool.query("SELECT id FROM media")).rows.length, 22);
});
