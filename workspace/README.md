# Pet Wool Platform 工作空间

本目录用于沉淀项目设计文档、模块拆分和原型图，和可运行源码目录分离。

## 目录结构

```text
workspace/
  README.md
  docs/
    product-requirements.md
    module-design.md
    api-and-data-model.md
    deployment-notes.md
    client-website-issues-analysis.md
    admin-backend-implementation-plan.md
  prototypes/
    frontend/
      user-frontend-prototype.md
    admin-backend/
      admin-backend-prototype.md
```

## 项目定位

Pet Wool Platform 是一个多语言羊毛毡宠物定制平台，分为两个端：

- 用户前端：品牌展示、商品浏览、定制流程说明、FAQ、订单提交。
- 后端管理端：管理员登录、订单管理、商品管理、FAQ 管理、站点配置和运营数据查看。

当前线上临时部署访问地址：

- 用户前端：`http://36.138.248.23:8888/`
- 管理端入口：`http://36.138.248.23:8888/admin`

默认管理账号：

- 邮箱：`admin@example.com`
- 密码：`admin123456`

上线前必须修改默认账号、JWT 密钥、数据库密码，并接入正式数据库与对象存储。
