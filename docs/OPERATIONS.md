# Pet Wool Platform 运维手册

本文档用于交付、上线前检查和日常运维。所有命令默认在 `/root/pet-wool-platform` 执行。

## 服务和访问

本文件描述**测试机 / 本机**拓扑（nginx 8888 + Vite 开发服务）。生产是 `deploy.sh` 发布的 Node 单体服务（systemd 单元 `pet-wool-platform`，nginx 443 反代到 `127.0.0.1:8888`），见 `DEPLOY.md`。

- 官网：`http://127.0.0.1:8888/`
- 管理端：`http://127.0.0.1:8888/admin`
- 客户文档：`http://127.0.0.1:8888/doc/`
- 前端服务：`pet-wool-frontend-dev`，Vite 监听 `127.0.0.1:5173`
- API 服务：`pet-wool-api`，Node API 监听 `127.0.0.1:8082`
- 对外入口：nginx 监听 `8888`，代理 `/api`、`/uploads`、`/health`

```bash
systemctl is-active pet-wool-frontend-dev pet-wool-api nginx
ss -ltnp
```

## 发布和回归

前端修改后发布到 8888：

```bash
cd /root/pet-wool-platform/frontend
npm run build
systemctl restart pet-wool-frontend-dev
```

API 或数据结构修改后：

```bash
cd /root/pet-wool-platform
systemctl restart pet-wool-api
```

发布后检查：

```bash
cd /root/pet-wool-platform
npm run verify:core
npm run smoke
node test-results/e2e-check.mjs
node scripts/cleanup-orphan-uploads.mjs --missing-refs
```

`npm run verify:core` 是 3 秒级快速闸门（API 合约 + 页面渲染），任何改动后先跑它；`scripts/smoke-check.sh` 进一步检查 nginx 页面、API 健康、基础接口、安全响应头，以及 `robots.txt` / `sitemap.xml` 是否有效。完整 E2E 覆盖官网下单、账号、支付、管理端商品/分类/订单/用户/站点配置、备份恢复和移动端布局。

## 健康检查

```bash
curl -s http://127.0.0.1:8082/health
curl -s http://127.0.0.1:8888/api/health
```

健康接口只返回服务状态和分类、商品、订单、用户、支付数量，不应暴露 `store.json`、`uploads` 或服务器绝对路径。

## 项目日志

API 会把结构化日志同时打印到进程 stderr，并默认写入：

```text
/root/pet-wool-platform/logs/pet-wool-structured.log
```

实时查看：

```bash
tail -f /root/pet-wool-platform/logs/pet-wool-structured.log
```

每条日志包含 `timestamp`、`level`、`event`、`request_id`（请求日志）和必要的订单/支付状态字段，方便按请求追踪问题。日志不会记录密码、Token、Cookie、PayPal Secret、Webhook ID 或客户照片内容；客户邮箱只保留哈希值。

默认会记录服务启动、数据加载、HTTP 请求、上传、登录、订单创建和幂等重放、支付创建/捕获/Webhook、邮件通知、后台操作和异常。PayPal 还会记录 OAuth 开始/成功、订单创建开始/成功、请求方法、接口路径、模式、API 地址、耗时、PayPal 请求 ID，以及错误响应中的 HTTP 状态、错误名称、错误代码、错误描述、debug ID 和 issues；不会记录凭据。每天首次启动及 UTC 日期切换后会写入一条 `business.daily_order_summary`，包含当日订单数、未支付订单数、已支付订单数、捕获支付数和按币种收入。

管理端 PayPal 页面有“支付订单测试”按钮。它只向 PayPal 创建一笔 0.01 USD（或零小数币种的最小金额）未捕获测试订单，不写入本站订单和支付表；失败时页面和日志都会显示 PayPal 的详细返回原因。

可在 `.env` 中调整：

```text
LOG_LEVEL=info
LOG_TO_FILE=true
LOG_DIR=/var/log/pet-wool-platform
LOG_FILE=/var/log/pet-wool-platform/pet-wool-structured.log
```

正式环境建议使用 `logrotate` 或日志平台按天轮转 `pet-wool-structured.log`，避免日志文件无限增长。

## 备份

大批量修改商品、订单、站点配置、支付配置或上线前，先创建数据备份：

```bash
cd /root/pet-wool-platform
node scripts/backup-data.mjs
```

备份目录为 `api-node/backups/<时间戳>/`，包含：

- `store.json`
- `uploads/`
- `README.txt`

脚本会校验 store 数据结构、唯一 ID、分类/商品/订单/支付引用和上传文件引用。默认保留最近 10 份备份，可通过 `BACKUP_KEEP` 调整。

管理端“下载脱敏备份”默认不包含 PayPal Secret 和 Webhook ID。只有明确点击“下载完整密钥备份”，或访问 `/api/admin/backup?secrets=1` 且同时带上 `x-confirm-secret-backup: true` 确认头时，才会包含完整支付密钥。完整密钥备份必须按敏感文件处理，不要发到公开渠道。命令行 `node scripts/backup-data.mjs` 会备份完整 `store.json`，如果已经配置 PayPal Secret 或 Webhook ID，也会一起写入备份目录；需要发给第三方排查时必须使用管理端脱敏备份。

## 恢复

恢复前先 dry-run 校验：

```bash
cd /root/pet-wool-platform
node scripts/restore-data.mjs --dry-run api-node/backups/<时间戳>
```

确认校验通过后再执行：

```bash
node scripts/restore-data.mjs --apply api-node/backups/<时间戳>
systemctl restart pet-wool-api
```

恢复脚本默认 dry-run，即使没有写 `--dry-run` 也不会覆盖数据。只有显式 `--apply` 才会替换 `api-node/data/store.json` 和 `api-node/uploads/`。真正恢复前脚本会自动创建一份恢复前备份。

恢复校验会拒绝以下情况：

- 缺少 `categories`、`products`、`orders`、`payments`、`site` 或 `site.paypal`
- 分类、商品、订单、支付、用户 ID 缺失或重复
- 商品引用不存在的分类
- 订单引用不存在的商品
- 支付引用不存在的订单
- 商品、订单、博客引用不存在或非法命名的上传文件

管理端“恢复站点配置”只恢复站点配置，不替换商品、订单和用户。使用脱敏备份恢复时，会保留当前 PayPal Secret 和 Webhook ID。

## 上传文件清理

先预览孤儿上传文件和缺失引用：

```bash
cd /root/pet-wool-platform
node scripts/cleanup-orphan-uploads.mjs --missing-refs
```

确认后删除未被订单、商品、博客引用的上传文件：

```bash
node scripts/cleanup-orphan-uploads.mjs --apply
```

如需同时清理 store 中已经丢失的上传引用，先备份，再执行：

```bash
node scripts/backup-data.mjs
node scripts/cleanup-orphan-uploads.mjs --apply --missing-refs
systemctl restart pet-wool-api
```

不要直接手动删除 `api-node/uploads/` 里的文件。先用脚本报告确认引用关系。

## 测试数据清理

E2E 测试会创建 `commercial-*`、`unpaid-*`、`blocked-*`、`payable-*`、`balance-due-*`、`stale-created-*`、`commercial-check-*`、`hidden-category-*` 等测试数据。清理脚本会识别并清理测试订单、用户、商品、隐藏分类、关联支付，以及测试 FAQ、评价和博客内容。预览清理：

```bash
node scripts/cleanup-e2e-data.mjs
```

确认后应用：

```bash
node scripts/cleanup-e2e-data.mjs --apply --confirm-e2e-cleanup
systemctl restart pet-wool-api
```

## 管理员角色和审计

正式环境建议用 `ADMIN_ACCOUNTS_JSON` 配置多管理员账号，密码值为 SHA-256 哈希，角色支持 `owner`、`admin`、`viewer`：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('替换成强密码').digest('hex'))"
```

`owner` 和 `admin` 可以写入后台数据，`viewer` 只能读取。所有后台写操作会写入 `store.audit_logs`，管理端“审计日志”展示最近操作；后端保留最近 500 条，备份和 Postgres 导出都会包含审计数据。

## Google OAuth 上线

开发环境可保留 demo 登录；正式环境必须配置 Google OAuth：

```text
GOOGLE_CLIENT_ID=<Google OAuth Client ID>
GOOGLE_DEMO_LOGIN=false
```

配置后前台会加载 Google Identity Services，API 会校验 Google ID Token 的签名、audience、issuer、过期时间和邮箱。多个站点或 Client ID 用 `GOOGLE_CLIENT_IDS` 逗号分隔。

## Postgres 导出

当前 API 仍以 `api-node/data/store.json` 为主数据源。迁库前可先生成 Postgres staging SQL：

```bash
cd /root/pet-wool-platform
npm run export:postgres
```

输出文件为 `workspace/generated/store-postgres-seed.sql`，包含完整 JSON 快照和分类、商品、订单、支付、用户、审计日志、站点设置等 staging 表。该脚本是迁移准备工具，不会自动切换线上 API 数据源；生产迁库前仍需设计正式 schema、索引、备份和回滚步骤。

## 多币种价格与 PayPal 收款

商店价格以韩元（KRW）为基准币种存储；前台按站点语言显示对应币种：

- 韩文(ko) → KRW（基准，原值显示）
- 英文(en) → USD
- 中文(zh) → CNY

USD/CNY 均由 KRW 基准按 `api-node/currency.mjs` 中的固定汇率换算并四舍五入到最小货币单位（分）；换算使用整数运算，规则与 `frontend/src/currency.ts` 保持一致，`node --experimental-strip-types scripts/verify-multicurrency.mjs` 用于校验两侧表一致。调整汇率时必须同步修改两个文件、递增 `CURRENCY_RATE_VERSION`，重跑校验脚本后一起发布；否则新旧支付单会使用不同汇率口径。

PayPal 无法以 KRW 收款，因此实际扣款始终使用站点配置的 PayPal 币种（当前为 USD）：支付单创建时服务端按同一固定汇率把订单基准金额换算成收款金额（支付记录同时保存 `base_amount_cents` 基准金额与 `amount_cents` 收款金额），捕获时按收款金额对账、按基准金额累计已付款。同币种、同汇率版本且历史已付款全部能由支付快照解释时，尾款按“整单换算 − 已收定金之和”分配取整差额；手工收款、旧数据或跨汇率版本的订单按本次应付额换算，实际支付快照为准。前台在下单摘要和账户支付面板会同时展示换算后的本地价格与 PayPal 实际收款金额。

历史订单保留创建时的币种（USD/CNY），支付时同样按固定汇率换算成 PayPal 币种收款，无需迁移。如需把存量商品价格统一换算为 KRW 基准，可执行幂等脚本 `node scripts/migrate-currency-krw.mjs`（先 `--dry-run` 预览；脚本会自动备份 store.json）。

当前固定业务汇率为 1 USD = 1,370 KRW、1 CNY = 203.5 KRW，不是实时市场报价，上线前应确认价格策略。`*_cents` 字段实际表示币种最小单位：KRW 是韩元整数，USD/CNY 是分，不能统一除以 100。

PayPal 官方 REST 币种列表不支持 KRW；CNY 有境内账号限制，本项目仅开放 USD 收款，不把中文展示等同于 CNY 扣款。依据：https://developer.paypal.com/api/rest/reference/currency-codes/ 。买方使用 PayPal 或银行卡换汇时，实际本币扣账由支付机构汇率及费用决定，不保证等于网站的参考换算金额。

服务端加载数据时会自动把支持的非 KRW 商品转换为 KRW（历史订单金额不转换），上线前必须备份实际使用的 JSON 或 PostgreSQL 数据，核对转换后的商品价格。手工迁移脚本仅针对 JSON，需停服后执行；不要对 PostgreSQL 部署的遗留 JSON 副本执行迁移。本次开发没有迁移或重启生产服务。

回归验证入口：`npm run test:currency`（换算表一致性、隔离支付流程、重复捕获与重复 Webhook）。Webhook 测试仅在临时子进程模拟 PayPal 验签接口的成功/失败响应，不绕过生产验签，也不证明真实 PayPal 签名或真实扣款有效。测试使用临时目录，不接触真实数据或网络收款；真实 sandbox/live 支付验收须另行完成。

## PayPal Live 回归

正式支付回归必须使用隐藏的小额商品或临时内部订单，不要把测试商品发布到前台：

1. 在 PayPal 后台配置 live app 的 Client ID、Secret，并创建 Webhook。
2. Webhook URL 填 `https://<正式域名>/api/paypal/webhook`，站点配置里填写 PayPal 生成的 Webhook ID。
3. 管理端站点配置设置 `mode=live`、币种和 live 凭据；确认小额测试商品保持 `hidden`。
4. 创建低金额内部订单，完成 PayPal 支付，确认订单支付状态、支付记录和审计/订单事件都更新。
5. 支付完成后运行 `bash scripts/smoke-check.sh`，并确认前台商品列表不出现 PayPal 测试商品。

## 上线前必须处理

- 替换默认管理端账号和密码。
- 配置正式 Google OAuth Client ID，并关闭 demo 登录。
- 配置正式 PayPal Client ID、Secret、Webhook ID 和币种，完成 live 小额回归。
- 确认 KakaoTalk、WhatsApp、社媒链接为真实可访问地址，账号名和链接配置正确。
- 替换 `/assets` 占位图片为真实自有作品图或授权图片。
- 如需要数据库承载，先执行 `npm run export:postgres` 并完成正式迁库方案。
- 执行 `node scripts/backup-data.mjs` 留存上线前备份。
- 执行 `bash scripts/smoke-check.sh` 和 `node test-results/e2e-check.mjs`，确认 0 失败。

上线前先执行：

```bash
npm run production:check
```

该检查不会输出密钥，只检查默认管理员、Google Demo、PayPal Live、HTTPS、SMTP
和基础站点配置。任何 `FAIL` 都应在发布前处理。

## 订单邮件通知

Node API 支持可选 SMTP 通知。配置 `SMTP_HOST`、`SMTP_FROM`，以及 SMTP 服务要求的
`SMTP_USER` / `SMTP_PASS` 后，会在以下事件通知客户邮箱和 `NOTIFY_ADMIN_EMAIL`：

配置文件使用项目根目录的 `.env`。API 启动时会自动读取该文件；systemd 环境中也可以通过
`EnvironmentFile` 注入变量，已经注入的变量优先。QQ 邮箱示例：

```text
SMTP_HOST=smtp.qq.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=你的QQ邮箱@qq.com
SMTP_PASS=QQ邮箱授权码
SMTP_FROM=WoolBuddy <你的QQ邮箱@qq.com>
NOTIFY_ADMIN_EMAIL=接收通知的邮箱@qq.com
SMTP_TIMEOUT_MS=10000
```

`SMTP_PASS` 必须使用 QQ 邮箱生成的授权码，不是 QQ 登录密码。修改 `.env` 后必须重启
`pet-wool-api`，启动日志中的 `smtp_enabled` 应为 `true`。

- 新订单创建
- PayPal 捕获成功或 Webhook 确认付款
- 后台手工修改付款状态
- 后台修改订单状态

通知发送是异步的，SMTP 暂时不可用不会回滚订单或支付；API 日志会记录失败原因。
