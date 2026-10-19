# WoolBuddy 宠物羊毛毡定制平台

宠物羊毛毡定制电商站。前台官网、`/admin` 管理端、Node.js 原生 HTTP API、宠物照片上传、订单与 PayPal 支付、博客与政策页、AI 机器人问答、Playwright 自动化回归。仓库项目名 `pet-wool-platform`。

## 访问地址

- 生产：`https://woolbuddy.shop`（Node 22 服务 systemd 单元 `pet-wool-platform`，监听 `127.0.0.1:8888`，nginx 443 反代；由 `deploy.sh` 发布）
- 测试机 `36.138.248.23`：nginx 仅监听 `127.0.0.1:8888`（2026-10 起收回回环，公网 IP:8888 已不可达），反代 Vite 开发服务 + `pet-wool-api:8082`
- 本机开发：`http://127.0.0.1:8888`

## 目录

```text
api-node/        Node API（server.mjs）+ data/store.json（JSON 后端/本地影子）+ uploads/
frontend/        Vue 3 + Vite + TypeScript，前台与 /admin 同工程
  src/api.ts     所有浏览器端 API 调用、token、错误归一化、30s 超时（视图不得绕过）
  src/currency.ts 与 api-node/currency.mjs 的汇率表必须一致
backend/         早期 Rust 草稿，线上未使用
deploy/          nginx vhost、安装脚本、logrotate 配置、systemd 单元模板
scripts/         校验、备份恢复、清理、发布打包脚本
site-doc/        客户文档与原型（前端 /doc/ 路由渲染，已设 noindex）
test-results/    Playwright E2E 脚本、报告、截图
docs/            运维与业务文档（OPERATIONS.md 为运维唯一事实来源）
.github/         CI（Node 22 上跑同一套门禁）
```

## 常用命令

```bash
npm install && npm --prefix frontend install   # 安装依赖
npm run build                                  # 构建前端（vite build，不做类型检查）
npm run verify:core                            # 部署前快速闸门，约 3 秒
npm run smoke                                  # nginx/接口/SEO 文件检查
npm run test:currency                          # 汇率、支付金额、Webhook 幂等
npm run test:admin                             # 管理端校验
npm run test:e2e                               # 全流程 E2E（会改 store.json，需 root）
npm run production:check                       # 上线配置门禁
npm run release:package                        # 打包 releases/*.tar.gz + sha256
```

修改 `api-node/` 或数据结构后 `systemctl restart pet-wool-api`；健康检查 `curl -s http://127.0.0.1:8082/health`。

## 运行拓扑

生产：nginx 443 → `127.0.0.1:8888`（Node 单体，前端静态 + API 同源）。

测试机：nginx 仅监听 `127.0.0.1:8888` → `/` 反代 `pet-wool-frontend-dev`（Vite 5173），`/api`、`/uploads`、`/health` 反代 `pet-wool-api`（8082）。此处改 `frontend/src` 免构建即时生效。

## 数据

生产主数据源是 PostgreSQL（`STORE_BACKEND=postgres`，表 `platform_runtime_store`，`id=1`）；`api-node/data/store.json` 是 JSON 后端/本地开发数据，在生产机上只是同步影子副本（gitignored，运行中不可手工编辑）。迁移导出工具 `npm run export:postgres` 只生成 staging SQL，不切换线上数据源。

```bash
# 生产（Postgres）：pg_dump + 客户照片 tar，0600，保留 14 份，每日 pet-wool-sql-backup.timer
sudo -n bash -c 'set -a; . ./.env; set +a; node scripts/backup-sql.mjs'
# JSON 后端/本地
node scripts/backup-data.mjs                                   # → api-node/backups/<时间戳>/
node scripts/restore-data.mjs --dry-run api-node/backups/<时间戳>
node scripts/restore-data.mjs --apply  api-node/backups/<时间戳>
```

`restore-data.mjs` 在服务运行中或 `STORE_BACKEND=postgres` 时会拒绝执行；Postgres 恢复是 `psql "$DATABASE_URL" -f api-node/sql-backups/store-<时间戳>.sql` 并解包 `uploads-<时间戳>.tar.gz`。异机副本由 `pet-wool-offsite.timer` 每天拉到 `/root/pet-wool-offsite/snapshots/`（保留 21 天）。服务或备份单元失败会触发 `OnFailure=pet-wool-alert@%n.service`，用 `.env` 的 SMTP 发邮件到 `NOTIFY_ADMIN_EMAIL`。

备份含客户 PII，可能带 PayPal Secret 与 Webhook ID，按敏感文件保存；对外只发管理端"下载脱敏备份"（`?secrets=1` 仅 owner 可用）。E2E 与清理脚本处理 `commercial-*`、`unpaid-*`、`blocked-*`、`payable-*`、`hidden-*` 等前缀数据。历史非 KRW 测试订单已由 `scripts/archive-non-krw-orders.mjs` 归档（0600 JSON）后清理。

## 管理端

入口 `/admin`。开发默认账号 `admin@example.com` / `admin123456`，上线前必须替换（`npm run production:check` 会 FAIL）。多管理员用 `ADMIN_ACCOUNTS_JSON`，角色 `owner` / `admin` / `viewer`，密码为 SHA-256 哈希；所有后台写操作进 `store.audit_logs`（保留最近 500 条）。

## 文档索引

- `AGENTS.md` — 给编码 agent 的工作约定
- `DEPLOY.md` — 唯一发布入口
- `RELEASE_PACKAGE.md` — 发布包安装说明
- `docs/OPERATIONS.md` — 运维：日志、备份恢复、支付、邮件
- `docs/SYSTEM_SETTINGS.md` — 前后台功能与配置项
- `docs/COMPLETED_FEATURES_AND_ORDER_FLOW.md` — 业务功能与订单全流程
- `test-results/E2E_TEST_PLAN.md` — E2E 覆盖范围
