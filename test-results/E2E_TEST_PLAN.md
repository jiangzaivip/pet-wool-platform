# Pet Wool Platform 自动化测试说明

## 目的

本文件记录当前 Playwright 全流程回归测试范围。后续新增功能、修复问题、上线前回归，都按这里的清单维护测试脚本。

## 测试脚本

- 脚本路径：`test-results/e2e-check.mjs`
- 结果报告：`test-results/report.json`
- 截图目录：`test-results/*.png`
- 默认测试地址：`http://127.0.0.1:8888`

执行命令：

```bash
node test-results/e2e-check.mjs
```

如果 Chromium 在受限环境里无法启动，需要在允许浏览器沙箱运行的环境中执行。

## 前置条件

- nginx 已监听 `8888`
- 前端服务 `pet-wool-frontend-dev` 已启动，8888 反代到 Vite 前端服务
- API 服务 `pet-wool-api` 已启动，8888 代理 `/api`、`/uploads` 和 `/health`
- 管理员账号可登录：
  - Email：`admin@example.com`
  - Password：`admin123456`

## 当前覆盖范围

`e2e-check.mjs` 当前是商业化交付回归脚本，最近稳定通过规模为 870+ 项断言。覆盖范围按模块维护，不再只覆盖早期 25 项冒烟用例。

| 模块 | 覆盖重点 |
| --- | --- |
| 服务健康和安全头 | 8888 页面、文档站、API health、安全响应头、缓存控制、内部路径不泄露 |
| 前台官网 | 首页、分类/子分类、商品列表、商品详情、博客、支持页、404/noindex、SEO head、移动端溢出 |
| 主题和文案 | 管理端主题配置、前台平铺色板、中文管理端文案、多语言回退防混用 |
| 上传和下单 | 图片类型/大小/签名校验、订单字段校验、重复提交幂等、隐藏/异常商品保护 |
| PayPal 流程 | 创建支付单、捕获支付、定金/尾款、禁用支付恢复、支付响应字段脱敏 |
| 我的订单 | 登录、订单归属、支付继续处理、物流追踪、客户可见进度、客服上下文 |
| 管理端用户 | 新增/编辑/删除、跟进记录、导出、分页、系统账号保护、移动端弹窗 |
| 管理端商品和分类 | 新增/编辑/删除、发布保护、SEO/Alt/图集、隐藏分类和引用保护 |
| 管理端订单 | 筛选、详情、备注并发保护、状态/付款流转、异常标记、支付记录、物流事件 |
| 站点配置 | 品牌、联系方式、政策、FAQ、评价、博客、PayPal 配置、备份恢复、主题配置 |
| 数据安全和运维 | 脱敏备份、完整密钥备份确认头、恢复 dry-run、上传引用清理、E2E 数据清理 |
| API 边界 | 认证、权限、公开字段白名单、输入长度、异常脱敏、no-store 缓存策略 |

## 生成截图

脚本会生成或覆盖以下截图：

- `home.png`
- `collections.png`
- `support.png`
- `mobile-home.png`
- `mobile-collections.png`
- `mobile-support.png`
- `blog-detail.png`
- `mobile-blog-detail.png`
- `product-detail.png`
- `mobile-product-detail.png`
- `order-paid.png`
- `mobile-order.png`
- `account.png`
- `mobile-account.png`
- `mobile-admin.png`
- `mobile-admin-users.png`
- `mobile-admin-orders.png`
- `mobile-admin-site.png`
- `admin-order-detail.png`
- `mobile-admin-order-detail.png`
- `admin-theme-config.png`
- `failure.png`，仅失败时用于排查

## 维护规则

- 新增前台页面时，至少增加一个“页面可访问 + 核心内容可见”的断言。
- 新增支付、订单、登录、上传、管理端配置等关键流程时，必须加入完整操作断言。
- 修改文案时，要同步更新脚本中的 `text=` 或 role/name 选择器。
- 尽量使用用户可见文本、按钮名称、表单 label 做选择器，减少对 CSS 结构的依赖。
- 每次部署后执行一次 `node test-results/e2e-check.mjs`，通过后再交付。

## 失败排查

1. 查看终端输出中 `status: "fail"` 的测试项。
2. 打开 `test-results/failure.png` 查看失败时页面状态。
3. 确认 nginx、`pet-wool-frontend-dev`、`pet-wool-api` 是否正在运行，并已按本次修改重启。
4. 如果是文案变更导致定位失败，更新 `e2e-check.mjs` 里的对应断言。
5. 如果是业务流程失败，先在浏览器手动复现，再修页面或接口。
