# Everwool Studio 后端管理端整体实现方案

参考客户提供的后台模块图，后端管理端定位为一个面向运营、订单、线索、商品、支付和安全的完整管理系统。本文档先定义整体功能范围、页面结构、数据模型、接口和实施优先级，后续可据此进入原型设计和开发排期。

## 1. 管理端目标

管理端用于支撑羊毛毡宠物定制业务的日常运营，核心目标：

- 统一查看业务概览、订单、线索、收入和上线状态。
- 管理商品分类、商品详情、规格、价格、图片和 SEO 内容。
- 管理客户线索、订单状态、付款状态、制作状态和发货状态。
- 管理用户、访问统计、支付方式、站点配置和安全设置。
- 为后续客服机器人、评价系统、博客、政策页面和多语言内容提供后台入口。

## 2. 整体导航模块

参考图中的一级导航建议如下：

| 一级模块 | 说明 | MVP 是否需要 |
| --- | --- | --- |
| 概览 | 运营数据、今日待办、上线状态 | 必须 |
| 线索 | 咨询、询盘、未下单客户、客服跟进 | 必须 |
| 商品管理 | 分类、商品、规格、价格、图片、SEO | 必须 |
| 订单管理 | 订单、付款、制作、发货、售后 | 必须 |
| 用户管理 | 客户、管理员、角色权限 | 建议 |
| 访问统计 | 访问量、来源、转化、热门页面 | 建议 |
| 支付与站点配置 | 支付方式、站点信息、语言、社媒、政策页面 | 必须 |
| 安全 | 登录安全、密码、Token、操作日志 | 必须 |

## 3. 概览模块

### 3.1 子标签

- 运营概览
- 今日待办
- 上线状态

### 3.2 运营概览指标

参考图中的指标卡，建议实现：

| 指标 | 含义 | 计算方式 |
| --- | --- | --- |
| 用户 | 注册/留资客户数量 | customer count |
| 商品 | 已创建商品数量 | product count |
| 订单 | 总订单数量 | order count |
| 未支付 | 未支付或仅提交未付款订单 | payment_status = unpaid |
| 已支付 | 已支付订单 | payment_status = paid / deposit_paid |
| 总线索 | 线索总数 | lead count |
| 新线索 | 未联系线索 | lead_status = new |
| 已联系 | 已联系线索 | lead_status = contacted |
| 已转化 | 已转订单线索 | lead_status = converted |
| 制作中 | 正在制作订单 | order_status = crafting |
| 待发货 | 已完成待发货订单 | order_status = ready_to_ship |
| 收入 | 已支付金额统计 | sum paid_amount |
| 支付转化率 | 已支付订单 / 总订单 | paid_orders / all_orders |

### 3.3 今日待办

待办来源：

- 新线索待联系。
- 新订单待确认。
- 已付定金待开始制作。
- 制作完成待预览。
- 预览确认后待收尾款。
- 已支付尾款待发货。
- 客户退款/售后待处理。
- 低库存或需补充商品图片/文案。

### 3.4 上线状态

上线检查项：

- 首页是否可访问。
- 商品详情页是否完整。
- 分类页是否完整。
- 下单流程是否可提交。
- 图片上传是否可用。
- 邮件通知是否配置。
- 支付方式是否配置。
- 多语言是否完整。
- SEO 标题和描述是否填写。
- 机器人客服是否配置。

## 4. 线索模块

线索是指客户咨询、客服机器人会话、商品咨询、未完成下单等潜在客户。

### 4.1 线索来源

- 首页联系入口。
- 商品详情页 Ask Before Ordering。
- 下单页未提交表单。
- AI 客服会话。
- 社媒来源：TikTok、Pinterest、Instagram、Facebook。
- 邮件咨询。

### 4.2 线索字段

| 字段 | 说明 |
| --- | --- |
| id | 线索 ID |
| name | 客户姓名 |
| email | 邮箱 |
| phone / whatsapp | 联系方式，可选 |
| country | 国家/地区 |
| language | 语言 |
| source | 来源 |
| interest_product | 感兴趣商品 |
| pet_type | 宠物类型 |
| message | 咨询内容 |
| status | new / contacted / quoted / converted / lost |
| assignee | 跟进人 |
| last_contacted_at | 最近联系时间 |
| created_at | 创建时间 |

### 4.3 页面功能

- 线索列表。
- 状态筛选。
- 来源筛选。
- 国家/语言筛选。
- 关键词搜索。
- 线索详情。
- 添加跟进记录。
- 转为订单。
- 标记丢失原因。

## 5. 商品管理模块

商品管理是本项目核心模块，需要支持“真实页面”，不是简单按钮。

### 5.1 商品分类

分类结构：

- 3D 宠物相框类肖像
  - 狗狗相框
  - 猫咪相框
  - 兔子相框
- 3D 宠物全身类肖像
  - 狗狗全身肖像
  - 猫猫全身肖像
  - 多宠物合照肖像
- 宠物纪念礼品
  - 纪念相框
  - 纪念全身肖像
- Occasion 场景分类
  - Birthday Gift
  - Anniversary Gift
  - Memorial Gift
  - Christmas Gift
- Style 风格分类已移除，不再作为前台筛选项。

### 5.2 商品字段

| 字段 | 说明 |
| --- | --- |
| id | 商品 ID |
| title | 商品标题 |
| slug | SEO URL |
| category_id | 主分类 |
| tags | 场景、风格、宠物类型标签 |
| description | 商品描述 |
| base_price | 基础价格 |
| currency | 币种 |
| deposit_percent | 定金比例 |
| images | 商品图片 |
| alt_texts | 图片 ALT |
| specs | 规格选项 |
| production_time | 制作周期 |
| shipping_note | 发货说明 |
| care_instruction | 护理说明 |
| refund_note | 退款说明 |
| seo_title | SEO 标题 |
| seo_description | SEO 描述 |
| status | draft / published / hidden |

### 5.3 规格价格

| 产品类型 | 规格 | 价格 |
| --- | --- | --- |
| 相框类 | 6 英寸头部 | 1600 |
| 相框类 | 7 英寸头部 | 2000 |
| 相框类 | 8 英寸头部 | 2400 |
| 相框类 | 6 英寸头 + 前爪 | 2000 |
| 相框类 | 7 英寸头 + 前爪 | 2500 |
| 相框类 | 8 英寸头 + 前爪 | 3000 |
| 相框类 | 头 + 全身 | 4000 |
| 宠物全身肖像 | 10 厘米 | 2600 |
| 宠物全身肖像 | 15 厘米 | 4000 |
| 宠物全身肖像 | 20 厘米 | 5300 |
| 宠物全身肖像 | 30 厘米 | 9400 |

### 5.4 页面功能

- 商品列表。
- 新建商品。
- 编辑商品。
- 上架/下架。
- 删除/归档。
- 批量排序。
- 商品图片上传。
- 多语言内容维护。
- SEO 内容维护。
- 商品预览。

## 6. 订单管理模块

订单管理围绕定制业务流程设计。

### 6.1 订单状态

| 状态 | 说明 |
| --- | --- |
| new | 新订单，待确认 |
| confirmed | 已确认需求 |
| deposit_paid | 已付定金 |
| crafting | 制作中 |
| preview | 已发送预览 |
| balance_due | 待收尾款 |
| paid | 已付全款或尾款 |
| ready_to_ship | 待发货 |
| shipped | 已发货 |
| completed | 已完成 |
| cancelled | 已取消 |
| refund_requested | 退款申请 |

### 6.2 付款状态

- unpaid：未支付。
- deposit_paid：已付定金。
- balance_pending：待付尾款。
- paid：已支付。
- refunded：已退款。

### 6.3 订单字段

| 字段 | 说明 |
| --- | --- |
| order_no | 订单号 |
| customer | 客户信息 |
| product | 商品信息 |
| selected_options | 规格选项 |
| pet_info | 宠物信息 |
| uploaded_photos | 上传照片 |
| notes | 客户备注 |
| internal_notes | 内部备注 |
| amount | 总金额 |
| paid_amount | 已支付金额 |
| payment_status | 付款状态 |
| order_status | 订单状态 |
| shipping_address | 收货地址 |
| tracking_no | 物流单号 |
| created_at | 创建时间 |

### 6.4 页面功能

- 订单列表。
- 订单详情。
- 状态修改。
- 付款状态修改。
- 查看上传照片。
- 下载照片。
- 内部备注。
- 发送预览记录。
- 物流单号录入。
- 售后/退款处理。

## 7. 用户管理模块

### 7.1 客户管理

- 客户列表。
- 客户详情。
- 历史订单。
- 历史线索。
- 国家/语言。
- 标签。
- 黑名单。

### 7.2 管理员管理

- 管理员列表。
- 新增管理员。
- 修改密码。
- 启用/禁用。
- 角色分配。

### 7.3 角色权限

建议角色：

| 角色 | 权限 |
| --- | --- |
| Owner | 全部权限 |
| Admin | 订单、商品、线索、站点配置 |
| Operator | 订单、线索、商品内容 |
| Support | 线索、订单查看、客服记录 |
| Viewer | 只读 |

## 8. 访问统计模块

### 8.1 核心指标

- PV。
- UV。
- 访问来源。
- 国家/地区。
- 语言。
- 热门页面。
- 商品详情页访问。
- 加购/下单点击。
- 下单提交。
- 支付转化。

### 8.2 页面功能

- 趋势图。
- 来源渠道统计。
- 热门商品。
- 热门分类。
- 转化漏斗。
- SEO 页面表现。

## 9. 支付与站点配置模块

### 9.1 支付配置

- 定金比例。
- 支付方式：Stripe、PayPal、线下转账。
- 币种。
- 税费。
- 运费规则。
- 支付成功回调。
- 支付失败提示。

### 9.2 站点基础配置

- 品牌名称。
- Logo。
- 联系邮箱。
- 客服入口。
- 机器人客服开关。
- 社媒链接：TikTok、Pinterest、Instagram、Facebook。
- 默认语言。
- 自动语言识别。
- 可用语言。
- 主题色。

### 9.3 内容页面配置

- 首页 Hero。
- 分类页文案。
- 产品详情 SEO。
- 护理说明。
- 运输政策。
- 退款政策。
- FAQ。
- 博客。
- 评价系统。

## 10. 安全模块

### 10.1 登录安全

- 管理员登录。
- 密码强度。
- JWT 过期。
- 登录失败限制。
- 修改密码。
- 退出登录。

### 10.2 操作安全

- 操作日志。
- 关键操作二次确认。
- 删除软删除。
- 数据导出权限。
- 文件上传限制。
- 图片类型和大小校验。

### 10.3 系统安全

- CORS 配置。
- API 限流。
- 后台路径保护。
- 环境变量管理。
- 数据库备份。
- 文件存储权限。

## 11. 建议后台页面清单

```text
/admin/login
/admin
/admin/overview
/admin/todos
/admin/launch-checklist
/admin/leads
/admin/leads/:id
/admin/products
/admin/products/new
/admin/products/:id
/admin/categories
/admin/orders
/admin/orders/:id
/admin/customers
/admin/customers/:id
/admin/admin-users
/admin/analytics
/admin/payments
/admin/site
/admin/content/policies
/admin/content/faqs
/admin/content/reviews
/admin/security
/admin/logs
```

## 12. 建议 API 分组

```text
POST   /api/admin/login
GET    /api/admin/overview
GET    /api/admin/todos
GET    /api/admin/launch-checklist

GET    /api/admin/leads
POST   /api/admin/leads
GET    /api/admin/leads/:id
PUT    /api/admin/leads/:id
POST   /api/admin/leads/:id/notes
POST   /api/admin/leads/:id/convert-to-order

GET    /api/admin/products
POST   /api/admin/products
GET    /api/admin/products/:id
PUT    /api/admin/products/:id
DELETE /api/admin/products/:id
POST   /api/admin/products/:id/images

GET    /api/admin/categories
POST   /api/admin/categories
PUT    /api/admin/categories/:id

GET    /api/admin/orders
GET    /api/admin/orders/:id
PUT    /api/admin/orders/:id/status
PUT    /api/admin/orders/:id/payment
POST   /api/admin/orders/:id/notes
POST   /api/admin/orders/:id/shipping

GET    /api/admin/customers
GET    /api/admin/customers/:id

GET    /api/admin/analytics
GET    /api/admin/site
PUT    /api/admin/site
GET    /api/admin/security/logs
```

## 13. 数据表建议

核心表：

- admins
- admin_roles
- admin_permissions
- customers
- leads
- lead_notes
- categories
- products
- product_translations
- product_options
- product_option_values
- product_images
- orders
- order_items
- order_photos
- order_notes
- payments
- shipments
- faqs
- reviews
- policy_pages
- site_settings
- analytics_events
- audit_logs

## 14. MVP 实施优先级

### P0 必须实现

1. 管理员登录。
2. 概览指标。
3. 订单列表和订单详情。
4. 订单状态修改。
5. 商品管理。
6. 分类管理。
7. 图片上传。
8. 站点基础配置。
9. 安全退出和操作日志基础。

### P1 建议实现

1. 线索管理。
2. 客户管理。
3. 支付配置。
4. 政策页面管理。
5. FAQ 管理。
6. 评价管理。
7. 上线检查清单。

### P2 后续增强

1. 访问统计。
2. 转化漏斗。
3. AI 客服后台。
4. 邮件通知模板。
5. 多角色权限。
6. 数据导出。
7. 自动备份。

## 15. 后台视觉方向

参考图的视觉方向建议保留：

- 深绿色背景，体现品牌质感。
- 圆角胶囊导航。
- 浅色激活态。
- 半透明深色卡片。
- 运营数据卡片网格。
- 简洁高级，不做过度装饰。

建议在真实设计中增强：

- 卡片层级和阴影。
- 表格可读性。
- 详情页信息分组。
- 状态颜色标签。
- 待办优先级。
- 上传图片预览。
- 移动端后台基础适配。
