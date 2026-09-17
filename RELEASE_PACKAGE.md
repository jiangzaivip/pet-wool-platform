# WoolBuddy 发布包

这是一个不包含密钥和生产数据的可运行发布包。包内已经包含前端生产构建和
Node API 程序，适合复制到另一台 Linux 服务器后安装。

## 1. 解压

```bash
sudo mkdir -p /opt/pet-wool-platform
sudo tar -xzf pet-wool-platform-release.tar.gz -C /opt/pet-wool-platform
cd /opt/pet-wool-platform
```

## 2. 准备环境变量

```bash
sudo cp .env.deploy.example .env
sudo chmod 600 .env
sudo nano .env
```

生产环境至少配置：

```env
NODE_ENV=production
PUBLIC_BASE_URL=https://正式域名
ADMIN_EMAIL=后台管理员邮箱
ADMIN_PASSWORD_HASH=非默认密码的SHA256
ADMIN_SESSION_SECRET=随机长密钥
USER_TOKEN_SECRET=随机长密钥

GOOGLE_CLIENT_ID=Google Web Client ID
GOOGLE_CLIENT_IDS=Google Web Client ID
GOOGLE_DEMO_LOGIN=false

PAYPAL_MOCK=false
PAYPAL_TIMEOUT_MS=15000
```

`GOOGLE_CLIENT_SECRET` 当前程序不读取，也不需要放入配置。

PayPal 的启用状态、模式、Client ID、Secret、Webhook ID 和币种全部在管理端的
PayPal 配置页维护，`.env` 不再提供这些配置。生产切换 Live 凭据后，在管理端保存
即可生效；如果修改了服务器运行参数，才需要重启服务。

## 3. 准备数据

本包不包含 `api-node/data/store.json` 和 `api-node/uploads/`。

如果是替换已有服务器，请从原服务器安全复制这两个目录；如果是新环境，
需要准备初始 `store.json`，不能直接让生产服务启动空数据。

## 4. 安装运行

```bash
sudo npm ci --omit=dev --ignore-scripts
sudo env PROJECT_ROOT_DIR=/opt/pet-wool-platform NODE_ENV=production node scripts/production-check.mjs
sudo bash install-systemd.sh
sudo systemctl status pet-wool-platform --no-pager
```

服务默认监听 `0.0.0.0:8888`。如果 nginx 已占用 8888，可在 `.env` 设置：

```env
PORT=8082
SERVE_FRONTEND=false
```

然后用 nginx 将 `/api/`、`/uploads/` 和 `/health` 反代到 `127.0.0.1:8082`。

## 5. 验证

```bash
curl -fsS http://127.0.0.1:8888/health
curl -fsS http://127.0.0.1:8888/api/site
sudo bash scripts/smoke-check.sh
```

Google 登录配置正确时，`/api/site` 中的 `google` 应显示真实
`client_id`、`auth_mode: "google"` 和 `demo_enabled: false`。

## 6. 安全要求

- 不要把 `.env`、`store.json`、`uploads/`、备份和日志发到公开位置。
- 不要把 Google Client Secret 或 PayPal Secret 放进前端。
- 更新前先运行 `node scripts/backup-data.mjs`。
- 修改 `.env` 后必须重启 `pet-wool-api` 或 `pet-wool-platform` 服务。
