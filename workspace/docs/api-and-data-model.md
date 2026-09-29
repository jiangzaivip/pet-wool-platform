# API 与数据模型

> 事实核对日期：2026-09-29。路由与字段名以 `api-node/server.mjs` 的 `handle()` 和实际 `store.json` 为准。
> 路由规则：所有 `/api/*` 进入显式路由表；非 `/api` 路径返回前端文件，未知前端路由返回 404。

## 1. API 前缀

同域访问，不需要写死 IP：

```text
生产：https://woolbuddy.shop/api
测试机：http://36.138.248.23:8888/api
```

## 2. 非 `/api` 路径

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health`、`/api/health` | 健康检查，返回 `counts` 统计，不暴露服务器路径 |
| GET | `/uploads/*` | **无鉴权**公开读取上传图片（上线前需改为签名 URL 或归属校验，见 `docs/LAUNCH_READINESS_ANALYSIS.md`） |
| GET | `/robots.txt` | 按请求 Host 动态生成，含 Sitemap 行 |
| GET | `/sitemap.xml` | 按 store 中已发布商品动态生成 |
| GET | 其它 | 返回 `frontend/dist/` 静态文件 |

## 3. 公开接口（`/api/*`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/site` | 站点配置（品牌、联系方式、政策、FAQ、评价、博客、主题、PayPal、机器人知识库等） |
| GET | `/api/categories` | 分类与子分类 |
| GET | `/api/products` | 商品列表，支持语言与筛选 |
| GET | `/api/blog`、`/api/blog/:slug` | 博客列表与详情 |
| GET | `/api/faqs` | FAQ 列表 |
| POST | `/api/uploads` | 上传宠物照片，无需登录 |
| POST | `/api/orders` | 创建订单；`client_request_id` 幂等 |
| GET | `/api/orders/lookup` | 订单查询（游客有限查询） |
| POST | `/api/auth/google` | Google 登录；`GOOGLE_DEMO_LOGIN` 未设为 false 时接受任意邮箱（生产风险） |
| POST | `/api/bot/answer` | 规则型 AI 机器人问答 |
| GET | `/api/me/orders` | 登录用户按邮箱查看自己的订单 |

## 4. 支付接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/paypal/create-order` | 创建 PayPal 支付单（`PAYPAL_MOCK` 或缺凭据时走本地 mock） |
| POST | `/api/paypal/capture-order` | 捕获支付；按收款金额对账、按基准金额累计已付 |
| POST | `/api/paypal/webhook` | PayPal Webhook，验签 + 幂等 |

## 5. 管理端接口（`/api/admin/*`）

鉴权 `Authorization: Bearer <token>`。除 `/admin/login`、`/admin/logout` 外全部需登录；非只读请求还需写权限（`owner` / `admin`，`viewer` 返回 403）。

| 路径 | 说明 |
| --- | --- |
| `/api/admin/login`、`/api/admin/logout` | 登录登出 |
| `/api/admin/overview` | 概览指标与多币种收入 |
| `/api/admin/categories` | 分类管理 |
| `/api/admin/users` | 用户管理 |
| `/api/admin/orders`（含 `/:id/status`） | 订单列表、详情、状态与付款流转 |
| `/api/admin/site` | 站点配置（含 PayPal 凭据、主题、政策、内容） |
| `/api/admin/products`、`/api/admin/faqs`、`/api/admin/blog` | 内容管理 |
| `/api/admin/backup` | 脱敏备份；`?secrets=1` + `x-confirm-secret-backup: true` 才含完整密钥 |
| `/api/admin/audit-logs` | 审计日志（保留最近 500 条） |
| `/api/admin/paypal/check`、`/api/admin/paypal/test-order` | PayPal OAuth 探测与小额测试单 |
| `/api/admin/translate` | 内容翻译辅助 |

## 6. 核心数据模型

金额字段一律 `*_cents`，表示**币种最小单位**（KRW 为韩元整数，USD/CNY 为分），不能统一除以 100。基准币种为 KRW，固定汇率 `1 USD = 1370 KRW`、`1 CNY = 203.5 KRW`（版本 `fixed-krw-v1`），定义在 `api-node/currency.mjs` 与 `frontend/src/currency.ts`，两份必须一致。

### Product

```text
id, slug, category_id, subcategory_slug, title, subtitle, description,
images, image_url, alt_text, specs, options, tags, use_cases, faqs,
seo_title, seo_description, status, sort_order,
base_price_cents, currency, deposit_percent, translations, updated_at
```

### Order

```text
id, order_no, client_request_id, lang, product_id, product_title,
option_id, option_name, customer_name, email, phone, country, shipping_address,
pet_name, pet_type, notes, photo_urls,
payment_type, amount_cents, initial_payment_cents, deposit_percent,
paid_amount_cents, currency, order_status, payment_status,
internal_note, flagged, paypal_order_id, revision, events,
created_at, updated_at
```

`order_status`：`new` / `confirmed` / `crafting` / `preview` / `balance_due` / `ready_ship` / `shipped` / `completed` / `cancelled`

`payment_status`：`unpaid` / `deposit_paid` / `balance_due` / `paid` / `refunded`

### Payment

保存 `base_amount_cents`（KRW 基准金额快照）与 `amount_cents`（PayPal 实际收款金额）、`currency`、汇率版本、`paypal_order_id`、`paypal_capture_id`、`provider`（`paypal` 或 `manual`）、`status`。

`provider: manual` 只是运营登记标记，不携带汇率版本，不参与尾款差额分配——后台手工置为 `refunded` **不会调用 PayPal 退款**。

### Site（`store.site`）

```text
brand, contact, shipping, google, paypal, theme, policies,
faq, reviews, socials, taxonomies, bot, blog, products
```

PayPal 凭据（Client ID / Secret / Webhook ID / mode / currency）只存这里，不在 `.env`。`.env` 中只有技术开关 `PAYPAL_MOCK` 和 `PAYPAL_TIMEOUT_MS`（**没有 `PAYPAL_ENV` 这个变量**）。

## 7. 数据源

- 默认：JSON 文件 `api-node/data/store.json`（整份读写替换）
- 可选：`STORE_BACKEND=postgres` + `DATABASE_URL` → 读写 `platform_runtime_store` 表中的**单条 JSONB 记录**，同时仍写本地 shadow 文件

两者都不是拆表后的关系库；`npm run export:postgres` 只是迁移准备工具。
