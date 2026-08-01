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
- 右下角 TALK / LINE / AI 机器人
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

- TALK
- LINE
- AI 机器人

AI 机器人当前是规则问答，不依赖外部 AI 服务。知识库在 `api-node/server.mjs` 的默认站点内容里初始化，并保存在 `api-node/data/store.json`。

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

管理端站点配置提供 PayPal Client ID、Secret、Webhook ID、币种和启用开关。没有配置 Client ID/Secret 时，系统会按 `PAYPAL_MOCK` 或缺失凭据进入本地 mock 路径，方便开发和 E2E；正式上线需要设置 `PAYPAL_ENV=live`、填写 live 凭据，并在 PayPal 后台把 Webhook URL 配成：

```text
https://<正式域名>/api/paypal/webhook
```

Webhook ID 不是 URL，应填写 PayPal 创建 Webhook 后生成的 ID。

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

首页和当前发布商品已改用站内 `/assets` 图片，不再依赖外部 Unsplash。当前 SVG 只是本地占位视觉；正式商业上线前应在后台替换为自有真实作品图或授权图片。

## 自动化测试

测试入口：

```bash
node test-results/e2e-check.mjs
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
