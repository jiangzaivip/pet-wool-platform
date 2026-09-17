# WoolBuddy 宠物羊毛毡定制平台

这是一个宠物羊毛毡定制电商站，当前线上版本包含前台官网、管理端、Node API、上传、订单、PayPal 真实支付跳转与确认、AI 机器人问答、博客、政策页和 Playwright 自动化测试。

仓库项目名：pet-wool-platform（静姐宠物网站项目）。

## 当前线上地址

- 前台：`http://36.138.248.23:8888/`
- 管理端：`http://36.138.248.23:8888/admin`
- 客户文档：`http://36.138.248.23:8888/doc/`

## 主要目录

```text
api-node/        当前 API 服务和 JSON 数据
frontend/        Vue 3 + Vite 前台和管理端
docs/            项目初始化、系统设置等维护文档
scripts/         常用维护脚本
site-doc/        客户文档和原型页面
test-results/    Playwright 测试脚本、报告、截图
backend/         早期 Rust 后端草稿，当前线上未使用
```

完整目录说明见：

```text
docs/PROJECT_INIT.md
```

系统设置说明见：

```text
docs/SYSTEM_SETTINGS.md
```

自动化测试说明见：

```text
test-results/E2E_TEST_PLAN.md
```

业务功能和订单全流程图见：

```text
docs/COMPLETED_FEATURES_AND_ORDER_FLOW.md
```

## 当前技术栈

- 前端：Vue 3 + Vite + TypeScript
- API：Node.js 原生 HTTP 服务
- 数据：`api-node/data/store.json`
- 上传：`api-node/uploads/`
- Web 服务：nginx 监听 8888，前端反代到 Vite 开发服务，API 代理到 Node API
- 自动化测试：Playwright
- 订单通知：可选 Node 内置 SMTP，未配置时不会影响下单和支付

## 常用命令

安装依赖：

```bash
npm install
cd frontend
npm install
```

前端开发服务：

```bash
systemctl restart pet-wool-frontend-dev
```

当前 `http://36.138.248.23:8888/` 直接反代到 Vite 开发服务，修改 `frontend/src` 后不需要再手动构建和复制静态文件。

前端修改后更新 8888：

```bash
cd /root/pet-wool-platform/frontend
npm run build
systemctl restart pet-wool-frontend-dev
```

当前 8888 不再复制 `frontend/dist/` 到 `/var/www/pet-wool-platform/`；nginx 直接反代 Vite 前端服务。

重启 API：

```bash
systemctl restart pet-wool-api
```

快速检查：

```bash
cd /root/pet-wool-platform
bash scripts/smoke-check.sh
```

全流程测试：

```bash
cd /root/pet-wool-platform
node test-results/e2e-check.mjs
```

上线配置检查：

```bash
npm run production:check
```

清理 E2E 测试残留数据：

```bash
cd /root/pet-wool-platform
node scripts/cleanup-e2e-data.mjs
systemctl restart pet-wool-api
```

默认只预览清理结果；确认后执行：

```bash
node scripts/cleanup-e2e-data.mjs --apply --confirm-e2e-cleanup
systemctl restart pet-wool-api
```

备份当前运营数据：

```bash
cd /root/pet-wool-platform
node scripts/backup-data.mjs
```

备份会写入 `api-node/backups/<时间戳>/`，包含 `store.json` 和 `uploads/`，默认保留最近 10 份。大批量修改商品、订单、站点配置或上线前先运行一次。

健康检查：

```bash
curl -s http://127.0.0.1:8082/health
```

`/health` 会返回 API 状态和分类/商品/订单/用户/支付数量，不暴露服务器文件路径。

## 管理端账号

- Email：`admin@example.com`
- Password：`admin123456`

上线前必须替换管理员密码、配置管理员角色、PayPal Live 凭据和正式 Google OAuth。

## 8888 端口运行方式

当前 8888 由 nginx 对外提供访问：

- `/` 反代到 `pet-wool-frontend-dev`，即 Vite 前端服务。
- `/api`、`/uploads`、`/health` 反代到 `pet-wool-api`。
- `/` 和 `/doc/` 由 nginx 补充 `X-Content-Type-Options`、`X-Frame-Options` 和 `Referrer-Policy`；API 自身返回安全头，nginx 不重复覆盖 `/api` 和 `/uploads`。

常用状态检查：

```bash
systemctl is-active pet-wool-frontend-dev pet-wool-api nginx
```

前端代码修改后：

```bash
cd /root/pet-wool-platform/frontend
npm run build
systemctl restart pet-wool-frontend-dev
```

API 或数据结构修改后：

```bash
systemctl restart pet-wool-api
```

数据文件和上传目录：

```text
api-node/data/store.json
api-node/uploads/
api-node/backups/
```

上线前或大批量修改商品、订单、站点配置前，先运行 `node scripts/backup-data.mjs` 备份 `store.json` 和 `uploads/`。命令行备份包含完整 `store.json`，如果已经配置 PayPal Secret 或 Webhook ID，也会一起进入备份目录，必须按敏感文件保存；需要给第三方时使用管理端“下载脱敏备份”。如需恢复，先执行 `node scripts/restore-data.mjs --dry-run api-node/backups/<时间戳>` 校验备份；确认无误后执行 `node scripts/restore-data.mjs --apply api-node/backups/<时间戳>`，脚本会先自动创建一份恢复前备份，恢复后再执行 `systemctl restart pet-wool-api`。PayPal 支付接口已做订单级幂等：同一未支付订单重复创建支付单会返回同一个 PayPal 单，已付款订单不会再次新增支付金额。迁移数据库前可运行 `npm run export:postgres` 生成 `workspace/generated/store-postgres-seed.sql`。

E2E 会自动清理 `commercial-*`、`unpaid-*`、`blocked-*`、`hidden-*`、`commercial-check-*` 测试数据，并删除这些测试订单关联的上传图片。手动测试后也可以运行 `node scripts/cleanup-e2e-data.mjs --apply` 保持后台运营数据干净。上传目录可用 `node scripts/cleanup-orphan-uploads.mjs` 先预览孤儿图片，再用 `node scripts/cleanup-orphan-uploads.mjs --apply` 删除未被任何订单引用的上传文件。

## 当前功能

- 首页 Hero、分类、客户反馈、制作流程、博客
- 大分类、子分类、Occasion / Style 筛选
- 产品详情 SEO 标题、描述、FAQ、ALT 文本
- 宠物照片上传下单
- PayPal 定金/全款 Orders API 支付、capture、webhook 和本地 mock fallback
- Google 登录入口，支持真实 Google ID Token 校验和开发 demo fallback
- 管理端订单流程管理、管理员角色和审计日志
- 管理端站点配置和主题配色
- KakaoTalk / WhatsApp / AI 机器人客服
- 可选社媒外链，仅展示已配置链接
- 护理说明、FAQ、运输政策、退款政策、评价系统
- 博客列表和详情页
