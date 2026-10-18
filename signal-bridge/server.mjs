import { createServer } from "node:http";
import QRCode from "qrcode";
import { signalAdminHtml } from "./admin-page.mjs";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  normalizeNotification, formatNotification, parseIncomingSignal,
  formatQueryResult, parseSseBlock
} from "./lib.mjs";

const enabled = process.env.SIGNAL_ENABLED === "true";
const dryRun = process.env.SIGNAL_DRY_RUN !== "false";
const configuredAccount = (process.env.SIGNAL_ACCOUNT || "").trim();
const adminToken = process.env.SIGNAL_ADMIN_TOKEN || "";
const groups = new Set((process.env.SIGNAL_GROUP_IDS || "").split(",").map(s => s.trim()).filter(Boolean));
const token = process.env.SIGNAL_BRIDGE_TOKEN || "";
const rpc = new URL(process.env.SIGNAL_CLI_RPC_URL || "http://127.0.0.1:8080");
const statePath = resolve(process.env.SIGNAL_STATE_PATH || "./data/state.json");
const queryUrl = process.env.SIGNAL_QUERY_URL || "";
const queryToken = process.env.SIGNAL_QUERY_TOKEN || "";
const receive = process.env.SIGNAL_ENABLE_RECEIVE === "true";
const port = Number(process.env.SIGNAL_BRIDGE_PORT || "8789");

if (!["127.0.0.1", "localhost", "[::1]"].includes(rpc.hostname) || rpc.protocol !== "http:" || rpc.username || rpc.password) {
  throw Error("signal-cli JSON-RPC must bind to loopback HTTP only");
}
if (queryUrl && (new URL(queryUrl).protocol !== "https:" || !queryToken)) throw Error("query adapter requires HTTPS and its own token");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw Error("invalid listen port");
if (enabled && token.length < 32) {
  throw Error("A >=32-character dedicated Signal bridge token is required");
}
if (enabled && !dryRun && queryUrl && queryUrl.includes("ethereum-usdt-monitor.mosen6266-ms007.workers.dev")) {
  throw Error("Do not point Signal bridge at the existing production Telegram Worker");
}

let state = { sent: [], replied: [], linkedAccount: null, groupIds: null };
try {
  const read = JSON.parse(await readFile(statePath, "utf8"));
  if (Array.isArray(read.sent) && Array.isArray(read.replied)) state = { ...state, ...read };
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const sent = new Set(state.sent);
const replied = new Set(state.replied);
if (Array.isArray(state.groupIds)) { groups.clear(); for (const group of state.groupIds) if (typeof group === "string") groups.add(group); }
let activeAccount = state.linkedAccount || configuredAccount;
let linkJob = { status: "idle", error: "", started: 0 };
const linkDeviceName = "Ethereum Signal Monitor";
let serial = Promise.resolve();
let lastSseId = "";
let sseActive = false;
let stopping = false;
function enqueue(fn) {
  const result = serial.then(fn);
  serial = result.catch(() => {});
  return result;
}
async function persist() {
  state = { sent: Array.from(sent).slice(-20000), replied: Array.from(replied).slice(-10000), linkedAccount: activeAccount || null, groupIds: Array.from(groups) };
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = statePath + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath);
}
function authenticated(req, secret = token) {
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? Buffer.from(header.slice(7), "utf8") : Buffer.alloc(0);
  const expected = Buffer.from(secret, "utf8");
  return !!secret && given.length === expected.length && timingSafeEqual(given, expected);
}
async function signalRpc(method, params = {}, timeout = 18000) {
  const result = await fetch(new URL("/api/v1/rpc", rpc.origin), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(timeout)
  });
  if (!result.ok) throw Error("Signal RPC HTTP " + result.status);
  const body = await result.json();
  if (body.error) throw Error("Signal RPC " + String(body.error.message || body.error.code || "error").slice(0, 160));
  return body.result;
}
async function startDeviceLink() {
  if (linkJob.status === "waiting" && Date.now() - linkJob.started < 180000) throw Error("already_linking");
  const result = await signalRpc("startLink");
  const uri = result?.deviceLinkUri;
  if (typeof uri !== "string" || !/^sgnl:\/\/linkdevice\?/.test(uri)) throw Error("Signal CLI did not return a valid device linking URI");
  const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", width: 300, margin: 2 });
  const currentId = randomUUID();
  linkJob = { id: currentId, status: "waiting", error: "", started: Date.now() };
  void (async () => {
    try {
      const linked = await signalRpc("finishLink", { deviceLinkUri: uri, deviceName: linkDeviceName }, 180000);
      const identity = linked?.number || linked?.aci;
      if (!identity || typeof identity !== "string") throw Error("Account identity missing after linking");
      if (linkJob.id !== currentId) return;
      activeAccount = identity;
      await persist();
      linkJob = { status: "linked", error: "", started: Date.now() };
    } catch (error) {
      if (linkJob.id === currentId) linkJob = { status: "failed", error: String(error?.message || error).slice(0, 180), started: Date.now() };
    }
  })();
  return { qr };
}
async function getGroups() {
  if (!activeAccount) throw Error("Please link a Signal account first");
  const raw = await signalRpc("listGroups", { account: activeAccount });
  const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.groups) ? raw.groups : null);
  if (!items) throw Error("Signal RPC group response is not an array");
  return items.filter(x => typeof x?.id === "string").map(x => ({ id: x.id, name: String(x.name || "未命名群组"), selected: groups.has(x.id) }));
}
function response(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  let input = "";
  for await (const chunk of req) {
    input += chunk;
    if (input.length > 16384) throw Error("request_too_large");
  }
  return JSON.parse(input);
}
async function signalSend(groupId, message) {
  if (!groups.has(groupId)) throw Error("group_not_allowed");
  if (!activeAccount) throw Error("signal_account_not_linked");
  if (dryRun) return { dryRun: true };
  const body = {
    jsonrpc: "2.0", id: randomUUID(), method: "send",
    params: { account: activeAccount, groupId, message: message.slice(0, 3500) }
  };
  const result = await fetch(new URL("/api/v1/rpc", rpc.origin), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
  });
  if (!result.ok) throw Error("Signal RPC HTTP " + result.status);
  const data = await result.json();
  if (data.error || !data.result) throw Error("Signal RPC delivery failed");
  return data.result;
}
async function handleEvent(event) {
  const key = event.groupId + ":" + event.eventId;
  return enqueue(async () => {
    if (sent.has(key)) return { duplicate: true };
    if (dryRun) return { dryRun: true, preview: formatNotification(event) };
    await signalSend(event.groupId, formatNotification(event));
    sent.add(key);
    await persist();
    return { delivered: true };
  });
}
async function handleIncoming(record) {
  const input = parseIncomingSignal(record, groups);
  if (!input || !queryUrl || !queryToken) return;
  const key = input.groupId + ":" + input.source + ":" + input.timestamp;
  return enqueue(async () => {
    if (replied.has(key)) return;
    const url = new URL(queryUrl);
    url.searchParams.set("address", input.address);
    const result = await fetch(url, {
      headers: { authorization: "Bearer " + queryToken, accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
    if (!result.ok) throw Error("Read-only query service HTTP " + result.status);
    const message = formatQueryResult(await result.json(), input.address);
    await signalSend(input.groupId, message);
    if (!dryRun) {
      replied.add(key);
      await persist();
    }
  });
}
async function receiveLoop() {
  if (!enabled || dryRun || !receive || !queryUrl) return;
  let backoff = 1000;
  while (!stopping) {
    try {
      const headers = { accept: "text/event-stream" };
      if (lastSseId) headers["last-event-id"] = lastSseId;
      const res = await fetch(new URL("/api/v1/events", rpc.origin), { headers, signal: AbortSignal.timeout(120000) });
      if (!res.ok || !res.body) throw Error("Signal SSE unavailable: " + res.status);
      sseActive = true;
      backoff = 1000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!stopping) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 262144) throw Error("Signal SSE frame too large");
        buffer = buffer.replace(/\r\n/g, "\n");
        let index;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const entry = parseSseBlock(block);
          if (!entry) continue;
          try {
            await handleIncoming(entry.value);
            if (entry.id) lastSseId = entry.id;
          } catch (error) {
            console.error("Signal read-only query failed", String(error));
          }
        }
      }
    } catch (error) {
      if (!stopping) console.error("Signal SSE reconnect", String(error));
    } finally {
      sseActive = false;
    }
    if (!stopping) {
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(30000, backoff * 2);
    }
  }
}
const http = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/admin") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" });
    res.end(signalAdminHtml);
    return;
  }
  if (req.url?.startsWith("/admin/api/")) {
    if (adminToken.length < 32) return response(res, 503, { error: "Signal 专属管理密钥未配置（SIGNAL_ADMIN_TOKEN）" });
    if (!authenticated(req, adminToken)) return response(res, 401, { error: "Signal 管理密钥不正确" });
    try {
      if (req.method === "GET" && req.url === "/admin/api/status") {
        let rpcConnected = false;
        try { await signalRpc("listAccounts", {}, 7000); rpcConnected = true; } catch {}
        return response(res, 200, { account: activeAccount || null, rpc_connected: rpcConnected, enabled, dry_run: dryRun, link_status: linkJob.status, link_error: linkJob.error });
      }
      if (req.method === "POST" && req.url === "/admin/api/start-link") {
        const result = await startDeviceLink();
        return response(res, 200, result);
      }
      if (req.method === "GET" && req.url === "/admin/api/groups") {
        return response(res, 200, { account: activeAccount, groups: await getGroups() });
      }
      if (req.method === "POST" && req.url === "/admin/api/groups") {
        const input = await readJson(req);
        if (!Array.isArray(input?.groupIds) || input.groupIds.length > 100 || !input.groupIds.every(x => typeof x === "string" && x.length < 500)) throw Error("invalid_group_list");
        const available = new Set((await getGroups()).map(x => x.id));
        if (input.groupIds.some(x => !available.has(x))) throw Error("unknown_group_id");
        groups.clear();
        for (const g of input.groupIds) groups.add(g);
        await persist();
        return response(res, 200, { saved: groups.size });
      }
      return response(res, 404, { error: "unknown_admin_endpoint" });
    } catch (error) {
      const why = String(error?.message || error);
      const invalid = /^(invalid_|unknown_group_id|already_linking|request_too_large)/.test(why) || error instanceof SyntaxError;
      return response(res, invalid ? 400 : 503, { error: why.slice(0, 180) });
    }
  }
  if (req.method === "GET" && req.url === "/health") {
    return response(res, 200, { service: "isolated-signal-bridge", enabled, dry_run: dryRun, receive_enabled: receive, sse_connected: sseActive, telegram_production_connected: false });
  }
  if (req.method !== "POST" || req.url !== "/v1/notify") return response(res, 404, { error: "not_found" });
  if (!enabled) return response(res, 503, { error: "signal_disabled" });
  if (!authenticated(req)) return response(res, 401, { error: "unauthorized" });
  try {
    const event = normalizeNotification(await readJson(req), groups);
    const result = await handleEvent(event);
    return response(res, 200, { ok: true, ...result });
  } catch (error) {
    const reason = String(error?.message || error);
    const invalid = /^(invalid_|unsupported_|group_not_allowed|request_too_large)/.test(reason) || error instanceof SyntaxError;
    console.error("Signal bridge notification", reason);
    return response(res, invalid ? 400 : 503, { error: invalid ? reason : "delivery_unavailable" });
  }
});
http.listen(port, "127.0.0.1", () => {
  console.log("Signal isolated bridge listening on loopback:" + port + (dryRun ? " (DRY RUN)" : ""));
  void receiveLoop();
});
function stop() { stopping = true; http.close(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
