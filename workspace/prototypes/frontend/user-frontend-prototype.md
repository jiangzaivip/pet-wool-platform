# 用户前端原型图

## 1. 页面流程

```mermaid
flowchart TD
  Home[首页 /] --> Products[商品区]
  Home --> Process[定制流程区]
  Home --> FAQ[FAQ 区]
  Home --> OrderCTA[下单按钮]
  OrderCTA --> OrderPage[下单页 /order]
  Products --> OrderPage
  OrderPage --> Submit[提交订单]
  Submit --> Success[显示订单号]
  Submit --> Error[显示错误信息]
```

## 2. 首页低保真原型

```mermaid
flowchart TD
  subgraph Page[首页]
    Nav[顶部导航: Logo / 语言 / 下单]
    Hero[首屏: 品牌标题 + 描述 + CTA + 作品图]
    Trust[信任卖点: 手工制作 / 多语言 / 定金支付]
    ProductGrid[商品卡片网格]
    ProcessSteps[定制流程: 上传照片 -> 确认 -> 制作 -> 发货]
    FaqList[FAQ 折叠列表]
    Footer[页脚: 品牌联系方式]
  end
  Nav --> Hero --> Trust --> ProductGrid --> ProcessSteps --> FaqList --> Footer
```

## 3. 商品卡片结构

```mermaid
flowchart TD
  Card[商品卡片] --> Image[商品图片]
  Card --> Title[标题]
  Card --> Subtitle[副标题]
  Card --> Price[价格]
  Card --> Deposit[定金比例]
  Card --> Specs[规格卖点列表]
  Card --> CTA[选择并下单: 后续增强]
```

## 4. 下单页低保真原型

```mermaid
flowchart TD
  subgraph Order[下单页]
    Header[标题: 定制下单]
    ProductSelect[商品选择]
    CustomerInfo[客户信息: 姓名 / 邮箱 / 国家]
    PetInfo[宠物信息: 名字 / 类型 / 尺寸]
    Payment[付款类型: 定金 / 尾款 / 全款]
    Amount[金额预览]
    Photos[照片 URL 多行输入]
    Notes[备注]
    SubmitButton[提交按钮]
    Message[成功订单号或错误提示]
  end
  Header --> ProductSelect --> CustomerInfo --> PetInfo --> Payment --> Amount --> Photos --> Notes --> SubmitButton --> Message
```

## 5. 前端模块组件关系

```mermaid
flowchart LR
  main[main.ts] --> App[App.vue]
  App --> Router[vue-router]
  Router --> Home[Home.vue]
  Router --> Order[Order.vue]
  Router --> AdminLogin[AdminLogin.vue]
  Router --> AdminDashboard[AdminDashboard.vue]
  Home --> API[api.ts]
  Order --> API
  App --> I18n[i18n.ts]
```

## 6. 用户端交互状态

| 场景 | 状态 | UI 表现 |
| --- | --- | --- |
| 加载商品 | loading | 显示 Loading |
| 切换语言 | reload | 重新请求商品和 FAQ |
| 未选择商品 | disabled amount | 金额为 0 或不显示 |
| 下单成功 | success | 显示订单号 |
| 下单失败 | error | 显示后端错误信息 |
