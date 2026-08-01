# 部署说明

## 1. 当前部署状态

当前服务器已部署临时可访问版本：

```text
http://36.138.248.23:8888/
```

服务组成：

- nginx：监听 `8888`，托管前端静态文件并反代 API。
- Node API：监听 `127.0.0.1:8082`，提供兼容接口。
- 数据文件：`/root/pet-wool-platform/api-node/data/store.json`。

## 2. systemd 服务

```bash
systemctl status pet-wool-api
systemctl status nginx
```

重启：

```bash
systemctl restart pet-wool-api
systemctl restart nginx
```

## 3. nginx 配置

站点配置：

```text
/etc/nginx/sites-available/pet-wool-platform
```

静态文件目录：

```text
/var/www/pet-wool-platform
```

## 4. 重新构建前端

```bash
cd /root/pet-wool-platform/frontend
npm install --include=dev
npm run build
cp -r dist/. /var/www/pet-wool-platform/
systemctl restart nginx
```

## 5. 生产化建议

- 使用 Rust + Axum 正式后端。
- 使用 PostgreSQL 正式数据库。
- 使用 HTTPS 和域名。
- 修改默认管理员密码。
- 使用强随机 `JWT_SECRET`。
- 使用 S3、Cloudflare R2 或阿里 OSS 存储宠物照片。
- 配置云安全组放行 `8888` 或正式端口。
