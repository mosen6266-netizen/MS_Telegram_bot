# 独立 Cloudflare 预发布环境操作手册（第十轮）

此文档说明下一阶段的**实际云端预发布验收**。当前只创建了配置模板和安全校验；**没有创建或部署任何 Cloudflare 资源**。

## 禁止直接沿用正式配置

现有 `wrangler.jsonc` 明确包含正式 Worker、D1 数据库、Queue、Cron 和公开回调地址。不得用它执行 `wrangler deploy` 或 `wrangler d1 migrations apply --remote` 作为测试。

## 需要事先独立准备

- 单独的 Cloudflare Worker 名称，例如 `ethereum-usdt-monitor-staging`。
- **全新的 D1** 数据库与 UUID，只放合成测试数据。
- 单独的 Queue 和 Dead Letter Queue；不能绑定正式的 `ethereum-usdt-monitor-tasks` 队列。
- 预发布独立 HTTPS Worker URL，绝不能等于正式 `PUBLIC_BASE_URL`。
- 独立的 Telegram **测试机器人**和只含测试成员的私有群；禁止使用正式机器人 Token 或回调。
- 独立的 Alchemy 测试项目 / Notify Webhook；必须是新 ID、新签名密钥和回调 URL。使用预发布专用 RPC / Etherscan Key，避免混用生产配额、告警和业务监控。
- 全新生成的 `APP_ENCRYPTION_KEY`、`INIT_SETUP_CODE` 和管理员密码，均只放在 Cloudflare Secrets 中，禁止写入 GitHub。

## 隔离部署准备（必须在用户授权实际预发布部署后）

1. 复制 `wrangler.staging.example.jsonc` 为本地私有的 `wrangler.staging.jsonc`，按实际创建的资源替换 ID 与回调 URL。
2. 运行 `node scripts/verify-staging-config.mjs wrangler.staging.jsonc`。任何地址、数据库或队列重名，缺少 UUID，启用 Cron，或者有凭证放进 `vars`，均拒绝继续。
3. 首先在隔离 D1 上执行迁移并检查外键、订阅来源、运行中队列租约、Spender generation 和监控状态。
4. 用经过 CI 的精确 GitHub commit 构建 Worker，记录产物 SHA-256；不得手工拼接线上代码。
5. 配置预发布专属秘密变量并启用测试机器人；先验证认证、CSRF、分页、备注、订阅、历史授权和 Telegram 测试推送。
6. 仅在专属回调、专属 Queue、隔离 D1 核对无误后，逐步开启 Cron；重演 Alchemy 限流、历史扫描中断、重试、移除以及资金通知队列。
7. 检查服务时间、错误率、浏览器页面跳转时间和 200+ 条历史列表加载速度，逐条记录未通过项。
8. 若预发布校验失败，只撤销预发布版本和绑定；严禁触碰生产资源。

## 验收必须满足

- 真实 Cloudflare Worker fetch/Queue/Cron 运行正常（不只是 Miniflare）。
- 专属测试 Telegram 群收到正确、去重的 ETH/USDT/USDC 通知；没有发送到正式群。
- 专属 Alchemy Webhook 的监听地址与隔离 D1 完整分页对账一致。
- 至少一次异常恢复与回滚演练通过；回滚不会隐式删除钱包或更改正式环境。
- 历史订阅和用户原有备注在隔离模拟数据中不丢失。
- 核查所有租约和限流路径没有泄露密钥或无法恢复的永久任务。

上述完成且得到用户单独批准后，才可讨论对 `main` 与正式环境发布。
