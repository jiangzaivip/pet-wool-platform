# 项目初始化与目录说明

## 当前项目定位

`pet-wool-platform` 是一个宠物羊毛毡定制电商站，包含：

- 前台官网：商品、分类、博客、支持政策、下单、用户订单
- 管理端：`/admin` 登录，管理商品、分类、订单、站点配置、主题配色
- API 服务：Node.js 原生 HTTP 服务，负责数据、订单、上传、PayPal 模拟、机器人问答
- 自动化测试：Playwright 全流程测试
- 客户文档和原型：`site-doc/`

## 标准目录

```text
pet-wool-platform/
  api-node/                 当前线上 API 服务
    server.mjs              API 入口
    data/store.json         当前 JSON 数据库
    uploads/                用户上传图片

  frontend/                 Vue 3 前端项目
    src/                    页面、路由、样式、API 封装
    dist/                   前端构建产物
    package.json            前端构建命令

  docs/                     项目维护文档
    PROJECT_INIT.md         初始化和目录说明
    SYSTEM_SETTINGS.md      系统配置说明

  scripts/                  常用维护脚本
    smoke-check.sh          服务和接口快速检查

  site-doc/                 给客户看的文档和原型入口
    index.html
    prototype/

  test-results/             自动化测试脚本、报告、截图
    e2e-check.mjs
    E2E_TEST_PLAN.md
    report.json
    *.png

  backend/                  早期 Rust 后端草稿，当前线上未使用
  docker-compose.yml        早期 Postgres 配置，当前线上未依赖
  README.md                 项目总说明
```

## 当前线上运行方式

当前部署方式：

- nginx 对外监听：`http://36.138.248.23:8888`
- 前端服务：`pet-wool-frontend-dev`，Vite 监听 `127.0.0.1:5173`
- API 服务：`pet-wool-api`
- API 监听：`127.0.0.1:8082`
- nginx 代理：
  - `/` -> `127.0.0.1:5173`
  - `/api/` -> `127.0.0.1:8082/api/`
  - `/uploads/` -> `127.0.0.1:8082/uploads/`
  - `/health` -> `127.0.0.1:8082/health`

8888 前端入口由 nginx 补充 `X-Content-Type-Options`、`X-Frame-Options` 和 `Referrer-Policy` 安全响应头；API 自身返回安全头，nginx 不重复覆盖 `/api` 和 `/uploads`。

## 初始化本地依赖

```bash
cd /root/pet-wool-platform
npm install
cd frontend
npm install
```

说明：

- 根目录 `npm install` 主要安装 Playwright。
- `frontend/npm install` 安装 Vue/Vite 依赖。
- `api-node` 使用 Node.js 内置模块，不需要单独安装依赖。

## 构建前端

```bash
cd /root/pet-wool-platform/frontend
npm run build
```

构建产物输出到：

```text
frontend/dist/
```

## 更新 8888 前端

```bash
cd /root/pet-wool-platform/frontend
npm run build
systemctl restart pet-wool-frontend-dev
```

当前 8888 直接反代到 Vite 前端服务，不再复制 `frontend/dist/` 到 `/var/www/pet-wool-platform/`。

## 重启 API

```bash
systemctl restart pet-wool-api
```

## 快速检查

```bash
cd /root/pet-wool-platform
bash scripts/smoke-check.sh
```

`scripts/smoke-check.sh` 会检查 8888 页面、前端安全响应头、API 健康和基础接口。

## 自动化测试

```bash
cd /root/pet-wool-platform
node test-results/e2e-check.mjs
```

测试说明见：

```text
test-results/E2E_TEST_PLAN.md
```

## 管理端入口

- 地址：`http://36.138.248.23:8888/admin`
- 默认邮箱：`admin@example.com`
- 默认密码：`admin123456`

上线前必须替换管理员账号和密码哈希。

## 重要数据

当前数据保存在：

```text
api-node/data/store.json
```

它包含：

- 分类和子分类
- 商品和价格选项
- 订单
- PayPal 模拟支付记录
- 站点配置
- 主题配色
- FAQ / 政策 / 博客 / 评价 / 社媒链接 / 机器人知识库

上线前建议接入真实数据库，至少定期备份 `store.json` 和 `uploads/`。
