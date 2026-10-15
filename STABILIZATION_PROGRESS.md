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
- [~] P1：已修复发送恢复时间（使用 sending_started_at 新迁移）并增加老消息场景测试；重复发送与最终失败补偿尚未完成
- [ ] P1：补扫公平队列、授权区块时间一致性、区块重组核对
- [ ] P1：群组和 Spender 订阅来源关系与删除行为
- [ ] P1：扫描、接入、定时任务分离和负载控制
- [ ] P2：后台服务端分页、性能、局部更新、加载状态
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
