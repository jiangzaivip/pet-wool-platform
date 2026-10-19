# WoolBuddy 上线前风险清单

> **状态（2026-10-19 更新）**：这是 2026-09-29 的只读审计快照，保留作为整改依据。其中已处置的条目：
> 默认管理员/Google demo 已关闭（scrypt 口令 + `GOOGLE_DEMO_LOGIN=false`）、后台登录加限流、
> `/doc/` 反射 XSS 已修、类型检查与门禁已全绿并接入 CI、历史非 KRW 异常订单已归档清理、
> 含密备份导出收紧为 owner 专用（默认导出脱敏）。
> 仍未处置：客户照片仍是无需授权的公开 URL、单条 JSONB 存储（未拆表）、viewer 前端按钮未按角色隐藏、
> 管理端未做服务端分页、webhook 无持久化重放/对账、systemd 以 root 运行。运维现状以 `OPERATIONS.md` 为准。

> 事实核对日期：2026-09-29。逐条对着 `api-node/server.mjs`、`scripts/production-check.mjs` 和实际 `store.json` 复核过；未复核的结论不要写进发布门禁。

## 一、当前门禁实际状态

`npm run production:check` 在本机（测试机 store）结果为 **4 个 FAIL、1 个 WARN**：

- 默认管理员凭据仍然有效
- `GOOGLE_DEMO_LOGIN` 不是 false
- PayPal 未处于 live 模式
- `PUBLIC_BASE_URL` 不是 HTTPS
- WARN：SMTP 订单通知未启用

存储后端由 `STORE_BACKEND=postgres` + `DATABASE_URL` 决定；两者未同时配置时使用 JSON。生产 `.env` 不在仓库内，**必须到生产机实际检查**，不能只读仓库推断线上用的是哪套。

## 二、代码级风险（上线前必须处理）

### 1. 后台"退款"不是 PayPal 退款

`applyManualPaymentStatus`（`api-node/server.mjs:4287`）在 `refunded` 时只把订单金额归零并写一条 `provider: manual` 的记录，不调用 PayPal Refund API，也不绑定 capture ID。后台会显示"已退款"而客户实际没收到钱。

二选一：实现真实 PayPal refund（保存 capture ID，支持部分退款、幂等、失败重试、结果回写），或把该操作改名为"登记线下退款"，不要用"退款成功"误导运营。

### 2. Google Demo 登录可冒用任意邮箱

`googleDemoLoginEnabled`（`api-node/server.mjs:106`）在未设 `GOOGLE_DEMO_LOGIN=false` 时默认开启，`/api/auth/google` 在没有 `id_token` 时接受请求体里的任意邮箱。这直接影响用户订单查看和后续支付。

生产应对 Demo 登录 fail closed：无 `id_token` 一律拒绝。若非 Google 登录确有需要，另做邮箱验证码或 magic link，不要复用 Demo 分支。

### 3. 客户照片是无授权公开 URL

上传无需登录，图片经 `/uploads/*` 直接读取。文件名含时间和随机 ID，但 URL 泄露即可访问；这与"照片属于客户订单资料"的业务预期不符。

上线前应改为私有 bucket + 短期签名 URL，或由 API 校验订单归属后代理，并把上传记录绑定到订单。

### 4. 类型检查失败，不能只以 Vite build 作为发布标准

`vue-tsc --noEmit` 当前失败，含 `string | number` 隐式转换、`findLastIndex` target 配置、`node_modules/vue-filepond` 与 `vue-i18n` 声明和当前 Vue/TS 版本不兼容等。根 `package.json` 没有任何 script 引用 vue-tsc，构建也不会暴露这些错误。

发布门禁应固定为 `npm run build` + `vue-tsc --noEmit` + E2E + `npm run production:check`，并把依赖从 `latest` 锁到确定版本。

### 5. systemd 以 root 运行

`install-systemd.sh` 生成的 unit 只设了 `ExecStart`，没有 `User=`，API、JSON 数据、上传目录和日志都可能由 root 持有。应建专用低权限用户，配置目录权限，并加 `NoNewPrivileges=true`、`PrivateTmp=true` 和明确的 `ReadWritePaths`。

## 三、运营与数据风险

- **数据量非空且含历史订单**：本机 `store.json` 有 14 商品 / 3 分类 / 216 订单 / 723 用户 / 213 支付 / 500 审计，订单状态为 `balance_due` 199、`confirmed` 10、`new` 7。上线前需逐条确认这些是真实业务还是测试产物，对真实订单重新核对金额、币种、已付金额和 capture ID。备份清场前数据。
- **PG 模式仍是单条 JSONB Store**：即使 `STORE_BACKEND=postgres`，`loadStore/saveStore` 读写的是 `platform_runtime_store` 表中的单条 JSONB 记录，不是 users/orders/payments 等领域表 + 索引 + 事务。存在并发写覆盖、全量读写、备份窗口变长的问题。小规模单实例试运营可接受并禁止横向扩容；要持续接单则需拆表迁移。存在导出脚本 ≠ 已完成数据库迁移。
- **管理员会话**：密码是直接 SHA-256 校验，无登录限流、失败锁定或 MFA；token 存浏览器 localStorage，服务端会话在进程内 Map，重启或多实例即失效。应改用 Argon2id/bcrypt，并迁到 HttpOnly Cookie 或可撤销的 refresh session。
- **viewer 角色只是后端拦截**：后端有 `owner/admin/viewer` 写权限判断，但管理端不按角色隐藏写按钮，viewer 会反复点到 403。应在登录响应中返回角色，前端统一用 `canWrite` 控制。
- **管理端一次性拉全量数据**：首次进入同时拉全量用户、商品、订单、审计日志，分页在浏览器端，全部客户 PII 下发到浏览器。应改为服务端分页、过滤和字段投影。
- **支付对账缺口**：webhook 无持久化重放和死信、无定时 PayPal 对账、未付款订单无过期归档策略。

## 四、消费者前端

- `frontend/src/views/Home.vue:25` 首屏图片仍为 Unsplash 外链，与"站内内容资产"约定不符；上线前换成自有授权资产并配 fallback。
- 游客下单失败或付款中断后无法安全恢复订单（不能把邮箱当身份凭证）。需要 magic link 或登录后继续付款。
- 法律页（隐私、条款、Cookie）内容主要来自前端 i18n，后台可编辑政策字段有限；上线前需业务/法务确认适用地区、退款、照片授权、跨境运输条款。
- 部分页面仍有硬编码文案（如 Home 的制作周期、定金说明、Docs 的中文），需逐页做 한국어/English/中文 切换检查。
- 移动端需重点验收：图片上传、PayPal 返回、长订单号、键盘弹起、错误提示、重复点击。
- `frontend/index.html` 初始 `lang` 固定为 `ko`；`robots.txt` 和 `sitemap.xml` 已就位，但 SEO 主要依赖挂载后的 JS。

## 五、建议发布顺序

1. 冻结生产配置：域名/TLS、管理员账号、Google、PayPal live、SMTP、备份位置、服务账号。
2. 修复上述 5 个代码级风险。
3. 备份并对现有 JSON 数据做测试隔离和订单/支付对账。
4. 用正式域名跑完整回归：三语言、移动端、登录、下单、上传、支付、webhook、尾款、取消、退款、角色、恢复。
5. 故障演练：PayPal 超时、webhook 重复/失败、SMTP 失败、磁盘不足、进程重启、备份恢复。
6. 单实例低流量先跑，重点监控支付状态、webhook、邮件和上传，稳定后再推进 PG 拆表与对象存储。

## 六、发布门禁

- [ ] `npm run build` 通过
- [ ] `vue-tsc --noEmit` 通过，依赖版本已锁定
- [ ] `npm run verify:core`、`npm run smoke`、`npm run test:currency`、`npm run test:admin` 全通过
- [ ] E2E 在独立测试数据上运行，不连接生产数据
- [ ] `npm run production:check` 零失败，SMTP 警告已按业务决定处理
- [ ] Google OAuth 真实登录通过，Demo 登录在生产不可用
- [ ] PayPal live 创建/捕获/webhook/尾款/退款均有真实结果记录，退款语义与实际收款一致
- [ ] 上传图片不再是公开无授权资源
- [ ] 默认凭据、测试账号和测试订单已清理
- [ ] 数据、上传、配置、日志均有备份，且完成过一次恢复演练
- [ ] systemd 使用专用低权限用户，反代已启用 HTTPS、限流和安全响应头

## 参考

`AGENTS.md`、`DEPLOY.md`、`docs/OPERATIONS.md`、`docs/COMPLETED_FEATURES_AND_ORDER_FLOW.md`、`scripts/production-check.mjs`、`api-node/server.mjs`、`install-systemd.sh`
