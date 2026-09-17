# WoolBuddy 上线前完善分析

> 评审日期：2026-09-07  
> 评审范围：消费者前端、管理端、Node API、支付、数据、部署与运维  
> 结论：当前功能已经接近 MVP 完成，但还不具备直接承接真实订单的上线条件。

## 一、结论摘要

项目目前是 Vue 3/Vite 前端 + Node 原生 HTTP API。仓库默认配置使用 JSON 文件，但如果生产 `.env` 设置了 `STORE_BACKEND=postgres` 和有效的 `DATABASE_URL`，Node API 会使用 PostgreSQL 作为权威数据源；本地 `store.json` 仍会作为 shadow/recovery 文件写入。Rust/Docker 相关内容不是当前 Node 部署链路，不能按“已经完成规范化数据库迁移”来验收。

### 关于生产 PostgreSQL 的确认

从仓库代码可以确认“支持并能够启用 PG”，不能仅凭仓库确认“线上当前已经启用 PG”，因为 `STORE_BACKEND` 和 `DATABASE_URL` 位于生产机 `.env`。服务启动时的判断是：

```text
STORE_BACKEND=postgres + DATABASE_URL -> 读取/写入 platform_runtime_store
其他情况或未配置 -> 读取/写入 api-node/data/store.json
```

生产机需要实际检查 `.env` 和 `platform_runtime_store` 表，不能只看 `backend/src/main.rs` 或 `.env.deploy.example`。`.env.deploy.example` 的默认值仍是 `STORE_BACKEND=json`。

当前最重要的判断如下：

| 等级 | 判断 | 说明 |
| --- | --- | --- |
| P0 | 阻断上线 | 生产配置检查未通过、Google Demo 登录存在身份冒用风险、前端类型检查失败、退款按钮可能只改本地状态、用户照片是公开 URL |
| P1 | 上线前应完成 | 管理员认证和会话、数据存储可靠性、支付对账、备份恢复、部署权限、限流监控、管理端数据加载方式 |
| P2 | 首个版本后优化 | SEO/首屏性能、完整多语言覆盖、无障碍、后台 CMS 体验、图片与内容资产治理 |

### 已执行验证

- `npm run build`：通过；但产物存在约 760 kB 的 JS 主包和约 137 kB 的 CSS。
- `node --check api-node/server.mjs`：通过。
- `./node_modules/.bin/vue-tsc --noEmit`：失败，存在依赖类型错误、重复 i18n key、模板类型错误和若干 `string | number` 类型错误。
- `npm run production:check`：当前工作区结果为 **3 个失败、1 个警告**：默认管理员凭据仍有效、`GOOGLE_DEMO_LOGIN` 不是 false、`PUBLIC_BASE_URL` 不是 HTTPS；SMTP 订单通知未启用。
- 当前本地 `store.json` 数据统计：14 个商品、3 个分类、212 个订单、720 个用户、212 条支付记录、10 条审计日志；订单中有 199 条 `balance_due`、3 条 `new`。这不是生产数据统计，生产环境需要从实际 PG/运行接口重新核对，并确认是否包含测试或历史数据。

## 二、P0：上线前必须解决

### P0-1 生产配置门禁没有闭环

当前生产检查已经明确失败。上线环境至少需要：

- 修改默认管理员邮箱和密码，并确认部署环境中不存在默认密码回退。
- `GOOGLE_DEMO_LOGIN=false`，配置真实 Google OAuth Client ID，并验证真实 ID token。
- 使用正式域名和 HTTPS，`PUBLIC_BASE_URL` 必须是 HTTPS 且与 PayPal 回调配置一致。
- PayPal 使用 live 模式、正式 client/secret/webhook ID，并完成一笔低金额真实支付、捕获、回调和退款演练。
- 明确 SMTP 是否是业务承诺的一部分；如果下单确认、付款提醒、发货通知依赖邮件，必须启用并验证送达。

相关位置：`.env.deploy.example`、`scripts/production-check.mjs`、`api-node/server.mjs:3401`。

### P0-2 Google Demo 登录可以冒用任意邮箱

`api-node/server.mjs:81` 的逻辑在未设置 `GOOGLE_DEMO_LOGIN=false` 时默认开启 Demo 登录。`/api/auth/google` 在没有 `id_token` 时，会接受请求体中的任意邮箱并创建 `google-demo` 用户（`api-node/server.mjs:3913`）。这会影响用户订单查看和后续支付流程，不能带着默认配置上线。

建议修复：

1. 生产环境对 Demo 登录 fail closed：未明确配置为 false 时直接拒绝启动。
2. 生产环境无 `id_token` 必须拒绝，不再接受 `email/name` 作为登录凭证。
3. `assertProductionRuntime` 增加 Google 配置校验，而不是只检查 PayPal 和 HTTPS。
4. 如果需要非 Google 登录，另行实现邮箱验证码或 magic link，不要复用 Demo 分支。

### P0-3 类型检查失败，不能只以 Vite build 作为发布标准

当前 `vue-tsc` 失败点包括：

- `frontend/src/i18n.ts:2551`：同一语言对象存在重复 `trustItems` key。
- `frontend/src/views/Account.vue:954`、`:955`：模板索引被推断为 `string | number`。
- `frontend/src/views/AdminDashboard.vue:765`、`:1041` 等：隐式 `any`、`findLastIndex` 的 target 配置和多个 `string | number` 类型错误。
- `node_modules/vue-filepond`、`vue-i18n` 的声明与当前 Vue/TypeScript 版本不兼容。

发布门禁应固定为：`build + vue-tsc --noEmit + E2E + production:check` 全部通过。建议补充 root `typecheck` script，锁定前端依赖版本，避免继续使用 `latest`（`frontend/package.json:13-22`）。

### P0-4 管理端“退款”目前不是 PayPal 退款

`applyManualPaymentStatus` 在设置 `refunded` 时只会把本地订单金额归零，并新增一条 `provider: manual` 的退款记录（`api-node/server.mjs:3753`）。没有调用 PayPal Refund API，也没有绑定 capture ID。这会造成“后台显示已退款但客户没有收到钱”的严重账务问题。

二选一：

- 上线前实现真实 PayPal refund：保存 capture ID，支持全额/部分退款、幂等、失败重试和结果回写；或
- 暂时把该操作改名为“登记线下退款/登记退款结果”，禁止用“退款成功”误导运营人员。

同时补充支付对账：PayPal 已付款但本地回调失败、重复 webhook、退款失败、争议/拒付都应有可查询状态和告警。

### P0-5 客户上传照片不能继续使用无授权公开 URL

上传接口无需客户登录（`api-node/server.mjs:3872`），图片通过 `/uploads/*` 直接读取（`api-node/server.mjs:3865`）。文件名虽然包含时间和随机 ID，但 URL 一旦泄露即可访问。代码注释和业务预期将照片视为客户订单资料，因此不应只依赖“难以猜测文件名”。

上线前应完成以下之一：

- 使用对象存储的私有 bucket + 短期签名 URL；或
- 由 API 提供校验订单归属的图片代理，管理员和对应客户才可访问。

还需绑定上传记录与订单、清理放弃下单产生的孤儿文件，并对下载进行访问日志记录。

### P0-6 上线数据必须进行业务级清场和对账

当前数据不是空的，且有 212 条订单、720 个用户、199 条 `balance_due`。上线前必须逐条确认这些数据是正式历史业务还是测试/E2E 产物：

- 删除或隔离所有测试用户、测试订单、测试支付记录和测试上传文件。
- 对真实订单重新核对订单金额、币种、已付金额、PayPal capture ID 和订单状态。
- 确认产品的 `hidden` 状态、价格、定金比例、分类和多语言内容。
- 备份清场前数据，记录数据版本和恢复方法；不要直接在生产库上凭感觉删除。

## 三、P1：上线前应补齐

### 1. 管理员账号和会话安全

当前管理员密码是直接 SHA-256 校验（`api-node/server.mjs:4473`），没有看到登录限流、失败锁定、MFA 或密码升级机制。管理员 token 存在浏览器 `localStorage`，服务端会话存在进程内 Map；服务重启、扩容或多实例时会失效或不一致。

建议：

- 使用 Argon2id、scrypt 或 bcrypt 存储密码，并支持旧密码平滑升级。
- 管理员登录增加 IP/账号维度限流、失败次数锁定、审计和 MFA。
- 使用 HttpOnly、Secure、SameSite Cookie 或短时 access token + 可撤销 refresh session，避免长期 token 暴露在 localStorage。
- 会话存 Redis/数据库，支持主动撤销、密钥轮换和多实例部署。
- 管理员列表、审计日志、备份下载、支付配置读取均按最小权限隔离。

### 2. 角色权限要做到“后端阻断 + 前端可理解”

后端已有 `owner/admin/viewer` 的写权限判断（`api-node/server.mjs:2290-2307`），但管理端登录只保存 token（`frontend/src/views/AdminLogin.vue:18-26`），看不到基于角色隐藏或禁用写操作的界面。只读账号可能仍看到保存、删除、改状态按钮，点击后反复得到 403。

建议返回当前管理员角色并在前端统一使用 `canWrite`：

- viewer 只显示查询、导出和必要详情。
- 支付密钥、管理员账号、备份恢复只允许 owner。
- 高风险操作必须二次确认，并显示操作者、影响范围和不可逆性。
- 审计日志记录前后值、订单/商品 ID、IP、request ID 和失败原因。

### 3. PostgreSQL 模式目前仍是“单条 JSONB Store”，不是完整数据库化

如果生产没有设置 `STORE_BACKEND=postgres`，当前每次保存会把整个 store 序列化到临时文件再替换（`api-node/server.mjs:1173-1190`）。如果已经设置 PG，`loadStore/saveStore` 会读写 `platform_runtime_store` 表中的单条 JSONB 记录（`api-node/server.mjs:192-204`、`1154-1190`），同时仍写本地 `store.json` shadow 文件。这说明“生产使用 PG”本身没有问题，但当前仍不是订单、用户、支付、审计等领域表的完整迁移。

单条 JSONB Store 仍有以下风险：并发写覆盖、全量读写、进程异常恢复复杂、查询无法有效使用领域索引、多实例写入协调和备份窗口变长。

上线决策应明确：

- 如果只是小规模、单实例、短期试运营：固定单实例，禁止横向扩容，增加文件锁、磁盘空间告警、原子备份、每日 offsite 备份和定期恢复演练。
- 如果要持续接真实订单：尽快迁移 PostgreSQL，至少拆出 users/orders/order_events/payments/products/site/audit_logs，增加索引、事务、唯一约束和迁移脚本；商品图片迁移对象存储。

不要把“存在 Postgres 导出脚本”当成已经完成数据库迁移。

### 4. 订单和支付运营闭环

现有下单、PayPal 创建/捕获、webhook 和手工状态能力较完整，但上线运营还缺：

- webhook 事件持久化、幂等键、失败重试、死信列表和人工重放。
- 定时 PayPal 对账任务，发现本地和 PayPal 状态不一致时告警。
- 未付款订单的过期、取消、提醒和归档策略，避免 `new/balance_due` 无限增长。
- 生产制作节点、补款、发货、完成、取消、退款、拒付的明确状态机和操作权限。
- 通知 outbox：邮件发送失败不能只写日志，应有重试和人工重发。
- 订单金额、币种、定金、补款金额的不可变快照，避免商品配置修改后影响历史订单。

### 5. 管理端查询和数据规模

`AdminDashboard.vue:2298-2324` 首次进入会同时拉取全量用户、商品、订单、审计日志；搜索和分页主要发生在浏览器端。现在数据量尚可，但这会把全部客户 PII 发送到浏览器，并且会随着订单增长明显变慢。

建议改为服务端分页、过滤、排序和字段投影：

- 订单：按状态、付款状态、时间、邮箱/订单号、制作阶段查询。
- 用户：按邮箱、状态、注册时间分页，不默认返回内部备注和全部历史信息。
- 审计：按 actor、资源、动作、时间范围查询，支持 request ID。
- 导出：服务端异步生成、权限校验、短期下载链接和下载审计。
- 增加批量操作前的数量上限、预览和失败明细。

### 6. 部署、权限和基础设施

`install-systemd.sh:27-46` 生成的 systemd 服务没有 `User=`，默认可能以 root 运行；API、JSON 数据、本地上传和日志因此都可能由 root 持有。应创建专用低权限用户，配置目录权限，并加入 `NoNewPrivileges=true`、`PrivateTmp=true`、资源限制和明确的 `ReadWritePaths`。

还需要完成：

- 正式域名、DNS、TLS 自动续期、反向代理和 HSTS。
- 代理层请求体大小、请求超时、连接数和基础限流；当前应用层主要覆盖上传和订单查询，管理员登录等关键接口仍需保护。
- `/health` 之外增加 `/ready`，检查数据目录、数据库/文件存储、PayPal、对象存储和 SMTP 的可用性。
- 进程、CPU、内存、磁盘、上传目录、webhook 失败、邮件失败和 5xx 告警。
- 日志轮转、保留周期、脱敏和集中收集；备份加密并存放到异地。
- 检查并清理发布包中的 `api-node/data/*.tmp`、E2E 产物和测试上传文件；临时文件不应被当成数据源。
- 统一生产架构文档。`README.md` 中的旧 IP/HTTP/代理拓扑与 `DEPLOY.md` 的当前 Node 8888 单体服务描述存在差异，应保留一套可执行方案。

## 四、消费者前端还需要完善的部分

### P1 级

- 真实登录闭环：关闭 Demo 后，必须验证 Google OAuth 在移动端、失败回调、账号已存在、账号被禁用、网络失败等状态；没有 Google 的用户需要明确的备用找回方式。
- 订单恢复：游客下单失败或付款中断后，用户只能看到有限的查询结果；需要安全的订单 magic link 或登录后继续付款，不能把邮箱当成身份凭证。
- 法律页面：`Legal.vue` 的隐私、条款、Cookie 等内容主要来自前端 i18n，后台当前可编辑的政策字段有限。上线前由业务/法律确认适用地区、退款说明、照片授权、付款和跨境运输条款，并保存版本、发布日期和语言版本。
- 内容多语言：`Home.vue` 中仍有硬编码英文 caption、制作周期和定金文案，`Docs.vue` 也有硬编码中文。逐页切换 한국어/English/中文检查，不仅检查导航翻译，还要检查产品、FAQ、政策、错误提示和支付文案。
- 客户照片和作品展示：确认每张作品图的客户授权、公开范围、删除流程和 CDN 缓存失效策略。
- 移动端验收：重点检查图片上传、PayPal 返回、键盘弹起、长订单号、错误提示、网络断开和重复点击。

### P2 级

- `frontend/src/views/Home.vue:24` 仍使用 Unsplash 外链作为首屏图片，与“本地内容资产”的文档约定不一致；上线应使用已授权、可控缓存和有 fallback 的自有资产。
- `frontend/index.html:2-6` 初始 `lang` 固定为 `ko`，静态 title/description/OG 信息不足；当前 SEO 主要依赖挂载后的 JS，建议增加预渲染/SSR 或至少验证搜索引擎和社交分享抓取结果，并补 sitemap、robots、canonical。
- 首屏构建产物偏大。管理端、PayPal SDK、富文本编辑器和非首屏页面应懒加载；图片使用 WebP/AVIF、响应式尺寸和明确的 CDN 缓存策略。
- 管理端和前端的弹窗都应补焦点进入、焦点恢复、Esc 关闭、滚动锁定、可读标题和错误关联；目前只有部分弹窗声明了 dialog，未形成统一可访问性实现。
- 前端错误需要区分网络失败、权限失败、支付失败和业务校验失败，给出可执行的下一步，而不是统一显示加载失败。

## 五、管理端还需要完善的部分

### 业务能力

- 退款必须区分“真实 PayPal 退款”和“线下登记”；支持 capture 关联、部分退款、失败重试和对账。
- 增加制作阶段和客户沟通历史，不能只依赖订单备注和状态字段。
- 增加邮件/通知发送记录、失败原因、重发和模板预览。
- 增加未付款、待补款、待确认、制作中、待发货、已完成、退款/拒付等运营视图及超时提醒。
- 商品发布前检查价格、币种、定金比例、图片、描述、分类和三语内容；发布后需要预览和回滚。
- FAQ、政策、首页模块和博客内容建议使用结构化表单、草稿/发布、版本记录和预览，不要长期依赖大段 textarea 与旧的分隔符格式。

### 工程和体验

- 所有列表改成服务端分页，避免一次性加载全量 PII。
- viewer 角色隐藏写入控件；owner 高风险设置单独二次认证。
- 弹窗、表格、上传、导出和批量操作统一 loading/empty/error/success 状态。
- 操作成功后刷新相关资源并保留筛选条件；失败时显示后端 request ID，方便客服报障。
- 后台当前是一个包含多个 tab 的大页面，建议第一阶段保留现有功能，但按“订单、商品、客户、内容、支付、系统”拆分路由和权限边界，降低每次加载和维护成本。

## 六、建议的发布顺序

1. 先冻结生产配置：域名/TLS、管理员账号、Google、PayPal live、SMTP、备份位置和服务账号。
2. 修复 Google Demo、类型检查、退款语义、上传隐私这四个代码级 P0。
3. 对现有 JSON 数据做备份、测试数据隔离、订单/支付逐条对账。
4. 用正式域名跑完整回归：三语言、移动端、注册/登录、下单、上传、支付、webhook、补款、取消、退款、管理员角色和恢复订单。
5. 做一次故障演练：PayPal 超时、webhook 重复/失败、SMTP 失败、磁盘不足、进程重启、备份恢复。
6. 上线先单实例、低流量观察，重点监控支付状态、webhook、邮件和上传；确认稳定后再推进 PostgreSQL 和对象存储迁移。
7. 发布后优先完成数据库化、对象存储、服务端分页和运营通知闭环。

## 七、最终发布门禁

- [ ] `npm run build` 通过
- [ ] `vue-tsc --noEmit` 通过，且依赖版本已锁定
- [ ] E2E 在独立测试数据和测试域名运行，不连接生产数据
- [ ] `npm run production:check` 零失败；SMTP 警告已按业务决定处理
- [ ] 真实 Google OAuth 登录通过，Demo 登录在生产不可用
- [ ] PayPal live 创建、捕获、webhook、补款和退款均有真实结果记录
- [ ] 退款语义与客户实际收款一致
- [ ] 上传图片不是公开无授权资源，且有订单归属校验
- [ ] 默认管理员凭据、示例 secret、测试账号和测试订单已清理
- [ ] 数据、上传文件、配置和日志均有备份；至少完成一次恢复演练
- [ ] systemd 使用专用低权限用户，反向代理已启用 HTTPS、限流和安全响应头
- [ ] 有磁盘、进程、5xx、支付、webhook、邮件和备份失败告警
- [ ] 业务负责人确认价格、币种、定金、退款、运输、照片授权和法律文本

## 参考文件

- `README.md`
- `DEPLOY.md`
- `docs/OPERATIONS.md`
- `docs/FUNCTION_COMPLETION_ANALYSIS.md`
- `docs/COMPLETED_FEATURES_AND_ORDER_FLOW.md`
- `test-results/E2E_TEST_PLAN.md`
- `api-node/server.mjs`
- `frontend/src/views/AdminDashboard.vue`
- `frontend/src/views/AdminLogin.vue`
- `frontend/src/views/Home.vue`
- `scripts/production-check.mjs`
- `install-systemd.sh`
