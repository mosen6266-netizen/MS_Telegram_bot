# Signal Monitor — Isolated bridge (development only)

> Safety: independent Node process, NOT a replacement for the production Telegram Worker. This branch must NOT be merged into or deployed over the Telegram production Worker.

## Current state

Implemented in this folder:
- Signal CLI JSON-RPC group messaging with group allowlist and independent account;
- new/change USDT approval, ETH/USDT/USDC transfer, reorg, usage and failure notification text;
- authenticated loopback-only local HTTP ingress;
- independent deduplication data/state.json (not Telegram D1);
- optional SSE reception of Signal group address queries via a dedicated read-only HTTPS query adapter;
- dry-run mode is ON by default and CI tests provide isolation checks.

Still NOT connected: Signal account and real group IDs; separate event-producing service; real-time monitoring event feed; query data source; end-to-end live delivery verification. Automatic monitoring enrollment and address remarks on Signal are not implemented yet. No Telegram production settings have been changed.

## Isolation requirements

The existing Telegram Worker already owns its D1, Cloudflare Queue, Alchemy webhooks and Telegram outbox. Do not modify these to add Signal. The Signal bridge must use its own runtime, local storage, credentials, account, groups and event producer. A separately authenticated read-only event feed or an independent Alchemy monitoring webhook is required to supply real events. Do not point SIGNAL_QUERY_URL at the production Telegram Worker or its administration APIs.

Never share or overwrite the Telegram token, Telegram D1, existing Alchemy production webhook, production queue, production Wrangler configuration or Signal Auto Scheduler account directory.

## Testing

Use Node 22+.

    cd signal-bridge
    npm run check

Copy .env.example to .env (never commit secrets). Run signal-cli daemon on loopback HTTP, with a dedicated account and data directory. Supply an authentic Signal account ID and raw group IDs. SIGNAL_ENABLED=true and SIGNAL_DRY_RUN=true allow synthetic event previews without sending anything.

    node --env-file=.env server.mjs

POST a JSON object to http://127.0.0.1:8789/v1/notify with Authorization: Bearer <SIGNAL_BRIDGE_TOKEN>. It must use the network ETH_MAINNET, a unique eventId (8–180 safe characters), an allowed groupId and a supported kind. For new_approval, include owner/spender addresses, transaction hash and amount; for transfer include address, tx_hash, asset, direction and amount.

The bridge listens on 127.0.0.1 ONLY. Never expose its inbound HTTP port publicly. A remote event producer needs a separately secured private transport and must not share credentials with Telegram.

## Query interface

Set SIGNAL_QUERY_URL to an independent HTTPS read-only JSON service; set SIGNAL_QUERY_TOKEN separately. If SIGNAL_ENABLE_RECEIVE=true and live mode is enabled, members in allowlisted Signal groups can send an exact Ethereum address or the /query command followed by an address. The query adapter returns:

    {
      "network": "ETH_MAINNET",
      "address": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "approvals": [{"spender":"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","amount":"100 USDT"}],
      "monitoring": "active",
      "exhaustive": true
    }

If an empty approvals list is not marked exhaustive=true, the bridge refuses to claim no valid authorization. The current query path only reads results. A dedicated Signal backend is needed for full enrollment and remark management.

## Safety and acceptance gates

- Root production source, Wrangler, migrations, queue bindings, notification code and deployment workflow unchanged.
- Production Telegram main SHA and deployed Worker version must remain unchanged.
- Signal service is separate and off by default. Only enable after live Signal account provisioning and independent event source validation.
- Signal failures and restarts must have no effect on Telegram notifications, latency or backlog.
- Deduplication is persisted AFTER successful send, so a crash between sending and persistence can cause a duplicate; exactly-once cannot be guaranteed.
- Sender needs its own stable event IDs. Signal delivery latency cannot be guaranteed at a fixed number of seconds.
- Rollback consists solely of stopping Signal bridge. Telegram production does not need a rollback because it has not been changed.

Do NOT run wrangler deploy, apply production migrations, update production webhooks, or auto-merge this branch.
