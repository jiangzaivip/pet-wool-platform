# API 与数据模型

## 1. API 前缀

线上访问统一走同域代理：

```text
http://36.138.248.23:8888/api
```

## 2. 公共接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 服务健康检查 |
| GET | `/api/site` | 获取站点配置 |
| GET | `/api/products?lang=zh` | 获取商品列表 |
| GET | `/api/faqs?lang=zh` | 获取 FAQ 列表 |
| POST | `/api/orders` | 创建订单 |

## 3. 管理端接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | 管理员登录 |
| GET | `/api/admin/orders` | 订单列表 |
| PUT | `/api/admin/orders/:id/status` | 更新订单状态 |
| POST | `/api/products` | 创建商品 |
| PUT | `/api/products/:id` | 更新商品 |
| DELETE | `/api/products/:id` | 删除商品 |
| POST | `/api/faqs` | 创建 FAQ |
| PUT | `/api/faqs/:id` | 更新 FAQ |
| DELETE | `/api/faqs/:id` | 删除 FAQ |
| PUT | `/api/admin/site` | 更新站点配置 |

管理端接口需要请求头：

```text
Authorization: Bearer <token>
```

## 4. 核心数据模型

### Product

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 商品 ID |
| slug | string | 商品唯一标识 |
| base_price_cents | number | 基础价格，单位分 |
| currency | string | 币种 |
| deposit_percent | number | 定金比例 |
| image_url | string | 商品图片 |
| is_active | boolean | 是否启用 |
| sort_order | number | 排序 |

### ProductTranslation

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| product_id | uuid | 商品 ID |
| lang | enum | `zh` / `en` / `ko` |
| title | string | 标题 |
| subtitle | string | 副标题 |
| description | string | 描述 |
| specs | string[] | 规格卖点 |

### Order

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | 订单 ID |
| order_no | string | 订单号 |
| product_id | uuid | 商品 ID |
| lang | string | 下单语言 |
| customer_name | string | 客户名 |
| email | string | 邮箱 |
| country | string | 国家/地区 |
| pet_name | string | 宠物名 |
| pet_type | string | 宠物类型 |
| size_option | string | 尺寸 |
| payment_type | enum | `deposit` / `balance` / `full` |
| amount_cents | number | 应付金额 |
| currency | string | 币种 |
| notes | string | 备注 |
| photo_urls | string[] | 宠物照片 URL |
| status | enum | 订单状态 |
| created_at | datetime | 创建时间 |

### FAQ

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | uuid | FAQ ID |
| sort_order | number | 排序 |
| is_active | boolean | 是否启用 |

### SiteSettings

| key | value 示例 | 说明 |
| --- | --- | --- |
| brand | `{ "name": "WoolBuddy" }` | 品牌信息 |
| theme | `{ "defaultTheme": "cream" }` | 主题配置 |
| order | `{ "depositPercent": 50 }` | 订单规则 |
