import { createServer } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import {
  normalizeNotification, formatNotification, parseIncomingSignal,
  formatQueryResult, parseSseBlock
} from "./lib.mjs";

const enabled = process.env.SIGNAL_ENABLED === "true";
const dryRun = process.env.SIGNAL_DRY_RUN !== "false";
const account = (process.env.SIGNAL_ACCOUNT || "").trim();
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
if (enabled && (!account || !groups.size || token.length < 32)) {
  throw Error("Signal account, allowed groups and >=32-character bridge token are required");
}
if (enabled && !dryRun && queryUrl && queryUrl.includes("ethereum-usdt-monitor.mosen6266-ms007.workers.dev")) {
  throw Error("Do not point Signal bridge at the existing production Telegram Worker");
}

let state = { sent: [], replied: [] };
try {
  const read = JSON.parse(await readFile(statePath, "utf8"));
  if (Array.isArray(read.sent) && Array.isArray(read.replied)) state = read;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const sent = new Set(state.sent);
const replied = new Set(state.replied);
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
  state = { sent: Array.from(sent).slice(-20000), replied: Array.from(replied).slice(-10000) };
  await mkdir(dirname(statePath), { recursive: true });
  const temporary = statePath + "." + process.pid + ".tmp";
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath);
}
function authenticated(req) {
  const header = req.headers.authorization || "";
  const given = header.startsWith("Bearer ") ? Buffer.from(header.slice(7), "utf8") : Buffer.alloc(0);
  const expected = Buffer.from(token, "utf8");
  return !!token && given.length === expected.length && timingSafeEqual(given, expected);
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
  if (dryRun) return { dryRun: true };
  const body = {
    jsonrpc: "2.0", id: randomUUID(), method: "send",
    params: { account, groupId, message: message.slice(0, 3500) }
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
