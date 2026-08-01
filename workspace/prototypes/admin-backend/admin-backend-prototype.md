# 后端管理端原型图

## 1. 管理端定位

后端在本项目中指“管理端后台系统”，由后台 UI 和管理 API 组成。管理员通过浏览器进入后台，对订单、商品、FAQ 和站点配置进行运营管理。

## 2. 页面流程

```mermaid
flowchart TD
  Login[管理登录 /admin] --> Auth{登录成功?}
  Auth -->|是| Dashboard[管理端 /admin/dashboard]
  Auth -->|否| LoginError[显示登录错误]
  Dashboard --> Orders[订单管理]
  Dashboard --> Products[商品管理]
  Dashboard --> FAQ[FAQ 管理]
  Dashboard --> Settings[站点配置]
  Dashboard --> Logout[退出登录]
  Logout --> Login
```

## 3. 管理端总布局原型

```mermaid
flowchart TD
  subgraph Admin[管理端后台]
    Topbar[顶部: Admin 标识 / 退出登录]
    Tabs[标签导航: 订单 / 商品 / FAQ / 设置]
    Content[内容区域]
  end
  Topbar --> Tabs --> Content
```

## 4. 登录页原型

```mermaid
flowchart TD
  subgraph LoginPage[登录页]
    Title[后台登录]
    Email[邮箱输入框]
    Password[密码输入框]
    Submit[登录按钮]
    Error[错误提示]
  end
  Title --> Email --> Password --> Submit --> Error
```

## 5. 订单管理原型

```mermaid
flowchart TD
  subgraph Orders[订单管理]
    Toolbar[筛选区: 状态 / 时间 / 关键词 后续]
    Table[订单表格]
    Row[订单行: 订单号 / 客户 / 宠物 / 金额 / 状态 / 时间]
    Status[状态下拉]
    Detail[订单详情抽屉: 后续]
  end
  Toolbar --> Table --> Row --> Status
  Row --> Detail
```

订单状态：

```mermaid
flowchart LR
  New[new] --> Confirmed[confirmed]
  Confirmed --> Crafting[crafting]
  Crafting --> Preview[preview]
  Preview --> Balance[balance_due]
  Balance --> Shipped[shipped]
  Shipped --> Completed[completed]
  New --> Cancelled[cancelled]
```

## 6. 商品管理原型

```mermaid
flowchart TD
  subgraph Products[商品管理]
    ProductForm[创建/编辑商品表单]
    Basic[基础信息: slug / 价格 / 币种 / 定金 / 排序 / 图片]
    I18n[多语言内容: 中文 / 英文 / 韩文]
    Save[保存按钮]
    ProductList[商品列表]
  end
  ProductForm --> Basic --> I18n --> Save
  Save --> ProductList
```

## 7. FAQ 管理原型

```mermaid
flowchart TD
  subgraph FAQ[FAQ 管理]
    FaqForm[创建/编辑 FAQ 表单]
    Sort[排序]
    Zh[中文问题和答案]
    En[英文问题和答案]
    Ko[韩文问题和答案]
    Save[保存按钮]
    FaqList[FAQ 列表]
  end
  FaqForm --> Sort --> Zh --> En --> Ko --> Save --> FaqList
```

## 8. 站点配置原型

```mermaid
flowchart TD
  subgraph Settings[站点配置]
    Theme[主题设置: 默认主题 / 可用主题]
    Brand[品牌设置: 名称 / 邮箱 / Instagram 后续]
    OrderRule[订单规则: 定金比例 / 制作周期 后续]
    SEO[SEO 设置: 标题 / 描述 / 语言 hreflang 后续]
    Save[保存]
  end
  Theme --> Save
  Brand --> Save
  OrderRule --> Save
  SEO --> Save
```

## 9. 管理端接口调用关系

```mermaid
sequenceDiagram
  participant Admin as 管理员
  participant UI as 管理端 UI
  participant API as 管理 API
  participant DB as 数据存储

  Admin->>UI: 输入邮箱和密码
  UI->>API: POST /api/admin/login
  API-->>UI: token
  UI->>API: GET /api/admin/orders
  API->>DB: 查询订单
  DB-->>API: 订单列表
  API-->>UI: 订单列表
  Admin->>UI: 修改订单状态
  UI->>API: PUT /api/admin/orders/:id/status
  API->>DB: 更新状态
  API-->>UI: 更新结果
```

## 10. 后续后台增强清单

| 模块 | 增强项 |
| --- | --- |
| 登录 | 修改密码、重置密码、登录过期提醒 |
| 订单 | 详情页、内部备注、客户沟通记录、照片预览 |
| 商品 | 编辑、删除、上下架、规格模板、库存/产能 |
| FAQ | 编辑、删除、启停、批量排序 |
| 设置 | 品牌配置、SEO、社交链接、邮件模板 |
| 数据 | 仪表盘统计、订单趋势、销售金额 |
