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
