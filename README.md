# 种植日记后端

Node.js 24 + TypeScript + Fastify 5 + PostgreSQL。代码独立于小程序项目，无需现在购买服务器。

## 本地启动

```powershell
cd D:\project\wxapp\sproutDiaryServer
npm ci
Copy-Item .env.example .env
npm run dev
```

访问 `http://127.0.0.1:3000/health`，返回 `{"ok":true}`。默认 `DATA_DRIVER=memory` 是基于 pg-mem 的开发临时库，**重启会丢失数据**；仅用来测试 API，不能保存正式记录。没有公开的模拟登录接口。自动测试通过注入微信服务替身验证登录与权限，不会访问微信账号。

真实登录：在 `.env` 填写微信公众平台的 `WX_APP_SECRET`，不需要发给开发者或写入前端。当前 AppID 为 `wxa2a5f23a2973420e`。登录不获取用户头像、昵称和手机号。服务端调用微信 code2Session，只保留 openid 关联账号，不保存 session_key。

```powershell
npm test
npm run check
npm run build
```

## PostgreSQL 与部署

安装 Docker 后，在 `.env` 填写 `DB_PASSWORD`（建议64位十六进制，避免 URL 转义问题）、`JWT_SECRET`（至少32位随机字符串）与 `WX_APP_SECRET`。生成随机值：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`。不要提交 `.env`。

```sh
docker compose up -d --build
docker compose logs --tail=100 api
```

Compose 强制使用 PostgreSQL，数据库不暴露端口，API 仅绑定服务器 127.0.0.1:3000。服务器 Nginx 使用 `deploy/nginx.conf.example` 反代 API，再配置合法 HTTPS 域名至微信公众平台 request、uploadFile、downloadFile 域名。上线前改为 HTTPS；不要关闭正式环境域名校验。大陆服务器域名备案按实际部署要求办理。

本机 PostgreSQL：设置 `DATA_DRIVER=postgres` 和 `DATABASE_URL`，启动时幂等创建表。生产 `NODE_ENV=production` 拒绝内存库和缺失密钥。Docker 使用 Node.js 24，非 root 用户运行。

## 接口

除 health、ready 和微信登录外，接口都需要 `Authorization: Bearer <token>`。JWT 7天过期，退出后服务端注销会话；过期后重新微信登录。

| 方法 | 路径 | 请求与行为 |
|---|---|---|
| POST | /v1/auth/wechat | `{code}`，返回 `{token,expiresIn,user:{id}}` |
| POST | /v1/auth/logout | 注销当前会话 |
| GET | /v1/me | 当前账号内部ID |
| GET | /v1/garden | `{state,revision}`，用于备份恢复 |
| PUT | /v1/garden | `{state,revision}`，比较版本后整体保存 |
| GET | /v1/plants、/v1/entries、/v1/tasks | 当前账号记录列表 |
| POST | 上述资源路径 | `{item,revision}`，新增，item含客户端唯一ID |
| PUT | 上述资源路径/:id | `{item,revision}`，完整替换，item.id必须等于路径ID |
| DELETE | 上述资源路径/:id | `{revision}`，删除；删除植物级联删除日记和任务 |
| POST | /v1/tasks/:id/complete、skip、postpone | `{revision}`；完成记入养护日记，周期任务生成下一次 |
| POST | /v1/media | multipart字段 `file`，返回 `{id,ref:"media:..."}` |
| GET | /v1/media/:id | 鉴权后返回 JPEG，不公开原图地址 |

所有写入接口返回新的 `{state,revision}`。409 代表版本冲突，禁止直接重试覆盖，需重新读取后选择同步方向。用户ID完全来自已验证的令牌，不接受客户端指定所有者。

State 与前端 `DiaryState` 一致，version为1、plants/entries/tasks数组。照片只接受示例 `plant:tomato/jasmine/mint/monstera` 或属于当前账号的 `media:UUID`；不能提交本地路径、data URL或外部网址。先上传照片，再将原路径映射到 media 引用后保存。

照片仅接受真正可解码的 JPEG/PNG/WebP，最大5MiB、2400万像素；自动旋转、压缩至最长1600像素JPEG并移除原始元数据。单账号最多2000张、压缩后合计200MiB。当前不自动删除服务器照片，避免备份与多设备并发误删；维护时需暂停写入、核对数据库引用后人工回收孤立文件。上传成功但备份失败的文件可能暂时保留。总磁盘空间仍需监控。

相同账号下的相同压缩图片以 SHA256 去重，不重复占用存储额度。客户端逐张保存上传映射，网络失败重试可接续；照片下载遇限流会暂停后从当前照片重试。普通请求按来源 IP 限制每分钟120次，登录每分钟10次；仅信任本机 Nginx 代理转发的来源信息。

## 备份与恢复

数据库与照片卷必须同时备份，不能仅备份代码或数据库。建议维护窗口暂停API写入后执行：

```sh
docker compose stop api
docker compose exec -T db pg_dump -U sprout -d sprout -Fc > sprout.dump
docker compose run --rm --no-deps --user root --entrypoint tar api -czf - -C /app/uploads . > sprout-photos.tar.gz
docker compose start api
```

恢复到空的新环境时保持 API 关闭：启动 db，用 `pg_restore -U sprout -d sprout --clean --if-exists` 恢复 dump；用临时容器把照片解压至 photos 卷并保证 node 用户可读，然后启动API。先在临时环境验证，不直接覆盖唯一生产数据。生产数据库、照片卷、`.env` 均需独立备份，密钥安全保管。

## 验证范围

测试覆盖真实 HTTP 路由、SQL 持久层逻辑（pg-mem）、账号隔离、退出失效、冲突保护、关联与日期校验、周期任务和图片转码。当前设备未安装 Docker/PostgreSQL，未声称验证容器构建或真实 PostgreSQL；部署前还需真实 PostgreSQL 联调。真实微信登录需配置 AppSecret，线上域名与真机上传下载需服务器后验证。
