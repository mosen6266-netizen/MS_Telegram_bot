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
- [~] P2：通知队列、钱包、订阅、管理员操作日志和链上交易已实现服务端分页与搜索（每页50条）；仍需其他长列表、浏览器局部更新和真实大数据量测压
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
