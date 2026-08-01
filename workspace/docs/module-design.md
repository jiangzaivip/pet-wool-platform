# 模块设计

## 1. 总体架构

```mermaid
flowchart LR
  Customer[客户浏览器] --> Frontend[用户前端 Vue]
  Admin[管理员浏览器] --> AdminUI[后端管理端 Vue]
  Frontend --> API[管理/业务 API]
  AdminUI --> API
  API --> DB[(PostgreSQL 或临时 JSON Store)]
  API --> Storage[(对象存储: 后续)]
  API --> Email[邮件通知: 后续]
```

## 2. 用户前端模块

| 模块 | 页面/组件 | 说明 |
| --- | --- | --- |
| 品牌首页 | `Home.vue` | 首屏、卖点、商品、流程、FAQ |
| 商品展示 | 首页商品区 | 按语言拉取商品列表 |
| 定制流程 | 首页流程区 | 展示下单、确认、制作、发货流程 |
| FAQ | 首页 FAQ 区 | 按语言拉取 FAQ |
| 下单 | `Order.vue` | 提交订单，计算付款金额 |
| 多语言 | `i18n.ts` | 页面静态文案切换 |
| API 客户端 | `api.ts` | 统一封装请求和 token |

## 3. 后端管理端模块

| 模块 | 页面/接口 | 说明 |
| --- | --- | --- |
| 管理登录 | `AdminLogin.vue` / `/api/admin/login` | 邮箱密码登录 |
| 管理首页 | `AdminDashboard.vue` | 后台主容器和标签页 |
| 订单管理 | `/api/admin/orders` | 订单列表和状态修改 |
| 商品管理 | `/api/products` | 商品创建、列表、编辑、删除 |
| FAQ 管理 | `/api/faqs` | FAQ 创建、列表、编辑、删除 |
| 站点配置 | `/api/admin/site` | 主题和站点配置 |
| 鉴权 | Bearer Token | 管理接口鉴权 |

## 4. 订单状态流

```mermaid
stateDiagram-v2
  [*] --> new: 客户提交订单
  new --> confirmed: 管理员确认
  confirmed --> crafting: 开始制作
  crafting --> preview: 发送预览
  preview --> balance_due: 等待尾款
  balance_due --> shipped: 发货
  shipped --> completed: 完成
  new --> cancelled: 取消
  confirmed --> cancelled: 取消
```

## 5. 管理端信息架构

```mermaid
flowchart TD
  Login[登录页] --> Dashboard[管理端工作台]
  Dashboard --> Orders[订单管理]
  Dashboard --> Products[商品管理]
  Dashboard --> FAQs[FAQ 管理]
  Dashboard --> Settings[站点配置]

  Orders --> OrderList[订单列表]
  Orders --> StatusUpdate[状态修改]

  Products --> ProductCreate[创建商品]
  Products --> ProductList[商品列表]
  Products --> ProductI18n[多语言内容]

  FAQs --> FaqCreate[创建 FAQ]
  FAQs --> FaqList[FAQ 列表]
  FAQs --> FaqI18n[多语言问答]

  Settings --> Theme[主题设置]
  Settings --> Brand[品牌信息: 后续]
  Settings --> SEO[SEO: 后续]
```
