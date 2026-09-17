# Pet Wool Platform 部署说明

本文件是当前发布流程的唯一操作入口。旧的 nginx/Vite 运行方式只适用于历史
服务器，不要把旧文档中的手动复制和单独启动命令混用于当前发布。

## 1. 发布到生产

发布前准备一份不提交到 Git 的生产环境文件，例如
`/root/secure/pet-wool.production.env`。至少要配置：

- `NODE_ENV=production`
- `PUBLIC_BASE_URL=https://正式域名`
- 非默认的管理员账号和密钥
- `PAYPAL_MOCK=false`
- PayPal live Client ID、Secret、Webhook ID、模式和币种在管理后台配置

部署目标必须显式指定，避免把代码传到错误服务器：

```bash
DEPLOY_HOST=生产服务器地址 \
DEPLOY_USER=ubuntu \
DEPLOY_DIR=/opt/pet-wool-platform \
DEPLOY_KEY=/root/pet-wool-platform/.deploy/production_ed25519 \
DEPLOY_ENV_FILE=/root/secure/pet-wool.production.env \
DEPLOY_UPDATE_ENV=true \
bash deploy.sh
```

`deploy.sh` 会按 `frontend/package-lock.json` 安装前端依赖并构建，然后执行远端端口和数据检查、依赖安装、生产配置检查、
PayPal OAuth 凭据探测、systemd 重启、健康检查和 smoke check。新版本验证失败
会尝试恢复发布前备份。

默认必须重新构建前端。只有确认 `frontend/dist/` 已由已验证的源码构建生成，
且当前机器暂时无法安装依赖时，才可以显式使用 `DEPLOY_SKIP_BUILD=true`；该开关不会跳过远端生产检查。

正常更新代码时会保留远端 `.env` 和生产数据，不要设置
`DEPLOY_BOOTSTRAP_DATA=true`。只有全新服务器并且确认要安装本地数据快照时才允许：

```bash
DEPLOY_BOOTSTRAP_DATA=true
```

如果历史服务器仍由 nginx 在 `8888` 对外反代，明确使用旧拓扑：

```bash
DEPLOY_HOST=生产服务器地址 \
DEPLOY_DIR=/root/pet-wool-platform \
DEPLOY_SERVICE_NAME=pet-wool-api \
DEPLOY_SERVICE_HOST=127.0.0.1 \
DEPLOY_PORT=8082 \
DEPLOY_SERVE_FRONTEND=false \
bash deploy.sh
```

该模式要求 nginx 已经反代 `/api`、`/uploads` 和 `/health` 到
`127.0.0.1:8082`；不要让 Node 服务同时绑定 nginx 的 `8888`。

## 2. 发布检查

```bash
npm run production:check
npm run build
```

正式 PayPal 凭据探测只验证 OAuth，不创建订单、不扣款：

```bash
set -a
. /root/secure/pet-wool.production.env
set +a
PROJECT_ROOT_DIR=/opt/pet-wool-platform npm run production:paypal-check
```

## 3. 手动启动（仅维护）

解压完整发布包后：

```bash
cp .env.deploy.example .env
bash start.sh
```

生产服务建议使用 `deploy.sh` 安装的 systemd。`start.sh` 只适合维护和隔离检查。

## 4. 生产配置

环境变量模板见 `.env.deploy.example`。PayPal 账号配置只使用管理后台保存的站点配置，
`.env` 不再配置 PayPal 凭据、模式、Webhook 或币种。

关键配置：

- `PUBLIC_BASE_URL` 必须是正式 HTTPS 域名，PayPal 回跳地址使用它生成。
- `PAYPAL_MOCK=false`，PayPal 模式必须在管理后台设置为 `live`。
- 管理端的 Client ID、Secret、Webhook ID 必须来自同一个 live App。
- PayPal 后台 Webhook URL：`https://正式域名/api/paypal/webhook`。
- 管理端的 Webhook ID 填 ID，不要填 Webhook URL。

## 5. systemd 常驻运行

在部署目录内执行：

```bash
sudo bash install-systemd.sh
sudo systemctl status pet-wool-platform
sudo systemctl restart pet-wool-platform
sudo journalctl -u pet-wool-platform -f
```

## 6. 数据备份和恢复

```bash
node scripts/backup-data.mjs
node scripts/restore-data.mjs --dry-run api-node/backups/<备份目录名>
node scripts/restore-data.mjs --apply api-node/backups/<备份目录名>
```

备份包含完整 `store.json` 和上传文件，可能包含 PayPal Secret 或 Webhook ID，
必须按敏感文件保存。恢复脚本会在覆盖前自动创建恢复前备份。

## 7. nginx 可选反代

如果使用 HTTPS 域名反代到当前服务：

```nginx
server {
    listen 443 ssl;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

配置 nginx 后，`.env` 中的 `PUBLIC_BASE_URL` 必须保持为正式 HTTPS 域名。
