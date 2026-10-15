# Ethereum Monitor 发布与回滚操作规范

## 不可跳过的安全边界

本文件是发布计划，不代表已获准发布。禁止直接用手工拼接代码向生产 Worker 执行 PUT，也禁止未经确认在生产 D1 执行迁移。

**当前状态：** `stabilization/2026-10-15-p0` 为测试分支；`main` 与 `ethereum-usdt-monitor` 生产服务未获本项目授权修改。

## 预发布安全检查

- 单独阅读 [独立预发布环境手册](ISOLATED_STAGING.md)，使用 `wrangler.staging.example.jsonc` 生成本地专属配置，不能直接用默认 `wrangler.jsonc` 发布到预发布。
- 运行 `node scripts/verify-staging-config.mjs wrangler.staging.jsonc` 核验独立 Worker 名、全新 D1 UUID、Queue/DLQ 与 HTTPS 回调 URL；禁用 Cron、禁止提交真实凭证。
- 配置校验和 GitHub CI 成功**不表示已部署**。目前仍未创建 Cloudflare 预发布 Worker、D1 或 Queue。

## 1. 发布前检查

- [ ] 确定 PR #1 最新 head SHA，所有 CI、Smoke Test、`npm run bundle:verify` 均为 green。
- [ ] 从该精确 SHA 创建构建产物并记录 SHA-256，绝不使用未经过验证的本地文件。
- [ ] 核对现有生产 Worker 部署版本、所有绑定名称、Cron、D1 ID 和 Queue，保存只读快照。
- [ ] 验证生产环境所有事件监控、webhook 和 Token 配置，不将敏感字段打印到日志、CI 或仓库。
- [ ] 在**隔离 D1** 上恢复与生产同版本的**脱敏结构及测试数据**，按 Wrangler 标准顺序应用新增迁移：
  - `20261015_outbox_sending_lease.sql`
  - `20261015_subscription_sources.sql`
  - `20261015_outbox_pagination_index.sql`
  - `20261016_spender_generation_fence.sql`（必须在 `20261015_spender_history.sql` 和 `20261015_spender_history_times.sql` 之后执行）
  - `20261017_admin_list_indexes.sql`（钱包、群组订阅及链上交易分页索引）
- [ ] 使用实际 D1 `PRAGMA table_info`、`PRAGMA foreign_key_check`、`SELECT count(*)` 检查迁移结果。
- [ ] 运行 `tests/in-place-upgrade-rehearsal.test.mjs`：基于旧架构的非空模拟 D1，升级后比较监控、旧订阅、通知队列、审计和 Spender 断点；验证索引和外键。
- [ ] 运行 `tests/admin-listing.test.mjs`：验证超过 200 条的钱包、订阅、链上交易和审计记录可分页/搜索，保留旧数据。
- [ ] 运行 `tests/full-worker-preflight.test.mjs`：直接启动构建后的完整 Worker（隔离 Miniflare + D1），验证真实请求路由、管理员会话、CSRF、接口分页、统一备注写入、审计记录。**仅使用模拟数据及测试会话，不访问生产服务**。
- [ ] 运行 `tests/admin-ui-remark-save.test.mjs`：确认备注保存不整页重绘、不丢其他行输入，连续点击、保存异常可恢复。
- [ ] CI 通过后必须另在独立 Cloudflare 预发布部署验证真实绑定、Queues/Webhook 与外部服务沙盒；不能仅凭本地模拟测试认定已通过实际部署验收。
- [ ] **注意**：现有 `.github/workflows/smoke.yml`（Production Liveness Check，仅 main 更新或手动触发）只检查生产 Worker 的健康与身份初始化接口，无法证明本次 PR 的新代码在隔离预发布环境能正常运行；不要将其显示为预发布端到端验收通过。
- [ ] 验证旧 `subscriptions` 被标记为 `legacy` 且未被取消，现有监控/通知不丢失。
- [ ] 新版 Worker 在**隔离预发布环境**通过健康检查、管理员登录、查询/修改备注、Spender 创建/编辑/删除（含删除期间扫描和相同地址重建）、Alchemy webhook 模拟、Telegram outbox 发送模拟、Cron 恢复和限流测试。
- [ ] 确定生产部署时间窗口及负责验收的管理员，事先告知现有监控风险。

## 2. 允许发布的执行顺序（仅在用户明确批准后）

1. 暂停与迁移表相关的后台写入，确保旧 Worker 不会在结构变更期间继续使用旧表逻辑。
2. 创建可恢复的生产 D1 备份或验证可用的 Time Travel 恢复点，记录数据库标识和恢复锚点；**没有可用备份则停止发布**。
3. 备份当前 Worker 的完整有效版本、绑定/触发器清单，并确认旧版本可立即重新部署。
4. 应用迁移并进行只读验证；如发生异常，停止发布，**不要继续切换 Worker**。
5. 从通过验证的单一构建产物发布新版 Worker，继承并核对原有环境绑定、Queue、Cron 和密钥。
6. 按业务链路测试历史授权发现 → 监控接入 → 链上事件 → D1 事件 → outbox → Telegram 发送。
7. 再次检查 Alchemy 远端地址列表与本地 D1 对账，验证删除/暂停订阅时不误删其他来源。
8. 至少连续观察多个 Cron 周期，排查异常 429、漏监控、stuck queue、重复通知和长时间失败记录。

## 3. 回滚说明

- Worker 代码可以回到发布前已保存的**旧版本**；恢复时必须确认环境绑定和 Cron/Queue 一致。
- **D1 迁移不能通过单纯恢复 Worker 版本自动撤销。** 旧版本是否兼容新表结构须预先验证。
- 恢复 D1 Time Travel/备份可能覆盖发布后写入的新业务记录，必须确认恢复点和预计的数据损失窗口，不能盲目执行。
- 优先使用兼容性迁移（新增表/列/索引）而非删除旧列；如必须回滚 D1，先停止所有写入并获得管理员明确批准。
- 若 Alchemy 已成功增删监控地址而 D1 回滚到旧快照，应先做远端只读对账，不要自动批量删除监听地址。
- 立即停用新功能不等于删除对应的钱包与 Telegram 订阅，禁止直接重置生产 D1。

## Telegram 投递不确定性验收（强制）

- [ ] 在隔离 Worker 中模拟 Telegram **HTTP 429 明确拒绝**，只对确定拒绝的请求继续按原限流冷却和最多五次重试。
- [ ] 模拟 Telegram 网络超时、断连和收发响应丢失：必须将通知标记 `delivery_unknown`，不得自动重发。
- [ ] 模拟 Telegram 已返回消息 ID，但 D1 写入 sent 失败：必须标记 `delivery_unknown`，不可误判为 pending；中断恢复超过 10 分钟同样进入该状态。
- [ ] 后台首页和通知队列显示待人工核查数量；仅管理员可以按 ID 明确重新排队或标记 `acknowledged`，两个操作均有审计记录。
- [ ] 重发前必须由管理员核对目标群聊天记录，理解可能重复发送的风险；`acknowledged` 表示“人工核查完成”，**不能**伪装成 Telegram 已确认送达。
- [ ] 执行 `tests/telegram-uncertain-delivery.test.mjs`、`tests/outbox-lease.test.mjs`、`tests/failed-outbox-retry.test.mjs` 和完整 Worker 权限回归。生产环境 Telegram 真正的送达结果依然必须人工核实，不能用本地模拟代替。

## 管理后台交互验收（第十二轮）

- [ ] 保存或恢复消息模板，不应整页重载；模板正文与管理员备注要在同一页面内保留并同步，自定义状态即时更新。
- [ ] 群组订阅修改备注或状态不应清空其他筛选和输入草稿；同一钱包的统一备注在列表中即时同步。
- [ ] 模拟当前页面刷新接口返回 HTTP 503：原页面和未保存输入仍可使用，页面内提示错误，不出现白屏；切换到新页面失败时仍应给出明确错误信息。
- [ ] 连续双击保存、重试等异步按钮只提交一次；请求期间锁定该按钮，请求失败后恢复；左侧栏正常导航不得被锁定。
- [ ] 运行 `tests/admin-ui-inline-mutations.test.mjs`、`tests/admin-ui-action-lock.test.mjs`、`tests/admin-ui-refresh-preservation.test.mjs` 和 `tests/full-worker-preflight.test.mjs`。
- [ ] **本地测试不能替代真实浏览器 UI 验收**：必须在隔离预发布服务上检查实际点击、滚动、焦点、键盘输入、窄屏与长页面性能，确认左侧栏不随主页面滚动。

## 历史监控调度与通知队列并发验收（第十三轮）

- [ ] 历史 Owner 接入批量任务必须为到期重试保留名额；有新地址及失败地址持续涌入时，两类任务都能推进，任何一类缺少任务时可使用空余名额。
- [ ] 两个 Cron 同时尝试历史批量接入时，只有持有 `spender_enroll_batch_lock` 独立令牌者可以执行；过期任务不能释放新任务的锁，异常后锁最终会释放。
- [ ] 模拟 Alchemy HTTP 429 / 1015：确认遵守服务端 `Retry-After`，冷却期内不重复 PATCH；持续受限时进行有上限的指数退避。不能因限流把当前钱包错误标记为已监控。
- [ ] 通知队列多执行器同时读取同一批待发记录，数据库领取动作必须原子检查 `state='pending'` 和 `due_at<=CURRENT_TIMESTAMP`；另一执行器刚延后重试时间时不得抢跑。
- [ ] 一批正常通知投递过程中，单条永久失败的管理员告警不可打断其余任务；结果无法确认仍遵循人工核查，不自动盲重发。
- [ ] 执行 `tests/spender-enrollment-fairness.test.mjs`、`tests/spender-enrollment-provider-429.test.mjs`、`tests/outbox-concurrency-load.test.mjs`、`tests/telegram-uncertain-delivery.test.mjs` 并确认 Worker 打包完整。
- [ ] 自动化使用的是模拟 Alchemy、Telegram 和隔离 D1，不等于长时间云端可靠性验证；正式发布前必须在独立预发布环境实测真正的限流、Queue 和 Cron 重叠。

## 第十四轮：多 Spender 公平调度和历史/钱包恢复验收

- [ ] 至少 32 个 Spender 同时具有新 Owner 和到期重试 Owner：使用持久化游标轮转，各 Spender 在有限 Cron 轮次内都能被选中；只存在一个处理名额时新/重试池必须交替，20 条批次依然保留前述 15/5 配额。
- [ ] Etherscan 历史任务：多个任务具有相同秒级 `updated_at` 时，借助 `spender_history_rr_cursor` 轮流推进；单个 Spender 查询失败后延迟重试，不影响其他 Spender 继续完成扫描；成功和错误情况下 `next_block` 不得错误跳过区块。
- [ ] 模拟 Etherscan 429：所有历史查询暂停短暂冷却；不因反复 Cron 继续发送 Etherscan HTTP 请求。
- [ ] 钱包资金缺口恢复：最旧的钱包反复 RPC 失败时，用 `checked_at` 进行至少五分钟的退避，但保留 `last_block`，其余活跃钱包继续扫描；冷却到期后可以重新选择。
- [ ] 运行 `tests/spender-enrollment-fairness.test.mjs`、`tests/spender-history-scheduler.test.mjs`、`tests/wallet-gap-recovery-fairness.test.mjs`，确认完整 Worker 包含上述功能。
- [ ] **仍需单独的云端长时间负载测试**：模拟 D1/RPC 的通过结果不代表 100–200 钱包在实际 Alchemy/Etherscan 配额下能够保持同步。必须采集真实滞后区块、Cron 耗时、Provider 429 和通知延迟。

## 4. 发布后明确验收条件

- [ ] 生产中既有的所有 Spender、钱包、Telegram 群组、备注、模板和历史交易行数无意外下降。
- [ ] 新旧钱包的监控状态与 Alchemy 远端完整分页对账一致，差异已解释或作为问题单记录。
- [ ] 交易与通知队列不出现事务半成品；最终失败消息可被管理员按需定位、确认后重试。
- [ ] 旧群手动订阅、多 Spender 重叠订阅和 Legacy 来源不会因单一规则编辑而被误停。
- [ ] 后台页面、搜索、保存、分页和左侧栏交互通过实机浏览器操作验证。
- [ ] 将生产版本号、构建 SHA、测试结果、回滚锚点（非敏感）写回进度文件。

**严格禁止**：无人监管的生产自动迁移、把测试分支直接强推 main、将线上凭据或钱包完整清单写入 GitHub。
