# 系统设置说明

## 前台设置

前台用户可见功能：

- 首页 Hero
- 大分类和子分类
- Occasion / Style 筛选
- 商品详情
- 宠物照片上传下单
- PayPal 支付流程
- Google 登录入口，可配置真实 OAuth Client ID
- 用户订单页
- 右下角 KakaoTalk / WhatsApp / AI 机器人
- 可选外部社媒链接，只展示已经配置的链接
- 护理说明、FAQ、运输政策、退款政策、评价
- 博客列表和详情

## 管理端设置

管理端路径：

```text
/admin
```

管理端功能：

- 概览数据
- 分类管理
- 商品管理
- 订单管理
- 订单详情流程
- 站点配置
- 右下角联系方式配置
- 平铺色板主题配色配置
- PayPal Client ID / Secret / Webhook ID 配置
- 管理员角色和审计日志
- 护理、运输、退款政策配置
- FAQ、客户评价、博客内容配置
- 脱敏备份、完整密钥备份和站点配置恢复

## 主题配色

位置：

```text
管理端 -> 站点配置 -> 网站主题配色
```

当前前台使用平铺色板切换，不再使用下拉框。当前主题：

- White
- Cream
- Sage
- Rose
- Dark

可配置字段：

- 默认主题
- 背景色
- 卡片底色
- 浅底色
- 文字色
- 副文字色
- 主色
- 强调色
- 边框色

前台右上角平铺色板会读取管理端配置。用户点击色板后会保存到本地，下次访问继续使用该配色。

## 联系方式

位置：

```text
管理端 -> 站点配置 -> 右下角联系方式
```

当前支持：

- KakaoTalk 账号
- WhatsApp 账号
- 品牌邮箱
- AI 机器人

AI 机器人当前是规则问答，不依赖外部 AI 服务。知识库在 `api-node/server.mjs` 的默认站点内容里初始化，并保存在运行时数据里（生产是 PostgreSQL `platform_runtime_store`，本地/JSON 后端是 `api-node/data/store.json`）。

## 外站链接

当前支持字段：

- TK：TikTok
- PT：Pinterest
- INS：Instagram，默认留空；只有配置真实自有链接时才会展示
- FB：Facebook

数据字段在：

```text
site.socials
```

## 订单流程

前台订单流程：

1. 选择商品和规格
2. 填写客户信息
3. 上传宠物照片
4. 提交订单
5. 创建 PayPal 支付
6. 支付成功后订单进入确认状态
7. 用户登录后可在“我的订单”查看

管理端订单流程状态：

- new
- confirmed
- crafting
- preview
- balance_due
- ready_ship
- shipped
- completed
- cancelled

## 支付说明

当前 PayPal 已接入 Orders API：

- `/api/paypal/create-order`
- `/api/paypal/capture-order`
- `/api/paypal/webhook`

管理端站点配置提供 PayPal Client ID、Secret、Webhook ID、币种和启用开关。没有配置 Client ID/Secret 时，系统会按 `PAYPAL_MOCK` 或缺失凭据进入本地 mock 路径，方便开发和 E2E；正式上线需要在管理端把模式设为 `live`、填写 live 凭据，设置 `PAYPAL_MOCK=false`，并在 PayPal 后台把 Webhook URL 配成：

```text
https://<正式域名>/api/paypal/webhook
```

Webhook ID 不是 URL，应填写 PayPal 创建 Webhook 后生成的 ID。

## 运费

运费在 `api-node/shipping.mjs` 中按目的地区域报价，规则本身是数据（存在
`store.site.shipping`），区域归属错了可以直接改，不用发版。

**默认关闭。** `shipping.enabled` 不是 `true` 时运费一律为 0，结账金额等于商品
价，与现在的线上价格一致。开启后请先确认费率符合实际，否则等于给在售商品加价。

配置项：

| 字段 | 含义 |
| --- | --- |
| `enabled` | 总开关，默认 `false` |
| `zones` | 各区域费率，`cents` 为基准币种（KRW）最小单位 |
| `country_zones` | 国家码到区域的映射，覆盖内置默认表 |
| `free_shipping_threshold_cents` | 商品金额达到该值免运费 |
| `note` | 前台说明文案 |

关键行为：运费在**建单时算一次**并写进订单，之后永不重算。制作期间调整费率不会
改变客户待付金额，历史订单也保留成交时的规则。订单同时记录
`product_amount_cents` / `shipping_cents` / `shipping_zone` / `shipping_free`。

之所以要固化：`payment-amounts.mjs` 把 `order.amount_cents` 当作唯一应付总额，
只在报价时存在的运费对支付校验不可见，capture 要么被拒要么少收。

`POST /api/shipping-quote`（入参 `country`、`subtotal_cents`）供前台试算。

## 前端错误上报

前台异常上报到自有接口 `POST /api/client-reports`，不进任何第三方 SaaS。
上报内容只有错误级别、脱敏消息、当前路由、语言环境；表单值、订单号、请求体都
不发送。存储前服务端二次清洗（邮箱、URL、长数字串、订单号格式全部替换），
每 IP 每分钟 10 条，最多保留 200 条。

管理端用 `GET /api/admin/client-reports` 查看，`DELETE` 清空。

## Google 登录

默认开发数据仍保留 demo 登录能力。配置真实 Google OAuth 后：

```text
GOOGLE_CLIENT_ID=<Google OAuth Client ID>
GOOGLE_DEMO_LOGIN=false
```

前台会加载 Google Identity Services 获取 ID Token，API 会校验 Google 公钥签名、audience、issuer、过期时间和邮箱格式。若需要多个 Client ID，可使用 `GOOGLE_CLIENT_IDS` 逗号分隔。

## 管理员角色和审计

默认仍支持单管理员环境变量；正式上线建议使用：

```text
ADMIN_ACCOUNTS_JSON=[{"email":"owner@example.com","password_hash":"<sha256>","role":"owner"},{"email":"ops@example.com","password_hash":"<sha256>","role":"admin"},{"email":"viewer@example.com","password_hash":"<sha256>","role":"viewer"}]
```

角色说明：

- `owner` 和 `admin` 可以读写后台。
- `viewer` 只能读取后台数据，不能修改用户、分类、商品、订单或站点配置。
- 管理端“审计日志”会展示最近写操作，后端保留最近 500 条 `store.audit_logs`。

## SEO 和图片

分类页支持 `/collections/:category` URL，并继续兼容旧的 `?category=` 查询参数。分类页和商品详情页会输出 JSON-LD，包含 `ItemList`、`Product` 和面包屑结构化数据。

`frontend/public/robots.txt`（须含一行 `Sitemap: `）和 `frontend/public/sitemap.xml` 会随前端构建产出到 `/robots.txt`、`/sitemap.xml`；`npm run smoke` 会校验两者，`npm run verify:core` 也会检查其有效性。客户文档页是前端路由 `/doc/`（数据来自 `site-doc/`），已在页面里设 `robots: noindex,nofollow`，且不再进入 sitemap。

首页 Hero 图仍是 Unsplash 外链（`frontend/src/views/Home.vue` 的 `heroImage`），商品与分类图已改用站内 `/assets`；`home-after` 等图目前是本地占位视觉。正式商业上线前应把 Hero 外链换成自有授权图片并配 fallback。

评价实拍图有 WebP 版本：`scripts/optimize-review-images.py` 生成同名 `.webp`
（9.4MB → 3.4MB，EXIF 一并剥离），服务端下发评价数据时若存在 `.webp` 就优先返回
它，原 JPEG 保留作为回退。新增评价图后重跑该脚本即可。

服务端按 URL 注入 meta（title / description / canonical / OG / JSON-LD）。SPA 的
空壳 HTML 对不执行 JS 的爬虫（微信、小红书等链接预览）没有价值，所以注入放在
服务端，而不是只靠前端 `setHead()`。

## 自动化测试

测试入口：

```bash
npm run verify:core      # 3 秒级快速闸门
npm run test:imports     # api-node 模块导入与导出符号校验
npm run test:i18n        # en/ko 键覆盖
npm run test:currency    # 货币与支付金额不变量
npm run test:admin       # 管理台
npm run smoke            # 站点与 API 冒烟
npm run test:e2e         # 全流程回归
```

测试文档：

```text
test-results/E2E_TEST_PLAN.md
```

当前 E2E 覆盖数百个断言，核心包括：

- 首页
- 联系方式
- AI 机器人
- 平铺主题色板切换
- 分类和子分类
- 支持页
- 博客
- 商品详情
- 下单
- PayPal
- 用户订单
- 用户管理
- 商品/分类发布保护
- 管理端订单详情
- 管理端站点配置、支付配置、备份恢复和主题配置
