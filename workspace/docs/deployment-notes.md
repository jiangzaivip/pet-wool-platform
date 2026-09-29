# 部署说明（历史文档）

> 本文件是设计期的临时部署草稿，**不是当前发布流程**。当前唯一发布入口是仓库根目录的 `DEPLOY.md`（`bash deploy.sh`）。这里保留仅为追溯早期 nginx 拓扑。

## 当时的部署状态

```text
http://36.138.248.23:8888/     # 测试机 / 早期服务器
```

当时的组成：

- nginx 监听 `8888`，托管前端静态文件并反代 API
- Node API 监听 `127.0.0.1:8082`
- 数据文件 `/root/pet-wool-platform/api-node/data/store.json`

## 与当前的差异

以下做法**已废弃**，不要照做：

- 把 `frontend/dist/` 复制到 `/var/www/pet-wool-platform/`
- 手工 `cp -r dist/. /var/www/...` 后重启 nginx 作为发布步骤

现在测试机上的 nginx `/` 直接反代 Vite 开发服务（`pet-wool-frontend-dev`，5173），改 `frontend/src` 免构建生效；生产则是 `deploy.sh` 发布的 Node 单体服务（systemd 单元 `pet-wool-platform`），前端静态与 API 同源，由 nginx 443 反代到 `127.0.0.1:8888`。

## 当前的系统服务名

```bash
systemctl status pet-wool-platform   # 生产
systemctl status pet-wool-api        # 测试机 API（8082）
systemctl status pet-wool-frontend-dev  # 测试机 Vite（5173）
```

## 早期建议中已实现的部分

- PostgreSQL 作为可选后端：`STORE_BACKEND=postgres` + `DATABASE_URL`
- HTTPS 与域名：生产已启用 `https://woolbuddy.shop`
- 修改默认管理员密码：已提供 `ADMIN_ACCOUNTS_JSON` 多账号方案，仍需在生产执行
- 对象存储：仍未实现，宠物照片存本地 `api-node/uploads/`
- Rust + Axum 后端：`backend/` 只是早期草稿，线上未使用

> 注：早期文档提到的 `JWT_SECRET` 变量在当前代码中不存在；管理员会话由 `ADMIN_SESSION_SECRET` 与进程内存储管理。
