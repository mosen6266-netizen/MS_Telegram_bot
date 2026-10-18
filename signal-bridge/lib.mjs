const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const KINDS = new Set(["new_approval", "approval_change", "transfer", "reorg_correction", "usage_alert", "notice_failed"]);
function display(value, max = 280) {
  const s = String(value ?? "—").replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return Array.from(s).slice(0, max).join("") || "—";
}
export function normalizeNotification(input, allowedGroups) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("invalid_event");
  const { eventId, kind, groupId, payload, network } = input;
  if (network !== "ETH_MAINNET") throw Error("unsupported_network");
  if (typeof eventId !== "string" || !/^[A-Za-z0-9:._-]{8,180}$/.test(eventId)) throw Error("invalid_event_id");
  if (!KINDS.has(kind)) throw Error("unsupported_event_kind");
  if (typeof groupId !== "string" || !allowedGroups.has(groupId)) throw Error("group_not_allowed");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw Error("invalid_payload");
  if (["new_approval","approval_change"].includes(kind) && (!ADDRESS.test(payload.owner || "") || !ADDRESS.test(payload.spender || ""))) throw Error("invalid_addresses");
  if (["transfer","reorg_correction"].includes(kind) && !ADDRESS.test(payload.address || "")) throw Error("invalid_address");
  if (["new_approval","approval_change","transfer","reorg_correction"].includes(kind) && !HASH.test(payload.tx_hash || "")) throw Error("invalid_transaction_hash");
  return { eventId, kind, groupId, payload, network };
}
export function formatNotification(event) {
  const p = event.payload;
  const tx = () => "\n交易：" + display(p.tx_hash, 70);
  if (event.kind === "new_approval") return [
    "🛡️ 新增 USDT 授权", "备注：" + display(p.remark), "Owner：" + display(p.owner, 42),
    "Spender：" + display(p.spender, 42), "Spender 备注：" + display(p.spender_remark),
    "授权额度：" + display(p.amount, 80), "监控状态：" + display(p.watch_status)
  ].join("\n") + tx();
  if (event.kind === "approval_change") return [
    "🔄 USDT 授权变更", "备注：" + display(p.remark), "Owner：" + display(p.owner, 42),
    "Spender：" + display(p.spender, 42), "类型：" + display(p.event_type, 80),
    "最新额度：" + display(p.amount, 80)
  ].join("\n") + tx();
  if (event.kind === "transfer") return [
    "🔔 Ethereum 资金异动", "备注：" + display(p.remark),
    "监控地址：" + display(p.address, 42), "资产：" + display(p.asset, 10),
    "方向：" + display(p.direction, 20), "金额：" + display(p.amount, 80),
    "发送方：" + display(p.from_address, 42), "接收方：" + display(p.to_address, 42),
    "区块：" + display(p.block_number, 30), "状态：首个区块已确认"
  ].join("\n") + tx();
  if (event.kind === "reorg_correction") return [
    "⚠️ 区块重组更正", "钱包：" + display(p.address, 42),
    "资产：" + display(p.asset, 10), "区块：" + display(p.block_number, 30),
    "原确认可能失效，请重新核验链上状态"
  ].join("\n") + tx();
  if (event.kind === "usage_alert") return "⚠️ 平台用量通知\n" + display(p.alert_text, 1600);
  return "⚠️ Signal 通知投递异常\n编号：" + display(p.queue_id, 100) + "\n原因：" + display(p.error_message, 600);
}
export function parseIncomingSignal(record, allowedGroups) {
  const item = record?.params?.result ?? record?.params;
  const envelope = item?.envelope;
  const dm = envelope?.dataMessage;
  const groupId = dm?.groupInfo?.groupId;
  if (!dm || typeof dm.message !== "string" || typeof groupId !== "string" || !allowedGroups.has(groupId)) return null;
  const raw = dm.message.trim();
  const candidate = raw.startsWith("/query ") ? raw.slice(7).trim() : raw;
  if (!ADDRESS.test(candidate)) return null;
  return { address: candidate.toLowerCase(), groupId, source: envelope.sourceUuid || envelope.sourceNumber || envelope.source || "", timestamp: envelope.timestamp };
}
export function formatQueryResult(result, address) {
  if (!result || result.network !== "ETH_MAINNET" || (result.address || "").toLowerCase() !== address.toLowerCase()) throw Error("invalid_query_result");
  if (!Array.isArray(result.approvals)) throw Error("invalid_query_approvals");
  if (result.approvals.length === 0 && result.exhaustive !== true) return "🔎 授权查询\n地址：" + address + "\n当前数据源未完成全量核验，不能据此断定没有有效授权。";
  const rows = result.approvals.slice(0, 15).map((a, i) => {
    if (!ADDRESS.test(a.spender || "")) throw Error("invalid_spender_result");
    return String(i + 1) + ". " + a.spender + "\n授权：" + display(a.amount, 80);
  });
  return "🔎 Ethereum USDT 授权查询\n地址：" + address + "\n有效授权：" + result.approvals.length + " 项\n" + (rows.join("\n") || "未发现有效授权") + "\n监控：" + display(result.monitoring, 60);
}
export function parseSseBlock(block) {
  let id = "";
  const data = [];
  for (const row of block.split(/\r?\n/)) {
    if (row.startsWith("id:")) id = row.slice(3).trim();
    if (row.startsWith("data:")) data.push(row.slice(5).trimStart());
  }
  if (!data.length) return null;
  try { return { id, value: JSON.parse(data.join("\n")) }; } catch { return null; }
}
