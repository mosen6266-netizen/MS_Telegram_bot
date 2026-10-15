// src/setup.ts
var SECRET_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "ADMIN_TELEGRAM_CHAT_ID", "ALCHEMY_RPC_URL", "ALCHEMY_NOTIFY_TOKEN", "ALCHEMY_ACTIVITY_WEBHOOK_ID", "ALCHEMY_SIGNING_KEY", "ETHERSCAN_API_KEY", "CF_ANALYTICS_API_TOKEN", "ALCHEMY_USAGE_TOKEN"];
var encoder = new TextEncoder();
var b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
var un64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
var hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
var random = (n) => crypto.getRandomValues(new Uint8Array(n));
async function sha256(s) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(s)));
}
async function passwordHash(password, salt, iters = 0, env) {
  if (iters > 0) {
    const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: un64(salt), iterations: iters, hash: "SHA-256" }, material, 256));
  }
  const k = await crypto.subtle.importKey("raw", un64(env.APP_ENCRYPTION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, encoder.encode("admin-v1:" + salt + ":" + password)));
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function key(env) {
  if (!env.APP_ENCRYPTION_KEY) throw Error("App encryption secret not provisioned");
  return crypto.subtle.importKey("raw", un64(env.APP_ENCRYPTION_KEY), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encrypt(env, s) {
  const iv = random(12), cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), encoder.encode(s));
  return b64(iv) + "." + b64(cipher);
}
async function decrypt(env, s) {
  const [i, v] = s.split(".");
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: un64(i) }, await key(env), un64(v));
  return new TextDecoder().decode(data);
}
async function adminExists(env) {
  return !!await env.DB.prepare("SELECT 1 FROM admin_login WHERE id=1").first();
}
async function locked(env, subject) {
  const row = await env.DB.prepare("SELECT locked_until FROM auth_failures WHERE subject=?").bind(subject).first();
  return row?.locked_until && new Date(row.locked_until).getTime() > Date.now();
}
async function fail(env, subject) {
  const l = new Date(Date.now() + 15 * 60 * 1e3).toISOString();
  await env.DB.prepare("INSERT INTO auth_failures(subject,attempts,locked_until) VALUES(?,1,NULL) ON CONFLICT(subject) DO UPDATE SET attempts=CASE WHEN attempts>=6 THEN 1 ELSE attempts+1 END,locked_until=CASE WHEN attempts>=5 THEN ? ELSE locked_until END,updated_at=CURRENT_TIMESTAMP").bind(subject, l).run();
}
async function clearFail(env, subject) {
  await env.DB.prepare("DELETE FROM auth_failures WHERE subject=?").bind(subject).run();
}
async function session(env) {
  const token = b64(random(32)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const id = await sha256(token);
  await env.DB.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)").bind(id, new Date(Date.now() + 12 * 36e5).toISOString()).run();
  return "__Host-ethadmin=" + token + "; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200";
}
async function authorized(req, env) {
  const raw = req.headers.get("cookie") || "";
  const token = raw.match(/(?:^|;\s*)__Host-ethadmin=([a-zA-Z0-9_-]+)/)?.[1];
  if (!token) return false;
  const hash = await sha256(token);
  return !!await env.DB.prepare("SELECT 1 FROM admin_sessions WHERE token_hash=? AND expires_at>?").bind(hash, now()).first();
}
function csrf(req) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return true;
  const origin = req.headers.get("origin");
  return origin === new URL(req.url).origin && req.headers.get("x-app-action") === "1";
}
async function isAdmin(req, env) {
  return csrf(req) && await authorized(req, env);
}
async function authRoute(req, env, path) {
  if (path === "/auth/status" && req.method === "GET") return json({ initialized: await adminExists(env), authenticated: await authorized(req, env) });
  if (path === "/auth/setup" && req.method === "POST") {
    if (!csrf(req)) return json({ error: "Invalid origin" }, 403);
    if (await adminExists(env)) return json({ error: "Already initialized" }, 403);
    const b = await req.json(), code = String(b.setup_code || ""), password = String(b.password || "");
    if (await locked(env, "setup")) return json({ error: "Too many setup attempts, retry later" }, 429);
    if (password.length < 14 || password.length > 200) return json({ error: "Password must be 14-200 characters" }, 400);
    if (!env.APP_ENCRYPTION_KEY) return json({ error: "Service encryption secret not configured. Contact the deployment administrator." }, 503);
    const rawSetupSecret = typeof env.INIT_SETUP_CODE === "string" ? env.INIT_SETUP_CODE : "";
    if (rawSetupSecret && rawSetupSecret.trim().length < 24)
      return json({ error: "Cloudflare \u7684 INIT_SETUP_CODE \u5DF2\u4FDD\u5B58\uFF0C\u4F46\u957F\u5EA6\u4E0D\u8DB3 24 \u4E2A\u5B57\u7B26\u3002\u8BF7\u5728 Worker \u751F\u4EA7\u73AF\u5883\u5C06\u5B83\u66F4\u65B0\u4E3A\u81F3\u5C11 24 \u4F4D\u7684\u968F\u673A\u7801\uFF0C\u5E76\u5728\u8FD9\u91CC\u8F93\u5165\u5B8C\u5168\u76F8\u540C\u7684\u5185\u5BB9\u3002" }, 409);
    const digest = await sha256(code.trim());
    const provisioned = rawSetupSecret.trim().length >= 24;
    const fromDatabase = !!await env.DB.prepare("SELECT 1 FROM setup_invites WHERE code_hash=? AND used_at IS NULL AND expires_at>?").bind(digest, now()).first();
    const fromCloudflare = provisioned && equal(digest, await sha256(rawSetupSecret.trim()));
    if (!fromDatabase && !fromCloudflare) {
      await fail(env, "setup");
      return json({ error: "\u4E00\u6B21\u6027\u7801\u4E0D\u6B63\u786E\u6216\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u4F7F\u7528\u5F53\u524D\u6709\u6548\u7684\u521D\u59CB\u5316\u7801\u3002" }, 403);
    }
    const salt = b64(random(24)), hash = await passwordHash(password, salt, 0, env);
    const result = await env.DB.prepare("INSERT OR IGNORE INTO admin_login(id,salt,verifier,iterations) VALUES(1,?,?,0)").bind(salt, hash).run();
    if (!result.meta?.changes) return json({ error: "Already initialized" }, 409);
    if (fromDatabase) await env.DB.prepare("UPDATE setup_invites SET used_at=? WHERE code_hash=? AND used_at IS NULL").bind(now(), digest).run();
    await clearFail(env, "setup");
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": await session(env) } });
  }
  if (path === "/auth/login" && req.method === "POST") {
    if (!csrf(req)) return json({ error: "Invalid origin" }, 403);
    if (await locked(env, "login")) return json({ error: "Too many attempts. Wait 15 minutes." }, 429);
    const b = await req.json(), p = String(b.password || "");
    const row = await env.DB.prepare("SELECT salt,verifier,iterations FROM admin_login WHERE id=1").first();
    if (!row) return json({ error: "Not initialized" }, 403);
    const hash = await passwordHash(p, row.salt, row.iterations, env);
    if (!equal(hash, row.verifier)) {
      await fail(env, "login");
      return json({ error: "Password incorrect" }, 401);
    }
    await clearFail(env, "login");
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": await session(env) } });
  }
  if (path === "/auth/logout" && req.method === "POST") {
    if (!csrf(req)) return json({ error: "Invalid origin" }, 403);
    const token = (req.headers.get("cookie") || "").match(/(?:^|;\s*)__Host-ethadmin=([a-zA-Z0-9_-]+)/)?.[1];
    if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "set-cookie": "__Host-ethadmin=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/" } });
  }
  return json({ error: "Unknown auth endpoint" }, 404);
}
async function configEnv(env) {
  const records = (await env.DB.prepare("SELECT key,encrypted_value FROM setup_secrets").all()).results || [];
  const e = { ...env };
  for (const r of records) {
    if (SECRET_KEYS.includes(r.key)) try {
      e[r.key] = await decrypt(env, r.encrypted_value);
    } catch (err) {
      console.error("Unable to decrypt configured key", r.key);
    }
  }
  return e;
}
async function persistSecret(env, keyName, value) {
  if (!SECRET_KEYS.includes(keyName)) throw Error("Unsupported secret name");
  await env.DB.prepare("INSERT INTO setup_secrets(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=CURRENT_TIMESTAMP").bind(keyName, await encrypt(env, value)).run();
}
async function status(env) {
  const configured2 = new Set(((await env.DB.prepare("SELECT key FROM setup_secrets").all()).results || []).map((x) => x.key));
  const ready = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value === "1";
  return { active: ready, keys: Object.fromEntries(SECRET_KEYS.map((k) => [k, configured2.has(k) || !!env[k]])), needs: [
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "ALCHEMY_RPC_URL",
    "ALCHEMY_NOTIFY_TOKEN",
    "ETHERSCAN_API_KEY"
  ].filter((k) => !configured2.has(k)) };
}
async function setupApi(req, env, path) {
  if (path === "/api/setup/status" && req.method === "GET") return json(await status(env));
  if (path === "/api/setup/save" && req.method === "POST") {
    const data = await req.json();
    if (!data || typeof data !== "object") return json({ error: "Invalid configuration" }, 400);
    const incoming = Object.entries(data).filter(([k, v]) => SECRET_KEYS.includes(k) && typeof v === "string" && v.trim());
    if (!incoming.length) return json({ error: "Nothing to save" }, 400);
    for (const [name, val] of incoming) {
      const clean = val.trim();
      if (clean.length > 8192) return json({ error: name + " too long" }, 400);
      if (name === "ALCHEMY_RPC_URL" && !/^https:\/\/[a-zA-Z0-9.-]+(?:\/[^\s]*)?$/.test(clean)) return json({ error: "Alchemy RPC must use HTTPS" }, 400);
      if (name === "TELEGRAM_WEBHOOK_SECRET" && !/^[A-Za-z0-9_-]{12,256}$/.test(clean)) return json({ error: "Webhook secret needs 12-256 safe characters" }, 400);
      const encrypted = await encrypt(env, clean);
      await env.DB.prepare("INSERT INTO setup_secrets(key,encrypted_value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET encrypted_value=excluded.encrypted_value,updated_at=CURRENT_TIMESTAMP").bind(name, encrypted).run();
    }
    await env.DB.prepare("DELETE FROM runtime_state WHERE key='usage_last_collect'").run();
    return json({ ok: true, configured: incoming.map((x) => x[0]), ...await status(env) });
  }
  if (path === "/api/setup/test" && req.method === "POST") {
    const b = await req.json(), which = b?.service;
    const e = await configEnv(env);
    if (which === "telegram") {
      if (!e.TELEGRAM_BOT_TOKEN) return json({ error: "Telegram Bot Token \u672A\u914D\u7F6E" }, 400);
      try {
        const result = await telegram(e, "getMe", {});
        return json({ ok: true, bot_name: result.username, id: result.id });
      } catch (err) {
        return json({ error: "Telegram connection failed: " + String(err).slice(0, 150) }, 422);
      }
    }
    if (which === "alchemy") {
      if (!e.ALCHEMY_RPC_URL) return json({ error: "Alchemy RPC \u672A\u914D\u7F6E" }, 400);
      try {
        const res = await fetch(e.ALCHEMY_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
        const dat = await res.json();
        if (dat.result !== "0x1") throw Error("RPC must point to Ethereum Mainnet");
        return json({ ok: true, chain: "Ethereum Mainnet" });
      } catch (err) {
        return json({ error: "Alchemy RPC test failed: " + String(err).slice(0, 150) }, 422);
      }
    }
    if (which === "etherscan") {
      if (!e.ETHERSCAN_API_KEY) return json({ error: "Etherscan API Key \u672A\u914D\u7F6E" }, 400);
      try {
        const u = new URL("https://api.etherscan.io/v2/api");
        u.search = new URLSearchParams({ chainid: "1", module: "proxy", action: "eth_blockNumber", apikey: e.ETHERSCAN_API_KEY }).toString();
        await recordUsage(e, "etherscan_requests");
        const data = await (await fetch(u)).json();
        if (!data.result || !String(data.result).startsWith("0x")) throw Error("Key refused or rate-limited");
        return json({ ok: true, block: Number(BigInt(data.result)) });
      } catch (err) {
        return json({ error: "Etherscan test failed: " + String(err).slice(0, 150) }, 422);
      }
    }
    return json({ error: "Unknown test service" }, 400);
  }
  if (path === "/api/setup/activate" && req.method === "POST") {
    const s = await status(env);
    if (s.needs.length) return json({ error: "Missing required configuration: " + s.needs.join(", ") }, 409);
    const e = await configEnv(env);
    if ((!e.ALCHEMY_ACTIVITY_WEBHOOK_ID || !e.ALCHEMY_SIGNING_KEY) && !e.ALCHEMY_NOTIFY_TOKEN)
      return json({ error: "Alchemy Notify token is needed for automatic creation of the first activity webhook" }, 409);
    const webhookUrl = new URL(req.url).origin + "/webhooks/telegram";
    try {
      await telegram(e, "setWebhook", { url: webhookUrl, secret_token: e.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
    } catch (err) {
      return json({ error: "Telegram webhook failed: " + String(err).slice(0, 150) }, 422);
    }
    await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('is_active','1') ON CONFLICT(key) DO UPDATE SET value='1',updated_at=CURRENT_TIMESTAMP").run();
    return json({ ok: true, active: true, webhook_url: webhookUrl });
  }
  if (path === "/api/setup/deactivate" && req.method === "POST") {
    await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('is_active','0') ON CONFLICT(key) DO UPDATE SET value='0',updated_at=CURRENT_TIMESTAMP").run();
    return json({ ok: true, active: false });
  }
  return json({ error: "Unknown setup API" }, 404);
}

// src/core.ts
var USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
var USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
var APPROVAL_TOPIC = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
var ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
var addr = (s) => ADDRESS_RE.test(String(s || "")) ? String(s).toLowerCase() : null;
var now = () => (/* @__PURE__ */ new Date()).toISOString();
var json = (data, status2 = 200) => Response.json(data, { status: status2, headers: { "cache-control": "no-store" } });
var esc = (s) => String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
var short = (s) => s ? s.slice(0, 8) + "\u2026" + s.slice(-6) : "\u2014";
var toTopic = (s) => "0x" + s.slice(2).toLowerCase().padStart(64, "0");
var fromTopic = (s) => s && addr("0x" + s.slice(-40));
var trunc = (s, n = 80) => Array.from(String(s || "")).slice(0, n).join("");
function formatUnits(raw, decimals = 6) {
  let n = BigInt(raw);
  const minus = n < 0n ? "-" : "";
  if (n < 0) n = -n;
  const digits = n.toString().padStart(decimals + 1, "0");
  if (!decimals) return minus + digits;
  const frac = digits.slice(-decimals).replace(/0+$/, "");
  return minus + digits.slice(0, -decimals) + (frac ? "." + frac : "");
}
async function rpc(env, method, params) {
  if (!env.ALCHEMY_RPC_URL) throw Error("ALCHEMY_RPC_URL is not configured");
  await recordUsage(env, "alchemy_rpc_requests");
  const r = await fetch(env.ALCHEMY_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw Error("Ethereum RPC HTTP " + r.status);
  const d = await r.json();
  if (d.error) throw Error("RPC " + String(d.error.message || d.error.code));
  return d.result;
}
async function blockNumber(env) {
  return Number(BigInt(await rpc(env, "eth_blockNumber", [])));
}
async function allowance(env, owner, spender, block = "latest") {
  const data = "0xdd62ed3e" + owner.slice(2).padStart(64, "0") + spender.slice(2).padStart(64, "0");
  const value = await rpc(env, "eth_call", [{ to: USDT, data }, block]);
  return BigInt(value || "0x0");
}
async function receiptSuccess(env, hash) {
  const d = await rpc(env, "eth_getTransactionReceipt", [hash]);
  return d ? d.status === "0x1" : null;
}
async function telegram(env, method, body2) {
  if (!env.TELEGRAM_BOT_TOKEN) throw Error("TELEGRAM_BOT_TOKEN is missing");
  await recordUsage(env, "telegram_api_requests");
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body2)
  });
  const d = await r.json();
  if (r.status === 429) await recordUsage(env, "telegram_rate_limited");
  if (!r.ok || !d.ok) {
    const error = Error("Telegram " + (d.description || r.status));
    error.retryAfter = Number(d.parameters?.retry_after) || 0;
    throw error;
  }
  if (method === "sendMessage") await recordUsage(env, "telegram_notifications");
  return d.result;
}
var send = (env, chat_id, text, reply_markup = void 0) => telegram(env, "sendMessage", {
  chat_id,
  text,
  parse_mode: "HTML",
  disable_web_page_preview: true,
  reply_markup
});
var buttons = (address) => ({ inline_keyboard: [
  [{ text: "\u270F\uFE0F \u4FEE\u6539\u5907\u6CE8", callback_data: "remark:" + address }],
  [{ text: "\u{1F50E} Etherscan", url: "https://etherscan.io/address/" + address }]
] });
async function increment(env, metric) {
  await env.DB.prepare("INSERT INTO counters(metric,day,value) VALUES(?,date('now'),1) ON CONFLICT(metric,day) DO UPDATE SET value=value+1").bind(metric).run();
}
async function recordUsage(env, metric) {
  try {
    await increment(env, metric);
  } catch {
    console.warn("Usage counter unavailable", metric);
  }
}
async function queueNotice(env, { dedup, chat_id, address, template, payload }) {
  await env.DB.prepare("INSERT OR IGNORE INTO outbox(dedup_key,chat_id,address,template_key,payload_json) VALUES(?,?,?,?,?)").bind(dedup, String(chat_id), address || null, template, JSON.stringify(payload || {})).run();
}
async function audit(env, actor, action, target, details = {}) {
  await env.DB.prepare("INSERT INTO admin_audit(actor,action,target,details_json) VALUES(?,?,?,?)").bind(String(actor), action, String(target), JSON.stringify(details)).run();
}
async function syncWatch(env, address, remove = false) {
  if (!env.ALCHEMY_NOTIFY_TOKEN) throw Error("Alchemy Notify token is missing");
  if (!env.ALCHEMY_ACTIVITY_WEBHOOK_ID && !remove) {
    const lock = await env.DB.prepare("INSERT OR IGNORE INTO runtime_state(key,value) VALUES('activity_webhook_lock',?)").bind(now()).run();
    if (!lock.meta?.changes) {
      const old = await env.DB.prepare("SELECT updated_at FROM runtime_state WHERE key='activity_webhook_lock'").first();
      if (old && Date.now() - (/* @__PURE__ */ new Date(old.updated_at + "Z")).getTime() > 18e4) {
        await env.DB.prepare("DELETE FROM runtime_state WHERE key='activity_webhook_lock'").run();
      }
      throw Error("Alchemy webhook creation is already running; retry shortly");
    }
    try {
      const r2 = await fetch("https://dashboard.alchemy.com/api/create-webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Alchemy-Token": env.ALCHEMY_NOTIFY_TOKEN },
        body: JSON.stringify({
          network: "ETH_MAINNET",
          webhook_type: "ADDRESS_ACTIVITY",
          webhook_url: env.PUBLIC_BASE_URL + "/webhooks/alchemy",
          name: "Ethereum USDT Owner Monitor",
          addresses: [address]
        })
      });
      const d = await r2.json();
      const created = d.data || d;
      if (!r2.ok || !created.id || !created.signing_key)
        throw Error("Alchemy webhook creation rejected: " + String(d.message || r2.status).slice(0, 100));
      await persistSecret(env, "ALCHEMY_ACTIVITY_WEBHOOK_ID", created.id);
      await persistSecret(env, "ALCHEMY_SIGNING_KEY", created.signing_key);
      env.ALCHEMY_ACTIVITY_WEBHOOK_ID = created.id;
      env.ALCHEMY_SIGNING_KEY = created.signing_key;
      return;
    } finally {
      await env.DB.prepare("DELETE FROM runtime_state WHERE key='activity_webhook_lock'").run();
    }
  }
  if (!env.ALCHEMY_ACTIVITY_WEBHOOK_ID) throw Error("Alchemy activity webhook missing");
  const r = await fetch("https://dashboard.alchemy.com/api/update-webhook-addresses", {
    method: "PATCH",
    headers: { "content-type": "application/json", "X-Alchemy-Token": env.ALCHEMY_NOTIFY_TOKEN },
    body: JSON.stringify({ webhook_id: env.ALCHEMY_ACTIVITY_WEBHOOK_ID, addresses_to_add: remove ? [] : [address], addresses_to_remove: remove ? [address] : [] })
  });
  if (!r.ok) throw Error("Alchemy sync HTTP " + r.status + " " + (await r.text()).slice(0, 140));
}
async function removeWatch(env, address) {
  const active = await env.DB.prepare("SELECT count(*) n FROM subscriptions WHERE address=? AND status='active'").bind(address).first();
  if (active?.n > 0) return false;
  const rule = await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(address).first();
  if (!rule || rule.state === "removed") return true;
  try {
    if (env.ALCHEMY_ACTIVITY_WEBHOOK_ID && env.ALCHEMY_NOTIFY_TOKEN) await syncWatch(env, address, true);
    await env.DB.prepare("UPDATE wallet_watches SET state='removed',last_error=NULL,updated_at=? WHERE address=?").bind(now(), address).run();
    return true;
  } catch (e) {
    await env.DB.prepare("UPDATE wallet_watches SET state='removal_pending',last_error=?,updated_at=? WHERE address=?").bind(String(e).slice(0, 300), now(), address).run();
    return false;
  }
}
async function ensureWatch(env, address, fromBlock = void 0) {
  await env.DB.prepare("INSERT OR IGNORE INTO wallet_watches(address,state) VALUES(?,'pending')").bind(address).run();
  try {
    const head = fromBlock === void 0 ? await blockNumber(env) : fromBlock;
    await env.DB.prepare("INSERT OR IGNORE INTO wallet_checkpoints(address,last_block) VALUES(?,?)").bind(address, Math.max(0, head - 1)).run();
    await syncWatch(env, address, false);
    await env.DB.prepare("UPDATE wallet_watches SET state='active',synced_at=?,last_error=NULL,updated_at=? WHERE address=?").bind(now(), now(), address).run();
    return true;
  } catch (e) {
    await env.DB.prepare("UPDATE wallet_watches SET state='pending',last_error=?,updated_at=? WHERE address=?").bind(String(e).slice(0, 500), now(), address).run();
    return false;
  }
}
async function notifyAdmin2(env, html) {
  if (!env.ADMIN_TELEGRAM_CHAT_ID) return;
  try {
    await send(env, env.ADMIN_TELEGRAM_CHAT_ID, html);
  } catch (e) {
    console.warn("Admin DM failed", String(e));
  }
}
async function verifyAlchemy(env, body2, signature) {
  if (!env.ALCHEMY_SIGNING_KEY || !signature) return false;
  const key2 = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.ALCHEMY_SIGNING_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const dig = new Uint8Array(await crypto.subtle.sign("HMAC", key2, new TextEncoder().encode(body2)));
  const ours = Array.from(dig, (x) => x.toString(16).padStart(2, "0")).join("");
  const theirs = signature.toLowerCase().replace(/^sha256=/, "");
  if (theirs.length !== ours.length) return false;
  let diff = 0;
  for (let i = 0; i < ours.length; i++) diff |= ours.charCodeAt(i) ^ theirs.charCodeAt(i);
  return diff === 0;
}

// src/cleanup.ts
async function scheduleMessageDeletion(env, chatId, messageId, reason, delaySeconds = 0) {
  if (!/^-?\d+$/.test(String(chatId)) || !Number.isSafeInteger(Number(messageId)) || Number(messageId) <= 0) return;
  const due = new Date(Date.now() + Math.max(0, delaySeconds) * 1e3).toISOString();
  await env.DB.prepare(
    "INSERT INTO telegram_message_cleanup(chat_id,message_id,reason,due_at) VALUES(?,?,?,?) ON CONFLICT(chat_id,message_id) DO UPDATE SET due_at=CASE WHEN state='deleted' THEN due_at WHEN excluded.due_at<due_at THEN excluded.due_at ELSE due_at END, state=CASE WHEN state='deleted' THEN 'deleted' ELSE 'pending' END, updated_at=CURRENT_TIMESTAMP"
  ).bind(String(chatId), Number(messageId), reason, due).run();
}
async function finishAddressQueryCleanup(env, job) {
  const tasks = [];
  if (job.user_message_id) tasks.push(scheduleMessageDeletion(env, job.chat_id, job.user_message_id, "query_address"));
  if (job.progress_message_id) tasks.push(scheduleMessageDeletion(env, job.chat_id, job.progress_message_id, "query_progress"));
  await Promise.all(tasks);
  await flushMessageCleanup(env, 8);
}
async function finishRemarkCleanup(env, chatId, promptMessageId, userMessageId) {
  await Promise.all([
    scheduleMessageDeletion(env, chatId, promptMessageId, "remark_prompt"),
    scheduleMessageDeletion(env, chatId, userMessageId, "remark_input")
  ]);
  await flushMessageCleanup(env, 8);
}
async function flushMessageCleanup(env, limit = 35) {
  await env.DB.prepare(
    "UPDATE telegram_message_cleanup SET state='pending' WHERE state='processing' AND updated_at<datetime('now','-5 minutes')"
  ).run();
  const rows = await env.DB.prepare(
    "SELECT chat_id,message_id,attempts,reason FROM telegram_message_cleanup WHERE state='pending' AND due_at<=? ORDER BY due_at LIMIT ?"
  ).bind(now(), limit).all();
  for (const task of rows.results || []) {
    const lease = await env.DB.prepare(
      "UPDATE telegram_message_cleanup SET state='processing', attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=? AND state='pending'"
    ).bind(task.chat_id, task.message_id).run();
    if (!lease.meta?.changes) continue;
    try {
      await telegram(env, "deleteMessage", { chat_id: task.chat_id, message_id: task.message_id });
      await env.DB.prepare(
        "UPDATE telegram_message_cleanup SET state='deleted',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=?"
      ).bind(task.chat_id, task.message_id).run();
    } catch (error) {
      const detail = String(error?.message || error).slice(0, 220);
      if (/message to delete not found|message not found/i.test(detail)) {
        await env.DB.prepare(
          "UPDATE telegram_message_cleanup SET state='deleted',last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=?"
        ).bind(task.chat_id, task.message_id).run();
        continue;
      }
      const permanent = /message can't be deleted|message cannot be deleted|message is too old/i.test(detail);
      const attempts = Number(task.attempts) + 1;
      if (permanent || attempts >= 9) {
        await env.DB.prepare(
          "UPDATE telegram_message_cleanup SET state='blocked',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=?"
        ).bind(detail, task.chat_id, task.message_id).run();
      } else {
        const backoff = Math.min(3600, 20 * Math.pow(2, Math.min(attempts, 7)));
        await env.DB.prepare(
          "UPDATE telegram_message_cleanup SET state='pending',last_error=?,due_at=?,updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND message_id=?"
        ).bind(detail, new Date(Date.now() + backoff * 1e3).toISOString(), task.chat_id, task.message_id).run();
      }
      console.warn("Telegram cleanup failed", task.reason, detail);
    }
  }
}

// src/notifications.ts
var DEFAULTS = {
  usage_alert: "\u26A0\uFE0F <b>\u5E73\u53F0\u7528\u91CF\u901A\u77E5</b>\n{{alert_text}}",
  new_approval: "\u{1F6E1}\uFE0F <b>\u53D1\u73B0\u65B0\u7684 USDT \u6388\u6743</b>\n\u5907\u6CE8\uFF1A{{remark}}\nOwner\uFF1A<code>{{owner}}</code>\nSpender\uFF1A<code>{{spender}}</code>\n\u88AB\u6388\u6743\u4EBA\u5907\u6CE8\uFF1A{{spender_remark}}\n\u5F53\u524D\u6388\u6743\uFF1A{{amount}}\n\u8D44\u91D1\u76D1\u63A7\uFF1A{{watch_status}}\n\u4EA4\u6613\uFF1A<code>{{tx_hash}}</code>",
  approval_change: "\u{1F504} <b>USDT \u6388\u6743\u53D8\u66F4</b>\n\u5907\u6CE8\uFF1A{{remark}}\n\u94B1\u5305\uFF1A<code>{{owner}}</code>\n\u88AB\u6388\u6743\u4EBA\uFF1A<code>{{spender}}</code>\n\u53D8\u5316\uFF1A{{event_type}}\n\u6700\u65B0\u989D\u5EA6\uFF1A{{amount}}\n\u4EA4\u6613\uFF1A<code>{{tx_hash}}</code>",
  transfer: "\u{1F514} <b>Ethereum \u8D44\u91D1\u5F02\u52A8</b>\n\u5907\u6CE8\uFF1A{{remark}}\n\u76D1\u63A7\u5730\u5740\uFF1A<code>{{address}}</code>\n\u8D44\u4EA7\uFF1A{{asset}}\n\u65B9\u5411\uFF1A{{direction}}\n\u91D1\u989D\uFF1A{{amount}} {{asset}}\n\u53D1\u9001\u65B9\uFF1A<code>{{from_address}}</code>\n\u63A5\u6536\u65B9\uFF1A<code>{{to_address}}</code>\n\u4EA4\u6613\uFF1A<code>{{tx_hash}}</code>\n\u533A\u5757\uFF1A{{block_number}}\n\u72B6\u6001\uFF1A\u9996\u4E2A\u533A\u5757\u5DF2\u786E\u8BA4",
  reorg_correction: "\u26A0\uFE0F <b>\u533A\u5757\u94FE\u91CD\u7EC4\u66F4\u6B63\u901A\u77E5</b>\n\u94B1\u5305\u5907\u6CE8\uFF1A{{remark}}\n\u5730\u5740\uFF1A<code>{{address}}</code>\n\u8D44\u4EA7\uFF1A{{asset}}\n\u4EA4\u6613\uFF1A<code>{{tx_hash}}</code>\n\u539F\u533A\u5757\uFF1A{{block_number}}\n\u539F\u4EA4\u6613\u6240\u5728\u533A\u5757\u5DF2\u79BB\u5F00\u5F53\u524D\u4E3B\u94FE\uFF0C\u4E4B\u524D\u7684\u63D0\u9192\u4E0D\u518D\u4EE3\u8868\u6709\u6548\u786E\u8BA4\u3002\u8BF7\u67E5\u770B\u94FE\u4E0A\u6700\u65B0\u4EA4\u6613\u72B6\u6001\u3002",
  query_progress: "\u{1F50E} <b>\u6B63\u5728\u67E5\u8BE2 USDT \u6388\u6743</b>\n\u5730\u5740\uFF1A<code>{{address}}</code>\n\u6B63\u5728\u68C0\u7D22\u5386\u53F2\u6388\u6743\u5E76\u6838\u9A8C\u5F53\u524D\u989D\u5EA6\uFF0C\u8BF7\u7A0D\u5019\u2026\u2026",
  query_active: "\u{1F6E1}\uFE0F <b>USDT \u6709\u6548\u6388\u6743</b>\n\u5907\u6CE8\uFF1A{{remark}}\n\u5730\u5740\uFF1A<code>{{address}}</code>\n{{approval_list}}{{more_count}}\n\u8D44\u91D1\u76D1\u63A7\uFF1A{{watch_status}}",
  query_inactive: "\u{1F50E} <b>USDT \u6388\u6743\u6838\u9A8C\u5B8C\u6210</b>\n\u5730\u5740\uFF1A<code>{{address}}</code>\n\u672A\u53D1\u73B0\u5F53\u524D\u6709\u6548\u6388\u6743\uFF0C\u56E0\u6B64\u672A\u81EA\u52A8\u542F\u52A8\u8D44\u91D1\u76D1\u63A7\u3002",
  query_failed: "\u26A0\uFE0F <b>USDT \u6388\u6743\u67E5\u8BE2\u672A\u5B8C\u6210</b>\n\u5730\u5740\uFF1A<code>{{address}}</code>\n\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002\u7CFB\u7EDF\u672A\u628A\u6B64\u5730\u5740\u9519\u8BEF\u6807\u8BB0\u4E3A\u65E0\u6388\u6743\uFF0C\u4E5F\u672A\u64C5\u81EA\u5F00\u542F\u76D1\u63A7\u3002",
  remark_prompt: "\u270F\uFE0F {{user_name}}\uFF0C\u8BF7<b>\u56DE\u590D\u8FD9\u6761\u6D88\u606F</b>\u8F93\u5165\u65B0\u7684\u5730\u5740\u5907\u6CE8\uFF1A\n<code>{{address}}</code>\n\u9650 1\u201380 \u4E2A\u5B57\u7B26\uFF0C10 \u5206\u949F\u5185\u6709\u6548\u3002",
  remark_invalid: "\u26A0\uFE0F \u5907\u6CE8\u5FC5\u987B\u4E3A 1\u201380 \u4E2A\u6709\u6548\u5B57\u7B26\uFF0C\u8BF7\u91CD\u65B0\u56DE\u590D\u3002",
  remark_unwatched: "\u26A0\uFE0F \u5F53\u524D\u7FA4\u7EC4\u5DF2\u505C\u6B62\u76D1\u63A7\u8FD9\u4E2A\u5730\u5740\u3002",
  remark_conflict: "\u26A0\uFE0F \u5907\u6CE8\u5DF2\u88AB\u5176\u4ED6\u6210\u5458\u66F4\u65B0\uFF0C\u8BF7\u91CD\u65B0\u70B9\u51FB\u4FEE\u6539\u6309\u94AE\u3002",
  remark_saved: "\u2705 \u5730\u5740\u5907\u6CE8\u5DF2\u66F4\u65B0\uFF1A<b>{{remark}}</b>\n<code>{{address}}</code>",
  start_welcome: "\u6B22\u8FCE\u4F7F\u7528 Ethereum USDT \u6388\u6743\u76D1\u63A7\u673A\u5668\u4EBA\u3002\u8BF7\u5C06\u673A\u5668\u4EBA\u52A0\u5165\u7FA4\u7EC4\u540E\u53D1\u9001 Ethereum \u5730\u5740\u67E5\u8BE2\u3002\n\u7BA1\u7406\u5458\u79C1\u804A\u9884\u8B66\u9700\u914D\u7F6E\u672C\u804A\u5929 ID\uFF1A{{chat_id}}",
  notice_failed: "\u26A0\uFE0F <b>\u901A\u77E5\u6295\u9012\u5931\u8D25</b>\n\u961F\u5217\u7F16\u53F7\uFF1A{{queue_id}}\n\u539F\u56E0\uFF1A{{error_message}}"
};
var defaults = DEFAULTS;
var templateCatalog = [
  {
    "key": "query_progress",
    "title": "\u6388\u6743\u67E5\u8BE2\u4E2D",
    "category": "\u67E5\u8BE2\u56DE\u590D",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u6210\u5458\u53D1\u9001\u94B1\u5305\u5730\u5740\u540E\u7ACB\u5373\u663E\u793A\uFF0C\u67E5\u8BE2\u7ED3\u675F\u540E\u81EA\u52A8\u5220\u9664\u3002",
    "variables": [
      "address"
    ],
    "temporary": true
  },
  {
    "key": "query_active",
    "title": "\u67E5\u8BE2\u5230\u6709\u6548 USDT \u6388\u6743",
    "category": "\u67E5\u8BE2\u56DE\u590D",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u5C55\u793A\u5730\u5740\u3001\u7FA4\u7EC4\u5907\u6CE8\u3001\u6388\u6743\u660E\u7EC6\u53CA\u8D44\u91D1\u76D1\u63A7\u72B6\u6001\uFF0C\u4FDD\u7559\u4FEE\u6539\u5907\u6CE8\u6309\u94AE\u3002",
    "variables": [
      "remark",
      "address",
      "approval_list",
      "more_count",
      "watch_status"
    ],
    "temporary": false
  },
  {
    "key": "query_inactive",
    "title": "\u672A\u67E5\u8BE2\u5230\u6709\u6548\u6388\u6743",
    "category": "\u67E5\u8BE2\u56DE\u590D",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u6838\u9A8C\u65E0\u6709\u6548 USDT \u6388\u6743\u65F6\u7684\u56DE\u590D\uFF0C\u4E0D\u542F\u52A8\u8D44\u91D1\u76D1\u63A7\u3002",
    "variables": [
      "address"
    ],
    "temporary": false
  },
  {
    "key": "query_failed",
    "title": "\u6388\u6743\u67E5\u8BE2\u5931\u8D25",
    "category": "\u67E5\u8BE2\u56DE\u590D",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u94FE\u4E0A\u63A5\u53E3\u6301\u7EED\u5931\u8D25\u540E\u7684\u515C\u5E95\u63D0\u9192\uFF0C\u4E0D\u4F1A\u9519\u8BEF\u5224\u65AD\u6210\u672A\u6388\u6743\u3002",
    "variables": [
      "address"
    ],
    "temporary": false
  },
  {
    "key": "remark_prompt",
    "title": "\u8BF7\u8F93\u5165\u65B0\u5907\u6CE8",
    "category": "\u5907\u6CE8\u7BA1\u7406",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u7FA4\u6210\u5458\u70B9\u51FB\u4FEE\u6539\u5907\u6CE8\u6309\u94AE\u540E\u663E\u793A\uFF0C\u5341\u5206\u949F\u540E\u81EA\u52A8\u6E05\u7406\u3002",
    "variables": [
      "user_name",
      "address"
    ],
    "temporary": true
  },
  {
    "key": "remark_invalid",
    "title": "\u5907\u6CE8\u683C\u5F0F\u4E0D\u7B26\u5408\u8981\u6C42",
    "category": "\u5907\u6CE8\u7BA1\u7406",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u7528\u6237\u63D0\u4EA4\u7A7A\u5907\u6CE8\u6216\u975E\u6CD5\u5185\u5BB9\u65F6\u53D1\u9001\uFF0C\u4F1A\u81EA\u52A8\u6E05\u7406\u3002",
    "variables": [],
    "temporary": true
  },
  {
    "key": "remark_unwatched",
    "title": "\u5907\u6CE8\u4FEE\u6539\u65F6\u5DF2\u505C\u6B62\u76D1\u63A7",
    "category": "\u5907\u6CE8\u7BA1\u7406",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u5730\u5740\u5DF2\u4ECE\u8BE5\u7FA4\u505C\u6B62\u76D1\u63A7\u65F6\u56DE\u590D\u3002",
    "variables": [],
    "temporary": false
  },
  {
    "key": "remark_conflict",
    "title": "\u5907\u6CE8\u88AB\u5176\u4ED6\u6210\u5458\u4FEE\u6539",
    "category": "\u5907\u6CE8\u7BA1\u7406",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u5E76\u53D1\u4FEE\u6539\u51B2\u7A81\u65F6\u63D0\u9192\u91CD\u65B0\u64CD\u4F5C\u3002",
    "variables": [],
    "temporary": false
  },
  {
    "key": "remark_saved",
    "title": "\u5907\u6CE8\u4FEE\u6539\u6210\u529F",
    "category": "\u5907\u6CE8\u7BA1\u7406",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u7FA4\u5907\u6CE8\u4FDD\u5B58\u6210\u529F\u540E\u7684\u6C38\u4E45\u7ED3\u679C\uFF0C\u9644\u4FEE\u6539\u5907\u6CE8\u6309\u94AE\u3002",
    "variables": [
      "remark",
      "address"
    ],
    "temporary": false
  },
  {
    "key": "new_approval",
    "title": "\u53D1\u73B0\u65B0 USDT \u6388\u6743",
    "category": "\u6388\u6743\u63A8\u9001",
    "mode": "\u4E3B\u52A8\u63A8\u9001",
    "description": "Spender \u65B0\u6388\u6743\u53D1\u73B0\u65F6\u63A8\u9001\u7ED9\u5BF9\u5E94\u7FA4\u7EC4\u3002",
    "variables": [
      "remark",
      "owner",
      "spender",
      "spender_remark",
      "amount",
      "watch_status",
      "tx_hash"
    ],
    "temporary": false
  },
  {
    "key": "approval_change",
    "title": "USDT \u6388\u6743\u989D\u5EA6\u53D8\u66F4",
    "category": "\u6388\u6743\u63A8\u9001",
    "mode": "\u4E3B\u52A8\u63A8\u9001",
    "description": "\u5DF2\u53D1\u73B0\u6388\u6743\u7684\u64A4\u9500\u3001\u589E\u52A0\u6216\u51CF\u5C11\u7B49\u53D8\u5316\u63D0\u9192\u3002",
    "variables": [
      "remark",
      "owner",
      "spender",
      "event_type",
      "amount",
      "tx_hash"
    ],
    "temporary": false
  },
  {
    "key": "transfer",
    "title": "ETH / USDT / USDC \u8F6C\u8D26\u63D0\u9192",
    "category": "\u8D44\u91D1\u76D1\u63A7",
    "mode": "\u4E3B\u52A8\u63A8\u9001",
    "description": "\u76D1\u63A7\u94B1\u5305\u53D1\u751F\u5165\u8D26\u6216\u51FA\u8D26\u5E76\u7ECF\u9996\u4E2A\u533A\u5757\u786E\u8BA4\u65F6\u63A8\u9001\u3002",
    "variables": [
      "remark",
      "address",
      "asset",
      "direction",
      "amount",
      "from_address",
      "to_address",
      "tx_hash",
      "block_number"
    ],
    "temporary": false
  },
  {
    "key": "reorg_correction",
    "title": "\u533A\u5757\u94FE\u91CD\u7EC4\u66F4\u6B63",
    "category": "\u8D44\u91D1\u76D1\u63A7",
    "mode": "\u4E3B\u52A8\u63A8\u9001",
    "description": "\u6B64\u524D\u786E\u8BA4\u7684\u533A\u5757\u88AB\u91CD\u7EC4\u66FF\u6362\u65F6\u53D1\u9001\u66F4\u6B63\u63D0\u9192\u3002",
    "variables": [
      "remark",
      "address",
      "asset",
      "tx_hash",
      "block_number"
    ],
    "temporary": false
  },
  {
    "key": "usage_alert",
    "title": "\u5E73\u53F0\u989D\u5EA6\u4E0E\u8D39\u7528\u9884\u8B66",
    "category": "\u7CFB\u7EDF\u901A\u77E5",
    "mode": "\u7CFB\u7EDF\u901A\u77E5",
    "description": "\u5E73\u53F0\u7528\u91CF\u8FBE\u5230 80% \u6216\u9884\u6D4B\u4E03\u5929\u5185\u8017\u5C3D\u65F6\u53D1\u7ED9\u7BA1\u7406\u5458\uFF1B\u4E5F\u7528\u4E8E\u8D39\u7528\u901A\u9053\u6D4B\u8BD5\u3002",
    "variables": [
      "alert_text"
    ],
    "temporary": false
  },
  {
    "key": "notice_failed",
    "title": "\u901A\u77E5\u53D1\u9001\u6700\u7EC8\u5931\u8D25",
    "category": "\u7CFB\u7EDF\u901A\u77E5",
    "mode": "\u7CFB\u7EDF\u901A\u77E5",
    "description": "\u901A\u77E5\u8FDE\u7EED\u6295\u9012\u5931\u8D25\uFF0C\u63D0\u9192\u7BA1\u7406\u5458\u68C0\u67E5\u9519\u8BEF\u539F\u56E0\u3002",
    "variables": [
      "queue_id",
      "error_message"
    ],
    "temporary": false
  },
  {
    "key": "start_welcome",
    "title": "\u673A\u5668\u4EBA\u79C1\u804A\u6B22\u8FCE\u6D88\u606F",
    "category": "\u7CFB\u7EDF\u901A\u77E5",
    "mode": "\u88AB\u52A8\u56DE\u590D",
    "description": "\u7BA1\u7406\u5458\u79C1\u804A\u5411\u673A\u5668\u4EBA\u53D1\u9001 /start \u65F6\u663E\u793A Chat ID\u3002",
    "variables": [
      "chat_id"
    ],
    "temporary": false
  }
];
function render(template, data, safeHtml = {}) {
  const allowed = /* @__PURE__ */ new Set(["remark", "address", "owner", "spender", "spender_remark", "amount", "asset", "direction", "from_address", "to_address", "tx_hash", "block_number", "event_type", "watch_status", "alert_text", "more_count", "user_name", "chat_id", "queue_id", "error_message"]);
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, name) => name === "approval_list" ? String(safeHtml.approval_list || "") : allowed.has(name) ? esc(data[name] ?? "\u2014") : "\u2014");
}
async function renderTemplate(env, key2, chatId, data = {}, safeHtml = {}) {
  const row = await env.DB.prepare("SELECT body FROM templates WHERE template_key=? AND chat_id IN (?, '*') ORDER BY CASE WHEN chat_id=? THEN 0 ELSE 1 END LIMIT 1").bind(key2, String(chatId), String(chatId)).first();
  return render(row?.body || DEFAULTS[key2] || "", data, safeHtml);
}
async function flushOutbox(env, max = 30, onlyUsage = false) {
  const { results: rows } = await env.DB.prepare("SELECT * FROM outbox WHERE state='pending' AND due_at<=CURRENT_TIMESTAMP " + (onlyUsage ? "AND template_key='usage_alert' " : "") + "ORDER BY id ASC LIMIT ?").bind(max).all();
  for (const row of rows || []) {
    const locked2 = await env.DB.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending'").bind(row.id).run();
    if (!locked2.meta?.changes) continue;
    try {
      const payload = JSON.parse(row.payload_json || "{}");
      if (payload.spender && (row.template_key === "new_approval" || row.template_key === "approval_change")) {
        const linked = await env.DB.prepare("SELECT r.chat_id,s.remark FROM spender_routes r JOIN spender_rules s ON s.spender=r.spender WHERE r.spender=? AND r.chat_id=?").bind(String(payload.spender).toLowerCase(), String(row.chat_id)).first();
        if (!linked) {
          await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Spender \u901A\u77E5\u7FA4\u5DF2\u66F4\u6362' WHERE id=?").bind(row.id).run();
          continue;
        }
        payload.spender_remark = linked.remark;
      }
      if (row.template_key === "usage_alert" && payload.expires_at && Date.parse(payload.expires_at) <= Date.now()) {
        await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Usage period has reset' WHERE id=?").bind(row.id).run();
        continue;
      }
      let remark = "\u2014";
      if (row.address) {
        const sub = await env.DB.prepare("SELECT remark,status FROM subscriptions WHERE address=? AND chat_id=?").bind(row.address, row.chat_id).first();
        if (!sub || sub.status !== "active") {
          await env.DB.prepare("UPDATE outbox SET state='skipped',last_error='Subscription no longer active' WHERE id=?").bind(row.id).run();
          continue;
        }
        remark = sub.remark;
      }
      const content = await renderTemplate(env, row.template_key, row.chat_id, { ...payload, remark, address: row.address });
      const result = await send(env, row.chat_id, content.slice(0, 3800), row.address ? buttons(row.address) : void 0);
      await env.DB.prepare("UPDATE outbox SET state='sent',sent_at=?,telegram_message_id=?,last_error=NULL WHERE id=?").bind(now(), result.message_id, row.id).run();
    } catch (e) {
      const message = String(e).slice(0, 250);
      if (row.attempts >= 5 && row.template_key !== "usage_alert") {
        await env.DB.prepare("UPDATE outbox SET state='failed',last_error=? WHERE id=?").bind(message, row.id).run();
        await notifyAdmin2(env, await renderTemplate(env, "notice_failed", env.ADMIN_TELEGRAM_CHAT_ID || "*", { queue_id: row.id, error_message: message }));
      } else {
        const seconds = Math.max(Number(e?.retryAfter) || 0, Math.min(3600, 30 * Math.pow(2, Math.min(row.attempts, 7))));
        await env.DB.prepare("UPDATE outbox SET state='pending',last_error=?,due_at=datetime('now',?) WHERE id=?").bind(message, "+" + seconds + " seconds", row.id).run();
      }
    }
  }
}
async function recoverStuck(env) {
  await env.DB.prepare("UPDATE outbox SET state='pending',due_at=datetime('now') WHERE state='sending' AND created_at<datetime('now','-10 minutes')").run();
}

// src/wallet-remarks.ts
async function walletRemark(env, address, fallback = "") {
  const row = await env.DB.prepare("SELECT remark FROM wallet_global_remarks WHERE address=?").bind(address).first();
  if (row?.remark) return row.remark;
  const existing = await env.DB.prepare("SELECT remark FROM subscriptions WHERE address=? ORDER BY updated_at DESC LIMIT 1").bind(address).first();
  return existing?.remark || fallback;
}
async function saveWalletRemark(env, address, value) {
  const a = addr(address), remark = String(value ?? "").trim();
  if (!a || !remark || Array.from(remark).length > 80 || /[\u0000-\u001f\u007f]/.test(remark)) throw Error("\u5907\u6CE8\u4E0D\u80FD\u4E3A\u7A7A\u3001\u6700\u591A80\u4E2A\u5B57\u7B26\uFF0C\u4E14\u4E0D\u80FD\u5305\u542B\u63A7\u5236\u5B57\u7B26");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO wallet_global_remarks(address,remark,updated_at) VALUES(?,?,?) ON CONFLICT(address) DO UPDATE SET remark=excluded.remark,updated_at=excluded.updated_at").bind(a, remark, now()),
    env.DB.prepare("UPDATE subscriptions SET remark=?,remark_version=remark_version+1,updated_at=? WHERE address=?").bind(remark, now(), a)
  ]);
  return remark;
}

// src/telegram.ts
async function memberAllowed(env, chatId, userId) {
  try {
    const m = await telegram(env, "getChatMember", { chat_id: chatId, user_id: Number(userId) });
    return !["left", "kicked"].includes(m.status);
  } catch (e) {
    console.warn("membership verification failed", String(e));
    return false;
  }
}
async function handleTelegram(env, upd) {
  if (upd.callback_query) {
    const c = upd.callback_query, data = String(c.data || "");
    await telegram(env, "answerCallbackQuery", { callback_query_id: c.id });
    if (!data.startsWith("remark:")) return;
    const address = addr(data.slice(7)), chat = c.message?.chat;
    if (!address || !chat || chat.type === "private") return;
    if (!await memberAllowed(env, chat.id, c.from.id)) return;
    const sub = await env.DB.prepare("SELECT 1 FROM subscriptions WHERE chat_id=? AND address=? AND status='active'").bind(String(chat.id), address).first();
    if (!sub) return;
    const prompt = await send(env, chat.id, await renderTemplate(env, "remark_prompt", String(chat.id), { user_name: c.from.first_name, address }), { force_reply: true, selective: true });
    await env.DB.prepare("INSERT OR REPLACE INTO remark_sessions(chat_id,user_id,prompt_message_id,address,expires_at) VALUES(?,?,?,?,datetime('now','+10 minutes'))").bind(String(chat.id), String(c.from.id), prompt.message_id, address).run();
    await scheduleMessageDeletion(env, String(chat.id), prompt.message_id, "remark_prompt_expired", 600);
    return;
  }
  const m = upd.message;
  if (!m || !m.from || !m.chat || !m.text) return;
  const chatId = String(m.chat.id), userId = String(m.from.id);
  const name = trunc([m.from.first_name, m.from.last_name].filter(Boolean).join(" "), 80) || userId;
  await env.DB.prepare("INSERT INTO telegram_users(user_id,display_name,username,last_seen_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,username=excluded.username,last_seen_at=excluded.last_seen_at").bind(userId, name, m.from.username || null, now()).run();
  await env.DB.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,chat_type=excluded.chat_type,active=1").bind(chatId, m.chat.title || "Private", m.chat.type).run();
  if (m.reply_to_message) {
    const session2 = await env.DB.prepare("SELECT * FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=? AND expires_at>datetime('now')").bind(chatId, userId, m.reply_to_message.message_id).first();
    if (session2) {
      const remark = trunc(m.text.trim(), 80);
      if (!remark || Array.from(m.text.trim()).length > 80 || /[\u0000-\u001f\u007f]/.test(remark)) {
        const notice = await send(env, chatId, await renderTemplate(env, "remark_invalid", chatId));
        await scheduleMessageDeletion(env, chatId, m.message_id, "invalid_remark_input", 90);
        await scheduleMessageDeletion(env, chatId, notice.message_id, "temporary_validation_notice", 90);
        return;
      }
      if (!await memberAllowed(env, m.chat.id, m.from.id)) return;
      const old = await env.DB.prepare("SELECT remark,remark_version FROM subscriptions WHERE chat_id=? AND address=? AND status='active'").bind(chatId, session2.address).first();
      if (!old) {
        await send(env, chatId, await renderTemplate(env, "remark_unwatched", chatId));
        await env.DB.prepare("DELETE FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=?").bind(chatId, userId, m.reply_to_message.message_id).run();
        try {
          await finishRemarkCleanup(env, chatId, m.reply_to_message.message_id, m.message_id);
        } catch (e) {
          console.warn("Remark cancellation cleanup", String(e));
        }
        return;
      }
      const result = await env.DB.prepare("UPDATE subscriptions SET remark=?,remark_version=remark_version+1,updated_at=? WHERE chat_id=? AND address=? AND remark_version=?").bind(remark, now(), chatId, session2.address, old.remark_version).run();
      if (!result.meta?.changes) {
        await send(env, chatId, await renderTemplate(env, "remark_conflict", chatId));
        await env.DB.prepare("DELETE FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=?").bind(chatId, userId, m.reply_to_message.message_id).run();
        try {
          await finishRemarkCleanup(env, chatId, m.reply_to_message.message_id, m.message_id);
        } catch (e) {
          console.warn("Remark conflict cleanup", String(e));
        }
        return;
      }
      await saveWalletRemark(env, session2.address, remark);
      await env.DB.prepare("INSERT INTO remark_edits(chat_id,address,actor_id,old_value,new_value) VALUES(?,?,?,?,?)").bind(chatId, session2.address, userId, old.remark, remark).run();
      await send(env, chatId, await renderTemplate(env, "remark_saved", chatId, { remark, address: session2.address }), buttons(session2.address));
      await env.DB.prepare("DELETE FROM remark_sessions WHERE chat_id=? AND user_id=? AND prompt_message_id=?").bind(chatId, userId, m.reply_to_message.message_id).run();
      try {
        await finishRemarkCleanup(env, chatId, m.reply_to_message.message_id, m.message_id);
      } catch (e) {
        console.warn("Remark cleanup deferred", String(e));
      }
      return;
    }
    const knownPrompt = await env.DB.prepare(
      "SELECT 1 FROM telegram_message_cleanup WHERE chat_id=? AND message_id=? AND reason LIKE 'remark_prompt%'"
    ).bind(chatId, m.reply_to_message.message_id).first();
    if (knownPrompt) {
      try {
        await scheduleMessageDeletion(env, chatId, m.message_id, "late_remark_reply");
      } catch (e) {
        console.warn("Late remark cleanup deferred", String(e));
      }
      return;
    }
  }
  if (m.chat.type === "private") {
    if (/^\/start/.test(m.text)) await send(env, chatId, await renderTemplate(env, "start_welcome", chatId, { chat_id: chatId }));
    return;
  }
  const match = m.text.trim().match(/^(?:\/check(?:@\w+)?\s+)?(0x[0-9a-fA-F]{40})$/);
  if (!match) return;
  const owner = addr(match[1]);
  if (!owner) return;
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,first_user_id,first_user_name,discovery_source) VALUES(?,?,?,'manual')").bind(owner, userId, name).run();
  await env.DB.prepare("UPDATE wallets SET first_user_id=?,first_user_name=? WHERE address=? AND first_user_id IS NULL").bind(userId, name, owner).run();
  const progress = await send(env, chatId, await renderTemplate(env, "query_progress", chatId, { address: owner }));
  await Promise.all([
    scheduleMessageDeletion(env, chatId, m.message_id, "query_address_stale", 1800),
    scheduleMessageDeletion(env, chatId, progress.message_id, "query_progress_stale", 1800)
  ]);
  await env.TASKS.send({
    kind: "check",
    owner,
    chat_id: chatId,
    user_id: userId,
    display_name: name,
    user_message_id: m.message_id,
    progress_message_id: progress.message_id
  });
  await increment(env, "telegram_queries");
}

// src/spender-history.ts
var HISTORY_WINDOW = 1e6;
var HISTORY_PAGE_SIZE = 200;
async function startSpenderHistory(env, spender) {
  const rule = await env.DB.prepare("SELECT start_block FROM spender_rules WHERE spender=?").bind(spender).first();
  if (!rule) throw Error("Spender not registered");
  await env.DB.prepare("INSERT OR IGNORE INTO spender_history_jobs(spender,next_block,cutoff_block,window_size,state) VALUES(?,0,?,?,'scanning')").bind(spender, Math.max(0, Number(rule.start_block) - 1), HISTORY_WINDOW).run();
}
function parseApprovalTime(log) {
  const raw = log.timeStamp || log.blockTimestamp;
  if (!raw) return null;
  try {
    const seconds = Number(BigInt(raw));
    return seconds > 14e8 && Number.isSafeInteger(seconds) ? new Date(seconds * 1e3).toISOString() : null;
  } catch {
    return null;
  }
}
function historyTimeStmt(env, spender, owner, block, time) {
  return env.DB.prepare("INSERT INTO spender_history_timestamps(spender,owner,block_number,approval_at) VALUES(?,?,?,?) ON CONFLICT(spender,owner) DO UPDATE SET block_number=excluded.block_number,approval_at=excluded.approval_at WHERE excluded.block_number>=spender_history_timestamps.block_number").bind(spender, owner, block, time);
}
function historyEventStmt(env, spender, owner, block, hash, amount) {
  return env.DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block,latest_tx_hash,last_event_amount_raw,verify_status) VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(spender,owner) DO UPDATE SET first_seen_block=MIN(spender_history_addresses.first_seen_block,excluded.first_seen_block),latest_tx_hash=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.latest_tx_hash ELSE spender_history_addresses.latest_tx_hash END,last_event_amount_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.last_event_amount_raw ELSE spender_history_addresses.last_event_amount_raw END,verify_status=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN 'pending' ELSE spender_history_addresses.verify_status END,current_allowance_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.current_allowance_raw END,verified_at=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.verified_at END,latest_event_block=MAX(spender_history_addresses.latest_event_block,excluded.latest_event_block)").bind(spender, owner, block, block, hash, amount);
}
async function recordSpenderLiveApproval(env, spender, log, amount) {
  const owner = fromTopic(log.topics?.[1]);
  if (!owner) return;
  const block = Number(BigInt(log.blockNumber));
  await historyEventStmt(env, spender, owner, block, log.transactionHash, BigInt(log.data || "0x0").toString()).run();
  const stamp = parseApprovalTime(log);
  if (stamp) await historyTimeStmt(env, spender, owner, block, stamp).run();
  await env.DB.prepare("UPDATE spender_history_addresses SET current_allowance_raw=?,verify_status=?,verified_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND latest_event_block<=?").bind(amount.toString(), amount > 0n ? "active" : "revoked", spender, owner, block).run();
}
async function fetchHistoryRange(env, spender, from, to) {
  if (!env.ETHERSCAN_API_KEY) throw Error("Etherscan V2 API Key \u672A\u914D\u7F6E");
  const q = new URLSearchParams({
    chainid: "1",
    module: "logs",
    action: "getLogs",
    address: USDT,
    fromBlock: String(from),
    toBlock: String(to),
    topic0: APPROVAL_TOPIC,
    topic2: toTopic(spender),
    topic0_2_opr: "and",
    page: "1",
    offset: String(HISTORY_PAGE_SIZE),
    apikey: env.ETHERSCAN_API_KEY
  });
  await recordUsage(env, "etherscan_requests");
  const response = await fetch("https://api.etherscan.io/v2/api?" + q.toString());
  if (!response.ok) throw Error("Etherscan HTTP " + response.status);
  const data = await response.json();
  const detail = String(data.result || data.message || "").slice(0, 200);
  if (data.status === "0" && /no records found/i.test(String(data.message) + " " + detail)) return [];
  if (data.status !== "1" || !Array.isArray(data.result)) throw Error("Etherscan \u5386\u53F2\u67E5\u8BE2\u5931\u8D25\uFF1A" + detail);
  return data.result;
}
async function scanSpenderHistories(env) {
  const job = await env.DB.prepare("SELECT j.* FROM spender_history_jobs j JOIN spender_rules r ON r.spender=j.spender WHERE r.enabled=1 AND (j.state IN ('scanning','retrying') OR (j.state='running' AND j.updated_at<datetime('now','-5 minutes'))) ORDER BY j.updated_at ASC LIMIT 1").first();
  if (!job) return false;
  const locked2 = await env.DB.prepare("UPDATE spender_history_jobs SET state='running',updated_at=CURRENT_TIMESTAMP WHERE spender=? AND (state IN ('scanning','retrying') OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(job.spender).run();
  if (!(locked2.meta?.changes > 0)) return false;
  try {
    const begin = Number(job.next_block), cutoff = Number(job.cutoff_block);
    if (begin > cutoff) {
      await env.DB.prepare("UPDATE spender_history_jobs SET state='completed',last_error=NULL,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(job.spender).run();
      return false;
    }
    const window = Math.max(1, Math.min(HISTORY_WINDOW, Number(job.window_size) || HISTORY_WINDOW));
    const end = Math.min(cutoff, begin + window - 1);
    const logs = await fetchHistoryRange(env, job.spender, begin, end);
    if (logs.length >= HISTORY_PAGE_SIZE) {
      if (end === begin) throw Error("\u5355\u4E2A\u533A\u5757\u6388\u6743\u4E8B\u4EF6\u8D85\u51FA\u63A5\u53E3\u8FD4\u56DE\u4E0A\u9650\uFF1B\u9700\u8981\u5206\u9875\u68C0\u7D22\uFF0C\u4E0D\u4F1A\u8DF3\u8FC7\u6B64\u533A\u5757");
      await env.DB.prepare("UPDATE spender_history_jobs SET state='scanning',window_size=?,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(Math.max(1, Math.floor(window / 2)), job.spender).run();
      return true;
    }
    const latest = /* @__PURE__ */ new Map();
    for (const log of logs) {
      if (log.removed) continue;
      if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== APPROVAL_TOPIC || log.topics[2]?.toLowerCase() !== toTopic(job.spender)) throw Error("Etherscan \u8FD4\u56DE\u4E86\u4E0E Spender \u4E0D\u7B26\u7684\u6388\u6743\u4E8B\u4EF6");
      const owner = fromTopic(log.topics[1]);
      if (!owner || !/^0x[0-9a-fA-F]{64}$/.test(String(log.data || "")) || !/^0x[0-9a-fA-F]{64}$/.test(String(log.transactionHash || ""))) throw Error("\u5386\u53F2\u6388\u6743\u4E8B\u4EF6\u683C\u5F0F\u4E0D\u5B8C\u6574");
      const block = Number(BigInt(log.blockNumber));
      if (!Number.isSafeInteger(block) || block < begin || block > end) throw Error("\u5386\u53F2\u6388\u6743\u4E8B\u4EF6\u533A\u5757\u8303\u56F4\u4E0D\u5339\u914D");
      const event = { owner, block, hash: log.transactionHash, amount: BigInt(log.data).toString(), stamp: parseApprovalTime(log) };
      const previous = latest.get(owner);
      if (!previous) latest.set(owner, { ...event, first: block });
      else {
        previous.first = Math.min(previous.first, block);
        if (block >= previous.block) {
          previous.block = block;
          previous.hash = event.hash;
          previous.amount = event.amount;
          previous.stamp = event.stamp;
        }
      }
    }
    const records = [...latest.values()];
    for (let i = 0; i < records.length; i += 35) {
      const statements = records.slice(i, i + 35).map((row) => historyEventStmt(env, job.spender, row.owner, row.block, row.hash, row.amount));
      for (let j = 0; j < statements.length; j++) {
        if (records[i + j].first !== records[i + j].block) statements[j] = env.DB.prepare("INSERT INTO spender_history_addresses(spender,owner,first_seen_block,latest_event_block,latest_tx_hash,last_event_amount_raw,verify_status) VALUES(?,?,?,?,?,?,'pending') ON CONFLICT(spender,owner) DO UPDATE SET first_seen_block=MIN(spender_history_addresses.first_seen_block,excluded.first_seen_block),latest_tx_hash=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.latest_tx_hash ELSE spender_history_addresses.latest_tx_hash END,last_event_amount_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN excluded.last_event_amount_raw ELSE spender_history_addresses.last_event_amount_raw END,verify_status=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN 'pending' ELSE spender_history_addresses.verify_status END,current_allowance_raw=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.current_allowance_raw END,verified_at=CASE WHEN excluded.latest_event_block>=spender_history_addresses.latest_event_block THEN NULL ELSE spender_history_addresses.verified_at END,latest_event_block=MAX(spender_history_addresses.latest_event_block,excluded.latest_event_block)").bind(job.spender, records[i + j].owner, records[i + j].first, records[i + j].block, records[i + j].hash, records[i + j].amount);
      }
      await env.DB.batch(statements);
      const times = records.slice(i, i + 35).filter((row) => row.stamp).map((row) => historyTimeStmt(env, job.spender, row.owner, row.block, row.stamp));
      if (times.length) await env.DB.batch(times);
    }
    const next = end + 1;
    await env.DB.prepare("UPDATE spender_history_jobs SET next_block=?,window_size=?,state=?,events_found=events_found+?,last_error=NULL,retry_count=0,updated_at=CURRENT_TIMESTAMP,finished_at=CASE WHEN ?>cutoff_block THEN CURRENT_TIMESTAMP ELSE finished_at END WHERE spender=?").bind(next, Math.min(HISTORY_WINDOW, Math.max(5e3, window * 2)), next > cutoff ? "completed" : "scanning", logs.length, next, job.spender).run();
    return next <= cutoff;
  } catch (e) {
    console.error("Spender history scan", job.spender, String(e));
    const message = String(e.message || e).slice(0, 240);
    if (/block range|query timeout|too large|response size|exceed|more than|too many records|window limit/i.test(message) && Number(job.window_size) > 1) {
      await env.DB.prepare("UPDATE spender_history_jobs SET window_size=?,state='scanning',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(Math.max(1, Math.floor(Number(job.window_size) / 2)), "\u8BF7\u6C42\u8303\u56F4\u8FC7\u5927\uFF0C\u6B63\u5728\u81EA\u52A8\u7F29\u5C0F\u533A\u5757\u8303\u56F4", job.spender).run();
      return true;
    }
    await env.DB.prepare("UPDATE spender_history_jobs SET state='retrying',last_error=?,retry_count=retry_count+1,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(String(e.message || e).slice(0, 240), job.spender).run();
    return false;
  }
}
async function verifyHistoricalAllowances(env, max = 8) {
  const rows = (await env.DB.prepare("SELECT h.spender,h.owner FROM spender_history_addresses h JOIN spender_rules r ON r.spender=h.spender WHERE h.verify_status='pending' AND r.enabled=1 ORDER BY h.latest_event_block DESC LIMIT ?").bind(max).all()).results || [];
  for (const row of rows) {
    try {
      const value = await allowance(env, row.owner, row.spender);
      await env.DB.prepare("UPDATE spender_history_addresses SET current_allowance_raw=?,verify_status=?,verified_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND verify_status='pending'").bind(value.toString(), value > 0n ? "active" : "revoked", row.spender, row.owner).run();
    } catch (e) {
      console.error("History allowance verification", row.spender, row.owner, String(e));
      break;
    }
  }
}

// src/approval.ts
async function ownerSpenders(env, owner) {
  if (!env.ETHERSCAN_API_KEY) throw Error("ETHERSCAN_API_KEY required for complete historical spender discovery");
  const found = /* @__PURE__ */ new Set();
  for (let page = 1; page <= 10; page++) {
    const q = new URLSearchParams({
      chainid: "1",
      module: "logs",
      action: "getLogs",
      address: USDT,
      topic0: APPROVAL_TOPIC,
      topic1: toTopic(owner),
      topic0_1_opr: "and",
      fromBlock: "0",
      toBlock: "latest",
      page: String(page),
      offset: "1000",
      apikey: env.ETHERSCAN_API_KEY
    });
    await recordUsage(env, "etherscan_requests");
    const r = await fetch("https://api.etherscan.io/v2/api?" + q);
    if (!r.ok) throw Error("Etherscan HTTP " + r.status);
    const d = await r.json();
    if (d.status === "0" && /no records found/i.test(String(d.message) + " " + String(d.result))) return [...found];
    if (d.status !== "1" || !Array.isArray(d.result)) throw Error("Historical log query failed: " + String(d.result || d.message).slice(0, 120));
    for (const log of d.result) if (log.topics?.[0]?.toLowerCase() === APPROVAL_TOPIC && log.topics?.[1]?.toLowerCase() === toTopic(owner)) {
      const a = fromTopic(log.topics[2]);
      if (a) found.add(a);
    }
    if (d.result.length < 1e3) return [...found];
  }
  throw Error("Historical allowance log scan exceeds configured pagination limit; result incomplete");
}
async function verifyAdminOwner(env, owner, chat_id) {
  const spenders = await ownerSpenders(env, owner);
  let active = 0;
  for (const spender of spenders) if (await allowance(env, owner, spender) > 0n) active++;
  if (active === 0) return { active: false, checked: spenders.length };
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'admin')").bind(owner).run();
  const watched = await ensureWatch(env, owner);
  if (watched) await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(owner).run();
  return { active: watched, allowances: active };
}
async function checkOwner(env, owner, chat_id, user_id, display_name) {
  const spenders = await ownerSpenders(env, owner);
  const positives = [];
  for (const spender of spenders) {
    const amt = await allowance(env, owner, spender);
    if (amt > 0n) positives.push({ spender, amount: amt.toString() });
  }
  await env.DB.prepare("INSERT INTO query_history(user_id,chat_id,address,result) VALUES(?,?,?,?)").bind(String(user_id), String(chat_id), owner, positives.length ? "authorized" : "no_effective_allowance").run();
  if (!positives.length) {
    await send(env, chat_id, await renderTemplate(env, "query_inactive", chat_id, { address: owner }));
    return;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,first_user_id,first_user_name,discovery_source) VALUES(?,?,?,'manual')").bind(owner, String(user_id), display_name).run();
  await env.DB.prepare("UPDATE wallets SET first_user_id=?,first_user_name=? WHERE address=? AND first_user_id IS NULL").bind(String(user_id), display_name, owner).run();
  const first = await env.DB.prepare("SELECT first_user_name FROM wallets WHERE address=?").bind(owner).first();
  const sharedRemark = await walletRemark(env, owner, first?.first_user_name || display_name);
  await env.DB.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending') ON CONFLICT(chat_id,address) DO UPDATE SET status=CASE WHEN status='removed' THEN 'pending' ELSE status END").bind(String(chat_id), owner, sharedRemark).run();
  const watched = await ensureWatch(env, owner);
  if (watched) await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE chat_id=? AND address=? AND status='pending'").bind(String(chat_id), owner).run();
  const current = await env.DB.prepare("SELECT remark FROM subscriptions WHERE chat_id=? AND address=?").bind(String(chat_id), owner).first();
  const groupRemark = await walletRemark(env, owner, current?.remark || first?.first_user_name || display_name);
  const lines = positives.slice(0, 25).map((x, i) => i + 1 + ". <code>" + esc(x.spender) + "</code>\n\u989D\u5EA6\uFF1A" + (BigInt(x.amount) >= 1n << 255n ? "\u65E0\u9650" : formatUnits(x.amount, 6) + " USDT"));
  const output = await renderTemplate(env, "query_active", chat_id, {
    remark: groupRemark,
    address: owner,
    more_count: positives.length > 25 ? "\n\u53E6\u6709 " + (positives.length - 25) + " \u9879\u6709\u6548\u6388\u6743\uFF0C\u8BF7\u5728\u540E\u53F0\u67E5\u770B\u3002" : "",
    watch_status: watched ? "\u2705 ETH / USDT / USDC \u5DF2\u542F\u52A8" : "\u26A0\uFE0F \u7B49\u5F85 Alchemy \u8BA2\u9605\u540C\u6B65\uFF0C\u5C1A\u672A\u6B63\u5F0F\u542F\u52A8"
  }, { approval_list: lines.join("\n") });
  await send(env, chat_id, output, buttons(owner));
  await increment(env, "wallet_lookups");
}
async function addSpender(env, spender, remark, chat_ids) {
  const head = await blockNumber(env);
  await env.DB.prepare("INSERT INTO spender_rules(spender,remark,start_block,cursor_block) VALUES(?,?,?,?) ON CONFLICT(spender) DO UPDATE SET remark=excluded.remark,enabled=1").bind(spender, remark, head, head).run();
  for (const chat of chat_ids || []) await env.DB.prepare("INSERT OR IGNORE INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(spender, String(chat)).run();
}
async function pollSpenders(env) {
  const head = await blockNumber(env);
  const { results: rules } = await env.DB.prepare("SELECT * FROM spender_rules WHERE enabled=1 ORDER BY cursor_block ASC LIMIT 40").all();
  for (const rule of rules || []) {
    const from = rule.cursor_block + 1;
    const to = Math.min(head, from + 499);
    if (from > to) continue;
    try {
      const logs = await rpc(env, "eth_getLogs", [{ address: USDT, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics: [APPROVAL_TOPIC, null, toTopic(rule.spender)] }]);
      for (const log of logs || []) {
        if (log.removed) continue;
        await processApproval(env, rule, log);
      }
      await env.DB.prepare("UPDATE spender_rules SET cursor_block=? WHERE spender=?").bind(to, rule.spender).run();
    } catch (e) {
      console.error("Spender polling failed", rule.spender, String(e));
    }
  }
}
async function processApproval(env, rule, log) {
  const owner = fromTopic(log.topics?.[1]);
  if (!owner) return;
  const ok = await receiptSuccess(env, log.transactionHash);
  if (ok !== true) return;
  const amount = await allowance(env, owner, rule.spender);
  await recordSpenderLiveApproval(env, rule.spender, log, amount);
  const manuallyExcluded = await env.DB.prepare("SELECT 1 FROM wallet_exclusions WHERE address=?").bind(owner).first();
  const walletRecord = await env.DB.prepare("SELECT deleted_at FROM wallets WHERE address=?").bind(owner).first();
  if (manuallyExcluded || walletRecord?.deleted_at) return;
  const previous = await env.DB.prepare("SELECT amount_raw FROM allowances WHERE owner=? AND spender=?").bind(owner, rule.spender).first();
  const before = BigInt(previous?.amount_raw || "0");
  const evId = "approval:" + log.transactionHash + ":" + log.logIndex;
  const type = amount === 0n ? "revoked" : !previous ? "new" : before === 0n ? "reauthorized" : amount > before ? "increased" : amount < before ? "decreased" : "unchanged";
  await env.DB.prepare("INSERT OR IGNORE INTO approval_events(event_id,owner,spender,amount_raw,block_number,tx_hash,event_type) VALUES(?,?,?,?,?,?,?)").bind(evId, owner, rule.spender, amount.toString(), Number(BigInt(log.blockNumber)), log.transactionHash, type).run();
  await env.DB.prepare("INSERT INTO allowances(owner,spender,amount_raw,first_seen_block,latest_block) VALUES(?,?,?,?,?) ON CONFLICT(owner,spender) DO UPDATE SET amount_raw=excluded.amount_raw,latest_block=excluded.latest_block,updated_at=CURRENT_TIMESTAMP").bind(owner, rule.spender, amount.toString(), Number(BigInt(log.blockNumber)), Number(BigInt(log.blockNumber))).run();
  const registered = await env.DB.prepare("SELECT 1 FROM wallet_watches WHERE address=?").bind(owner).first();
  if (amount > 0n && (!registered || !previous)) {
    await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'spender')").bind(owner).run();
    const { results: routes } = await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(rule.spender).all();
    for (const route of routes || []) {
      const chat = String(route.chat_id);
      const exists = await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first();
      if (!exists) continue;
      const remark = await walletRemark(env, owner, "\u5F85\u5907\u6CE8 \xB7 " + short(owner));
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat, owner, remark).run();
    }
    const watched = await ensureWatch(env, owner, Number(BigInt(log.blockNumber)));
    if (watched) await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(owner).run();
    for (const route of routes || []) await queueNotice(env, {
      dedup: evId + ":" + route.chat_id,
      chat_id: route.chat_id,
      address: owner,
      template: "new_approval",
      payload: { owner, spender: rule.spender, spender_remark: rule.remark, amount: formatUnits(amount, 6) + " USDT", tx_hash: log.transactionHash, watch_status: watched ? "active" : "pending" }
    });
    await increment(env, "discovered_wallets");
  } else if (type !== "unchanged" && previous) {
    const { results: routes } = await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(rule.spender).all();
    for (const route of routes || []) await queueNotice(env, {
      dedup: evId + ":" + route.chat_id,
      chat_id: route.chat_id,
      address: owner,
      template: "approval_change",
      payload: { owner, spender: rule.spender, spender_remark: rule.remark, amount: formatUnits(amount, 6) + " USDT", event_type: type, tx_hash: log.transactionHash }
    });
  }
}

// src/spender-enroll.ts
var ENROLL_BATCH = 20;
var BACKOFF_KEY = "spender_enroll_retry_after";
var LOCK_KEY = "spender_enroll_batch_lock";
async function setEnrollmentCooldown(env, minutes) {
  const until = String(Date.now() + minutes * 6e4);
  await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(BACKOFF_KEY, until).run();
}
async function enrollHistoricalOwners(env, limit = ENROLL_BATCH) {
  const db = env.DB;
  await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=COALESCE(synced_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE state IN ('retrying','pending','running') AND EXISTS (SELECT 1 FROM wallet_watches w WHERE w.address=spender_history_monitor_enrollments.owner AND w.state='active') AND EXISTS (SELECT 1 FROM subscriptions s JOIN spender_routes r ON r.chat_id=s.chat_id AND r.spender=spender_history_monitor_enrollments.spender WHERE s.address=spender_history_monitor_enrollments.owner AND s.status='active') AND NOT EXISTS (SELECT 1 FROM wallet_exclusions x WHERE x.address=spender_history_monitor_enrollments.owner)").run();
  const wait = await db.prepare("SELECT value FROM runtime_state WHERE key=?").bind(BACKOFF_KEY).first();
  if (Number(wait?.value || 0) > Date.now()) return { cooldown: true, until: Number(wait.value) };
  const lock = await db.prepare("INSERT OR IGNORE INTO runtime_state(key,value) VALUES(?,?)").bind(LOCK_KEY, now()).run();
  if (!lock.meta?.changes) {
    const old = await db.prepare("SELECT updated_at FROM runtime_state WHERE key=?").bind(LOCK_KEY).first();
    if (old && Date.now() - (/* @__PURE__ */ new Date(old.updated_at + "Z")).getTime() > 3e5) {
      await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK_KEY).run();
    }
    return { busy: true };
  }
  try {
    const query = "SELECT h.spender,h.owner FROM spender_history_addresses h JOIN spender_rules r ON r.spender=h.spender AND r.enabled=1 LEFT JOIN wallets w ON w.address=h.owner LEFT JOIN wallet_exclusions x ON x.address=h.owner LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner WHERE x.address IS NULL AND (w.deleted_at IS NULL OR w.address IS NULL) AND (e.spender IS NULL OR (e.state IN ('pending','retrying') AND e.updated_at<datetime('now','-90 seconds')) OR (e.state='running' AND e.updated_at<datetime('now','-5 minutes'))) ORDER BY h.first_seen_block ASC LIMIT ?";
    const rows = (await db.prepare(query).bind(Math.max(1, Math.min(ENROLL_BATCH, limit))).all()).results || [];
    if (!rows.length) return { processed: 0 };
    const toSync = [];
    for (const row of rows) {
      const { spender, owner } = row;
      try {
        await db.prepare("INSERT OR IGNORE INTO spender_history_monitor_enrollments(spender,owner,state) VALUES(?,?,'pending')").bind(spender, owner).run();
        const claimed = await db.prepare("UPDATE spender_history_monitor_enrollments SET state='running',attempts=attempts+1,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=? AND (state='pending' OR (state='retrying' AND updated_at<datetime('now','-90 seconds')) OR (state='running' AND updated_at<datetime('now','-5 minutes')))").bind(spender, owner).run();
        if (!claimed.meta?.changes) continue;
        const exclude = await db.prepare("SELECT 1 FROM wallet_exclusions WHERE address=?").bind(owner).first();
        const archived = await db.prepare("SELECT deleted_at FROM wallets WHERE address=?").bind(owner).first();
        if (exclude || archived?.deleted_at) {
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='excluded',last_error='\u7BA1\u7406\u5458\u5DF2\u624B\u52A8\u79FB\u9664',updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(spender, owner).run();
          continue;
        }
        await db.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'spender_history')").bind(owner).run();
        const remark = await walletRemark(env, owner, "\u5F85\u5907\u6CE8 \xB7 " + short(owner));
        const groups = (await db.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(spender).all()).results || [];
        if (!groups.length) throw Error("Spender \u672A\u8BBE\u7F6E\u901A\u77E5\u7FA4");
        for (const group of groups) {
          const chat = String(group.chat_id);
          if (!await db.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()) continue;
          await db.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat, owner, remark).run();
        }
        const state = await db.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(owner).first();
        if (state?.state === "active") {
          await db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(owner, spender).run();
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(spender, owner).run();
        } else toSync.push({ spender, owner });
      } catch (e) {
        const reason = String(e.message || e).slice(0, 210);
        await db.prepare("UPDATE spender_history_monitor_enrollments SET state='retrying',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(reason, spender, owner).run();
      }
    }
    if (!toSync.length) return { processed: rows.length, alreadyWatched: true };
    const unique = [...new Set(toSync.map((x) => x.owner))];
    try {
      if (!env.ALCHEMY_ACTIVITY_WEBHOOK_ID) {
        const created = await ensureWatch(env, unique[0]);
        if (!created) throw Error("Alchemy webhook \u521B\u5EFA\u5931\u8D25");
        const one = unique.shift();
        const matched = toSync.filter((x) => x.owner === one);
        for (const row of matched) {
          await db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(row.owner, row.spender).run();
          await db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(row.spender, row.owner).run();
        }
      }
      if (!unique.length) return { processed: rows.length };
      if (!env.ALCHEMY_NOTIFY_TOKEN || !env.ALCHEMY_ACTIVITY_WEBHOOK_ID) throw Error("Alchemy Notify Token / Webhook ID \u672A\u914D\u7F6E");
      const latest = await blockNumber(env);
      const setup = [];
      for (const owner of unique) {
        setup.push(db.prepare("INSERT OR IGNORE INTO wallet_watches(address,state) VALUES(?,'pending')").bind(owner));
        setup.push(db.prepare("INSERT OR IGNORE INTO wallet_checkpoints(address,last_block) VALUES(?,?)").bind(owner, Math.max(0, latest - 1)));
      }
      await db.batch(setup);
      const res = await fetch("https://dashboard.alchemy.com/api/update-webhook-addresses", {
        method: "PATCH",
        headers: { "content-type": "application/json", "X-Alchemy-Token": env.ALCHEMY_NOTIFY_TOKEN },
        body: JSON.stringify({ webhook_id: env.ALCHEMY_ACTIVITY_WEBHOOK_ID, addresses_to_add: unique, addresses_to_remove: [] })
      });
      const body2 = await res.text();
      if (!res.ok) throw Error("Alchemy batch sync HTTP " + res.status + " " + body2.slice(0, 130));
      let parsed;
      try {
        parsed = JSON.parse(body2);
      } catch {
      }
      if (parsed?.success === false || parsed?.error) throw Error("Alchemy batch rejected: " + JSON.stringify(parsed.error || parsed.message).slice(0, 150));
      const stamp = now();
      const statements = [];
      for (const owner of unique) statements.push(db.prepare("UPDATE wallet_watches SET state='active',synced_at=?,last_error=NULL,updated_at=? WHERE address=?").bind(stamp, stamp, owner));
      for (const row of toSync) {
        statements.push(db.prepare("UPDATE subscriptions SET status='active',updated_at=CURRENT_TIMESTAMP WHERE address=? AND status='pending' AND chat_id IN (SELECT chat_id FROM spender_routes WHERE spender=?)").bind(row.owner, row.spender));
        statements.push(db.prepare("UPDATE spender_history_monitor_enrollments SET state='active',last_error=NULL,synced_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(row.spender, row.owner));
      }
      await db.batch(statements);
      await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(BACKOFF_KEY).run();
      return { processed: rows.length, synced: unique.length };
    } catch (e) {
      const reason = String(e.message || e).slice(0, 225);
      const limited = /HTTP 429|error code:\s*1015|rate limit/i.test(reason);
      if (limited) await setEnrollmentCooldown(env, 15);
      else if (/HTTP 5\d\d/.test(reason)) await setEnrollmentCooldown(env, 5);
      console.error("Historical Spender bulk enrollment failed", reason);
      for (const row of toSync) {
        await db.prepare("UPDATE spender_history_monitor_enrollments SET state='retrying',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE spender=? AND owner=?").bind(reason, row.spender, row.owner).run();
        await db.prepare("UPDATE wallet_watches SET last_error=?,updated_at=CURRENT_TIMESTAMP WHERE address=? AND state='pending'").bind(reason, row.owner).run();
      }
      return { processed: 0, error: reason, cooldown: limited };
    }
  } finally {
    await db.prepare("DELETE FROM runtime_state WHERE key=?").bind(LOCK_KEY).run();
  }
}

// src/transfers.ts
var asNum = (x) => typeof x === "string" && x.startsWith("0x") ? Number(BigInt(x)) : Number(x || 0);
function identify(a) {
  const category = String(a.category || "").toLowerCase();
  if (category === "external" || category === "internal") return { asset: "ETH", decimals: 18 };
  if (category !== "erc20") return null;
  const contract = addr(a.rawContract?.address || a.contractAddress || "");
  if (contract === USDT) return { asset: "USDT", decimals: 6 };
  if (contract === USDC) return { asset: "USDC", decimals: 6 };
  return null;
}
function displayAmount(a, asset) {
  if (a.value !== void 0 && a.value !== null) return String(a.value);
  const raw = a.rawContract?.rawValue;
  if (raw !== void 0 && raw !== null) {
    let n = BigInt(raw), d = asset === "ETH" ? 18 : 6, txt = n.toString().padStart(d + 1, "0");
    return txt.slice(0, -d) + (txt.slice(-d).replace(/0+$/, "") ? "." + txt.slice(-d).replace(/0+$/, "") : "");
  }
  return "\u672A\u77E5";
}
async function processActivity(env, payload) {
  const event = payload.event || {};
  if (event.network && event.network !== "ETH_MAINNET") throw Error("Not Ethereum mainnet activity");
  if (payload.network && payload.network !== "ETH_MAINNET") throw Error("Invalid source network");
  const activities = event.activity || [];
  for (const a of activities) {
    const asset = identify(a);
    if (!asset) continue;
    const from = addr(a.fromAddress), to = addr(a.toAddress);
    if (!from || !to) continue;
    const hash = a.hash || a.transactionHash;
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash || "")) continue;
    const success = await receiptSuccess(env, hash);
    if (success !== true) continue;
    const baseId = "tx:" + hash + ":" + (a.uniqueId || a.logIndex || a.category + ":" + from + ":" + to + ":" + a.rawContract?.rawValue);
    const block = asNum(a.blockNum || a.blockNumber);
    const val = displayAmount(a, asset.asset);
    const owners = from === to ? [{ address: from, direction: "\u81EA\u8F6C" }] : [{ address: from, direction: "\u8F6C\u51FA" }, { address: to, direction: "\u8F6C\u5165" }];
    for (const o of owners) {
      const watch = await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=? AND state='active'").bind(o.address).first();
      if (!watch) continue;
      const eventId = baseId + ":" + o.address + ":" + o.direction;
      const inserted = await env.DB.prepare("INSERT OR IGNORE INTO transfer_events(event_id,address,asset,direction,raw_amount,from_address,to_address,tx_hash,block_number,block_hash) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(eventId, o.address, asset.asset, o.direction, val, from, to, hash, block, a.blockHash || null).run();
      if (!inserted.meta?.changes) continue;
      const { results: subs } = await env.DB.prepare("SELECT chat_id FROM subscriptions WHERE address=? AND status='active'").bind(o.address).all();
      for (const s of subs || []) await queueNotice(env, {
        dedup: eventId + ":" + s.chat_id,
        chat_id: s.chat_id,
        address: o.address,
        template: "transfer",
        payload: { asset: asset.asset, direction: o.direction, amount: val, from_address: from, to_address: to, tx_hash: hash, block_number: block }
      });
      await increment(env, "transfer_events");
    }
  }
}

// src/recovery.ts
async function getOneDirection(env, address, direction, from, to) {
  let cursor = null, loops = 0, transactions = 0;
  do {
    if (++loops > 20) throw Error("Transfer backlog exceeds 20 pages; abort without advancing checkpoint");
    const params = {
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
      order: "asc",
      category: ["external", "internal", "erc20"],
      contractAddresses: [USDT, USDC],
      excludeZeroValue: true,
      withMetadata: false,
      maxCount: "0x3e8",
      ...direction === "out" ? { fromAddress: address } : { toAddress: address },
      ...cursor ? { pageKey: cursor } : {}
    };
    const page = await rpc(env, "alchemy_getAssetTransfers", [params]);
    if (!page || !Array.isArray(page.transfers)) throw Error("Alchemy transfer page is invalid");
    const normalized = page.transfers.map((x) => ({
      fromAddress: x.from,
      toAddress: x.to,
      hash: x.hash,
      uniqueId: x.uniqueId,
      blockNum: x.blockNum,
      value: x.value,
      category: x.category,
      rawContract: { address: x.rawContract?.address, rawValue: x.rawContract?.value }
    }));
    await processActivity(env, { network: "ETH_MAINNET", event: { network: "ETH_MAINNET", activity: normalized } });
    transactions += normalized.length;
    cursor = page.pageKey || null;
  } while (cursor);
  return transactions;
}
async function scanWalletGaps(env, maxWallets = 3) {
  const head = await blockNumber(env);
  const { results: wallets } = await env.DB.prepare(
    "SELECT c.address,c.last_block FROM wallet_checkpoints c JOIN wallet_watches w ON c.address=w.address WHERE w.state='active' AND c.last_block<? ORDER BY c.last_block ASC LIMIT ?"
  ).bind(head, maxWallets).all();
  for (const w of wallets || []) {
    const from = Math.max(0, w.last_block - 5), to = Math.min(head, w.last_block + 120);
    try {
      await getOneDirection(env, w.address, "out", from, to);
      await getOneDirection(env, w.address, "in", from, to);
      await env.DB.prepare("UPDATE wallet_checkpoints SET last_block=?,checked_at=?,last_error=NULL WHERE address=?").bind(to, now(), w.address).run();
    } catch (e) {
      await env.DB.prepare("UPDATE wallet_checkpoints SET last_error=? WHERE address=?").bind(String(e).slice(0, 300), w.address).run();
      console.error("Wallet recovery failure", w.address, String(e));
    }
  }
}
async function reconcileRecentReorgs(env) {
  const head = await blockNumber(env);
  const { results: rows } = await env.DB.prepare(
    "SELECT DISTINCT block_number,block_hash FROM transfer_events WHERE state='confirmed' AND block_hash IS NOT NULL AND block_number BETWEEN ? AND ? LIMIT 16"
  ).bind(Math.max(0, head - 16), head).all();
  for (const row of rows || []) {
    try {
      const block = await rpc(env, "eth_getBlockByNumber", ["0x" + row.block_number.toString(16), false]);
      if (!block || block.hash?.toLowerCase() === row.block_hash.toLowerCase()) continue;
      const { results: changed } = await env.DB.prepare(
        "SELECT * FROM transfer_events WHERE block_number=? AND block_hash=? AND state='confirmed'"
      ).bind(row.block_number, row.block_hash).all();
      for (const event of changed || []) {
        await env.DB.prepare("UPDATE transfer_events SET state='reorged' WHERE event_id=?").bind(event.event_id).run();
        const { results: chats } = await env.DB.prepare("SELECT chat_id FROM subscriptions WHERE address=? AND status='active'").bind(event.address).all();
        for (const item of chats || []) await queueNotice(env, {
          dedup: "reorg:" + event.event_id + ":" + item.chat_id,
          chat_id: item.chat_id,
          address: event.address,
          template: "reorg_correction",
          payload: { address: event.address, asset: event.asset, tx_hash: event.tx_hash, block_number: event.block_number }
        });
      }
    } catch (e) {
      console.warn("reorg reconciliation error", String(e));
    }
  }
}

// src/usage-math.ts
function monthPeriod(at, billingDay = 1) {
  function boundary(year, month) {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(billingDay, last)));
  }
  let start = boundary(at.getUTCFullYear(), at.getUTCMonth());
  if (start > at) start = boundary(at.getUTCFullYear(), at.getUTCMonth() - 1);
  const end = boundary(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}
function dayPeriod(at) {
  const start = /* @__PURE__ */ new Date(at.toISOString().slice(0, 10) + "T00:00:00.000Z");
  return { start: start.toISOString(), end: (/* @__PURE__ */ new Date(+start + 864e5)).toISOString() };
}
function assessUsage(point, previous, at) {
  const quota = point.quota;
  const current = Date.parse(point.observed_at);
  const age = +at - current;
  const valid = Number.isFinite(point.used) && point.used >= 0 && Number.isFinite(current) && age >= -6e4 && age <= 45 * 6e4 && +at >= Date.parse(point.period_start) && +at < Date.parse(point.period_end);
  const hasLimit = typeof quota === "number" && Number.isFinite(quota) && quota > 0;
  const remaining = hasLimit ? Math.max(0, quota - point.used) : null;
  const elapsed = previous ? current - Date.parse(previous.observed_at) : 0;
  const rate = previous && elapsed >= 15 * 6e4 && elapsed <= 8 * 864e5 && previous.period_start === point.period_start && previous.source === point.source && point.used >= previous.used ? (point.used - previous.used) / elapsed : null;
  const exhaustMs = rate && rate > 0 && remaining !== null ? remaining / rate : null;
  const untilReset = Date.parse(point.period_end) - current;
  const threshold = valid && hasLimit && point.used / quota >= 0.8;
  const forecast = valid && exhaustMs !== null && exhaustMs <= 7 * 864e5 && exhaustMs < untilReset;
  return {
    fresh: valid,
    remaining,
    percentage: hasLimit ? Math.round(point.used / quota * 1e3) / 10 : null,
    predicted_exhaust_days: exhaustMs === null ? null : Math.round(exhaustMs / 864e4) / 10,
    threshold_alert: threshold,
    forecast_alert: forecast,
    forecast_ready: rate !== null
  };
}
function nonnegative(value, name) {
  const result = typeof value === "number" || typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(result) || result < 0) throw Error("\u5E73\u53F0\u8FD4\u56DE\u4E86\u65E0\u6548\u7684 " + name);
  return result;
}
function parseAlchemySummary(response) {
  const data = response?.data;
  const limitData = data?.usageLimit;
  const total = data?.totals?.monthToDate;
  if (!data?.billingPeriod || !limitData && !total) throw Error("Alchemy \u7528\u91CF\u54CD\u5E94\u4E0D\u5B8C\u6574");
  if (limitData ? limitData.unit && limitData.unit !== "CU" : !["CU", "ALCHEMY_COMPUTE_UNIT"].includes(total?.unit))
    throw Error("Alchemy \u8FD4\u56DE\u4E86\u975E CU \u7528\u91CF\uFF0C\u4E0D\u80FD\u7528\u4E8E CU \u989D\u5EA6\u9884\u8B66");
  const start = new Date(data.billingPeriod.startTime);
  const end = new Date(data.billingPeriod.endTime);
  const observed = new Date(data.freshness?.dataThrough);
  if (![+start, +end, +observed].every(Number.isFinite) || end <= start)
    throw Error("Alchemy \u672A\u8FD4\u56DE\u6709\u6548\u7684\u8D26\u671F\u6216\u6570\u636E\u65F6\u95F4");
  const used = nonnegative(limitData ? limitData.used : total.amount, "Alchemy CU");
  const limit = !limitData || limitData.limit === null ? null : nonnegative(limitData.limit, "Alchemy \u989D\u5EA6");
  const usd = data.totals?.monthToDate?.usd;
  return {
    metric: "alchemy_cu",
    used,
    quota: limit && limit > 0 ? limit : null,
    unit: "CU",
    period_start: start.toISOString(),
    period_end: end.toISOString(),
    observed_at: observed.toISOString(),
    source: "official_api",
    scope: "Alchemy \u6574\u4E2A\u56E2\u961F",
    extra: {
      usd: usd === void 0 ? null : nonnegative(usd, "Alchemy \u8D39\u7528"),
      quota_source: limitData ? "official_api" : "not_returned",
      note: limitData ? "\u5E73\u53F0\u805A\u5408\u6570\u636E\u53EF\u80FD\u6709\u5EF6\u8FDF" : "\u5B98\u65B9 API \u672A\u8FD4\u56DE\u989D\u5EA6\uFF0C\u8BF7\u6309\u5F53\u524D\u5957\u9910\u786E\u8BA4 CU \u989D\u5EA6"
    }
  };
}
function cloudflareDayQuery(account, day) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw Error("Cloudflare \u8D26\u53F7\u6216\u65E5\u671F\u65E0\u6548");
  const start = day + "T00:00:00Z";
  const end = new Date(Date.parse(start) + 864e5).toISOString();
  const time = "datetime_geq:" + JSON.stringify(start) + ",datetime_lt:" + JSON.stringify(end);
  const date = "date_geq:" + JSON.stringify(day) + ",date_leq:" + JSON.stringify(day);
  return "{viewer{accounts(filter:{accountTag:" + JSON.stringify(account) + "}){workers:workersInvocationsAdaptive(limit:1,filter:{" + time + "}){sum{requests cpuTimeUs}}d1:d1AnalyticsAdaptiveGroups(limit:1,filter:{" + date + "}){sum{rowsRead rowsWritten}}queues:queueMessageOperationsAdaptiveGroups(limit:1,filter:{" + time + "}){sum{billableOperations}}storage:d1StorageAdaptiveGroups(limit:10000,filter:{" + date + "}){dimensions{databaseId}max{databaseSizeBytes}}}}}";
}
function parseCloudflareDay(response) {
  const body2 = response;
  const account = body2.data?.viewer?.accounts?.[0];
  if (!account || body2.errors?.length) throw Error("Cloudflare \u672A\u8FD4\u56DE\u5B8C\u6574\u7EDF\u8BA1\uFF0C\u8BF7\u68C0\u67E5 Analytics \u8BFB\u53D6\u6743\u9650\u548C\u67E5\u8BE2\u8303\u56F4");
  for (const key2 of ["workers", "d1", "queues", "storage"]) {
    if (!Array.isArray(account[key2])) throw Error("Cloudflare \u7F3A\u5C11 " + key2 + " \u7EDF\u8BA1");
  }
  const sum = (rows, key2) => rows.reduce((n, r) => n + nonnegative(r.sum?.[key2], key2), 0);
  if (account.storage.length >= 1e4) throw Error("D1 \u5B58\u50A8\u7EDF\u8BA1\u8FBE\u5230\u5206\u9875\u4E0A\u9650\uFF0C\u4E0D\u80FD\u4F5C\u4E3A\u5B8C\u6574\u7528\u91CF");
  return {
    workers_requests: sum(account.workers, "requests"),
    workers_cpu_ms: sum(account.workers, "cpuTimeUs") / 1e3,
    d1_reads: sum(account.d1, "rowsRead"),
    d1_writes: sum(account.d1, "rowsWritten"),
    queue_ops: sum(account.queues, "billableOperations"),
    d1_storage_bytes: account.storage.reduce((n, r) => n + nonnegative(r.max?.databaseSizeBytes, "D1 \u5B58\u50A8"), 0)
  };
}

// src/usage.ts
var USAGE_METERS = [
  { name: "Alchemy", metric: "alchemy_cu", detail: "\u56E2\u961F Compute Units", unit: "CU", provider: "alchemy" },
  { name: "Cloudflare Workers", metric: "workers_requests", detail: "\u8D26\u53F7\u8BF7\u6C42\u6570", unit: "\u6B21", provider: "cloudflare" },
  { name: "Cloudflare Workers CPU", metric: "workers_cpu_ms", detail: "\u8D26\u53F7 CPU \u65F6\u95F4", unit: "\u6BEB\u79D2", provider: "cloudflare" },
  { name: "Cloudflare D1 \u8BFB\u53D6", metric: "d1_reads", detail: "\u8D26\u53F7\u8BFB\u53D6\u884C\u6570", unit: "\u884C", provider: "cloudflare" },
  { name: "Cloudflare D1 \u5199\u5165", metric: "d1_writes", detail: "\u8D26\u53F7\u5199\u5165\u884C\u6570", unit: "\u884C", provider: "cloudflare" },
  { name: "Cloudflare D1 \u5B58\u50A8", metric: "d1_storage_bytes", detail: "\u8D26\u53F7\u6BCF\u65E5\u6700\u9AD8\u5B58\u50A8\u5408\u8BA1", unit: "\u5B57\u8282", provider: "cloudflare" },
  { name: "Cloudflare Queues", metric: "queue_ops", detail: "\u8D26\u53F7\u8BA1\u8D39\u64CD\u4F5C\u6570", unit: "\u6B21", provider: "cloudflare" },
  { name: "Etherscan", metric: "etherscan_requests", detail: "\u672C\u7A0B\u5E8F API \u8BF7\u6C42\u6570", unit: "\u6B21", provider: "internal" },
  { name: "Telegram", metric: "telegram_notifications", detail: "\u672C\u7A0B\u5E8F\u6210\u529F\u53D1\u9001\u6D88\u606F\u6570", unit: "\u6761", provider: "internal" }
];
var ISO = () => (/* @__PURE__ */ new Date()).toISOString();
async function usageSettings(env) {
  const row = await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_settings'").first();
  const d = row ? JSON.parse(row.value) : {};
  return {
    cloudflare_plan: ["free", "standard"].includes(d.cloudflare_plan) ? d.cloudflare_plan : "unknown",
    cloudflare_billing_day: Number.isInteger(d.cloudflare_billing_day) ? d.cloudflare_billing_day : 1
  };
}
async function saveUsageSettings(env, d) {
  if (!["unknown", "free", "standard"].includes(d.cloudflare_plan) || !Number.isInteger(d.cloudflare_billing_day) || d.cloudflare_billing_day < 1 || d.cloudflare_billing_day > 31)
    throw Error("\u8BF7\u9009\u62E9\u5B9E\u9645 Cloudflare \u5957\u9910\u548C\u8D26\u671F\u8D77\u59CB\u65E5");
  await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(JSON.stringify(d)).run();
}
async function storeSample(env, s) {
  const complete = JSON.parse(s.extra_json || "{}").complete !== false;
  const statements = [
    env.DB.prepare("INSERT INTO usage_samples(metric,used,quota,unit,period_start,period_end,observed_at,source,scope,extra_json) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(metric) DO UPDATE SET used=excluded.used,quota=excluded.quota,unit=excluded.unit,period_start=excluded.period_start,period_end=excluded.period_end,observed_at=excluded.observed_at,source=excluded.source,scope=excluded.scope,extra_json=excluded.extra_json").bind(s.metric, s.used, s.quota, s.unit, s.period_start, s.period_end, s.observed_at, s.source, s.scope, s.extra_json || "{}")
  ];
  if (complete) statements.push(env.DB.prepare("INSERT OR IGNORE INTO usage_observations(metric,observed_at,used,period_start,source) VALUES(?,?,?,?,?)").bind(s.metric, s.observed_at, s.used, s.period_start, s.source));
  await env.DB.batch(statements);
}
async function collector(env, provider, work) {
  const attempted = ISO();
  try {
    await work();
    await env.DB.prepare("INSERT INTO usage_collectors(provider,attempted_at,succeeded_at,last_error) VALUES(?,?,?,NULL) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at,succeeded_at=excluded.succeeded_at,last_error=NULL").bind(provider, attempted, ISO()).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "\u91C7\u96C6\u5931\u8D25";
    await env.DB.prepare("INSERT INTO usage_collectors(provider,attempted_at,last_error) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET attempted_at=excluded.attempted_at,last_error=excluded.last_error").bind(provider, attempted, message.slice(0, 250)).run();
  }
}
async function requestJson(url, init, provider) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12e3) });
  if (!response.ok) throw Error(provider + " \u91C7\u96C6\u5931\u8D25\uFF08HTTP " + response.status + "\uFF09\uFF0C\u8BF7\u68C0\u67E5\u53EA\u8BFB\u51ED\u8BC1\u3001\u6743\u9650\u548C\u5E73\u53F0\u72B6\u6001");
  return response.json();
}
async function collectAlchemy(env) {
  if (!env.ALCHEMY_USAGE_TOKEN) throw Error("\u5F85\u914D\u7F6E Alchemy Usage read \u53EA\u8BFB\u8BBF\u95EE Key\uFF1BRPC / Notify Key \u4E0D\u80FD\u8BFB\u53D6\u7528\u91CF");
  const body2 = await requestJson("https://admin-api.alchemy.com/v1/usage/summary", { headers: { Authorization: "Bearer " + env.ALCHEMY_USAGE_TOKEN } }, "Alchemy");
  const data = parseAlchemySummary(body2);
  if (data.extra.quota_source === "not_returned") {
    const limit = await env.DB.prepare("SELECT quota,period FROM usage_limits WHERE metric='alchemy_cu'").first();
    if (limit?.period === "monthly" && Number.isFinite(limit.quota) && limit.quota > 0) {
      data.quota = limit.quota;
      data.extra.quota_source = "configured_plan";
      data.extra.note = "\u5DF2\u7528\u91CF\u6765\u81EA\u5B98\u65B9 API\uFF1B\u989D\u5EA6\u91C7\u7528\u5DF2\u786E\u8BA4\u7684\u8D26\u53F7\u5957\u9910\u57FA\u51C6\uFF0C\u5957\u9910\u53D8\u66F4\u540E\u8BF7\u66F4\u65B0";
    }
  }
  await storeSample(env, { ...data, extra_json: JSON.stringify(data.extra) });
}
async function cfDay(env, day) {
  const body2 = await requestJson("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer " + env.CF_ANALYTICS_API_TOKEN },
    body: JSON.stringify({ query: cloudflareDayQuery(env.CF_ACCOUNT_ID, day) })
  }, "Cloudflare");
  const data = parseCloudflareDay(body2);
  await env.DB.prepare("INSERT INTO usage_cf_days(day,payload_json,updated_at) VALUES(?,?,?) ON CONFLICT(day) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at").bind(day, JSON.stringify(data), ISO()).run();
  return data;
}
async function collectCloudflare(env, settings) {
  if (!env.CF_ANALYTICS_API_TOKEN) throw Error("\u5F85\u914D\u7F6E\u5F53\u524D\u8D26\u53F7\u7684 Account Analytics Read \u53EA\u8BFB\u4EE4\u724C");
  const now3 = /* @__PURE__ */ new Date(), today = now3.toISOString().slice(0, 10), monthly = monthPeriod(now3, settings.cloudflare_billing_day), daily = dayPeriod(now3);
  const rows = (await env.DB.prepare("SELECT day FROM usage_cf_days WHERE day>=?").bind(monthly.start.slice(0, 10)).all()).results;
  const cached = new Set(rows.map((x) => x.day));
  await cfDay(env, today);
  const yesterday = new Date(+now3 - 864e5).toISOString().slice(0, 10);
  if (yesterday >= monthly.start.slice(0, 10)) await cfDay(env, yesterday);
  const required = [];
  for (let time = Date.parse(monthly.start); time < +now3; time += 864e5) required.push(new Date(time).toISOString().slice(0, 10));
  for (const day of required.filter((d) => !cached.has(d) && d !== today && d !== yesterday).slice(0, 4)) await cfDay(env, day);
  const updated = (await env.DB.prepare("SELECT day,payload_json FROM usage_cf_days WHERE day>=? AND day<=?").bind(monthly.start.slice(0, 10), today).all()).results;
  const totals = new Map(updated.map((x) => [x.day, JSON.parse(x.payload_json)]));
  const free = settings.cloudflare_plan === "free", known = settings.cloudflare_plan !== "unknown", period = free ? daily : monthly;
  const complete = free || required.every((day) => totals.has(day)), last = totals.get(today);
  if (!last) throw Error("Cloudflare \u5F53\u65E5\u7528\u91CF\u672A\u8FD4\u56DE");
  const presets = free ? { workers_requests: 1e5, workers_cpu_ms: null, d1_reads: 5e6, d1_writes: 1e5, d1_storage_bytes: 5e9, queue_ops: 1e4 } : { workers_requests: 1e7, workers_cpu_ms: 3e7, d1_reads: 25e9, d1_writes: 5e7, d1_storage_bytes: 5e9, queue_ops: 1e6 };
  const limits = (await env.DB.prepare("SELECT * FROM usage_limits").all()).results;
  for (const meter of USAGE_METERS.filter((x) => x.provider === "cloudflare")) {
    const key2 = meter.metric, storage = key2 === "d1_storage_bytes";
    const used = storage || free ? last[key2] : required.reduce((sum, day) => sum + (totals.get(day)?.[key2] || 0), 0);
    const limit = limits.find((x) => x.metric === key2 && x.period === (free ? "daily" : "monthly"));
    await storeSample(env, {
      metric: key2,
      used,
      quota: known && complete ? limit?.quota ?? presets[key2] : null,
      unit: meter.unit,
      period_start: storage ? monthPeriod(now3).start : period.start,
      period_end: storage ? "9999-12-31T00:00:00.000Z" : period.end,
      observed_at: ISO(),
      source: "official_api",
      scope: "Cloudflare \u6574\u4E2A\u8D26\u53F7\uFF08\u542B\u5176\u4ED6\u9879\u76EE\uFF09",
      extra_json: JSON.stringify({
        plan: settings.cloudflare_plan,
        complete,
        missing_days: required.filter((d) => !totals.has(d)),
        note: !known ? "\u8BF7\u786E\u8BA4\u5B9E\u9645\u5957\u9910\u540E\u8BA1\u7B97\u989D\u5EA6" : !complete ? "\u6B63\u5728\u56DE\u586B\u8D26\u671F\u5386\u53F2\u7528\u91CF" : storage ? "\u5F53\u5929\u6700\u9AD8\u5B58\u50A8\u5408\u8BA1\uFF0C\u53EF\u80FD\u7565\u9AD8\u4E8E\u5F53\u524D\u503C" : "\u5E73\u53F0\u805A\u5408\u6570\u636E\u53EF\u80FD\u6709\u5EF6\u8FDF"
      })
    });
  }
}
async function collectInternal(env) {
  const now3 = /* @__PURE__ */ new Date(), daily = dayPeriod(now3), monthly = monthPeriod(now3);
  const rows = (await env.DB.prepare("SELECT metric,day,value FROM counters WHERE day>=?").bind(monthly.start.slice(0, 10)).all()).results;
  const limits = (await env.DB.prepare("SELECT * FROM usage_limits").all()).results;
  const started = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_started_at'").first())?.value;
  for (const meter of USAGE_METERS.filter((x) => x.provider === "internal")) {
    const limit = limits.find((x) => x.metric === meter.metric), period = limit?.period === "monthly" ? monthly : daily;
    await storeSample(env, {
      metric: meter.metric,
      used: rows.filter((x) => x.metric === meter.metric && x.day >= period.start.slice(0, 10)).reduce((n, x) => n + x.value, 0),
      quota: limit?.quota || null,
      unit: meter.unit,
      period_start: period.start,
      period_end: period.end,
      observed_at: ISO(),
      source: "application_counter",
      scope: "\u4EC5\u672C\u7A0B\u5E8F\uFF0C\u81EA " + (started || "\u672C\u6B21\u66F4\u65B0") + " \u8D77\u7EDF\u8BA1",
      extra_json: JSON.stringify({
        rate_limited: rows.find((x) => x.metric === "telegram_rate_limited" && x.day === daily.start.slice(0, 10))?.value || 0,
        note: meter.metric === "telegram_notifications" ? "\u666E\u901A\u6D88\u606F\u65E0\u56FA\u5B9A\u6708\u989D\u5EA6\uFF1B\u663E\u793A\u6210\u529F\u53D1\u9001\u91CF\u548C\u9650\u6D41\u6B21\u6570" : "\u6309\u53D1\u8D77\u8BF7\u6C42\u8BA1\u6570\uFF0C\u5305\u542B\u5931\u8D25\u5C1D\u8BD5\uFF1B\u4E0D\u542B\u5176\u4ED6\u7A0B\u5E8F\u4F7F\u7528\u6B64 Key \u7684\u8BF7\u6C42"
      })
    });
  }
}
async function collectGithub(env) {
  const cached = await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_github_checked_at'").first();
  if (cached && Date.now() - Date.parse(cached.value) < 864e5) return;
  const data = await requestJson("https://api.github.com/repos/mosen6266-netizen/MS_Telegram_bot", { headers: { "user-agent": "Ethereum-Monitor", accept: "application/vnd.github+json" } }, "GitHub");
  if (typeof data.private !== "boolean") throw Error("GitHub \u672A\u8FD4\u56DE\u4ED3\u5E93\u53EF\u89C1\u6027");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_github_visibility',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(data.private ? "private" : "public"),
    env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_github_checked_at',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(ISO())
  ]);
}
async function collectUsage(env, force = false) {
  const last = await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_last_collect'").first();
  if (!force && last && Date.now() - Date.parse(last.value) < 15 * 6e4) return { skipped: true };
  const lockId = crypto.randomUUID();
  const lock = await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_collect_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP WHERE updated_at<datetime('now','-4 minutes')").bind(lockId).run();
  if (!lock.meta.changes) return { busy: true };
  try {
    const latest = await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_last_collect'").first();
    if (!force && latest && Date.now() - Date.parse(latest.value) < 15 * 6e4) return { skipped: true };
    await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES('usage_last_collect',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(ISO()).run();
    const settings = await usageSettings(env);
    const results = await Promise.allSettled([
      collector(env, "alchemy", () => collectAlchemy(env)),
      collector(env, "cloudflare", () => collectCloudflare(env, settings)),
      collector(env, "internal", () => collectInternal(env)),
      collector(env, "github", () => collectGithub(env))
    ]);
    for (const result of results) if (result.status === "rejected") throw result.reason;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_observations WHERE observed_at<?").bind(new Date(Date.now() - 35 * 864e5).toISOString()),
      env.DB.prepare("DELETE FROM usage_cf_days WHERE day<date('now','-35 days')")
    ]);
    return { ok: true };
  } finally {
    await env.DB.prepare("DELETE FROM runtime_state WHERE key='usage_collect_lock' AND value=?").bind(lockId).run();
  }
}
async function usageSnapshot(env) {
  const samples = (await env.DB.prepare("SELECT * FROM usage_samples").all()).results;
  const collectors = (await env.DB.prepare("SELECT * FROM usage_collectors").all()).results;
  const rows = [];
  for (const meter of USAGE_METERS) {
    const sample = samples.find((x) => x.metric === meter.metric), health = collectors.find((x) => x.provider === meter.provider);
    if (!sample) {
      rows.push({
        ...meter,
        used: null,
        quota: null,
        percentage: null,
        status: "waiting",
        source: "not_connected",
        note: health?.last_error || "\u7B49\u5F85\u9996\u6B21\u91C7\u96C6",
        threshold_alert: false,
        forecast_alert: false
      });
      continue;
    }
    const previous = await env.DB.prepare("SELECT * FROM usage_observations WHERE metric=? AND period_start=? AND source=? AND observed_at<=? AND observed_at>=? ORDER BY observed_at DESC LIMIT 1").bind(meter.metric, sample.period_start, sample.source, new Date(Date.parse(sample.observed_at) - 15 * 6e4).toISOString(), new Date(Date.parse(sample.observed_at) - 864e5).toISOString()).first();
    const assessment = assessUsage(sample, previous, /* @__PURE__ */ new Date()), extra = JSON.parse(sample.extra_json || "{}");
    const valid = assessment.fresh && !health?.last_error && extra.complete !== false;
    rows.push({
      ...meter,
      ...sample,
      ...assessment,
      extra,
      note: health?.last_error || extra.note || "",
      status: health?.last_error ? "error" : !assessment.fresh ? "stale" : extra.complete === false ? "backfilling" : "ok",
      threshold_alert: valid && assessment.threshold_alert,
      forecast_alert: valid && assessment.forecast_alert,
      accurate_official_usage: sample.source === "official_api"
    });
  }
  const repo = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='usage_github_visibility'").first())?.value;
  const githubError = collectors.find((x) => x.provider === "github")?.last_error;
  rows.push({
    name: "GitHub",
    metric: "github_actions",
    detail: "\u4EE3\u7801\u4ED3\u5E93 / \u6807\u51C6 Actions",
    unit: "\u5206\u949F",
    provider: "github",
    source: repo ? "official_repository" : "not_connected",
    status: githubError ? "error" : repo === "public" ? "not_applicable" : "waiting",
    used: null,
    quota: null,
    percentage: null,
    threshold_alert: false,
    forecast_alert: false,
    note: githubError || (repo === "public" ? "\u5F53\u524D\u4E3A\u516C\u5F00\u4ED3\u5E93\uFF0C\u6807\u51C6 Actions \u4E0D\u6D88\u8017\u79C1\u6709\u4ED3\u5E93\u5206\u949F\u5305\uFF1B\u7A0B\u5E8F\u65E5\u5E38\u76D1\u63A7\u8FD0\u884C\u5728 Cloudflare" : "\u4ED3\u5E93\u53EF\u89C1\u6027\u672A\u786E\u8BA4\u6216\u4E3A\u79C1\u6709\uFF0C\u9700\u53E6\u5916\u914D\u7F6E\u8D26\u5355\u8BFB\u53D6\u6743\u9650")
  });
  return rows;
}
async function runUsageAlerts(env) {
  if (!env.ADMIN_TELEGRAM_CHAT_ID) return;
  for (const row of await usageSnapshot(env)) {
    if (!row.period_start || !row.period_end) continue;
    for (const [kind, hit] of [["80_percent", row.threshold_alert], ["7_day_forecast", row.forecast_alert]]) {
      if (!hit) continue;
      const text = "\u5E73\u53F0\uFF1A" + row.name + "\n\u8303\u56F4\uFF1A" + row.scope + "\n\u5DF2\u7528\uFF1A" + row.used + " / " + row.quota + " " + row.unit + "\n\u4F7F\u7528\u7387\uFF1A" + row.percentage + "%\n\u989D\u5EA6\u91CD\u7F6E\uFF1A" + row.period_end + "\n\u539F\u56E0\uFF1A" + (kind === "80_percent" ? "\u4F7F\u7528\u7387\u5DF2\u8FBE\u5230 80%" : "\u6309\u8FD1\u671F\u5B9E\u9645\u589E\u91CF\u9884\u8BA1 7 \u5929\u5185\u8017\u5C3D\uFF0C\u4E14\u65E9\u4E8E\u989D\u5EA6\u91CD\u7F6E") + "\n\u6765\u6E90\uFF1A" + (row.source === "official_api" ? "\u5E73\u53F0\u5B98\u65B9\u7528\u91CF\uFF08\u53EF\u80FD\u6709\u7EDF\u8BA1\u5EF6\u8FDF\uFF09" : "\u672C\u7A0B\u5E8F\u8C03\u7528\u8BA1\u6570\uFF0C\u975E\u5B98\u65B9\u8D26\u5355");
      await queueNotice(env, {
        dedup: "usage:" + row.metric + ":" + kind + ":" + row.period_start,
        chat_id: env.ADMIN_TELEGRAM_CHAT_ID,
        address: null,
        template: "usage_alert",
        payload: { alert_text: text, expires_at: row.period_end }
      });
    }
  }
}
async function queueUsageTest(env) {
  if (!env.ADMIN_TELEGRAM_CHAT_ID) throw Error("\u8BF7\u5148\u7ED1\u5B9A\u7BA1\u7406\u5458 Telegram \u79C1\u804A");
  const dedup = "usage-test:" + crypto.randomUUID();
  await queueNotice(env, {
    dedup,
    chat_id: env.ADMIN_TELEGRAM_CHAT_ID,
    address: null,
    template: "usage_alert",
    payload: {
      alert_text: "\u{1F9EA} \u8D39\u7528\u9884\u8B66\u901A\u9053\u6D4B\u8BD5\n\u8FD9\u662F\u4E00\u6761\u6D4B\u8BD5\u6D88\u606F\uFF0C\u4E0D\u4EE3\u8868\u771F\u5B9E\u7528\u91CF\u5DF2\u8FBE\u5230\u9884\u8B66\u9608\u503C\u3002\n\u53D1\u9001\u65F6\u95F4\uFF1A" + ISO(),
      expires_at: new Date(Date.now() + 5 * 6e4).toISOString()
    }
  });
  return dedup;
}

// src/admin-ui.ts
var ADMIN_HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ethereum Monitor \xB7 \u7BA1\u7406\u540E\u53F0</title><style>\n:root{color-scheme:dark;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}*{box-sizing:border-box}\nbody{overflow-x:hidden;overflow-wrap:anywhere;margin:0;background:#0e1014;color:#f0f2f7}button,input,select,textarea{font:inherit}button{cursor:pointer}\n.app{min-height:100vh;display:grid;grid-template-columns:224px minmax(0,1fr);align-items:start}\naside{position:sticky;top:0;align-self:start;height:100vh;height:100dvh;overflow-y:auto;overscroll-behavior:contain;background:#181b21;padding:22px 12px;border-right:1px solid #30343b}\n.brand{font-size:17px;font-weight:750;padding:7px 10px 23px}\nnav button{width:100%;border:0;text-align:left;border-radius:10px;padding:11px 12px;background:transparent;color:#bfc5d0;margin:2px 0}\nnav button.sel,nav button:hover{background:#303741;color:#fff}\nmain{padding:28px;min-width:0;max-width:1550px;width:100%;margin:0 auto}\nheader{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:15px;margin:0 0 25px}\nh1{font-size:24px;margin:0}h2{font-size:18px;margin:0 0 16px}h3{font-size:15px;margin:0 0 10px}\n.panel{padding:20px;background:#1b1f26;border-radius:15px;border:1px solid #333945;margin-bottom:16px}\n.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px}.grid>.panel{margin:0}\n.big{font-size:28px;font-weight:720}.muted{color:#a5acb9;font-size:12px}.warning{color:#ffc68d}.good{color:#a2e7c1}\ninput,textarea,select{display:block;width:100%;border:1px solid #454b57;background:#11151b;color:#f9fafb;border-radius:9px;padding:11px;margin:7px 0 16px;outline:none}\ninput:focus,textarea:focus,select:focus{border-color:#93a4ba}textarea{min-height:200px;resize:vertical}\n.btn{background:#e5e8ee;border:0;border-radius:9px;color:#16191f;padding:10px 15px;margin:4px 5px 4px 0;font-weight:650}\n.btn.secondary{background:#343b46;color:#f2f3f5}.btn.danger{background:#66353a;color:#fff}\ntable{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;vertical-align:top;padding:12px 9px;border-bottom:1px solid #353944}th{color:#a6abb5;font-weight:500}td{word-break:break-all}\n.scroll{overflow:auto}.flex{display:flex;gap:12px;align-items:center;flex-wrap:wrap}\n.field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:0 16px}\n.pill{display:inline-block;background:#293b32;border-radius:99px;padding:4px 10px;color:#a9dfbf;font-size:12px}\n#msg{font-size:12px;padding:6px}.intro{max-width:560px;margin:7vh auto}.intro h1{margin-bottom:12px}\n@media(max-width:760px){.app{display:block}aside{height:auto;max-height:168px;position:sticky;top:0;z-index:5;padding:9px 12px;border-bottom:1px solid #30343b}.brand{padding:5px 8px}nav{display:flex;overflow:auto}nav button{white-space:nowrap;width:auto}main{padding:15px}}\n.template-info{background:#12171f;border:1px solid #384451;border-radius:10px;padding:13px 15px;margin:12px 0 19px}.template-title{font-size:16px;font-weight:700;margin-bottom:5px}.template-detail{margin:8px 0 4px;color:#d8dce5}.template-info .muted{margin-top:5px}select optgroup{background:#232831;color:#e8ebf1;font-weight:700}\n</style></head><body>\n<div class="app"><aside><div class="brand">\u25C8 Ethereum Monitor</div><nav id="nav"></nav><p class="muted">Ethereum Mainnet \xB7 \u53EA\u8BFB\u94FE\u4E0A\u76D1\u63A7</p></aside>\n<main><header><div><h1 id="title">\u9996\u6B21\u8BBE\u7F6E</h1><div class="muted">\u6388\u6743\u67E5\u8BE2\u3001\u8D44\u91D1\u76D1\u63A7\u4E0E\u8D44\u6E90\u7528\u91CF\u7BA1\u7406</div></div><div class="flex"><span id="msg">\u52A0\u8F7D\u4E2D</span><button id="refresh" class="btn secondary">\u5237\u65B0</button><button id="logout" class="btn secondary" hidden>\u9000\u51FA\u767B\u5F55</button></div></header><div id="content"></div></main></div>\n<script>\n(function(){\nvar views=[["overview","\u7CFB\u7EDF\u603B\u89C8"],["setup","\u8FDE\u63A5\u4E0E\u542F\u52A8"],["wallets","\u94B1\u5305\u5730\u5740"],["monitoring","\u6B63\u5728\u76D1\u63A7\u5730\u5740"],["spenders","Spender \u89C4\u5219"],["subscriptions","\u7FA4\u7EC4\u5907\u6CE8"],["templates","\u6D88\u606F\u6A21\u677F"],["transfers","\u4EA4\u6613\u8BB0\u5F55"],["outbox","\u901A\u77E5\u961F\u5217"],["usage","\u8D44\u6E90\u8D39\u7528"],["audit","\u64CD\u4F5C\u65E5\u5FD7"]];\nvar route="setup",root=document.getElementById("content"),nav=document.getElementById("nav"),logged=false,initialized=false;\nvar historySpender="",historyPage=0,historyFilter="all";\nvar monitorSearch="",monitorStatus="all",monitorPage=0;\nvar templateChoice="query_active",templateChat="*";\nvar renderEpoch=0,renderedView="";\nfunction node(tag,text,cl){var e=document.createElement(tag);if(text!==undefined&&text!==null)e.textContent=String(text);if(cl)e.className=cl;return e}\nfunction put(p,n){p.appendChild(n);return n}\nfunction panel(label){var p=put(root,node("section",null,"panel"));if(label)put(p,node("h2",label));return p}\nfunction input(parent,label,placeholder,type){var box=put(parent,node("div"));put(box,node("label",label));var x=put(box,node("input"));x.placeholder=placeholder||"";if(type)x.type=type;return x}\nfunction action(p,name,fn,style){var b=put(p,node("button",name,"btn"+(style?" "+style:"")));b.onclick=fn;return b}\nfunction table(p,heads,items){var outer=put(p,node("div",null,"scroll")),t=put(outer,node("table")),h=put(t,node("tr"));heads.forEach(x=>put(h,node("th",x)));(items||[]).forEach(row=>{var tr=put(t,node("tr"));row.forEach(x=>put(tr,node("td",x===null||x===undefined?"\u2014":x)))});}\nfunction alertMsg(s,error){var e=document.getElementById("msg");e.textContent=s;e.style.color=error?"#ffaba7":"#a9dfbf"}\nasync function api(path,method,data){var r=await fetch(path,{method:method||"GET",credentials:"same-origin",headers:{"content-type":"application/json","x-app-action":"1"},body:data===undefined?undefined:JSON.stringify(data)});var d=await r.json();if(!r.ok)throw Error(d.error||"HTTP "+r.status);return d}\nfunction err(e){alertMsg(e.message||String(e),true);alert(e.message||String(e))}\nfunction navigate(view){if(route===view)return;route=view;render()}\nasync function start(){\n try{var state=await api("/auth/status");initialized=state.initialized;logged=state.authenticated;\n document.getElementById("logout").hidden=!logged;\n document.getElementById("nav").hidden=!logged;\n if(!initialized){renderSetupFirst();return;}\n if(!logged){renderLogin();return;}\n render();\n }catch(e){err(e)}\n}\nfunction renderSetupFirst(){\n document.getElementById("title").textContent="\u9996\u6B21\u7BA1\u7406\u5458\u521D\u59CB\u5316";root.replaceChildren();\n alertMsg("\u8BF7\u8BBE\u7F6E\u7BA1\u7406\u5458\u5BC6\u7801");\n var p=panel("\u8BBE\u7F6E\u7BA1\u7406\u5458\u5BC6\u7801");put(p,node("p","\u8BF7\u8F93\u5165\u4E00\u6B21\u6027\u521D\u59CB\u5316\u7801\u5E76\u8BBE\u7F6E\u7BA1\u7406\u5458\u5BC6\u7801\u3002\u6B64\u5904\u4E0D\u518D\u9700\u8981 Cloudflare \u7BA1\u7406 API \u4EE4\u724C\u3002\u521D\u59CB\u5316\u6210\u529F\u540E\u8BE5\u7801\u7ACB\u5373\u5931\u6548\u3002","muted"));\n var code=input(p,"\u4E00\u6B21\u6027\u521D\u59CB\u5316\u7801","\u4E00\u6B21\u6027\u521D\u59CB\u5316\u7801","password");\n var pass=input(p,"\u7BA1\u7406\u5458\u5BC6\u7801\uFF08\u81F3\u5C11 14 \u4E2A\u5B57\u7B26\uFF09","\u5EFA\u8BAE\u4F7F\u7528\u968F\u673A\u5F3A\u5BC6\u7801","password");\n action(p,"\u5B8C\u6210\u521D\u59CB\u5316",async()=>{try{await api("/auth/setup","POST",{setup_code:code.value.trim(),password:pass.value});code.value="";pass.value="";await start()}catch(e){err(e)}});\n}\nfunction renderLogin(){\n document.getElementById("title").textContent="\u7BA1\u7406\u5458\u767B\u5F55";root.replaceChildren();\n var p=panel("\u767B\u5F55 Ethereum Monitor");var pass=input(p,"\u7BA1\u7406\u5458\u5BC6\u7801","","password");\n action(p,"\u767B\u5F55",async()=>{try{await api("/auth/login","POST",{password:pass.value});pass.value="";await start()}catch(e){err(e)}});\n}\nasync function render(){\n // Build the next view offscreen. The previous page stays interactive and\n // visible while API requests finish; only the latest request may commit.\n const epoch=++renderEpoch,activeRoute=route,liveRoot=document.getElementById("content"),stage=node("div");\n const lastScroll=window.scrollY||document.documentElement.scrollTop||0;\n const sameView=renderedView===activeRoute;\n const root=stage;\n function panel(label){var p=put(root,node("section",null,"panel"));if(label)put(p,node("h2",label));return p}\n let loadError=null;\n try {\n if(activeRoute==="setup"){\n var s=await api("/api/setup/status"),p=panel("\u8FD0\u884C\u72B6\u6001");\n put(p,node("div",s.active?"\u25CF \u6B63\u5728\u8FD0\u884C":"\u25CF \u5C1A\u672A\u542F\u7528",s.active?"good":"warning"));\n put(p,node("p","\u5148\u586B\u5199\u5E73\u53F0 Token / API \u4FE1\u606F\u5E76\u4FDD\u5B58\uFF0C\u7136\u540E\u9010\u9879\u6D4B\u8BD5\uFF0C\u6700\u540E\u70B9\u51FB\u542F\u7528\u3002\u5DF2\u4FDD\u5B58\u503C\u4E0D\u4F1A\u663E\u793A\u539F\u6587\u3002","muted"));\n var keys=[\n ["TELEGRAM_BOT_TOKEN","Telegram Bot Token","\u4ECE @BotFather \u83B7\u53D6"],\n ["TELEGRAM_WEBHOOK_SECRET","Telegram Webhook \u5B89\u5168\u5BC6\u94A5","12 \u4F4D\u4EE5\u4E0A\u82F1\u6587\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u6216\u77ED\u6A2A\u7EBF"],\n ["ADMIN_TELEGRAM_CHAT_ID","\u7BA1\u7406\u5458 Telegram \u79C1\u804A Chat ID","\u5148\u5411\u673A\u5668\u4EBA\u53D1\u9001 /start \u83B7\u53D6"],\n ["ALCHEMY_RPC_URL","Alchemy Ethereum Mainnet RPC HTTPS URL","https://eth-mainnet.g.alchemy.com/v2/..."],\n ["ALCHEMY_NOTIFY_TOKEN","Alchemy Notify Auth Token","Alchemy Webhooks Dashboard"],\n ["ALCHEMY_ACTIVITY_WEBHOOK_ID","Alchemy Address Activity Webhook ID\uFF08\u53EF\u7559\u7A7A\u5C1D\u8BD5\u81EA\u52A8\u521B\u5EFA\uFF09","\u81EA\u52A8\u521B\u5EFA\u5931\u8D25\u65F6\u5728\u6B64\u586B\u5199"],\n ["ALCHEMY_SIGNING_KEY","Alchemy Webhook \u7B7E\u540D Key\uFF08\u53EF\u7559\u7A7A\u5C1D\u8BD5\u81EA\u52A8\u521B\u5EFA\uFF09","\u81EA\u52A8\u521B\u5EFA\u5931\u8D25\u65F6\u5728\u6B64\u586B\u5199"],\n ["ETHERSCAN_API_KEY","Etherscan V2 API Key","\u7528\u4E8E USDT \u5386\u53F2\u6388\u6743\u53D1\u73B0"],\n ["CF_ANALYTICS_API_TOKEN","Cloudflare \u7528\u91CF\u91C7\u96C6 \xB7 \u53EA\u8BFB Token","\u5F53\u524D\u8D26\u53F7\u7684 Account Analytics Read \u6743\u9650"],\n ["ALCHEMY_USAGE_TOKEN","Alchemy \u7528\u91CF\u91C7\u96C6 \xB7 \u53EA\u8BFB Key","Admin API \u7684 Usage read \u6743\u9650"]\n ];\n var sec=panel("\u5E73\u53F0\u8FDE\u63A5\u51ED\u8BC1"),form=put(sec,node("div",null,"field-grid")),fields={};\n keys.forEach(item=>{\n   var entry=put(form,node("div")),label=item[1]+(s.keys[item[0]]?" \xB7 \u5DF2\u4FDD\u5B58":" \xB7 \u672A\u914D\u7F6E");\n   fields[item[0]]=input(entry,label,s.keys[item[0]]?"\u5DF2\u914D\u7F6E\uFF1B\u7559\u7A7A\u4E0D\u4FEE\u6539":item[2],"password");\n   if(item[0]==="ALCHEMY_RPC_URL"||item[0]==="ADMIN_TELEGRAM_CHAT_ID")fields[item[0]].type="text";\n });\n action(sec,"\u52A0\u5BC6\u4FDD\u5B58\u586B\u5199\u7684\u9879\u76EE",async()=>{try{var d={};Object.keys(fields).forEach(k=>{if(fields[k].value.trim())d[k]=fields[k].value.trim()});await api("/api/setup/save","POST",d);alertMsg("\u5DF2\u52A0\u5BC6\u4FDD\u5B58");await render()}catch(e){err(e)}});\n var tests=panel("\u8FDE\u63A5\u81EA\u68C0");\n ["telegram","alchemy","etherscan"].forEach(service=>action(tests,"\u6D4B\u8BD5 "+service,async()=>{try{var d=await api("/api/setup/test","POST",{service});alertMsg(service+" \u8FDE\u63A5\u6B63\u5E38");alert(JSON.stringify(d,null,2))}catch(e){err(e)}},"secondary"));\n var control=panel("\u76D1\u63A7\u542F\u52A8\u63A7\u5236");put(control,node("p","\u542F\u7528\u5C06\u5C1D\u8BD5\u81EA\u52A8\u521B\u5EFA Alchemy Address Activity Webhook\uFF0C\u5E76\u81EA\u52A8\u5411 Telegram \u6CE8\u518C Webhook\u3002\u82E5\u5E73\u53F0\u62D2\u7EDD\u521B\u5EFA\uFF0C\u8BF7\u5728\u4E0A\u65B9\u8F93\u5165\u5DF2\u6709\u7684 Alchemy Webhook ID \u548C\u7B7E\u540D Key\u3002","muted"));\n action(control,"\u68C0\u67E5\u5E76\u542F\u7528\u76D1\u63A7",async()=>{if(!confirm("\u786E\u8BA4\u5DF2\u6D4B\u8BD5\u5E73\u53F0\u8FDE\u63A5\uFF1F\u542F\u7528\u540E\u4F1A\u63A5\u6536\u771F\u5B9E Telegram \u548C\u94FE\u4E0A\u4E8B\u4EF6\u3002"))return;try{var d=await api("/api/setup/activate","POST",{});alertMsg("\u76D1\u63A7\u5DF2\u542F\u7528");alert("\u5DF2\u542F\u7528\uFF1A"+d.webhook_url);await render()}catch(e){err(e)}});\n action(control,"\u6682\u505C\u6574\u4E2A\u76D1\u63A7",async()=>{if(!confirm("\u6682\u505C\u6240\u6709\u76D1\u63A7\u4E8B\u4EF6\u5904\u7406\uFF1F"))return;try{await api("/api/setup/deactivate","POST",{});await render()}catch(e){err(e)}},"danger");\n }\n if(activeRoute==="overview"){\n var s=await api("/api/summary"),g=put(root,node("div",null,"grid"));\n Object.entries({"\u5DF2\u767B\u8BB0\u94B1\u5305":s.wallets,"\u6D3B\u8DC3 Spender":s.spenders,"\u76D1\u63A7\u8BA2\u9605":s.subscriptions,"\u4ECA\u5929\u8D44\u91D1\u4E8B\u4EF6":s.transfers_today,"\u53D1\u9001\u5931\u8D25":s.failed,"\u5F85\u5220\u9664\u4E34\u65F6\u6D88\u606F":s.cleanup_pending,"\u6E05\u7406\u53D7\u963B":s.cleanup_blocked}).forEach(([n,v])=>{var p=put(g,node("section",null,"panel"));put(p,node("div",n,"muted"));put(p,node("div",v,"big"))});\n var state=await api("/api/setup/status");\n put(panel("\u670D\u52A1\u5065\u5EB7"),node("p",state.active?"\u5DF2\u542F\u7528\u76D1\u542C\u4EFB\u52A1":"\u672A\u542F\u7528\uFF1B\u8BF7\u5148\u5B8C\u6210\u201C\u8FDE\u63A5\u4E0E\u542F\u52A8\u201D\u3002",state.active?"good":"warning"));\n put(panel("\u81EA\u52A8\u6E05\u7406\u8BF4\u660E"),node("p","\u67E5\u8BE2\u5B8C\u6210\u540E\u81EA\u52A8\u5220\u9664\u6210\u5458\u53D1\u9001\u7684\u5730\u5740\u548C\u67E5\u8BE2\u4E2D\u63D0\u793A\uFF1B\u5907\u6CE8\u4FEE\u6539\u5B8C\u6210\u540E\u5220\u9664\u4E34\u65F6\u63D0\u793A\u548C\u6210\u5458\u56DE\u590D\u3002\u82E5\u201C\u6E05\u7406\u53D7\u963B\u201D\u4E0D\u4E3A 0\uFF0C\u8BF7\u68C0\u67E5 Telegram \u7FA4\u7EC4\u4E2D\u673A\u5668\u4EBA\u662F\u5426\u5177\u5907\u201C\u5220\u9664\u6D88\u606F\u201D\u7684\u7BA1\u7406\u5458\u6743\u9650\u3002","muted"));\n }\n if(activeRoute==="wallets"){\n var p=panel("\u6DFB\u52A0\u94B1\u5305\u5730\u5740\uFF08\u4EC5\u6709\u6548 USDT \u6388\u6743\u624D\u542F\u52A8\u76D1\u63A7\uFF09"),addr=input(p,"\u94B1\u5305\u5730\u5740","0x..."),chat=input(p,"Telegram \u7FA4 ID\uFF08\u53EF\u4E0D\u586B\uFF09","-100..."),remark=input(p,"\u5907\u6CE8","");\n action(p,"\u6DFB\u52A0\u94B1\u5305",async()=>{try{var x=await api("/api/wallets","POST",{address:addr.value,chat_id:chat.value,remark:remark.value});alert(x.note);await render()}catch(e){err(e)}});\n var rows=await api("/api/wallets");table(panel("\u94B1\u5305\u5217\u8868"),["\u5730\u5740","\u7EDF\u4E00\u5907\u6CE8","\u9996\u6B21\u67E5\u8BE2\u4EBA","\u6765\u6E90","\u76D1\u63A7\u72B6\u6001"],rows.map(x=>[x.address,x.remark,x.first_user_name,x.discovery_source,x.watch_state]));\n }\n\n if(activeRoute==="monitoring"){\n  var monitor=await api("/api/monitoring?page="+monitorPage+"&status="+monitorStatus+"&search="+encodeURIComponent(monitorSearch));\n  var pm=panel("\u6B63\u5728\u76D1\u63A7\u5730\u5740 \xB7 Ethereum Mainnet");\n  put(pm,node("p","\u8FD9\u91CC\u96C6\u4E2D\u663E\u793A\u5DF2\u63A5\u5165\u53CA\u7B49\u5F85\u63A5\u5165\u7684 ETH / USDT / USDC \u8D44\u91D1\u76D1\u63A7\u94B1\u5305\u3002\u7F16\u8F91\u4E00\u4E2A\u5730\u5740\u7684\u5907\u6CE8\uFF0C\u4F1A\u540C\u6B65\u6240\u6709 Telegram \u7FA4\u3001\u540E\u53F0\u5217\u8868\u548C\u4ECA\u540E\u7684\u901A\u77E5\u3002","muted"));\n  var stats=put(pm,node("div",null,"grid"));\n  var totals={};(monitor.summary||[]).forEach(x=>totals[x.state]=x.n);\n  [["\u6B63\u5728\u76D1\u63A7",totals.active||0],["\u7B49\u5F85\u63A5\u5165",totals.pending||0],["\u79FB\u9664\u5F85\u5904\u7406",totals.removal_pending||0]].forEach(x=>{var cell=put(stats,node("section",null,"panel"));put(cell,node("div",x[0],"muted"));put(cell,node("div",x[1],"big"))});\n  var search=input(pm,"\u641C\u7D22\u94B1\u5305\u5730\u5740\u6216\u5907\u6CE8","\u8F93\u5165\u5730\u5740\u6216\u5907\u6CE8\u540E\u70B9\u51FB\u641C\u7D22");search.value=monitorSearch;\n  search.onkeydown=e=>{if(e.key==="Enter"){monitorSearch=search.value.trim();monitorPage=0;render()}};\n  action(pm,"\u641C\u7D22",async()=>{monitorSearch=search.value.trim();monitorPage=0;await render()},"secondary");\n  action(pm,"\u6E05\u9664\u641C\u7D22",async()=>{monitorSearch="";monitorStatus="all";monitorPage=0;await render()},"secondary");\n  var filter=put(pm,node("select"));filter.setAttribute("aria-label","\u76D1\u63A7\u72B6\u6001\u7B5B\u9009");\n  [["all","\u5168\u90E8\u72B6\u6001"],["active","\u6B63\u5728\u76D1\u63A7"],["pending","\u7B49\u5F85\u63A5\u5165"],["removal_pending","\u79FB\u9664\u5F85\u5904\u7406"]].forEach(x=>{var o=put(filter,node("option",x[1]));o.value=x[0]});\n  filter.value=monitorStatus;\n  filter.onchange=async()=>{monitorStatus=filter.value;monitorPage=0;await render()};\n  var wrap=put(pm,node("div",null,"scroll")),tab=put(wrap,node("table")),hd=put(tab,node("tr"));\n  ["\u94B1\u5305\u5730\u5740","\u7EDF\u4E00\u5907\u6CE8\uFF08\u53EF\u4FEE\u6539\uFF09","\u76D1\u63A7\u72B6\u6001","Telegram \u901A\u77E5\u7FA4","\u5730\u5740\u6765\u6E90","\u4E0A\u6B21\u540C\u6B65","\u64CD\u4F5C"].forEach(x=>put(hd,node("th",x)));\n  monitor.rows.forEach(x=>{\n    var tr=put(tab,node("tr"));\n    put(tr,node("td",x.address));\n    var editCell=put(tr,node("td")),field=put(editCell,node("input"));field.value=x.remark||"";field.maxLength=80;field.setAttribute("aria-label","\u7F16\u8F91 "+x.address+" \u7684\u5907\u6CE8");field.style.minWidth="180px";\n    put(tr,node("td",x.state==="active"?"\u25CF \u6B63\u5728\u76D1\u63A7":x.state==="pending"?"\u25CF \u7B49\u5F85\u63A5\u5165":"\u25CF \u79FB\u9664\u5F85\u5904\u7406"));\n    put(tr,node("td",x.groups||"\u2014"));put(tr,node("td",x.discovery_source||"\u2014"));put(tr,node("td",x.synced_at||"\u2014"));\n    var actions=put(tr,node("td"));\n    var save=action(actions,"\u4FDD\u5B58\u5907\u6CE8",async()=>{\n      save.disabled=true;\n      try{await api("/api/monitoring/remark","POST",{address:x.address,remark:field.value});await render();alertMsg("\u5907\u6CE8\u5DF2\u540C\u6B65\u6240\u6709\u9875\u9762\u3001\u901A\u77E5\u7FA4\u548C\u672A\u6765\u6D88\u606F")}\n      catch(e){err(e);save.disabled=false}\n    });\n  });\n  if(!monitor.rows.length)put(pm,node("p","\u5F53\u524D\u6CA1\u6709\u7B26\u5408\u6761\u4EF6\u7684\u76D1\u63A7\u5730\u5740\u3002\u5386\u53F2\u626B\u63CF\u53D1\u73B0\u7684\u94B1\u5305\u4F1A\u9010\u6B65\u81EA\u52A8\u52A0\u5165\u3002","muted"));\n  put(pm,node("p","\u7B26\u5408\u6761\u4EF6\uFF1A"+monitor.total+" \u4E2A\u5730\u5740 \xB7 \u7B2C "+(monitorPage+1)+" / "+Math.max(1,monitor.total_pages)+" \u9875 \xB7 \u6BCF\u9875 50 \u6761","muted"));\n  var pages=put(pm,node("div"));\n  if(monitorPage>0)action(pages,"\u4E0A\u4E00\u9875",async()=>{monitorPage--;await render()},"secondary");\n  if(monitorPage+1<monitor.total_pages)action(pages,"\u4E0B\u4E00\u9875",async()=>{monitorPage++;await render()},"secondary");\n }\n if(activeRoute==="spenders"){\n var p=panel("\u767B\u8BB0 Spender\uFF08\u81EA\u52A8\u76D1\u63A7\u5386\u53F2\u53CA\u65B0\u6388\u6743\u7684 Owner\uFF09"),a=input(p,"Spender Ethereum \u5730\u5740","0x..."),remark=input(p,"\u88AB\u6388\u6743\u4EBA\u5907\u6CE8","\u4F8B\u5982\uFF1A\u6388\u6743\u5408\u7EA6"),ch=input(p,"\u901A\u77E5\u7FA4 ID\uFF08\u591A\u4E2A\u7528\u9017\u53F7\u5206\u9694\uFF09","");\n action(p,"\u6DFB\u52A0 Spender",async()=>{try{await api("/api/spenders","POST",{spender:a.value,remark:remark.value,chat_ids:ch.value.split(",").map(x=>x.trim()).filter(Boolean)});await render()}catch(e){err(e)}});\n var data=await api("/api/spenders");\n var list=panel("\u53CD\u5411\u6388\u6743\u76D1\u542C\u89C4\u5219");\n put(list,node("p","\u6BCF\u6761 Spender \u90FD\u53EF\u4EE5\u5355\u72EC\u7F16\u8F91\u6216\u5220\u9664\u3002\u5220\u9664\u540E\u505C\u6B62\u6B64 Spender \u7684\u626B\u63CF\u548C\u63A8\u9001\uFF0C\u4F46\u5DF2\u63A5\u5165\u7684\u72EC\u7ACB\u94B1\u5305\u76D1\u63A7\u4ECD\u4FDD\u7559\u3002","muted"));\n var scroll=put(list,node("div",null,"scroll")),tbl=put(scroll,node("table")),header=put(tbl,node("tr"));\n ["Spender \u5730\u5740","\u5907\u6CE8","\u8FD0\u884C\u4E2D","\u5F00\u59CB\u533A\u5757","\u626B\u63CF\u8FDB\u5EA6","\u901A\u77E5\u7FA4 ID","\u64CD\u4F5C"].forEach(x=>put(header,node("th",x)));\n var editor=panel("\u7F16\u8F91 Spender \u89C4\u5219");\n put(editor,node("p","\u8BF7\u9009\u62E9\u4E0A\u65B9\u4E00\u6761 Spender \u8FDB\u884C\u4FEE\u6539\u3002\u591A\u4E2A\u7FA4 ID \u7528\u82F1\u6587\u9017\u53F7\u5206\u9694\u3002\u65B0\u7FA4\u5FC5\u987B\u5148\u52A0\u5165\u673A\u5668\u4EBA\u5E76\u767B\u8BB0\u3002","muted"));\n var editAddress=input(editor,"\u5F53\u524D\u9009\u62E9\u7684 Spender","\u8BF7\u70B9\u51FB\u4E0A\u65B9\u201C\u7F16\u8F91\u201D");editAddress.readOnly=true;\n var editRemark=input(editor,"Spender \u5907\u6CE8\uFF081\u201380 \u4E2A\u5B57\u7B26\uFF09","\u4F8B\u5982\uFF1A\u6388\u6743\u5408\u7EA6");\n var editChats=input(editor,"Telegram \u901A\u77E5\u7FA4 ID","\u4F8B\u5982\uFF1A-1001234567890,-1009876543210");\n var originalGroups=put(editor,node("p","","muted"));\n var selectedRule="";\n function chooseSpender(x){\n  selectedRule=x.spender;\n  editAddress.value=x.spender;editRemark.value=x.remark||"";\n  editChats.value=x.groups||"";\n  originalGroups.textContent="\u539F\u901A\u77E5\u7FA4\uFF1A"+(x.groups||"\u65E0");\n  editor.scrollIntoView({behavior:"smooth",block:"center"});\n  editRemark.focus();\n }\n data.forEach(x=>{\n  var row=put(tbl,node("tr"));\n  [x.spender,x.remark,x.enabled?"\u662F":"\u5426",x.start_block,x.cursor_block,x.groups||"\u2014"].forEach(v=>put(row,node("td",v)));\n  var op=put(row,node("td"));\n  action(op,"\u7F16\u8F91",()=>chooseSpender(x),"secondary");\n  action(op,"\u5220\u9664",async()=>{\n    if(!confirm("\u786E\u8BA4\u6C38\u4E45\u5220\u9664\u8FD9\u6761 Spender \u89C4\u5219\uFF1F\\\\n\\\\n\u5730\u5740\uFF1A"+x.spender+"\\\\n\u5907\u6CE8\uFF1A"+x.remark+"\\\\n\\\\n\u8FD9\u4F1A\u505C\u6B62\u6B64 Spender \u7684\u6388\u6743\u626B\u63CF\u548C\u89C4\u5219\u63A8\u9001\uFF0C\u5E76\u6E05\u9664\u672C\u89C4\u5219\u7684\u5386\u53F2\u626B\u63CF\u7ED3\u679C\u3002\u5DF2\u7ECF\u63A5\u5165\u7684\u72EC\u7ACB\u94B1\u5305\u76D1\u63A7\u3001\u539F\u6709\u4EA4\u6613\u53CA\u6D88\u606F\u8BB0\u5F55\u4F1A\u4FDD\u7559\u3002"))return;\n    try{\n      var result=await api("/api/spenders","DELETE",{spender:x.spender});\n      if(selectedRule===x.spender)selectedRule="";\n      if(historySpender===x.spender){historySpender="";historyPage=0;historyFilter="all";}\n      await render();\n      alertMsg(result.note||"Spender \u5DF2\u5220\u9664");\n    }catch(e){err(e)}\n  },"danger");\n });\n action(editor,"\u4FDD\u5B58\u4FEE\u6539",async()=>{\n  if(!selectedRule){alertMsg("\u8BF7\u5148\u9009\u62E9\u4E00\u6761 Spender \u89C4\u5219",true);return;}\n  var remark=editRemark.value.trim(),chats=[...new Set(editChats.value.split(/[,\uFF0C\\n]+/).map(x=>x.trim()).filter(Boolean))];\n  if(!remark||Array.from(remark).length>80){alertMsg("\u8BF7\u8F93\u5165 1\u201380 \u4E2A\u5B57\u7B26\u7684\u5907\u6CE8",true);return;}\n  if(!chats.length){alertMsg("\u8BF7\u81F3\u5C11\u586B\u5199\u4E00\u4E2A Telegram \u7FA4 ID",true);return;}\n  if(!confirm("\u786E\u8BA4\u4FDD\u5B58\u8FD9\u6761 Spender \u7684\u5907\u6CE8\u548C\u7FA4 ID\uFF1F\u7CFB\u7EDF\u4F1A\u66F4\u65B0\u540E\u7EED\u6388\u6743\u901A\u77E5\uFF0C\u5E76\u4E3A\u65B0\u7FA4\u540C\u6B65\u5DF2\u53D1\u73B0\u7684\u76D1\u63A7\u94B1\u5305\uFF1B\u65E7\u7FA4\u7684\u624B\u52A8\u8BA2\u9605\u548C\u5176\u4ED6 Spender \u8BA2\u9605\u4E0D\u53D7\u5F71\u54CD\u3002"))return;\n  try{\n   var answer=await api("/api/spenders","PATCH",{spender:selectedRule,remark:remark,chat_ids:chats});\n   await render();\n   alertMsg(answer.note||"Spender \u5DF2\u66F4\u65B0");\n  }catch(e){err(e)}\n });\n action(editor,"\u53D6\u6D88\u7F16\u8F91",()=>{selectedRule="";editAddress.value="";editRemark.value="";editChats.value="";originalGroups.textContent="";},"secondary");\n\n var hp=panel("USDT \u5386\u53F2\u6388\u6743\u5730\u5740 \xB7 Ethereum Mainnet");\n put(hp,node("p","\u81EA\u52A8\u56DE\u6EAF\u5386\u53F2 USDT \u6388\u6743\uFF1B\u5168\u90E8\u66FE\u6388\u6743\u7684 Owner\uFF08\u5305\u62EC\u73B0\u5DF2\u64A4\u9500\u7684\uFF09\u9010\u6B65\u52A0\u5165\u8D44\u91D1\u76D1\u63A7\u3002\u5DF2\u624B\u52A8\u79FB\u9664\u7684\u94B1\u5305\u4E0D\u4F1A\u91CD\u65B0\u52A0\u5165\u3002","muted"));\n var choices=put(hp,node("div"));\n data.forEach(x=>action(choices,(historySpender===x.spender?"\u25CF ":"")+x.remark+" \xB7 "+x.spender.slice(0,10)+"\u2026",async()=>{historySpender=x.spender;historyPage=0;historyFilter="all";await render()},"secondary"));\n if(data.length&&!data.some(x=>x.spender===historySpender)){historySpender=data[0].spender;historyPage=0;historyFilter="all";}\n if(historySpender){\n  var h=await api("/api/spenders/history?spender="+encodeURIComponent(historySpender)+"&page="+historyPage+"&status="+historyFilter),j=h.job;\n  var pct=Math.min(100,Math.max(0,Math.floor(100*Math.min(j.next_block,j.cutoff_block+1)/(j.cutoff_block+1||1))));\n  put(hp,node("h3",(j.state==="completed"?"\u5386\u53F2\u626B\u63CF\u5DF2\u5B8C\u6210":j.state==="retrying"?"\u626B\u63CF\u7B49\u5F85\u91CD\u8BD5":"\u6B63\u5728\u56DE\u6EAF\u5386\u53F2\u6388\u6743")+" \xB7 "+pct+"%"));\n  put(hp,node("p","\u5DF2\u626B\u63CF\u533A\u5757\uFF1A"+Math.max(0,j.next_block-1)+" / "+j.cutoff_block+"\uFF1B\u5DF2\u53D1\u73B0\u6388\u6743\u4E8B\u4EF6\uFF1A"+j.events_found,"muted"));\n  if(j.last_error)put(hp,node("p","\u626B\u63CF\u63D0\u793A\uFF1A"+j.last_error,"warning"));\n  if(j.state!=="completed")put(hp,node("p","\u5386\u53F2\u626B\u63CF\u5C1A\u672A\u5B8C\u6210\uFF0C\u5F53\u524D\u5730\u5740\u6570\u91CF\u5E76\u975E\u6700\u7EC8\u603B\u91CF\u3002","warning"));\n  if(h.counts.pending)put(hp,node("p","\u8FD8\u6709 "+h.counts.pending+" \u4E2A\u5730\u5740\u7B49\u5F85\u6838\u9A8C\u5B9E\u65F6\u6388\u6743\u989D\u5EA6\u3002","warning"));\n  var stats=put(hp,node("div",null,"grid"));\n  [["\u5730\u5740\u603B\u6570",h.counts.total],["\u5F53\u524D\u6709\u6548",h.counts.active],["\u5DF2\u64A4\u9500 / \u989D\u5EA6\u4E3A 0",h.counts.revoked],["\u5F85\u6838\u9A8C",h.counts.pending]].forEach(x=>{var cell=put(stats,node("section",null,"panel"));put(cell,node("div",x[0],"muted"));put(cell,node("div",x[1],"big"))});\n  var sf=put(hp,node("select"));sf.setAttribute("aria-label","\u6388\u6743\u72B6\u6001\u7B5B\u9009");\n  [["all","\u5168\u90E8\u5730\u5740"],["active","\u5F53\u524D\u6709\u6548"],["revoked","\u5DF2\u64A4\u9500 / \u96F6\u989D\u5EA6"],["pending","\u5F85\u6838\u9A8C"]].forEach(x=>{var o=put(sf,node("option",x[1]));o.value=x[0]});\n  sf.value=historyFilter;sf.onchange=async()=>{historyFilter=sf.value;historyPage=0;await render()};\n  action(hp,"\u5237\u65B0\u8FDB\u5EA6",async()=>{await render()},"secondary");\n  action(hp,"\u91CD\u65B0\u6838\u9A8C\u5F53\u524D\u989D\u5EA6",async()=>{try{await api("/api/spenders/history/refresh","POST",{spender:historySpender});historyPage=0;await render()}catch(e){err(e)}},"secondary");\n  function units(raw){if(raw===null||raw===undefined)return "\u5F85\u6838\u9A8C";try{if(BigInt(raw)>=(1n<<255n))return "\u65E0\u9650\u989D\u5EA6";var s=String(raw).padStart(7,"0"),f=s.slice(-6).replace(/0+$/,"");return s.slice(0,-6)+(f?"."+f:"")+" USDT"}catch{return "\u6570\u636E\u5F02\u5E38"}}\n  table(hp,["Owner \u5730\u5740","\u7EDF\u4E00\u5907\u6CE8","\u6388\u6743\u72B6\u6001","\u76D1\u63A7\u72B6\u6001","\u5F53\u524D USDT \u6388\u6743\u989D\u5EA6","\u6700\u8FD1\u6388\u6743\u4EA4\u6613\u989D\u5EA6","\u6700\u65B0\u6388\u6743\u65F6\u95F4","\u9996\u6B21\u533A\u5757","\u6700\u65B0\u6388\u6743\u533A\u5757","\u4EA4\u6613\u54C8\u5E0C","\u6838\u9A8C\u65F6\u95F4"],h.rows.map(x=>[x.owner,x.remark||"\u5F85\u5907\u6CE8",x.verify_status==="active"?"\u6709\u6548":x.verify_status==="revoked"?"\u5DF2\u64A4\u9500 / \u96F6\u989D\u5EA6":"\u5F85\u6838\u9A8C",x.monitor_state==="active"?"\u5DF2\u63A5\u5165":x.monitor_state==="retrying"?"\u8FDE\u63A5\u91CD\u8BD5\u4E2D":x.monitor_state==="excluded"?"\u5DF2\u624B\u52A8\u6392\u9664":"\u7B49\u5F85\u63A5\u5165",units(x.current_allowance_raw),units(x.last_event_amount_raw),x.approval_at||"\u5F85\u8865\u9F50",x.first_seen_block,x.latest_event_block,x.latest_tx_hash,x.verified_at||"\u2014"]));\n  put(hp,node("p","\u5171 "+h.total+" \u4E2A\u5730\u5740 \xB7 \u7B2C "+(historyPage+1)+" / "+Math.max(1,h.total_pages)+" \u9875 \xB7 \u6BCF\u9875 50 \u6761","muted"));\n  var pager=put(hp,node("div"));if(historyPage>0)action(pager,"\u4E0A\u4E00\u9875",async()=>{historyPage--;await render()},"secondary");if(historyPage+1<h.total_pages)action(pager,"\u4E0B\u4E00\u9875",async()=>{historyPage++;await render()},"secondary");\n }\n var edit=panel("\u6682\u505C / \u6062\u590D Spender \u53D1\u73B0\u4EFB\u52A1"),editSpender=input(edit,"Spender \u5730\u5740","0x...");\n action(edit,"\u6682\u505C\u6388\u6743\u53D1\u73B0",async()=>{try{await api("/api/spenders","PATCH",{spender:editSpender.value,enabled:false});await render()}catch(e){err(e)}},"secondary");\n action(edit,"\u6062\u590D\u6388\u6743\u53D1\u73B0",async()=>{try{await api("/api/spenders","PATCH",{spender:editSpender.value,enabled:true});await render()}catch(e){err(e)}});\n }\n if(activeRoute==="subscriptions"){\n var rows=await api("/api/subscriptions");table(panel("\u5730\u5740\u7FA4\u7EC4\u8BA2\u9605"),["\u7FA4\u7EC4","\u94B1\u5305","\u5907\u6CE8","\u72B6\u6001"],rows.map(x=>[x.title||x.chat_id,x.address,x.remark,x.status]));\n var p=panel("\u4FEE\u6539\u672C\u7FA4\u5907\u6CE8\u6216\u6682\u505C"),chat=input(p,"\u7FA4 ID",""),address=input(p,"\u94B1\u5305\u5730\u5740",""),remark=input(p,"\u65B0\u5907\u6CE8\uFF08\u4E0D\u4FEE\u6539\u53EF\u7559\u7A7A\uFF09","");\n var select=put(p,node("select"));["\u4FDD\u6301\u5F53\u524D\u72B6\u6001","active","paused","removed"].forEach((name,i)=>{var o=put(select,node("option",name));o.value=i?name:""});\n action(p,"\u4FDD\u5B58",async()=>{try{await api("/api/subscriptions","PATCH",{chat_id:chat.value,address:address.value,...(remark.value?{remark:remark.value}:{}),...(select.value?{status:select.value}:{})});await render()}catch(e){err(e)}});\n }\n if(activeRoute==="templates"){\n var data=await api("/api/templates"),catalog=data.catalog||[],p=panel("\u7EDF\u4E00\u6D88\u606F\u6A21\u677F\u7BA1\u7406");\n put(p,node("p","\u67E5\u8BE2\u56DE\u590D\u3001\u4E3B\u52A8\u63A8\u9001\u3001\u5907\u6CE8\u64CD\u4F5C\u3001\u94FE\u4E0A\u5F02\u52A8\u4E0E\u7CFB\u7EDF\u63D0\u9192\uFF0C\u5168\u90E8\u96C6\u4E2D\u7BA1\u7406\u3002\u4E0B\u62C9\u83DC\u5355\u663E\u793A\u4E2D\u6587\u540D\u79F0\uFF0C\u4FDD\u5B58\u540E\u7ACB\u5373\u7528\u4E8E\u540E\u7EED\u6D88\u606F\u3002","muted"));\n var select=put(p,node("select"));select.setAttribute("aria-label","\u9009\u62E9\u6D88\u606F\u6A21\u677F");\n var categories=[];\n catalog.forEach(t=>{\n   var group=categories.find(g=>g.name===t.category);\n   if(!group){var item=put(select,node("optgroup"));item.label=t.category;group={name:t.category,element:item};categories.push(group)}\n   var o=put(group.element,node("option",t.title+" \xB7 "+t.mode));o.value=t.key;\n });\n if(!catalog.length){Object.keys(data.defaults||{}).forEach(k=>{var o=put(select,node("option",k));o.value=k})}\n select.value=(catalog.some(t=>t.key===templateChoice)?templateChoice:select.options[0]?.value)||"";\n var infobox=put(p,node("div",null,"template-info"));\n var chat=input(p,"\u7FA4\u7EC4 ID\uFF08\u8F93\u5165 * \u8868\u793A\u5168\u5C40\u901A\u7528\uFF1B\u6307\u5B9A\u7FA4\u7EC4\u53EF\u8986\u76D6\u5168\u5C40\u6A21\u677F\uFF09","*");chat.value=templateChat;\n put(p,node("h3","Telegram \u6D88\u606F\u6B63\u6587"));\n var textarea=put(p,node("textarea"));textarea.setAttribute("aria-label","\u6D88\u606F\u6A21\u677F\u6B63\u6587");\n var note=input(p,"\u6A21\u677F\u5907\u6CE8\uFF08\u4EC5\u7BA1\u7406\u5458\u53EF\u89C1\uFF0C\u4E0D\u4F1A\u53D1\u9001\u5230 Telegram\uFF09","\u53EF\u4EE5\u8BB0\u5F55\u8FD9\u4E2A\u6A21\u677F\u7684\u7528\u9014\u3001\u8C03\u6574\u539F\u56E0\u6216\u63D0\u9192\u4E8B\u9879");\n var tip=put(p,node("p",null,"muted"));\n function update(){\n   var key=select.value,groupId=chat.value.trim()||"*",t=catalog.find(x=>x.key===key);\n   var exact=data.overrides.find(x=>x.template_key===key&&x.chat_id===groupId);\n   var global=data.overrides.find(x=>x.template_key===key&&x.chat_id==="*");\n   textarea.value=exact?exact.body:global?global.body:data.defaults[key]||"";\n   var savedNote=(data.notes||[]).find(x=>x.id===key+":"+groupId);\n   note.value=savedNote?savedNote.note:"";\n   infobox.replaceChildren();\n   put(infobox,node("div",(t?t.title:"\u5F53\u524D\u6A21\u677F")+" \xB7 "+(t?t.category:"\u6D88\u606F"),"template-title"));\n   put(infobox,node("div","\u89E6\u53D1\u65B9\u5F0F\uFF1A"+(t?t.mode:"\u7CFB\u7EDF\u89E6\u53D1")+"\u3000|\u3000"+(t&&t.temporary?"\u4E34\u65F6\u901A\u77E5 \xB7 \u81EA\u52A8\u6E05\u7406":"\u6B63\u5F0F\u901A\u77E5 \xB7 \u6309\u4E1A\u52A1\u89C4\u5219\u4FDD\u7559"),"muted"));\n   put(infobox,node("div",t?t.description:"\u8BF7\u6309\u9700\u7F16\u8F91\u6B63\u6587\u3002","template-detail"));\n   tip.textContent="\u53EF\u7528\u53D8\u91CF\uFF1A"+(t&&t.variables.length?t.variables.map(v=>"{{"+v+"}}").join("\u3001"):"\u672C\u6A21\u677F\u65E0\u9700\u53D8\u91CF")+"\u3002\u53D8\u91CF\u4F1A\u81EA\u52A8\u66FF\u6362\uFF0C\u7FA4\u7EC4\u5730\u5740\u5907\u6CE8\u4F7F\u7528 {{remark}}\u3002\u4FEE\u6539\u5907\u6CE8\u6309\u94AE\u4ECD\u7531\u7CFB\u7EDF\u81EA\u52A8\u6DFB\u52A0\u3002";\n   put(infobox,node("div",exact?"\u6B63\u5728\u7F16\u8F91\uFF1A\u5F53\u524D\u7FA4\u7EC4\u4E13\u5C5E\u7248\u672C":global?"\u5F53\u524D\u663E\u793A\uFF1A\u5168\u5C40\u5DF2\u53D1\u5E03\u7248\u672C":"\u5F53\u524D\u663E\u793A\uFF1A\u7CFB\u7EDF\u9ED8\u8BA4\u7248\u672C","muted"));\n }\n select.onchange=()=>{templateChoice=select.value;update()};\n chat.onchange=()=>{templateChat=chat.value.trim()||"*";update()};\n update();\n action(p,"\u4FDD\u5B58\u5E76\u53D1\u5E03\u6A21\u677F",async()=>{\n   try{var groupId=chat.value.trim()||"*";await api("/api/templates","PUT",{template_key:select.value,chat_id:groupId,body:textarea.value,note:note.value});templateChoice=select.value;templateChat=groupId;await render();alertMsg("\u6A21\u677F\u548C\u7BA1\u7406\u5458\u5907\u6CE8\u5DF2\u4FDD\u5B58")}\n   catch(e){err(e)}\n });\n action(p,"\u6062\u590D\u7CFB\u7EDF\u9ED8\u8BA4 / \u79FB\u9664\u8986\u76D6",async()=>{\n   if(!confirm("\u786E\u8BA4\u79FB\u9664\u5F53\u524D\u6A21\u677F\u5728\u8FD9\u4E2A\u7FA4\u7EC4\u7684\u81EA\u5B9A\u4E49\u5185\u5BB9\u4E0E\u7BA1\u7406\u5458\u5907\u6CE8\uFF1F\u82E5\u6709\u5168\u5C40\u6A21\u677F\uFF0C\u5C06\u81EA\u52A8\u4F7F\u7528\u5168\u5C40\u6A21\u677F\u3002"))return;\n   try{var groupId=chat.value.trim()||"*";await api("/api/templates","DELETE",{template_key:select.value,chat_id:groupId});templateChoice=select.value;templateChat=groupId;await render();alertMsg("\u5DF2\u6062\u590D\u5BF9\u5E94\u9ED8\u8BA4\u6A21\u677F")}catch(e){err(e)}\n },"secondary");\n var list=panel("\u5168\u90E8\u6D88\u606F\u6A21\u677F\uFF08"+catalog.length+" \u79CD\uFF09");\n put(list,node("p","\u5206\u7C7B\u4E0E\u89E6\u53D1\u65B9\u5F0F\u5747\u4E3A\u4E2D\u6587\uFF1B\u70B9\u9009\u4E0A\u65B9\u4E0B\u62C9\u83DC\u5355\u5373\u53EF\u7F16\u8F91\u4EFB\u610F\u6D88\u606F\u3002\u4FEE\u6539\u7FA4\u7EC4\u4E13\u5C5E\u7248\u672C\u4E0D\u4F1A\u5F71\u54CD\u5176\u4ED6\u7FA4\u7EC4\u3002","muted"));\n table(list,["\u5206\u7C7B","\u6D88\u606F\u6A21\u677F","\u89E6\u53D1\u65B9\u5F0F","\u7528\u9014\u8BF4\u660E","\u81EA\u5B9A\u4E49\u72B6\u6001"],catalog.map(t=>[\n   t.category,t.title,t.mode,t.description,\n   data.overrides.some(x=>x.template_key===t.key)?"\u5B58\u5728\u5DF2\u53D1\u5E03\u4FEE\u6539":"\u4F7F\u7528\u9ED8\u8BA4\u6B63\u6587"\n ]));\n }\n if(activeRoute==="transfers"){\n var rows=await api("/api/transfers");table(panel("\u6700\u8FD1\u94FE\u4E0A\u4EA4\u6613"),["\u94B1\u5305","\u8D44\u4EA7","\u65B9\u5411","\u6570\u91CF","\u533A\u5757","\u4EA4\u6613\u54C8\u5E0C"],rows.map(x=>[x.address,x.asset,x.direction,x.raw_amount,x.block_number,x.tx_hash]));\n }\n if(activeRoute==="outbox"){\n var rows=await api("/api/outbox");table(panel("\u901A\u77E5\u961F\u5217\u548C\u5931\u8D25\u8BB0\u5F55"),["\u4EFB\u52A1","\u7FA4\u7EC4","\u6A21\u677F","\u72B6\u6001","\u91CD\u8BD5","\u9519\u8BEF"],rows.map(x=>[x.id,x.chat_id,x.template_key,x.state,x.attempts,x.last_error]));\n }\n if(activeRoute==="usage"){\n var d=await api("/api/usage");\n var rule=panel("\u8D39\u7528\u9884\u8B66");put(rule,node("p","\u989D\u5EA6\u4F7F\u7528\u8FBE\u5230 80%\uFF0C\u6216\u6309\u8FD1\u671F\u5B9E\u9645\u7528\u91CF\u9884\u8BA1 7 \u5929\u5185\u8017\u5C3D\u4E14\u65E9\u4E8E\u91CD\u7F6E\u65F6\u95F4\uFF0C\u53D1\u9001 Telegram \u7BA1\u7406\u5458\u79C1\u804A\u3002\u7535\u5B50\u90AE\u4EF6\u901A\u77E5\u5173\u95ED\u3002"));\n put(rule,node("p",d.source_warning,"muted"));\n var sync=action(rule,"\u7ACB\u5373\u540C\u6B65\u7528\u91CF",async()=>{sync.disabled=true;try{await api("/api/usage/refresh","POST",{});await render();alertMsg("\u91C7\u96C6\u5DF2\u6267\u884C\uFF0C\u8BF7\u67E5\u770B\u5404\u5E73\u53F0\u72B6\u6001")}catch(e){err(e)}finally{sync.disabled=false}});\n var test=action(rule,"\u53D1\u9001\u79C1\u804A\u6D4B\u8BD5\u901A\u77E5",async()=>{test.disabled=true;try{var r=await api("/api/usage/test-alert","POST",{});alertMsg(r.state==="sent"?"\u6D4B\u8BD5\u901A\u77E5\u5DF2\u9001\u8FBE Telegram":"\u6D4B\u8BD5\u901A\u77E5\u5DF2\u6392\u961F\uFF0C\u53D1\u9001\u5931\u8D25\u4F1A\u81EA\u52A8\u91CD\u8BD5",r.state!=="sent")}catch(e){err(e)}finally{test.disabled=false}},"secondary");\n action(rule,"\u914D\u7F6E\u53EA\u8BFB\u91C7\u96C6\u51ED\u8BC1",()=>navigate("setup"),"secondary");\n function num(v){return typeof v==="number"?v.toLocaleString("zh-CN",{maximumFractionDigits:3}):"\u2014"}\n function time(v){return v&&v.startsWith("9999")?"\u4E0D\u6309\u5468\u671F\u6E05\u96F6":v?new Date(v).toISOString().replace("T"," ").slice(0,16):"\u2014"}\n var source={official_api:"\u5E73\u53F0\u5B98\u65B9\u7EDF\u8BA1",application_counter:"\u672C\u7A0B\u5E8F\u8BA1\u6570",official_repository:"\u5B98\u65B9\u4ED3\u5E93\u4FE1\u606F",not_connected:"\u672A\u63A5\u901A"};\n var state={ok:"\u6B63\u5E38",waiting:"\u7B49\u5F85\u914D\u7F6E",error:"\u91C7\u96C6\u5F02\u5E38",stale:"\u6570\u636E\u8FC7\u671F",backfilling:"\u5386\u53F2\u56DE\u586B\u4E2D",not_applicable:"\u65E0\u6B64\u989D\u5EA6\u5305"};\n table(panel("\u5404\u5E73\u53F0\u7528\u91CF"),["\u5E73\u53F0 / \u8303\u56F4","\u91C7\u96C6\u72B6\u6001","\u6765\u6E90","\u5DF2\u7528 / \u989D\u5EA6","\u4F7F\u7528\u7387","\u9884\u8BA1\u8017\u5C3D","\u91CD\u7F6E\u65F6\u95F4\uFF08UTC\uFF09","\u6709\u6548\u91C7\u6837\u65F6\u95F4\uFF08UTC\uFF09","\u8BF4\u660E"],d.platforms.map(x=>[\n x.name+" \xB7 "+(x.scope||x.detail),state[x.status]||x.status,source[x.source]||x.source,\n num(x.used)+(x.unit?" "+x.unit:"")+" / "+num(x.quota),x.percentage==null?"\u2014":x.percentage+"%",\n x.predicted_exhaust_days==null?(x.quota?"\u7B49\u5F85\u589E\u91CF\u91C7\u6837":"\u2014"):x.predicted_exhaust_days+" \u5929",\n time(x.period_end),time(x.observed_at),(x.note||"")+(x.extra&&x.extra.rate_limited?"\uFF1B\u4ECA\u65E5\u9650\u6D41 "+x.extra.rate_limited+" \u6B21":"")\n ]));\n var settings=panel("Cloudflare \u989D\u5EA6\u57FA\u51C6"),plan=put(settings,node("select"));plan.setAttribute("aria-label","Cloudflare \u5F53\u524D\u5957\u9910");\n [["unknown","\u5957\u9910\u5C1A\u672A\u786E\u8BA4"],["free","Workers Free \xB7 \u514D\u8D39\u5957\u9910"],["standard","Workers Paid \xB7 \u6807\u51C6\u4ED8\u8D39\u5957\u9910"]].forEach(x=>{var o=put(plan,node("option",x[1]));o.value=x[0]});plan.value=d.settings.cloudflare_plan;\n var billday=input(settings,"\u6708\u8D26\u671F\u8D77\u59CB\u65E5\uFF08UTC\uFF09","1","number");billday.min="1";billday.max="31";billday.value=String(d.settings.cloudflare_billing_day);\n put(settings,node("p","\u8BF7\u6309\u5B9E\u9645\u5957\u9910\u548C\u8D26\u5355\u5468\u671F\u786E\u8BA4\u3002\u7528\u91CF\u6309\u6574\u4E2A Cloudflare \u8D26\u53F7\u7EDF\u8BA1\uFF0C\u5305\u542B\u5176\u4ED6\u9879\u76EE\u5171\u4EAB\u7684\u989D\u5EA6\uFF1B\u5957\u9910\u672A\u786E\u8BA4\u65F6\u4E0D\u8BA1\u7B97\u4F7F\u7528\u7387\u3002\u514D\u8D39\u5957\u9910\u6309 UTC \u6BCF\u65E5\u91CD\u7F6E\u3002","muted"));\n action(settings,"\u4FDD\u5B58\u989D\u5EA6\u57FA\u51C6",async()=>{try{await api("/api/usage/settings","PUT",{cloudflare_plan:plan.value,cloudflare_billing_day:Number(billday.value)});await api("/api/usage/refresh","POST",{});await render()}catch(e){err(e)}});\n var p=panel("\u81EA\u5B9A\u4E49\u989D\u5EA6"),sel=put(p,node("select"));sel.setAttribute("aria-label","\u9700\u8981\u8C03\u6574\u989D\u5EA6\u7684\u6307\u6807");\n d.platforms.filter(x=>x.metric!=="github_actions").forEach(x=>{var o=put(sel,node("option",x.name+" \xB7 "+x.unit));o.value=x.metric});\n var value=input(p,"\u989D\u5EA6\u6570\u91CF","\u6B63\u6574\u6570","number"),period=put(p,node("select"));period.setAttribute("aria-label","\u989D\u5EA6\u5468\u671F");\n [["daily","\u6BCF\u65E5"],["monthly","\u6BCF\u6708"]].forEach(x=>{var o=put(period,node("option",x[1]));o.value=x[0]});\n function syncUsagePeriod(){period.disabled=sel.value==="alchemy_cu";if(period.disabled)period.value="monthly"}sel.addEventListener("change",syncUsagePeriod);syncUsagePeriod();\n put(p,node("p","\u4EC5\u5728\u5E73\u53F0\u5957\u9910\u6216\u81EA\u5B9A\u9884\u7B97\u53D1\u751F\u53D8\u5316\u65F6\u8C03\u6574\u3002Alchemy \u4F18\u5148\u91C7\u7528\u5B98\u65B9\u63A5\u53E3\u989D\u5EA6\uFF1B\u63A5\u53E3\u672A\u8FD4\u56DE\u989D\u5EA6\u65F6\u91C7\u7528\u8FD9\u91CC\u786E\u8BA4\u7684\u5F53\u524D\u5957\u9910\u57FA\u51C6\u3002Telegram \u666E\u901A\u6D88\u606F\u6CA1\u6709\u56FA\u5B9A\u6708\u989D\u5EA6\uFF0C\u9ED8\u8BA4\u53EA\u7EDF\u8BA1\u53D1\u9001\u91CF\u548C\u9650\u6D41\u3002\u9884\u6D4B\u81F3\u5C11\u9700\u8981\u4E24\u6B21\u95F4\u9694 15 \u5206\u949F\u7684\u6709\u6548\u91C7\u6837\u3002","muted"));\n action(p,"\u4FDD\u5B58\u81EA\u5B9A\u4E49\u989D\u5EA6",async()=>{try{await api("/api/usage/limit","PUT",{metric:sel.value,quota:Number(value.value),period:period.value});await api("/api/usage/refresh","POST",{});await render()}catch(e){err(e)}});\n }\n if(activeRoute==="audit"){\n var rows=await api("/api/audit");table(panel("\u7BA1\u7406\u5458\u64CD\u4F5C\u8BB0\u5F55"),["\u65F6\u95F4","\u64CD\u4F5C","\u5BF9\u8C61"],rows.map(x=>[x.created_at,x.action,x.target]));\n }\n }catch(e){\n  loadError=e;\n  // No partially loaded page and no blank-screen flash on errors.\n  root.replaceChildren();\n  var fail=put(root,node("section",null,"panel"));\n  put(fail,node("h2","\u9875\u9762\u52A0\u8F7D\u5931\u8D25"));\n  put(fail,node("p",e.message||String(e),"warning"));\n  action(fail,"\u91CD\u8BD5",()=>render(),"secondary");\n }\n if(epoch!==renderEpoch)return;\n liveRoot.replaceChildren(...root.childNodes);\n renderedView=activeRoute;\n document.getElementById("title").textContent=views.find(x=>x[0]===activeRoute)?.[1]||"\u63A7\u5236\u53F0";\n [...nav.children].forEach(x=>x.classList.toggle("sel",x.dataset.key===activeRoute));\n alertMsg(loadError?(loadError.message||String(loadError)):"\u5DF2\u8FDE\u63A5",!!loadError);\n requestAnimationFrame(()=>{if(epoch===renderEpoch)window.scrollTo(0,sameView?lastScroll:0)});\n}\nviews.forEach(([k,n])=>{var b=action(nav,n,()=>navigate(k));b.className="";b.dataset.key=k});\ndocument.getElementById("refresh").onclick=start;\ndocument.getElementById("logout").onclick=async()=>{try{await api("/auth/logout","POST",{});await start()}catch(e){err(e)}};\nstart();\n})();\n<\/script></body></html>';

// src/admin.ts
var adminHtml = () => ADMIN_HTML;
var bad = (message, status2 = 400) => json({ error: message }, status2);
var body = async (req) => {
  try {
    return await req.json();
  } catch {
    return {};
  }
};
async function handleAdmin(req, env, path) {
  if (!await isAdmin(req, env)) return bad("\u7BA1\u7406\u5458\u9A8C\u8BC1\u5931\u8D25\u6216\u8BF7\u6C42\u6765\u6E90\u65E0\u6548", 401);
  const method = req.method;
  if (method === "GET" && path === "/api/summary") {
    const qs = ["SELECT count(*) n FROM wallets", "SELECT count(*) n FROM spender_rules WHERE enabled=1", "SELECT count(*) n FROM subscriptions WHERE status='active'", "SELECT count(*) n FROM outbox WHERE state='failed'", "SELECT count(*) n FROM transfer_events WHERE date(created_at)=date('now')", "SELECT count(*) n FROM telegram_message_cleanup WHERE state='blocked'", "SELECT count(*) n FROM telegram_message_cleanup WHERE state='pending'"];
    const v = [];
    for (const q of qs) v.push((await env.DB.prepare(q).first())?.n || 0);
    return json({ wallets: v[0], spenders: v[1], subscriptions: v[2], failed: v[3], transfers_today: v[4], cleanup_blocked: v[5], cleanup_pending: v[6] });
  }
  if (method === "GET" && path === "/api/chats") return json((await env.DB.prepare("SELECT * FROM telegram_chats ORDER BY title").all()).results);
  if (method === "GET" && path === "/api/monitoring") {
    const q = new URL(req.url).searchParams;
    const page = Math.min(1e5, Math.max(0, parseInt(q.get("page") || "0", 10) || 0));
    const status2 = q.get("status") || "all", search = String(q.get("search") || "").trim().slice(0, 90);
    if (!["all", "active", "pending", "removal_pending"].includes(status2)) return bad("\u76D1\u63A7\u72B6\u6001\u7B5B\u9009\u65E0\u6548");
    const where = "ww.state IN ('active','pending','removal_pending') AND (w.deleted_at IS NULL OR w.address IS NULL)" + (status2 === "all" ? "" : " AND ww.state=?") + (search ? " AND (ww.address LIKE ? OR COALESCE(g.remark,(SELECT remark FROM subscriptions s WHERE s.address=ww.address ORDER BY s.updated_at DESC LIMIT 1),'') LIKE ?)" : "");
    const args = [...status2 === "all" ? [] : [status2], ...search ? ["%" + search + "%", "%" + search + "%"] : []];
    const total = (await env.DB.prepare("SELECT COUNT(*) n FROM wallet_watches ww LEFT JOIN wallets w ON w.address=ww.address LEFT JOIN wallet_global_remarks g ON g.address=ww.address WHERE " + where).bind(...args).first())?.n || 0;
    const rows = (await env.DB.prepare(
      "SELECT ww.address,ww.state,ww.synced_at,ww.updated_at,ww.last_error,w.discovery_source,w.first_user_name,COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=ww.address ORDER BY s.updated_at DESC LIMIT 1),w.first_user_name,'\u5F85\u5907\u6CE8') AS remark,(SELECT GROUP_CONCAT(DISTINCT COALESCE(c.title,s.chat_id)) FROM subscriptions s LEFT JOIN telegram_chats c ON c.chat_id=s.chat_id WHERE s.address=ww.address AND s.status IN ('active','pending')) AS groups,(SELECT COUNT(*) FROM subscriptions s WHERE s.address=ww.address AND s.status='active') AS active_groups,(SELECT COUNT(*) FROM spender_history_addresses h WHERE h.owner=ww.address) AS history_spenders FROM wallet_watches ww LEFT JOIN wallets w ON w.address=ww.address LEFT JOIN wallet_global_remarks g ON g.address=ww.address WHERE " + where + " ORDER BY ww.updated_at DESC LIMIT 50 OFFSET ?"
    ).bind(...args, page * 50).all()).results || [];
    const summary = (await env.DB.prepare("SELECT state,COUNT(*) n FROM wallet_watches WHERE state IN ('active','pending','removal_pending') GROUP BY state").all()).results || [];
    return json({ rows, total, page, total_pages: Math.ceil(total / 50), summary });
  }
  if (method === "POST" && path === "/api/monitoring/remark") {
    const d = await body(req), address = addr(d.address);
    if (!address) return bad("\u94B1\u5305\u5730\u5740\u65E0\u6548");
    const watch = await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(address).first();
    if (!watch || watch.state === "removed") return bad("\u6B64\u5730\u5740\u5F53\u524D\u4E0D\u5728\u76D1\u63A7\u5217\u8868\u4E2D", 404);
    const previous = await walletRemark(env, address, "");
    let remark;
    try {
      remark = await saveWalletRemark(env, address, d.remark);
    } catch (e) {
      return bad(String(e.message || e));
    }
    await audit(env, "admin", "global_wallet_remark", address, { previous, remark });
    return json({ ok: true, remark, note: "\u6B64\u5730\u5740\u5907\u6CE8\u5DF2\u540C\u6B65\u6240\u6709\u7FA4\u7EC4\u3001\u540E\u53F0\u5217\u8868\u4E0E\u540E\u7EED\u6D88\u606F" });
  }
  if (method === "GET" && path === "/api/wallets") return json((await env.DB.prepare("SELECT w.*,ww.state watch_state,COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=w.address ORDER BY s.updated_at DESC LIMIT 1),w.first_user_name) remark FROM wallets w LEFT JOIN wallet_watches ww USING(address) LEFT JOIN wallet_global_remarks g USING(address) ORDER BY w.created_at DESC LIMIT 200").all()).results);
  if (method === "POST" && path === "/api/wallets") {
    const d = await body(req), a = addr(d.address);
    if (!a) return bad("\u65E0\u6548\u7684 Ethereum \u5730\u5740");
    await env.DB.prepare("INSERT OR IGNORE INTO wallets(address,discovery_source) VALUES(?,'admin')").bind(a).run();
    if (d.chat_id) {
      const chat = String(d.chat_id);
      if (!await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()) return bad("\u673A\u5668\u4EBA\u5FC5\u987B\u5148\u52A0\u5165\u8FD9\u4E2A Telegram \u7FA4\u7EC4");
      const remark = await walletRemark(env, a, String(d.remark || "\u5F85\u6838\u9A8C \xB7 " + short(a)).trim().slice(0, 80));
      await env.DB.prepare("INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,?,'pending')").bind(chat, a, remark).run();
      await env.TASKS.send({ kind: "verify_admin", owner: a, chat_id: chat });
    }
    await audit(env, "admin", "create_wallet", a);
    return json({ ok: true, monitored: false, note: "\u5730\u5740\u5DF2\u5B58\u6863\u3002\u5FC5\u987B\u6838\u5B9E\u6709\u6548 USDT \u6388\u6743\u624D\u80FD\u542F\u52A8\u8D44\u91D1\u76D1\u63A7\u3002" });
  }
  if (method === "POST" && path === "/api/wallets/remove") {
    const d = await body(req), wallet = addr(d.address);
    if (!wallet) return bad("\u65E0\u6548\u94B1\u5305\u5730\u5740");
    if (!await env.DB.prepare("SELECT 1 FROM wallets WHERE address=?").bind(wallet).first()) return bad("\u5730\u5740\u4E0D\u5B58\u5728", 404);
    await env.DB.prepare("INSERT OR IGNORE INTO wallet_exclusions(address) VALUES(?)").bind(wallet).run();
    await env.DB.prepare("UPDATE subscriptions SET status='removed',updated_at=? WHERE address=?").bind(now(), wallet).run();
    await env.DB.prepare("UPDATE wallets SET deleted_at=? WHERE address=?").bind(now(), wallet).run();
    await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='excluded',last_error='\u7BA1\u7406\u5458\u624B\u52A8\u79FB\u9664',updated_at=CURRENT_TIMESTAMP WHERE owner=?").bind(wallet).run();
    const removed = await removeWatch(await configEnv(env), wallet);
    await audit(env, "admin", "global_remove_wallet", wallet, { alchemy_removed: removed });
    return json({ ok: true, alchemy_removed: removed, archived: true });
  }
  if (method === "POST" && path === "/api/wallets/restore") {
    const d = await body(req), wallet = addr(d.address);
    if (!wallet) return bad("\u65E0\u6548\u94B1\u5305\u5730\u5740");
    await env.DB.prepare("DELETE FROM wallet_exclusions WHERE address=?").bind(wallet).run();
    await env.DB.prepare("UPDATE wallets SET deleted_at=NULL WHERE address=?").bind(wallet).run();
    await env.DB.prepare("UPDATE spender_history_monitor_enrollments SET state='pending',last_error=NULL,updated_at=datetime('now','-2 minutes') WHERE owner=? AND state='excluded'").bind(wallet).run();
    await audit(env, "admin", "restore_wallet", wallet);
    return json({ ok: true, watch_status: "not_automatically_resumed", note: "\u5DF2\u6062\u590D\u6863\u6848\u3002\u9700\u8981\u91CD\u65B0\u8FDB\u884C\u6709\u6548 USDT \u6388\u6743\u6838\u9A8C\u5E76\u5EFA\u7ACB\u7FA4\u7EC4\u8BA2\u9605\u3002" });
  }
  if (method === "GET" && path === "/api/spenders") return json((await env.DB.prepare("SELECT s.*,group_concat(r.chat_id) groups FROM spender_rules s LEFT JOIN spender_routes r USING(spender) GROUP BY s.spender ORDER BY s.created_at DESC LIMIT 200").all()).results);
  if (method === "POST" && path === "/api/spenders") {
    const d = await body(req), a = addr(d.spender);
    if (!a) return bad("Spender \u5730\u5740\u65E0\u6548");
    const groups = [...new Set((Array.isArray(d.chat_ids) ? d.chat_ids : []).map(String).filter((x) => /^-?\d+$/.test(x)))];
    if (!groups.length) return bad("\u5FC5\u987B\u9009\u62E9\u81F3\u5C11\u4E00\u4E2A Telegram \u7FA4\u7EC4");
    for (const chat of groups) if (!await env.DB.prepare("SELECT 1 FROM telegram_chats WHERE chat_id=?").bind(chat).first()) return bad("\u672A\u767B\u8BB0\u7684\u7FA4\u7EC4\uFF1A" + chat);
    await addSpender(await configEnv(env), a, String(d.remark || "Spender " + short(a)).slice(0, 80), groups);
    await startSpenderHistory(env, a);
    await audit(env, "admin", "create_spender", a, { groups });
    return json({ ok: true, mode: "history_and_new_approvals", note: "\u5386\u53F2\u4E0A\u6388\u6743\u8FC7\u6B64 Spender \u7684 Owner \u5C06\u9010\u6B65\u52A0\u5165\u76D1\u63A7\uFF1B\u4E0D\u81EA\u52A8\u76D1\u63A7 Spender \u81EA\u8EAB\u3002" });
  }
  if (method === "GET" && path === "/api/spenders/history") {
    const q = new URL(req.url).searchParams, spender = addr(q.get("spender"));
    if (!spender) return bad("\u8BF7\u8F93\u5165\u6709\u6548\u7684 Spender \u5730\u5740");
    const page = Math.min(1e5, Math.max(0, Number.parseInt(q.get("page") || "0", 10) || 0));
    const status2 = q.get("status") || "all";
    if (!["all", "active", "revoked", "pending"].includes(status2)) return bad("\u6388\u6743\u72B6\u6001\u7B5B\u9009\u503C\u65E0\u6548");
    const job = await env.DB.prepare("SELECT * FROM spender_history_jobs WHERE spender=?").bind(spender).first();
    if (!job) return bad("\u5C1A\u672A\u521B\u5EFA\u5386\u53F2\u6388\u6743\u626B\u63CF\u4EFB\u52A1", 404);
    const counts = await env.DB.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN verify_status='active' THEN 1 ELSE 0 END),0) AS active, COALESCE(SUM(CASE WHEN verify_status='revoked' THEN 1 ELSE 0 END),0) AS revoked, COALESCE(SUM(CASE WHEN verify_status='pending' THEN 1 ELSE 0 END),0) AS pending FROM spender_history_addresses WHERE spender=?").bind(spender).first();
    const filter = status2 === "all" ? "" : " AND h.verify_status=?";
    const args = status2 === "all" ? [spender, 50, page * 50] : [spender, status2, 50, page * 50];
    const rows = (await env.DB.prepare("SELECT h.owner,h.first_seen_block,h.latest_event_block,h.latest_tx_hash,h.last_event_amount_raw,h.current_allowance_raw,h.verify_status,h.verified_at,t.approval_at,g.remark,COALESCE(e.state,'waiting') monitor_state FROM spender_history_addresses h LEFT JOIN spender_history_timestamps t ON t.spender=h.spender AND t.owner=h.owner LEFT JOIN wallet_global_remarks g ON g.address=h.owner LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner WHERE h.spender=?" + filter + " ORDER BY h.latest_event_block DESC LIMIT ? OFFSET ?").bind(...args).all()).results || [];
    const total = status2 === "all" ? counts.total : counts[status2];
    const monitor = await env.DB.prepare(
      "SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN ww.state='active' THEN 1 ELSE 0 END),0) watched,COALESCE(SUM(CASE WHEN e.state='active' THEN 1 ELSE 0 END),0) connected,COALESCE(SUM(CASE WHEN e.state='retrying' THEN 1 ELSE 0 END),0) retrying FROM spender_history_addresses h LEFT JOIN wallet_watches ww ON ww.address=h.owner LEFT JOIN spender_history_monitor_enrollments e ON e.spender=h.spender AND e.owner=h.owner WHERE h.spender=?"
    ).bind(spender).first();
    const cooldown = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='spender_enroll_retry_after'").first())?.value || null;
    return json({ job, counts, monitor, monitor_retry_at: cooldown ? Number(cooldown) : null, rows, page, total, total_pages: Math.ceil(total / 50) });
  }
  if (method === "POST" && path === "/api/spenders/history/refresh") {
    const d = await body(req), spender = addr(d.spender);
    if (!spender) return bad("Spender \u5730\u5740\u65E0\u6548");
    if (!await env.DB.prepare("SELECT 1 FROM spender_history_jobs WHERE spender=?").bind(spender).first()) return bad("\u5386\u53F2\u626B\u63CF\u4EFB\u52A1\u4E0D\u5B58\u5728", 404);
    await env.DB.prepare("UPDATE spender_history_addresses SET verify_status='pending',verified_at=NULL WHERE spender=?").bind(spender).run();
    await env.DB.prepare("UPDATE spender_history_jobs SET state=CASE WHEN state='retrying' THEN 'scanning' ELSE state END,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE spender=?").bind(spender).run();
    return json({ ok: true, note: "\u5DF2\u5B89\u6392\u91CD\u65B0\u6838\u9A8C\u5F53\u524D\u6388\u6743\u989D\u5EA6\uFF0C\u5386\u53F2\u626B\u63CF\u4ECE\u65AD\u70B9\u7EE7\u7EED" });
  }
  if (method === "DELETE" && path === "/api/spenders") {
    const d = await body(req), a = addr(d.spender);
    if (!a) return bad("Spender \u5730\u5740\u65E0\u6548");
    const rule = await env.DB.prepare("SELECT spender,remark FROM spender_rules WHERE spender=?").bind(a).first();
    if (!rule) return bad("\u8BE5 Spender \u5DF2\u4E0D\u5B58\u5728", 404);
    const histories = (await env.DB.prepare("SELECT COUNT(*) AS n FROM spender_history_addresses WHERE spender=?").bind(a).first())?.n || 0;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM spender_routes WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_monitor_enrollments WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_timestamps WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_addresses WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_history_jobs WHERE spender=?").bind(a),
      env.DB.prepare("DELETE FROM spender_rules WHERE spender=?").bind(a)
    ]);
    await audit(env, "admin", "delete_spender", a, { remark: rule.remark, history_wallets_deleted_from_rule: histories, monitored_wallets_retained: true });
    return json({
      ok: true,
      removed_spender: a,
      history_records_removed: histories,
      monitored_wallets_retained: true,
      note: "Spender \u89C4\u5219\u5DF2\u5220\u9664\uFF0C\u5386\u53F2\u626B\u63CF\u4E0E\u8FD9\u6761\u89C4\u5219\u7684\u7FA4\u7EC4\u63A8\u9001\u5DF2\u505C\u6B62\uFF1B\u5DF2\u63A5\u5165\u7684\u72EC\u7ACB\u94B1\u5305\u76D1\u63A7\u548C\u65E2\u6709\u6D88\u606F\u8BB0\u5F55\u4FDD\u7559\u3002"
    });
  }
  if (method === "PATCH" && path === "/api/spenders") {
    const d = await body(req), a = addr(d.spender);
    if (!a) return bad("\u65E0\u6548 Spender \u5730\u5740");
    const rule = await env.DB.prepare("SELECT spender,remark,enabled FROM spender_rules WHERE spender=?").bind(a).first();
    if (!rule) return bad("\u627E\u4E0D\u5230\u8BE5 Spender \u89C4\u5219", 404);
    let remark;
    if (d.remark !== void 0) {
      remark = String(d.remark).trim();
      if (!remark || Array.from(remark).length > 80 || /[\u0000-\u001f\u007f]/.test(remark)) return bad("\u5907\u6CE8\u987B\u4E3A 1\u201380 \u4E2A\u5B57\u7B26\uFF0C\u4E0D\u80FD\u5305\u542B\u63A7\u5236\u5B57\u7B26");
    }
    let chats, oldGroups = [], removed = [], added = [];
    if (d.chat_ids !== void 0) {
      if (!Array.isArray(d.chat_ids)) return bad("\u901A\u77E5\u7FA4 ID \u683C\u5F0F\u65E0\u6548");
      chats = [...new Set(d.chat_ids.map((x) => String(x).trim()))];
      if (!chats.length || chats.some((x) => !/^-\d{5,20}$/.test(x))) return bad("\u8BF7\u586B\u5199\u81F3\u5C11\u4E00\u4E2A\u6709\u6548 Telegram \u7FA4 ID\uFF08\u4F8B\u5982 -100...\uFF09");
      for (const chat of chats) {
        const c = await env.DB.prepare("SELECT chat_id,chat_type,active FROM telegram_chats WHERE chat_id=?").bind(chat).first();
        if (!c) return bad("\u7FA4\u7EC4\u5C1A\u672A\u767B\u8BB0\uFF1A" + chat + "\u3002\u8BF7\u5148\u5C06\u673A\u5668\u4EBA\u52A0\u5165\u8BE5\u7FA4\uFF0C\u5E76\u5728\u7FA4\u5185\u53D1\u9001\u4E00\u6761\u6D88\u606F\u3002");
        if (!["group", "supergroup"].includes(c.chat_type) || !c.active) return bad("\u901A\u77E5\u76EE\u6807\u4E0D\u662F\u5DF2\u542F\u7528\u7684 Telegram \u7FA4\uFF1A" + chat);
      }
      oldGroups = ((await env.DB.prepare("SELECT chat_id FROM spender_routes WHERE spender=?").bind(a).all()).results || []).map((x) => String(x.chat_id));
      removed = oldGroups.filter((x) => !chats.includes(x));
      added = chats.filter((x) => !oldGroups.includes(x));
    }
    const changes = [];
    if (d.enabled !== void 0) changes.push(env.DB.prepare("UPDATE spender_rules SET enabled=? WHERE spender=?").bind(d.enabled ? 1 : 0, a));
    if (remark !== void 0) changes.push(env.DB.prepare("UPDATE spender_rules SET remark=? WHERE spender=?").bind(remark, a));
    if (chats) {
      for (const chat of added) changes.push(env.DB.prepare("INSERT OR IGNORE INTO spender_routes(spender,chat_id) VALUES(?,?)").bind(a, chat));
      for (const chat of added) {
        changes.push(env.DB.prepare(
          "INSERT OR IGNORE INTO subscriptions(chat_id,address,remark,status) SELECT ?,h.owner,COALESCE(g.remark,(SELECT s.remark FROM subscriptions s WHERE s.address=h.owner ORDER BY s.updated_at DESC LIMIT 1),'\u5F85\u5907\u6CE8 \xB7 '||substr(h.owner,1,12)),CASE WHEN ww.state='active' THEN 'active' ELSE 'pending' END FROM spender_history_addresses h LEFT JOIN wallet_global_remarks g ON g.address=h.owner LEFT JOIN wallet_watches ww ON ww.address=h.owner LEFT JOIN wallets w ON w.address=h.owner LEFT JOIN wallet_exclusions x ON x.address=h.owner WHERE h.spender=? AND x.address IS NULL AND (w.deleted_at IS NULL OR w.address IS NULL)"
        ).bind(chat, a));
      }
      for (const chat of removed) changes.push(env.DB.prepare("DELETE FROM spender_routes WHERE spender=? AND chat_id=?").bind(a, chat));
      for (const chat of removed) {
        changes.push(env.DB.prepare(
          "UPDATE subscriptions SET status='removed',updated_at=CURRENT_TIMESTAMP WHERE chat_id=? AND status IN ('active','pending') AND address IN (SELECT owner FROM spender_history_addresses WHERE spender=?) AND NOT EXISTS(SELECT 1 FROM wallets w WHERE w.address=subscriptions.address AND (w.first_user_id IS NOT NULL OR w.discovery_source IN ('manual','admin'))) AND NOT EXISTS(SELECT 1 FROM spender_history_addresses h2 JOIN spender_routes r2 ON r2.spender=h2.spender WHERE h2.owner=subscriptions.address AND r2.chat_id=? AND h2.spender<>?)"
        ).bind(chat, a, chat, a));
      }
    }
    if (changes.length) await env.DB.batch(changes);
    await audit(env, "admin", "update_spender", a, { remark_changed: remark !== void 0, old_groups: oldGroups, new_groups: chats || void 0, removed, added });
    return json({ ok: true, remark: remark ?? rule.remark, groups: chats || oldGroups, added, removed, note: "Spender \u5907\u6CE8\u548C\u901A\u77E5\u7FA4\u89C4\u5219\u5DF2\u4FDD\u5B58\uFF1B\u65E7\u7FA4\u7684\u624B\u52A8\u8BA2\u9605\u4E0E\u5176\u4ED6 Spender \u8BA2\u9605\u4FDD\u6301\u4E0D\u53D8\u3002" });
  }
  if (method === "GET" && path === "/api/subscriptions") return json((await env.DB.prepare("SELECT s.*,c.title FROM subscriptions s LEFT JOIN telegram_chats c USING(chat_id) ORDER BY s.updated_at DESC LIMIT 200").all()).results);
  if (method === "PATCH" && path === "/api/subscriptions") {
    const d = await body(req), a = addr(d.address), chat = String(d.chat_id || "");
    if (!a || !/^-?\d+$/.test(chat)) return bad("\u65E0\u6548\u8BA2\u9605\u5730\u5740\u6216\u7FA4\u7EC4");
    const old = await env.DB.prepare("SELECT * FROM subscriptions WHERE address=? AND chat_id=?").bind(a, chat).first();
    if (!old) return bad("\u8BA2\u9605\u4E0D\u5B58\u5728", 404);
    if (d.remark !== void 0) {
      const text = String(d.remark).trim();
      if (!text || Array.from(text).length > 80) return bad("\u5907\u6CE8\u957F\u5EA6\u4E3A 1\u201380 \u5B57\u7B26");
      await saveWalletRemark(env, a, text);
      await env.DB.prepare("INSERT INTO remark_edits(chat_id,address,actor_id,old_value,new_value) VALUES(?,?,?,?,?)").bind(chat, a, "admin", old.remark, text).run();
    }
    if (d.status !== void 0) {
      if (!["active", "paused", "removed"].includes(d.status)) return bad("\u72B6\u6001\u65E0\u6548");
      if (d.status === "active" && (await env.DB.prepare("SELECT state FROM wallet_watches WHERE address=?").bind(a).first())?.state !== "active") {
        if (!["paused", "removed"].includes(old.status)) return bad("\u8BE5\u5730\u5740\u5C1A\u672A\u5B8C\u6210\u6709\u6548 USDT \u6388\u6743\u6838\u9A8C", 409);
        if (!await ensureWatch(await configEnv(env), a)) return bad("Alchemy \u76D1\u63A7\u8BA2\u9605\u4ECD\u672A\u5B8C\u6210\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5", 409);
      }
      await env.DB.prepare("UPDATE subscriptions SET status=?,updated_at=? WHERE chat_id=? AND address=?").bind(d.status, now(), chat, a).run();
      if (d.status === "removed" || d.status === "paused") {
        const still = (await env.DB.prepare("SELECT count(*) n FROM subscriptions WHERE address=? AND status='active'").bind(a).first())?.n || 0;
        if (!still) await removeWatch(await configEnv(env), a);
      }
    }
    await audit(env, "admin", "update_subscription", a, { chat });
    return json({ ok: true });
  }
  if (method === "GET" && path === "/api/templates") {
    const overrides = (await env.DB.prepare("SELECT * FROM templates ORDER BY template_key,chat_id").all()).results;
    const notes = (await env.DB.prepare("SELECT key,value FROM runtime_state WHERE key LIKE 'template_note:%'").all()).results;
    return json({ defaults, catalog: templateCatalog, overrides, notes: notes.map((x) => ({ id: x.key.slice("template_note:".length), note: x.value })) });
  }
  if ((method === "PUT" || method === "DELETE") && path === "/api/templates") {
    const d = await body(req), key2 = String(d.template_key || ""), chat = String(d.chat_id || "*"), txt = String(d.body || "");
    if (!Object.hasOwn(defaults, key2) || !/^(\*|-?\d+)$/.test(chat)) return bad("\u6A21\u677F\u7C7B\u578B\u6216\u7FA4\u7EC4 ID \u4E0D\u5408\u6CD5");
    const noteKey = "template_note:" + key2 + ":" + chat;
    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM templates WHERE template_key=? AND chat_id=?").bind(key2, chat).run();
      await env.DB.prepare("DELETE FROM runtime_state WHERE key=?").bind(noteKey).run();
      await audit(env, "admin", "reset_template", key2, { chat });
      return json({ ok: true });
    }
    const note = d.note === void 0 ? void 0 : String(d.note);
    if (!txt.trim() || txt.length > 3500 || note !== void 0 && Array.from(note).length > 500) return bad("\u6A21\u677F\u6B63\u6587\u987B\u4E3A 1\u20133500 \u5B57\u7B26\uFF1B\u7BA1\u7406\u5458\u5907\u6CE8\u6700\u591A 500 \u5B57");
    await env.DB.prepare("INSERT INTO templates(template_key,chat_id,body) VALUES(?,?,?) ON CONFLICT(template_key,chat_id) DO UPDATE SET body=excluded.body,version=templates.version+1,updated_at=CURRENT_TIMESTAMP").bind(key2, chat, txt).run();
    if (note !== void 0) {
      await env.DB.prepare("INSERT INTO runtime_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").bind(noteKey, note).run();
    }
    await audit(env, "admin", "update_template", key2, { chat });
    return json({ ok: true });
  }
  if (method === "GET" && path === "/api/transfers") return json((await env.DB.prepare("SELECT * FROM transfer_events ORDER BY block_number DESC LIMIT 200").all()).results);
  if (method === "GET" && path === "/api/outbox") return json((await env.DB.prepare("SELECT id,chat_id,address,template_key,state,attempts,last_error,created_at FROM outbox ORDER BY id DESC LIMIT 200").all()).results);
  if (method === "GET" && path === "/api/audit") return json((await env.DB.prepare("SELECT * FROM admin_audit ORDER BY id DESC LIMIT 200").all()).results);
  if (method === "GET" && path === "/api/usage") return json({
    warning_threshold_percent: 80,
    forecast_days: 7,
    telegram_dm: true,
    email: false,
    source_warning: "\u5B98\u65B9\u7528\u91CF\u7EA6\u6BCF 15 \u5206\u949F\u540C\u6B65\uFF1B\u672C\u7A0B\u5E8F\u8BA1\u6570\u5355\u72EC\u6807\u6CE8\u3002\u5931\u8054\u6216\u8FC7\u671F\u6570\u636E\u4E0D\u53C2\u4E0E\u9884\u8B66\u3002\u9884\u6D4B\u53EA\u6BD4\u8F83\u540C\u4E00\u8D26\u671F\u7684\u5B9E\u9645\u589E\u91CF\uFF0C\u5E76\u8003\u8651\u989D\u5EA6\u91CD\u7F6E\u3002",
    settings: await usageSettings(env),
    platforms: await usageSnapshot(env)
  });
  if (method === "POST" && path === "/api/usage/refresh") {
    const e = await configEnv(env);
    const result = await collectUsage(e, true);
    await runUsageAlerts(e);
    await flushOutbox(e, 10, true);
    return json({ ...result, platforms: await usageSnapshot(e) });
  }
  if (method === "PUT" && path === "/api/usage/settings") {
    try {
      await saveUsageSettings(env, await body(req));
    } catch (e) {
      return bad(e.message);
    }
    await audit(env, "admin", "update_usage_settings", "usage");
    return json({ ok: true });
  }
  if (method === "POST" && path === "/api/usage/test-alert") {
    const e = await configEnv(env), dedup = await queueUsageTest(e);
    await flushOutbox(e, 10, true);
    return json(await env.DB.prepare("SELECT state,attempts,last_error FROM outbox WHERE dedup_key=?").bind(dedup).first());
  }
  if (method === "PUT" && path === "/api/usage/limit") {
    const d = await body(req);
    const allowed = Object.fromEntries(USAGE_METERS.map((x) => [x.metric, x.name]));
    if (!allowed[d.metric] || !["daily", "monthly"].includes(d.period) || !Number.isSafeInteger(d.quota) || d.quota < 1) return bad("\u914D\u989D\u53C2\u6570\u65E0\u6548");
    if (d.metric === "alchemy_cu" && d.period !== "monthly") return bad("Alchemy CU \u989D\u5EA6\u6309\u5B98\u65B9\u6708\u8D26\u671F\u8BA1\u7B97\uFF0C\u8BF7\u9009\u62E9\u6BCF\u6708");
    await env.DB.prepare("INSERT INTO usage_limits(metric,platform,unit,quota,period,source) VALUES(?,?,?,?,?,'configured_quota') ON CONFLICT(metric) DO UPDATE SET quota=excluded.quota,unit=excluded.unit,period=excluded.period,source=excluded.source,updated_at=CURRENT_TIMESTAMP").bind(d.metric, allowed[d.metric], USAGE_METERS.find((x) => x.metric === d.metric).unit, d.quota, d.period).run();
    await audit(env, "admin", "update_usage_limit", d.metric, { quota: d.quota });
    return json({ ok: true, source: "configured_quota" });
  }
  return bad("Unknown admin route", 404);
}

// src/index.ts
async function cron(env) {
  await recoverStuck(env);
  const { results: pending } = await env.DB.prepare("SELECT w.address FROM wallet_watches w WHERE w.state='pending' AND NOT EXISTS (SELECT 1 FROM spender_history_monitor_enrollments e WHERE e.owner=w.address AND e.state IN ('pending','running','retrying')) LIMIT 8").all();
  for (const p of pending || []) {
    if (await ensureWatch(env, p.address)) await env.DB.prepare("UPDATE subscriptions SET status='active' WHERE address=? AND status='pending'").bind(p.address).run();
  }
  try {
    await pollSpenders(env);
  } catch (e) {
    console.error("Spender scan", String(e));
  }
  try {
    for (let i = 0; i < 4; i++) {
      if (!await scanSpenderHistories(env)) break;
    }
  } catch (e) {
    console.error("Spender history scan", String(e));
  }
  try {
    await verifyHistoricalAllowances(env, 8);
  } catch (e) {
    console.error("Historical allowance checks", String(e));
  }
  try {
    await enrollHistoricalOwners(env, 20);
  } catch (e) {
    console.error("Historical monitoring enrollment", String(e));
  }
  try {
    await scanWalletGaps(env, 3);
  } catch (e) {
    console.error("Transfer recovery", String(e));
  }
  try {
    await reconcileRecentReorgs(env);
  } catch (e) {
    console.error("Reorg checks", String(e));
  }
  await flushOutbox(env, 40);
  await env.DB.prepare("DELETE FROM remark_sessions WHERE expires_at<datetime('now')").run();
}
var index_default = {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname;
    try {
      if (path.startsWith("/auth/")) return await authRoute(req, env, path);
      if (path.startsWith("/api/setup/")) {
        if (!await isAdmin(req, env)) return json({ error: "Administrator authentication required" }, 401);
        return await setupApi(req, env, path);
      }
      const active = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value === "1";
      const configured2 = active ? await configEnv(env) : env;
      if (req.method === "GET" && path === "/health") return json({ service: "ethereum-usdt-monitor", network: "Ethereum Mainnet", status: "service_available", build: "2026-10-15-auto-cleanup-v1", database_configured: !!env.DB });
      if (req.method === "GET" && path === "/admin") return new Response(adminHtml(), { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
      if (path.startsWith("/api/")) return await handleAdmin(req, env, path);
      if (req.method === "POST" && path === "/webhooks/telegram") {
        if (!active) return json({ error: "Monitor is not enabled" }, 503);
        if (!configured2.TELEGRAM_WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== configured2.TELEGRAM_WEBHOOK_SECRET) return json({ error: "Unauthorized" }, 401);
        const upd = await req.json();
        if (!Number.isSafeInteger(upd.update_id)) return json({ error: "Invalid update" }, 400);
        const seen = await env.DB.prepare("SELECT 1 FROM telegram_updates WHERE update_id=?").bind(upd.update_id).first();
        if (seen) return json({ ok: true, duplicate: true });
        await handleTelegram(configured2, upd);
        await env.DB.prepare("INSERT OR IGNORE INTO telegram_updates(update_id) VALUES(?)").bind(upd.update_id).run();
        return json({ ok: true });
      }
      if (req.method === "POST" && path === "/webhooks/alchemy") {
        if (!active) return json({ error: "Monitor is not enabled" }, 503);
        const raw = await req.text();
        if (!await verifyAlchemy(configured2, raw, req.headers.get("x-alchemy-signature"))) return json({ error: "Invalid webhook signature" }, 401);
        const d = JSON.parse(raw);
        await env.TASKS.send({ kind: "activity", payload: d });
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      console.error("Worker request error", String(e));
      return json({ error: "Service temporarily unavailable" }, 503);
    }
  },
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const item = message.body;
      try {
        const active = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value === "1";
        if (!active) {
          message.retry({ delaySeconds: 120 });
          continue;
        }
        const configured2 = await configEnv(env);
        if (item.kind === "check") {
          await checkOwner(configured2, item.owner, item.chat_id, item.user_id, item.display_name);
          try {
            await finishAddressQueryCleanup(configured2, item);
          } catch (cleanErr) {
            console.warn("Address query cleanup deferred", String(cleanErr));
          }
        } else if (item.kind === "activity") await processActivity(configured2, item.payload);
        else if (item.kind === "verify_admin") await verifyAdminOwner(configured2, item.owner, item.chat_id);
        else throw Error("Unknown queue message kind");
        message.ack();
      } catch (e) {
        console.error("Queue job failed", item.kind, String(e));
        if (message.attempts >= 5) {
          if (item.kind === "check") {
            try {
              await send(configured, item.chat_id, await renderTemplate(configured, "query_failed", item.chat_id, { address: item.owner }));
            } catch {
            }
            try {
              await finishAddressQueryCleanup(configured, item);
            } catch (cleanErr) {
              console.warn("Failed query cleanup deferred", String(cleanErr));
            }
          }
          message.ack();
        } else message.retry({ delaySeconds: Math.min(120, 10 * Math.pow(2, message.attempts || 1)) });
      }
    }
  },
  async scheduled(event, env, ctx) {
    const configured2 = await configEnv(env);
    ctx.waitUntil((async () => {
      try {
        await collectUsage(configured2);
        await runUsageAlerts(configured2);
        await flushOutbox(configured2, 10, true);
      } catch (e) {
        console.error("Usage maintenance failed", String(e));
      }
    })());
    ctx.waitUntil((async () => {
      try {
        await flushMessageCleanup(configured2, 60);
      } catch (e) {
        console.warn("Telegram message cleanup maintenance", String(e));
      }
    })());
    ctx.waitUntil((async () => {
      const active = (await env.DB.prepare("SELECT value FROM runtime_state WHERE key='is_active'").first())?.value === "1";
      if (active) await cron(configured2);
    })());
  }
};
export {
  index_default as default
};
