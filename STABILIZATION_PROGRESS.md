# Ethereum Monitor 稳定性修复 — 可恢复工作记录

- **基准分支**：`main`
- **开始时的正式源码提交**：`b311eb5071e3dacee87d9b8d93f59d26701775a8`
- **修复分支**：`stabilization/2026-10-15-p0`
- **线上 Worker**：`ethereum-usdt-monitor`
- **上线策略**：本分支开发、测试、PR 审核；**不得直接 PUT 覆盖正式 Worker**。没有完整通过测试和人工批准前不合并 main、不改变生产 D1。
- **阶段目标**：先解决真实漏通知、Alchemy 状态分歧、历史地址接入阻塞、发布缺模块；再处理性能、可维护性和 UI 体验。
- **敏感信息**：不要把 API Token、秘钥、管理员密码、生产请求体或用户钱包清单加入仓库。

## 进度

- [x] 确认 2026-10-15 正式代码提交并建立独立开发分支
- [x] 审查最近一期 30 项问题；生产数据库只读检查
- [x] P0-A：资金事件与通知队列改为 D1 原子写入；重复通知去重与旧缺项回放修复；新增实际 D1 集成测试
- [x] P0-B（开发与自动化测试）：通过 Alchemy 官方地址列表 API 完整分页、只读对账；后台可查看上次完整对账结果、遗漏数量和限流失败；按成功24小时/失败1小时的规则自动重试。尚未在真实 Alchemy 生产配置下运行验证，仍待发布验收。
- [~] P0-C：已优先处理从未尝试的钱包，失败地址按尝试次数延迟重试；还需做真实 Alchemy 限流与公平吞吐验证
- [~] P0-D：CI 和 Worker 打包工作流已强制验证 18 个关键模块；仍需封闭手工拼接发布途径和构建产物签名/回滚
- [~] P0-E：ensureWatch 对 active 钱包幂等，失败不降级；远端只读对账已实现和测试，尚待生产真实结果验证及自动修复策略
- [~] P1：发送租约恢复已修复；通知最终失败支持管理员单条确认后手动重新排队并有测试，自动无重复确认仍待完善
- [ ] P1：补扫公平队列、授权区块时间一致性、区块重组核对
- [~] P1：已有 subscription_sources 多来源归属、保守 legacy 保留；已添加历史订阅来源只读搜索/分页审核；仍需人工来源确认流程和正式数据验收
- [ ] P1：扫描、接入、定时任务分离和负载控制
- [~] P2：主要列表分页与搜索已实现；第 9/12 轮又完成监控备注、群组订阅、消息模板局部保存及异步按钮防重复提交，当前页面刷新失败可保留未保存输入；仍需真实浏览器长时间压力测试和其他表单优化
- [ ] P2：密码安全、历史归档、费用用量查询优化、文档一致性
- [ ] 全路径自动化回归：Telegram→D1→Alchemy→事件→通知
- [ ] 合并请求经 CI 验证，并单独确认正式环境发版窗口

## 如果对话中断，下一次如何继续

将下面这段指令发给新对话：

> 继续 `mosen6266-netizen/MS_Telegram_bot` 的 Ethereum Monitor 30 项稳定性修复工程。先查看分支 `stabilization/2026-10-15-p0` 上的 `STABILIZATION_PROGRESS.md` 和 PR/提交历史，再检查 CI；只在开发分支上继续未完成项，逐项补测试。不要直接修改生产 Cloudflare Worker、生产 D1 或 main，也不要重复已经验证的修复。完成一项就更新进度文件和提交记录。若要正式发布，先让我确认。

## 恢复原则

1. 新对话必须从 GitHub 读取实际分支、测试和提交，不得凭聊天摘要推断已经完成。
2. 优先保证已有钱包监控、备注、Telegram 群组、消息模板和历史记录完全保留。
3. 一个问题包含代码、回归测试、错误处理和可观察状态，缺任意一项仍标记为进行中。
4. GitHub Actions 通过不代表外部服务真实监控无误；任何真实服务端到端验证必须单独记录。
5. 不得声称离线/中断后自主完成工作；需要恢复对话继续执行，或使用明确配置的自动化工作流。

## 本阶段提交与测试（2026-10-15）

- **已完成开发**：交易通知入库原子化、历史接入公平/分级重试、活动中的钱包幂等保护、发送任务准确超时恢复、Worker 包完整性验证。
- **数据库迁移**：`migrations/20261015_outbox_sending_lease.sql`。在正式发布前需先在隔离环境运行和核验迁移；**尚未对正式 D1 执行**。
- **新增测试**：`tests/transfer-atomicity.test.mjs`、`tests/watch-onboarding.test.mjs`、`tests/outbox-lease.test.mjs`；真实 D1/Miniflare 集成测试通过。
- **最新已验证 CI**：提交 `f5d78b5ddc7d346955769846c34db956aedaa527`，GitHub Actions CI / Smoke Test 均成功；构建模块完整性检查也通过。
- **已知剩余风险**：Alchemy 远端对账已完成开发但尚未使用正式凭据验证；通知最终失败补偿缺失；迁移上线与 Worker 代码需要按顺序；不建议现在合并和部署。
- **下一步 P0**：建立 Alchemy 远端地址只读核验及每日对账，修复队列跳过已订阅地址的风险，补部署前迁移核验与真实回滚方案。

## 2026-10-15 第二轮进度：远端 Alchemy 钱包监控对账

- 新增 `src/alchemy-reconcile.ts`：使用官方只读 `GET /api/webhook-addresses`，必须校验所有游标分页、地址格式、数据去重、总数一致性。
- 新增 `tests/alchemy-reconcile.test.mjs`：测试完整分页、429、格式错误、循环游标、数字不一致、D1 状态对比及失败不覆盖成功快照。
- 后台监控页添加 **Alchemy 实际监控地址核验** 区域；`GET /api/monitoring/reconciliation` 只返回管理员可读的最近完整快照。
- Worker 每次定时任务只检查对账是否到期；上次成功后 24 小时内不再请求 Alchemy，失败间隔至少 1 小时；对账任务独立运行，不能阻塞 Telegram 通知。
- **安全约束**：发现本地/远端差异只报告，不擅自改变钱包状态、不删除远端钱包，避免任何不完整快照引发误删。
- **最近验证**：开发提交 `c9f88ea740ac3e631607985a6a214c303d1aef92` CI 和 Deployment Smoke Test 均成功。
- 官方分页接口文档：https://www.alchemy.com/docs/data/webhooks/webhooks-api-endpoints/notify-api-endpoints/webhook-addresses
- 仍未执行真实 Alchemy 生产环境对账，且正式 Cloudflare Worker/D1 未修改；部署前还需要预演和验证。
- 草稿 PR：https://github.com/mosen6266-netizen/MS_Telegram_bot/pull/1
- **下一步**：重点是通知最终失败的可追踪补偿和重试、监控移除待处理状态的自动清理、跨 Spender 的群组订阅来源保护，以及测试环境部署演练。

## 2026-10-15 第三轮：移除重试及队列错误处理

- 新增 `src/watch-maintenance.ts`：对 `removal_pending` 地址以每轮最多 2 个、失败至少等待 30 分钟的方式重试 Alchemy 地址移除。始终要求有完整 Alchemy 身份配置，若存在活跃订阅则跳过，尊重新增地址接入的限流冷却期。
- 新增 `tests/watch-removal-retry.test.mjs`：验证活跃订阅保护、新旧任务选择、限流跳过和 429 失败时仍保留待移除状态。
- 修正 `src/index.ts` 中 Telegram Queue 异常处理时变量 `configured` 作用域错误；失败通知和临时消息清理不再因引用未定义变量失效。
- 修正 `src/notifications.ts` 中 `attempts` 当前尝试未计入达到 5 次上限的判断（历史上可能多尝试一次）。
- 新增 `tests/queue-failure-regression.test.mjs` 防止异常分支作用域和重试判断回退。
- 本阶段 CI 基准：`b39f00430edb5bdd6e27f25fe70e551caa62a6be`；须检查该提交在 GitHub Actions 上的最终结果。
- **仍然没有动生产 Worker 或正式 D1**。所有改动只在 `stabilization/2026-10-15-p0`，草稿 PR #1 继续保持未合并。
- **下一步重点**：实现完整的订阅归属来源关系和跨 Spender 编辑/删除竞态测试；加强通知失败后补偿以及可靠的正式部署和回滚流程；随后才是性能与界面优化。

## 2026-10-15 第四轮：Telegram 订阅来源与通知最终失败手动补偿

- 新增 `migrations/20261015_subscription_sources.sql` 和 `src/subscription-sources.ts`。同一个 (chat_id,address) 订阅可以有多个独立来源：manual、admin、spender、legacy 和 retained。
- 历史旧订阅**统一标记 legacy 并保留**，因为老数据库不能可靠推断所有订阅是否源于手动操作；旧来源不明时宁可保留，不因切换 Spender 群组误停通知。
- 新产生的手动查询、管理员添加、Spender 实时发现/历史回溯都记录来源；群组路由变更移除该 Spender 的来源，只有所有其他来源均不存在时才解除对应订阅。
- 删除 Spender 前将其持有的来源转换为 retained，沿用用户已明确要求的“保留已监控钱包与原有群组通知”行为。
- 新增 `tests/subscription-sources.test.mjs`，采用 Miniflare + D1 实际迁移验证：旧订阅保留、两个 Spender 归属重叠、手动归属保护、仅有单一 Spender 时解除、删除 Spender 保留订阅、首次新增规则追踪来源。
- 新增 `src/outbox-operations.ts`、管理员 `POST /api/outbox/retry` 和通知队列页面单条“重新排队”按钮。只允许从 failed 状态手动操作，管理员有显式重复发送警示并记录审计。**不自动重发最终失败消息**，因为远端可能收到但 D1 记录失败。
- 新增 `tests/failed-outbox-retry.test.mjs`，验证非 failed 状态拒绝、重试清理错误及发送租约、重复点击安全。
- CI 完整性校验补充 subscription sources、Alchemy 对账、待移除重试、管理员手动补偿模块。
- **验证结果**：最新 `3456360614ba0e4087eb6cf2d4d891403aa6c2ac` 提交 GitHub CI 与 Deployment Smoke Test 均通过。
- **上线边界**：正式 Worker、正式数据库和 main 均未改变。新迁移需在隔离 D1 进行完整回放后才能上线；绝不直接覆盖生产表。
- **剩余问题**：对于迁移前无法识别来源的订阅，群组更换可能留下保守保留的旧推送，需要提供可审核的“旧订阅归属清理”流程。还需测试 Spender 删除与实时扫描竞态、最终失败操作的真实 Telegram 交互和程序级回归；不能视为全部 30 项完成。
- 草稿 PR：https://github.com/mosen6266-netizen/MS_Telegram_bot/pull/1
- **下一阶段**：正式发布前迁移与回滚预演、管理员异常任务检索和批量分页、Spender 并发删除防护、性能优化与群组订阅来源审核界面。

## 2026-10-15 第五轮：通知队列分页和发布回滚流程

- `GET /api/outbox` 改为标准化服务端分页（每页 50）、状态筛选（failed/pending/sent/sending/skipped）、任务 ID/Telegram 群 ID 搜索，统计独立批量查询，避免仅返回最近 200 条导致旧错误无法定位。
- 前端通知队列页面增加状态过滤、搜索、分页及失败任务的手动确认重试；移除对一次性 200 行数组响应的依赖。
- 新增 `migrations/20261015_outbox_pagination_index.sql`，为 outbox 的状态和 ID 倒序索引。
- `tests/outbox-pagination.test.mjs` 在 Miniflare D1 中写入 241 条通知，验证五页、历史失败查询、按群筛选、按 ID 查找和非法过滤值拒绝。
- 最新功能提交 `9f1ee74fa52a2fb17b8f5862ab2a664689660c8e` 的 CI / Deployment Smoke Test 均通过。
- 新增 `docs/RELEASE_AND_ROLLBACK.md`：正式发版前的备份、隔离 D1 迁移、验证包完整性、Worker 回滚、D1 时点恢复的风险边界及人工验收清单。
- 最新文档提交 `0f1c3fa94bd75df8334ab714bcecf9f7ff826ef9` 仍需对应 CI 最终确认；文档不会自动部署。
- **所有生产配置未变，当前草稿 PR #1 不可合并。**
- 下阶段重点：`spender_rules` 删除和 Poll / History 并发竞态、通知失败与 Telegram 回执不可确定时的明确状态管理、订阅来源归属人工审核机制、真实发布迁移演练。

## 2026-10-15 第六轮：Spender 删除/重建并发保护与历史订阅审核

- **历史授权及实时授权版本护栏**：`migrations/20261016_spender_generation_fence.sql` 为 `spender_rules` 和历史扫描任务增加不可复用的 `generation`。新建 Spender 分配新的 `crypto.randomUUID()`，旧规则被删除并重建后旧扫描结果不得混入新版本。
- `src/spender-history.ts`：Etherscan RPC 返回后、每批地址写入前校验规则 generation；历史地址和授权时间戳插入使用原子 `INSERT SELECT ... WHERE EXISTS` 版本护栏，游标/错误/核验结果按 generation 条件写入。旧请求不能复活已删历史记录。
- `src/approval.ts`：实时扫描游标更新仅在 generation 与旧游标均匹配时执行；实时事件入库与 allowance UPSERT 也校验 generation；已失效的旧回调不进入新规则的通知群。
- `tests/spender-generation-fence.test.mjs`：真实 Miniflare D1 测试中模拟 Etherscan 请求尚未返回时删除并重建 Spender，验证旧历史不写入新任务，旧版本实时写入被拒绝。
- `tests/spender-live-generation.test.mjs`：模拟实时 RPC allowance 返回前删除并重建相同 Spender，验证旧授权事件、额度和游标不会重新出现。
- **迁移顺序已修正**：开始时命名不正确，CI 捕获“历史扫描表尚未创建”；现迁移改为 `20261016_spender_generation_fence.sql`，并在 `docs/RELEASE_AND_ROLLBACK.md` 明确其必须排在历史表迁移之后。
- **旧订阅来源审核**：`src/subscription-sources.ts` 新增只读 `listLegacySubscriptions`，管理员 `GET /api/subscriptions/legacy`，在地址群组订阅页面显示历史来源待核实清单，可搜索钱包/群组、每页 30 条；不会自动改写来源或停止旧群通知。
- `tests/legacy-provenance-audit.test.mjs`：76 条模拟订阅、旧数据保守迁移、过滤和分页、无修改审计。
- `scripts/verify-worker-bundle.mjs` 增加 generation 校验与历史来源审核模块检查。
- 最新历史/实时竞态和只读审核功能提交 `d1c0ea7cb19adb9ac0e986bc0cc0d4f10f39d7f7` 已有 GitHub CI 与 Smoke Test 成功记录；发布清单与最终捆绑检查提交 `0c8a739140d6ecec56adc7e35caa8c6698d7477a` 的 CI 还需核对完成状态。
- **仍未合并 main，也未修改生产 Cloudflare Worker/D1。**
- **剩余并发风险**：对在删除前已开始、且在最后一次规则校验后才进入远端 Alchemy API 的调用，还需统一引入受控接入队列和操作租约，才能保证远端同样无孤儿监控。不要把本阶段说成彻底消除所有异步竞争。
- **下一阶段**：完善 Alchemy 接入/删除统一调度与租约、Telegram 旧订阅来源人工确认/取消的强权限功能、交易通知可恢复性测试、性能和 UI 全面复核、隔离环境部署迁移演练。

## 2026-10-15 第七轮：Alchemy 增删全局互斥、Webhook 去重及删除冲突防护

- 新增 `src/alchemy-mutation-lease.ts`：基于现有 D1 `runtime_state` 的全局 `alchemy_mutation_lease`。通过原子条件 UPSERT 抢占，凭独立随机令牌释放；旧执行不能误解锁新执行。租约容错 180 秒，单次远端调用 AbortSignal 超时 25 秒，避免默认长期卡死。
- `src/core.ts`：单钱包 `ensureWatch`、`removeWatch` 和 `syncWatch` 统一借助锁完成远端操作及本地状态写入；锁繁忙时移除任务保留或改为 `removal_pending` 供后续清理，避免误报 Alchemy 已删除。
- 同一钱包添加与删除请求发生重叠时，显式删除优先：地址会继续处于 `removal_pending`，添加流程不能错误返回已激活。定时删除遵守活跃订阅保护。
- 首次 Webhook 创建时，在锁内重新查找并解密数据库保存的 ID；避免其他执行已经创建成功但本执行持有旧配置时重复创建 Webhook；如果已存密钥无法解密，拒绝新建，须人工处理配置。
- `src/spender-enroll.ts`：历史批量接入 Alchemy 前锁内重新检查每条 Spender 规则 `generation`、已发现地址及管理员排除；仅提交仍有效的地址，成功后仍在锁内写入本地监控及订阅状态。
- Spender 删除接口也参与该全局互斥锁。已有远端接入调用尚未结束时返回 HTTP 409 告知管理员稍后重试；不能直接删除规则导致远端新增孤儿地址。
- `src/watch-maintenance.ts`、`src/index.ts`：普通 Cron 重试现在只接入仍有活跃来源的 pending 订阅，排除已移除 Spender 留下的待接入孤立地址；原有手动、管理员与旧 legacy 来源保持兼容。
- 新增测试 `tests/alchemy-mutation-lease.test.mjs`、`tests/alchemy-webhook-identity.test.mjs`、`tests/spender-alchemy-race.test.mjs`、`tests/pending-watch-origin.test.mjs`。覆盖锁冲突/令牌交接、加/删重叠、旧 webhook 身份重读、正在批量接入时删 Spender、规则删除后禁止远端残留新增、定时重试孤儿隔离。
- 扩展 `scripts/verify-worker-bundle.mjs`：关键 Alchemy 互斥、超时控制与待监控任务来源筛选模块必须存在于最终 Worker 包。
- 功能与测试提交 `ae236a61d14d906359c033dcbdcaa3c985aff4e4` 的 CI、Deployment Smoke Test 均已通过；捆绑校验提交 `e4161e0c62363ad729b21f58f955f111cddc1cff` 正在 CI 检查中，应确认最终结果。
- **仍未改动生产 Worker、生产 D1 或 main**；全部修复位于草稿 PR #1 的独立开发分支，尚不允许上线。
- **剩余风险**：租约能防止所有使用统一调用路径的操作重叠，但不能阻止未来新增、未使用锁的外部代码或已有 Worker。历史地址初期本地记录准备与删除的全部步骤尚不是同一事务；应继续增加输入来源版本条件、解除规则时的待接入数据清理和生产级灰度演练。
- **下一步**：验证正式迁移顺序与回滚、监控真实 Alchemy 远端清单对账、统一群组来源人工归属审查与界面性能压测。发布需要单独征得用户同意。

## 2026-10-15 第八轮：旧 D1 升级预演及后台全局列表分页

- `tests/in-place-upgrade-rehearsal.test.mjs`：通过隔离 Miniflare/D1 按实际 SQL 顺序由旧 schema 升级到全部新迁移，使用**已有监控钱包、活跃 Telegram 订阅、运行中及失败通知、旧 Spender 扫描断点和操作审计**为种子数据。验证升级后业务记录保持一致、旧发送任务有 `sending_started_at`、历史订阅标记 `legacy`、旧 Spender 和扫描任务保持一致的 `generation`、索引及外键完整。
- 说明：上面的运行是**非空模拟数据库的自动化迁移预演**，并非完整复制或迁移实际生产 D1，也不是已完成生产级 Time Travel 回滚。生产 D1 和 Worker **没有改动**。
- `src/admin-listing.ts`：新建支持钱包、群组订阅、管理员审计、链上转账 50 条/页的 D1 查询，带搜索和订阅状态 / ETH、USDT、USDC 资产筛选。已删除这四处硬编码的 `LIMIT 200` 后台数据上限。
- `src/admin.ts`：四个对应 API 返回 `{rows,total,page,total_pages}`，必要时返回明确的筛选错误；数据库统计及列表使用同一 D1 batch，减少往返。
- `src/admin-ui.ts`：四个页面同步改为中文筛选搜索、上一页/下一页及显示总数；维持现有无闪屏渲染和管理操作。
- `migrations/20261017_admin_list_indexes.sql`：新增钱包、订阅及链上交易排序索引，作为新迁移纳入旧数据库升级预演。
- `tests/admin-listing.test.mjs`：230 条模拟记录跨页搜索与筛选，验证旧记录不再因 200 条上限消失。为避免 Miniflare 初始化时逐条发出数百次测试写入，该测试数据已改用 SQL 递归批量生成。
- `scripts/verify-worker-bundle.mjs`：现在检查所有四个列表查询函数必须存在于 Worker 构建成品。
- `docs/RELEASE_AND_ROLLBACK.md`：增加该版本迁移与列表测试核验要求，并强调现有 `smoke.yml` 只检查**生产端点是否存活**，不能证明本开发分支的新代码已经通过真实隔离环境部署。
- **测试状态**：功能与迁移的 CI 在 `9bddc14ee4434318fc9d72d0b533190291fb8abf` 已通过；最新 `4cfef07a8d5d0a63e5bd3be0af8e81b4f9b1cfe6` 测试数据生成优化的 CI 尚待最终结果核验。
- **下一步**：确认 CI，随后重点执行隔离预发布 Worker + D1 真正的端到端运行测试、逐项浏览器交互与大数据量性能压力测试；继续修复剩余长列表、重复渲染和资源用量查询瓶颈。
- **禁止直接部署到生产**：PR #1 保持草稿、`main` 不合并、生产 D1 与 Worker 未修改；上线仍需用户确认及真实回滚预案。

## 2026-10-15 第九轮：完整 Worker 隔离运行、备注局部保存、检查流程区分

- **第八轮最终确认**：此前提交 `79b38f039f47ee74cb9396989a6164ecb7fe6067` 的两组 CI 均成功；不再将其标为等待。
- 新增 `tests/full-worker-preflight.test.mjs`：使用 **真正构建后的 `src/index.ts` 全部 Worker 代码**，通过 Miniflare 独立运行，采用按真实迁移创建的隔离 D1、模拟管理员登录会话及 HTTP 请求验证：`/health`、`/admin`、`/auth/status`、`/api/summary`、监控/钱包/订阅/审计/链上交易分页、Alchemy 对账结果读接口、未登录 401、合法管理员写入的 CSRF 拦截、备注同步与操作审计。
- **不等于外部预发布**：本测试没有把 Worker 部署到 Cloudflare 预发布账号，没有调用真实 Telegram/Alchemy API，也没有做浏览器实机操作。真实 Cloudflare Queue、Cron、外部服务与版本发布仍需后续验收。
- **备注保存体验**：`src/admin-ui.ts` 正在监控地址每行“保存备注”改为局部异步保存，无整页 `render()`；保护其他行未保存的输入与当前列表定位；按钮有“保存中”状态、阻止重复点击、错误后恢复。通用错误显示不再打开阻塞式浏览器 `alert`，改为页面提示。
- 新增 `tests/admin-ui-remark-save.test.mjs`：通过 VM 执行实际前端 `saveRemarkInline`，验证成功、失败、双击及无页面重绘。新增完整 Worker 请求测试覆盖统一备注写入、订阅同步、搜索和审计。
- **验证**：第九轮含端到端隔离测试与备注逻辑的功能提交 `dc840f44e7ec377fc96e8fe4e75dc2aca7a0e5e7` 已通过两组 GitHub CI。
- **工作流澄清**：`.github/workflows/smoke.yml` 改名 `Production Liveness Check (not staging validation)`，仅 `main` push 或手动执行，用于确认现有生产端点存活；开发分支通过实际完整 Worker 的 CI 测试验证，避免“旧线上能打开 = 新版本已验收”的错误结论。
- `docs/RELEASE_AND_ROLLBACK.md` 已加入新验收门槛、正式 Cloudflare 沙盒/预发布外部联调要求。
- 当前仅修改 `stabilization/2026-10-15-p0`，**未合并 main，未修改生产 Worker/D1**。本轮文档/工作流最终 CI 需在下次继续前核实。
- **下一步**：搭建与正式环境隔离的 Cloudflare 预发布 Worker + D1 + Queue，验证真正的 Telegram / Alchemy 接入与 Cron（不得复制生产密钥或混用生产 Webhook）；继续修复剩余列表/按钮的重复渲染、UI 搜索保存性能，以及用量汇总 N+1 查询和正式发布回滚演练。

## 2026-10-15 第十轮：用量性能、采集原子性及预发布资源隔离

- **接续核验**：第九轮末次进度提交 `d76bee3dd3a74f8c0477e0ac9640f7c6e5414dd1` GitHub CI 双份均为成功；`main` 未合并，生产 Worker/D1 未修改。
- **费用查询消除 N+1 往返**：`src/usage.ts` 的 `usageSnapshot` 将样本/平台错误/GitHub 信息放入一次 `D1.batch`，再将所有指标的账期内历史增量基准放入第二次 `D1.batch`，避免按每个指标连续单独访问数据库。原先的 15 分钟至 24 小时有效观测范围、同账期/同来源匹配、80% 和 7 天预警判断保持不变。
- `tests/usage-snapshot-batch.test.mjs`：仪器化真实 Miniflare/D1 `batch` 调用次数，9 项有样本时严格为两轮数据库往返；验证 80%/7 天预警、跨账期/来源误基准拒绝、采集失败不报警，样本为空时只读取一次。
- **采集批量写入**：Cloudflare 账号的 6 项指标和本程序内部计数均改为按采集来源汇总后通过一次 `D1.batch` 写入，避免部分 Cloudflare 指标先更新、剩余更新失败导致的混杂快照，并减少数据库请求；Alchemy 单项样本路径保持兼容。
- `tests/usage-atomic-collect.test.mjs`：故意对其中一个 Cloudflare 指标添加 D1 中止触发器，验证其他 Cloudflare 指标不会部分提交；解除故障后可重新采集、清除采集错误。原有 `tests/usage.test.mjs` 继续验证预警与通知真实 D1 回归。
- **首页跳转**：`src/admin-ui.ts` 的 Overview 首屏统计和启动状态改为 `Promise.all` 并行请求，避免两个 HTTP 接口串行等待。
- **预发布防误操作**：现有 `wrangler.jsonc` 是生产资源配置（含真实 D1 ID、Queue 名、Worker 地址），不得直接用于测试部署。新增 `wrangler.staging.example.jsonc`（非可部署占位符）、`scripts/verify-staging-config.mjs`（安全校验）、`tests/staging-isolation-config.test.mjs`（生产 Worker/D1/Queue/回调复用、明文密钥与 Cron 都必须拒绝）。专属 `wrangler.staging.jsonc` 加入 `.gitignore`。
- 新增 `docs/ISOLATED_STAGING.md`、更新 `docs/RELEASE_AND_ROLLBACK.md`，明确必须先分别创建全新 Cloudflare Worker/D1/Queue、专用 Telegram Bot 和 Alchemy Webhook，用独立测试账号/凭证运行，再进行**真正云端预发布**。
- **验证记录**：数据与性能改动提交 `72a6526f92398f679a08b93b872ee933f663d11b` 已双 CI 成功；预发布独立配置验证及手册 `5cc88a73e77f8783bf6fe4e8a6fe1596356cc5fe` 已双 CI 成功。最近几个仅文档/.gitignore 提交的 CI 还在运行，下一轮须确认。
- **当前严格边界**：只操作 `stabilization/2026-10-15-p0`；未部署生产或预发布 Cloudflare、未创建任何云端新资源、未改生产 D1/Queue、未合并 `main`。
- **下一步**：在得到独立预发布资源所需权限与用户同意后，按文档创建和验证云端测试环境；在此之前可继续针对剩余页面交互、历史列表查询性能、队列异常和用量长周期测试进行纯开发分支修复。绝不可把 GitHub 绿色 CI 当作生产完整验收。

## 2026-10-15 第十一轮：Telegram 投递结果不明时防重复发送与人工核查

- **起点确认**：第十轮最终进度提交 `601e5f1477a91d8a7361f937800df8cf9ac55ff1` 的 GitHub CI 双份成功。
- **核心故障**：原 `recoverStuck` 会在 `sending` 超过十分钟后自动变为 `pending`，但这不能证明 Telegram 没有收到消息；若 Telegram 已收、D1 回执写入失败或 Worker 崩溃，可能导致重复通知。
- `src/notifications.ts`：超过十分钟的遗留 `sending` 任务改为 `delivery_unknown`，不再自动重发；发送网络阶段出现断连/超时，或 Telegram 已返回成功后 D1 记录失败，统一标记“投递结果待确认”，等待人工核对。仅当 Telegram 明确返回非 OK/429 时，仍按既有重试及限流逻辑处理。
- `src/core.ts`：Telegram 明确拒绝错误携带 `telegramRejected` 标识，以区别送达结果无法确认的网络/持久化错误。
- `src/outbox-operations.ts`、`src/admin.ts`：管理员可对 `delivery_unknown` / `failed` 显式重新排队，对 `delivery_unknown` 核查后标记 `acknowledged`（人工核查完成，不代表 Telegram 已送达）；全部保留管理员审计、状态二次比较与非授权请求拦截。
- `src/admin-ui.ts`：通知队列状态、筛选与处理按钮全部中文，新增“投递结果待确认”和“已人工核查”；首页显示待确认数量，重发前要求确认 Telegram 群记录，避免无意重复发送。
- **真实 D1 故障注入与权限测试**：`tests/telegram-uncertain-delivery.test.mjs` 验证网络断连不重发、明确 429 仍按冷却重试、Telegram 成功但 D1 sent 状态写入失败不重发，以及人工重发/核查状态；`tests/outbox-lease.test.mjs` 验证十分钟任务回收不盲目重发；`tests/failed-outbox-retry.test.mjs` 更新明确错误状态；`tests/full-worker-preflight.test.mjs` 覆盖授权/未授权管理员、首页数量、人工核查 API。
- `scripts/verify-worker-bundle.mjs` 增加打包检查，要求人工核查逻辑与 `delivery_unknown` 必须进入 Worker 产物。发布手册 `docs/RELEASE_AND_ROLLBACK.md` 增加上述异常场景的强制验收门槛。
- **已核验 CI**：完整 Worker 管理员 API 与异常通知逻辑提交 `ddfe5a9d772c70d514a7abad29bb95a577353216` 双 CI 成功；打包强制检查提交 `e75e3c553dc46666accb4a4fab84037ab1319dea` 至少一轮 CI 成功。末尾文档与状态中文化提交需核对最新 CI 完成状态。
- **发布边界不变**：仅在 `stabilization/2026-10-15-p0`；未合并 `main`，未修改正式 Worker、D1、Queue、Telegram Bot、Alchemy 配置。新的业务逻辑**尚未在真实 Telegram/Cloudflare 预发布环境联调**。
- **待继续**：对多发送端/并发 Cron 负载进行压测，检查 `delivery_unknown` 人工操作审计与权限，完善用户所要求的其他界面局部保存以及启动后长时间资源性能测试。正式发布需先完成独立预发布环境和备份回滚演练。

## 2026-10-15 第十二轮：后台局部保存、异常页面保护与按钮双击防重复

- **起点核验**：第十一轮进度文件最后提交 `15db3ef2f6...` 的 CI 双份成功。继续使用 `stabilization/2026-10-15-p0`，没有修改 `main`。
- **消息模板编辑器不再整页重绘**：`src/admin-ui.ts` 的模板 PUT 和 DELETE 改由 `runInlineMutation` 在原位置提交。成功后只更新该模板的本地 `overrides` / `notes` 和状态表格；其他未保存输入保留；删除覆盖则更新编辑器为当前默认或继承版本。
- **群组订阅局部更新**：备注和状态 PATCH 成功后只修改当前显示表格中的相关行；同一个钱包的统一备注对当前列表可见行同步，页面搜索条件、分页和其他输入不被重新初始化。下一次完整搜索依然重新获取数据库最新值。
- **刷新接口异常防闪屏**：`render` 同页面刷新遇到错误时保留原有 DOM 和未保存草稿，展示明确的错误提示；切换到其他页面失败仍显示错误页以免旧页面错位。
- **异步按钮防重复提交**：所有通过 `action()` 创建的异步按钮会在 Promise 未完成期间临时禁用；异常自动恢复；同步导航仍立即响应，不锁住左侧栏。
- **新增自动化测试**：`tests/admin-ui-inline-mutations.test.mjs`、`tests/admin-ui-refresh-preservation.test.mjs`、`tests/admin-ui-action-lock.test.mjs`。`tests/full-worker-preflight.test.mjs` 新增实际隔离 Worker 的模板 PUT/DELETE、管理员备注入库/清除测试。
- **CI 基准**：上述所有功能与新测试提交 `4025ecf44d634b4bd81c8aeaaf5834a9df838177` 已两组 CI 通过；更新发布手册后的提交 `c7deb31454fc945970d3c6fcb96cb10060846c65` 正等待最终 CI 结果核实。
- **发布操作规范**：`docs/RELEASE_AND_ROLLBACK.md` 强制加入模板保存、订阅修改、刷新失败保留表单、双击测试以及真实浏览器不同视口下的导航和滚动验收。
- **仍未做的事**：未部署独立 Cloudflare 预发布环境，没有在真实浏览器点击实测，也没有验证线上性能提升多少毫秒。正式 Worker、生产 D1/Queues 和 `main` 未修改。
- **第十三轮建议**：扫描与通知队列并发/高负载压力测试、历史回扫公平调度、限流恢复路径；若需要真正的外部联调，先按 `docs/ISOLATED_STAGING.md` 单独创建隔离测试资源并确认权限。

## 2026-10-15 第十三轮：历史 Owner 接入公平调度、Alchemy 限流恢复及通知并发保护

- **起点验证**：第十二轮最后一次提交 `386af8b1611a96a4d6d287d954e6914ba9f7be2b` 的两组 CI 已成功。继续只操作 `stabilization/2026-10-15-p0`。
- `src/spender-enroll.ts`：`selectEnrollmentCandidates` 将每轮 20 个处理名额划分为约 15 个最新发现地址、5 个到期重试地址；不足时由另一个池补足。消除新地址持续涌入导致已到期失败任务一直排不到的风险，但尚未实现不同 Spender 之间的严格轮询公平。
- **批量任务可靠租约**：`withEnrollmentLease` 在现有 D1 `runtime_state` 上使用原子、有过期时间和独立随机令牌的锁；旧任务不能释放已被其他执行领取的锁，取代旧版“用过期时间判断后不分令牌删除锁”的竞争路径。
- **429/1015 限流恢复**：Alchemy PATCH 不成功时识别 HTTP 429 及 `Retry-After`（秒数或 HTTP 日期），优先遵守服务端延时；没有给出延时时按重复限流次数做有上限的指数退避，返回冷却之前不重复发送。成功入队后重置限流计数。
- `tests/spender-enrollment-fairness.test.mjs`：在隔离 Miniflare/D1 构造 80 个历史 Owner 与长期重试地址，验证 15/5 配额及下一轮不会无限重复挑选同一批；验证锁重叠、过期接管、旧执行释放不会删新锁及 Retry-After 解析。
- `tests/spender-enrollment-provider-429.test.mjs`：真实 D1 配合模拟 Alchemy 429；验证 120 秒 `Retry-After`、冷却期间 Cron 再次执行不会调用 Alchemy、第二次没有服务端头时延长到约 30 分钟。
- `src/notifications.ts`：领取 pending 通知时在数据库 CAS 上同时检验 `due_at<=CURRENT_TIMESTAMP`，杜绝旧执行列表绕过别的执行器刚设置的限流延期；“通知最终失败”时给管理员发消息的失败不会打断剩余队列批次。
- `tests/outbox-concurrency-load.test.mjs`：并发两路通知消费执行器处理 48 条模拟 Telegram 消息，每条记录至多领取发送一次；模拟旧列表读完后 `due_at` 被其他任务延后，应被原子条件拒绝。首个故障测试拦截对象错误已被 CI 发现，并修复测试夹具后通过。
- `scripts/verify-worker-bundle.mjs`：要求最终完整 Worker 包含公平接入、令牌租约、Retry-After 解析函数。
- `docs/RELEASE_AND_ROLLBACK.md` 新增强制验收清单，包括延时重试、Cron 并发及 Telegram 不重复发送。
- **已验证 CI**：核心功能与所有新增测试提交 `fe13732fbd97b8b4190a31b190d88662306ab386` 两组 CI 成功；最终捆绑检查提交 `c3f369206c4aa00a254be1f80930fd31a5ddef44` 两组 CI 成功。最后的文档提交需继续确认 CI。
- **仍未完成**：各 Spender 之间的严格配额公平性、真实高负载云端压测和 Queue/Cron 的长时间故障恢复、Alchemy 在实际配额下的稳定性、正式云端预发布 D1/Queue/Worker 的部署和最终回滚验收。此次仍未触碰生产 Worker、正式 D1/Queue、主分支或 Telegram Bot。
- **下轮建议**：继续补充多 Spender 公平调度和跨服务长时间故障测试，以及安全的云端预发布环境验收；不要把模拟 CI 成功表述为已通过正式生产验收。

## 2026-10-15 第十四轮：多 Spender 跨任务公平性与资金回扫失败隔离

- **接续状态**：上一轮最后的进度提交 `290d7118edd51a8f224b59030e05e5cf5cb25a49` 两次 CI 都已成功；仍然仅操作 `stabilization/2026-10-15-p0`。
- `src/spender-enroll.ts`：在原有“每批 15 个新 Owner / 5 个到期重试 Owner”基础上，加入 `ROW_NUMBER() OVER(PARTITION BY spender)` 的跨 Spender 公平轮转，使用 `runtime_state` 中的 `spender_enroll_rr_fresh` / `spender_enroll_rr_retry` 持久化两个队列的上次服务位置。超过单批容量的 Spender 不再永久排在后面。仅一个名额时使用 `spender_enroll_rr_pool_turn` 新/重试交替，避免单类饿死。
- `tests/spender-enrollment-fairness.test.mjs`：保留原先 80 个 Owner 测试；新增 32 个竞争 Spender、两类队列连续七轮、公平进度断言，以及单名额新/重试交替。对应功能和测试两组 GitHub CI 已通过。
- `src/spender-history.ts`：Etherscan 历史任务采用 `spender_history_rr_cursor` 对相同更新时间的不同 Spender 轮转；单个失败任务根据重试次数延迟 2/10/60 分钟，避免连续占据 Cron 配额；HTTP 429 触发短暂全局历史扫描冷却。当前 Spender 扫描完成或普通失败，Cron 仍可继续检查其他待扫描任务；不改写失败任务的扫描游标。
- `tests/spender-history-scheduler.test.mjs`：8 个待扫描 Spender，其中一个模拟 Etherscan 错误，7 个能继续完成；故障任务到期后恢复。模拟全局 429 则后续不再重复发送历史查询。测试两组 CI 通过。
- `src/recovery.ts`：为失败的钱包资金缺口回扫设置约五分钟退避，将最近失败时间写入已有 `wallet_checkpoints.checked_at`（不会前进 `last_block`），避免最旧且连续失败的钱包永久挤占 3 个回扫名额；筛选时通过 `datetime(checked_at)` 正确比较 SQLite 时间戳和 ISO8601。
- `tests/wallet-gap-recovery-fairness.test.mjs`：使用模拟 RPC 超时和隔离真实 D1，验证失败钱包的断点保留、其他活跃钱包继续回扫、五分钟后失败钱包可重新入队。提交 `1b52c19a82af7c36b73fb920415e6c1adb1214cb` 两组 CI 成功。
- `scripts/verify-worker-bundle.mjs`：增加跨 Spender 游标、钱包失败退避函数的完整构建检查。`docs/RELEASE_AND_ROLLBACK.md` 增强上线前公平调度、冷却、断点完整性、100–200 钱包负载验收条款。
- **已确认 CI**：核心功能与新 D1 故障测试提交 `1b52c19a82af7c36b73fb920415e6c1adb1214cb` 双 CI 成功。最新构建校验与文档更新提交仍需核对最终 CI。
- **尚未完成的风险**：仅本地模拟数据库/RPC 测试，实际外部 Cloudflare Queue/Cron/Alchemy/Etherscan 长时间运行、回调投递验证、100–200 钱包持续区块跟踪能力、生产数据库备份回滚均未验收；跨服务 429 仍需云端压力测试。不得承诺完全消除重组与通知延迟风险。
- **发布隔离边界**：未修改生产 Worker、生产 D1、Queues、Telegram Bot、Alchemy、`main`；PR #1 继续保持草稿。下一阶段优先使用 `docs/ISOLATED_STAGING.md` 的独立环境验收，在用户批准并确认资源隔离后再实际创建预发布资源；在此之前继续修复阻断正式发布的代码问题和静态核对。
