# Pet Wool Platform 工作空间

本目录只保留**与代码核对过的事实性文档**。设计期需求、模块方案和原型已删除——已实现的现状说明在仓库根目录 `README.md`、`AGENTS.md` 和 `docs/`；`site-doc/index.html` 是给客户看的概览页。

两者冲突时以根目录文档和 `api-node/server.mjs` 为准。

## 目录结构

```text
workspace/
  README.md
  docs/
    api-and-data-model.md   # API 路由与数据模型（按代码核对，2026-09-29）
    deployment-notes.md     # 早期 nginx 部署草稿（历史，当前见 DEPLOY.md）
```

## 项目定位

多语言（한국어 / English / 中文）羊毛毡宠物定制平台，两个端：

- 用户前端：品牌展示、商品浏览、定制流程、FAQ、宠物照片上传下单、PayPal 支付、订单追踪。
- 后端管理端：管理员登录、订单管理、商品与分类管理、用户管理、站点配置、审计日志。

## 访问地址

- 生产：`https://woolbuddy.shop`
- 测试机：`http://36.138.248.23:8888/`（管理端 `/admin`）
- 本机：`http://127.0.0.1:8888`

## 默认管理账号

- 邮箱：`admin@example.com`
- 密码：`admin123456`

上线前必须替换（`npm run production:check` 会 FAIL 拦截）。多管理员用 `ADMIN_ACCOUNTS_JSON`（角色 `owner` / `admin` / `viewer`，SHA-256 哈希）。

> 注：早期文档中提到的 `JWT_SECRET` 在当前代码中不存在；会话由 `ADMIN_SESSION_SECRET` 与进程内存储管理。数据库（`STORE_BACKEND=postgres`）为可选后端，对象存储仍未实现。
