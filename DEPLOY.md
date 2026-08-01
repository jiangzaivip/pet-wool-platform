# Pet Wool Platform 部署说明

本部署包已经包含：

- 前端构建产物：`frontend/dist/`
- Node API 后端：`api-node/server.mjs`
- 当前业务数据：`api-node/data/store.json`
- 当前上传文件：`api-node/uploads/`
- 启动脚本：`start.sh`、`stop.sh`、`restart.sh`

目标机器只需要安装 Node.js 18 或更新版本。运行此部署包不需要执行 `npm install`，也不强制要求 nginx。

## 1. 解压并启动

```bash
tar -xzf pet-wool-platform-deploy-*.tar.gz
cd pet-wool-platform
bash start.sh
```

启动后访问：

```text
官网：http://服务器IP:8888/
管理端：http://服务器IP:8888/admin
健康检查：http://服务器IP:8888/health
```

默认管理端账号：

```text
Email：admin@example.com
Password：admin123456
```

上线前必须修改管理员密码和密钥。

## 2. 常用命令

```bash
bash start.sh
bash stop.sh
bash restart.sh
tail -f logs/pet-wool.log
bash scripts/smoke-check.sh
```

如果要换端口：

```bash
PORT=8899 bash start.sh
```

## 3. 生产配置

需要覆盖默认配置时复制环境变量模板：

```bash
cp .env.deploy.example .env
nano .env
bash restart.sh
```

重点配置项：

- `PUBLIC_BASE_URL`：正式访问地址，例如 `https://example.com`
- `ADMIN_PASSWORD_HASH`：管理员密码的 SHA-256 哈希
- `ADMIN_SESSION_SECRET`、`USER_TOKEN_SECRET`：长随机字符串
- `PAYPAL_CLIENT_ID`、`PAYPAL_SECRET`、`PAYPAL_WEBHOOK_ID`：正式 PayPal 配置
- `PAYPAL_MOCK=false`：正式收款时必须关闭 mock

生成 SHA-256 密码哈希示例：

```bash
node -e "const {createHash}=require('crypto'); console.log(createHash('sha256').update('你的新密码').digest('hex'))"
```

## 4. systemd 常驻运行

在部署目录内执行：

```bash
sudo bash install-systemd.sh
```

之后用 systemd 管理：

```bash
sudo systemctl status pet-wool-platform
sudo systemctl restart pet-wool-platform
sudo journalctl -u pet-wool-platform -f
```

## 5. 数据备份和恢复

备份当前运营数据：

```bash
node scripts/backup-data.mjs
```

恢复前先 dry-run 校验：

```bash
node scripts/restore-data.mjs --dry-run api-node/backups/<备份目录名>
```

确认后恢复：

```bash
node scripts/restore-data.mjs --apply api-node/backups/<备份目录名>
bash restart.sh
```

备份包含完整 `store.json` 和上传文件，可能包含 PayPal Secret 或 Webhook ID，按敏感文件保存。

## 6. nginx 可选反代

如果需要用域名和 HTTPS，可以让 nginx 反代到本服务：

```nginx
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:8888;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

配置 nginx 后，`.env` 里把 `PUBLIC_BASE_URL` 改成正式域名。
