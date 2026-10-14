# Ethereum USDT Telegram Monitor

## LIVE ADMIN WIZARD

Admin URL: https://ethereum-usdt-monitor.mosen6266-ms007.workers.dev/admin

State: Worker, D1, Queues and scheduled tasks deployed. Monitoring remains **OFF** until the administrator completes the setup and activation steps. Real Telegram and chain transfers remain untested until provider tokens are supplied.

### Step 1 — initialize once

Create a scoped Cloudflare API token with Workers Scripts Edit permission for your own Cloudflare account and use it **once** on the admin initialization page together with a new administrator password (at least 14 characters). The Worker uses that proof of ownership to generate an AES-256 master key and saves the key as a Cloudflare Worker secret, not to GitHub or D1. The Cloudflare API token is never stored. Revoke it after setup.

### Step 2 — connect providers entirely in the dashboard

- Telegram: Bot Token from @BotFather and a random 12+ character Webhook Secret.
- Alchemy: Ethereum Mainnet HTTPS RPC URL and Notify Auth Token.
- Alchemy Address Activity Webhook ID and Signing Key are optional; the service attempts to create a webhook when the first real monitored Owner is found. They can also be entered manually in the dashboard.
- Etherscan V2 API Key for historical USDT allowance/Spender discovery.
- Administrator private Telegram Chat ID for 80% and seven-day quota warnings. After enabling the bot, send /start in private to retrieve your chat ID and return to the settings page to save it.

Test Telegram, Alchemy, Etherscan connections from the dashboard; click Enable Monitoring to register Telegram webhook. This is designed to require no ordinary token editing in GitHub or Cloudflare after initial setup.

Telegram BotFather Privacy Mode must allow the bot to read ordinary address messages. Make the bot a group admin for reliable membership verification.

### Security notes

Do not submit credentials to GitHub, Telegram groups or Issues. Credentials are AES-GCM encrypted in D1 and the encryption key is a Cloudflare Worker secret. Web admin uses HttpOnly Secure SameSite sessions, same-origin mutation checks, and PBKDF2 password hashing.

### Caveats

- Financial usage percentages are currently internal estimates/manual reference quotas; official Cloudflare and Alchemy billing data APIs are **not** yet connected.
- Historical Spender queries may be incomplete when free Etherscan log APIs restrict deep historical access. The bot should not falsely report absence when the index is unavailable.
- Transaction replay is bounded to keep API costs under control. First-block notifications may require chain reorganization corrections.
- Production reliability depends on real-provider acceptance tests and long-running monitoring tests.

## Earlier architecture notes
# Ethereum USDT Telegram Monitor

Cloudflare Workers + D1 + Queues: Ethereum Mainnet USDT allowance lookup, reverse Spender approval discovery, Owner ETH/USDT/USDC transfer alerts and Telegram group remarks.

**Project state: development, not live.** A configured, deployed, tested environment is required before alerts can be trusted.

## Rules
- Ethereum mainnet only. Official USDT contract for approval checks; official USDT/USDC addresses and native ETH for transfers.
- New manually queried wallets are watched only after current positive USDT allowance has been **verified**.
- Spender rules discover new Owner wallets from USDT \`Approval\` logs. Watch **Owner transfers only**, never Spender balances just because the Spender is registered.
- First manual query name is immutable; each chat's display remark is editable by any current group member.
- A watch persists when USDT approval is revoked, until removed by an administrator.
- Incoming and outgoing transfers alert after inclusion in the first successful canonical block; reorgs must be reconciled.
- Usage alarms at 80% or predicted exhaustion in seven days, via Telegram admin DM; email off.

## Configuration
1. Create a **new** D1 database and Queues named \`ethereum_usdt_monitor\`, \`ethereum-usdt-monitor-tasks\`, \`ethereum-usdt-monitor-dlq\`; update \`wrangler.jsonc\` database_id.
2. Run \`npm install\`, \`npx wrangler d1 migrations apply ethereum_usdt_monitor --remote\`.
3. Set all secrets in \`.env.example\` via \`npx wrangler secret put NAME\`. Never commit secrets.
4. Create an Alchemy Ethereum Mainnet **Address Activity** webhook pointing at \`/webhooks/alchemy\`; store its webhook ID and signing key. Dynamic address sync needs the Alchemy Notify token.
5. Use a valid Ethereum mainnet archive/history indexing provider for allowance discovery. Etherscan V2 \`getLogs\` is implemented with pagination/caps; query results must not claim absence on incomplete history.
6. Deploy with \`npm run deploy\`; set Telegram webhook to \`https://<worker>.workers.dev/webhooks/telegram\` with a secret_token. In BotFather allow reading ordinary group messages (disable privacy or promote bot appropriately).
7. Bot admin must start a private chat first so usage alerts can arrive. Test webhook verification, event replay, queue delays and alert delivery before production.
8. Management UI: \`/admin\`, requires \`ADMIN_API_TOKEN\` and HTTPS.

## Security
The GitHub repository is **public**. Tokens, credentials, chat exports and wallet/user records must remain in Cloudflare Secrets/D1, never GitHub.
Read-only chain monitoring: no private keys, wallet connects or transfer signing. Review and test API scopes, Telegram admin identity and alert reliability before treating it as production-ready.

## Known rollout gates
- Alchemy transfer webhook cannot operate without configured signing key, webhook ID and token.
- Historical allowances need comprehensive, paginated archival logs; API limits can produce 'incomplete' status rather than a false 'no allowance'.
- Cloudflare resource usage panel must distinguish officially measured metrics from local estimates and manually configured quotas.
- Contract-wallet/Permit2 approvals and internal ETH transfers have indexing caveats.
- Per-block reorg handling and replay validation are required for high-reliability use; test on mainnet before claiming zero missed events.
