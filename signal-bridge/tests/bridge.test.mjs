import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNotification, formatNotification, parseIncomingSignal, formatQueryResult, parseSseBlock } from "../lib.mjs";

const owner = "0x" + "a".repeat(40);
const spender = "0x" + "b".repeat(40);
const tx = "0x" + "c".repeat(64);
const group = "group-id-base64=";
const allow = new Set([group]);
const example = {
  network: "ETH_MAINNET", eventId: "approval:123456789", kind: "new_approval", groupId: group,
  payload: { owner, spender, tx_hash: tx, amount: "100", watch_status: "active" }
};
test("strict group allowlist isolates the Signal routing from Telegram chats", () => {
  assert.equal(normalizeNotification(example, allow).groupId, group);
  assert.throws(() => normalizeNotification({ ...example, groupId: "-1000123456" }, allow), /group_not_allowed/);
  assert.throws(() => normalizeNotification({ ...example, network: "TRON" }, allow), /unsupported_network/);
});
test("event and chain input validation", () => {
  assert.throws(() => normalizeNotification({ ...example, eventId: "../../secret" }, allow), /invalid_event_id/);
  assert.throws(() => normalizeNotification({ ...example, payload: { ...example.payload, owner: "bad" } }, allow), /invalid_addresses/);
  assert.throws(() => normalizeNotification({ ...example, payload: { ...example.payload, tx_hash: "bad" } }, allow), /invalid_transaction_hash/);
});
test("approval and transfer text render without Telegram HTML", () => {
  const approval = formatNotification(normalizeNotification(example, allow));
  assert.match(approval, /新增 USDT 授权/);
  assert.match(approval, /Spender/);
  const transfer = formatNotification(normalizeNotification({
    ...example, kind: "transfer", payload: { address: owner, tx_hash: tx, asset: "USDT", direction: "转入", amount: "20.3" }
  }, allow));
  assert.match(transfer, /Ethereum 资金异动/);
  assert.match(transfer, /20.3/);
});
test("incoming group query accepts only exact Ethereum addresses", () => {
  const envelope = { sourceUuid: "user-uuid", timestamp: 12345, dataMessage: { message: "/query " + owner, groupInfo: { groupId: group } } };
  assert.deepEqual(parseIncomingSignal({ params: { envelope } }, allow), {
    address: owner, groupId: group, source: "user-uuid", timestamp: 12345
  });
  assert.equal(parseIncomingSignal({ params: { envelope: { ...envelope, dataMessage: { ...envelope.dataMessage, groupInfo: { groupId: "unknown" } } } } }, allow), null);
  assert.equal(parseIncomingSignal({ params: { envelope: { ...envelope, dataMessage: { ...envelope.dataMessage, message: "wrong" } } } }, allow), null);
});
test("read-only query response never labels an incomplete scan as no authorization", () => {
  const incomplete = formatQueryResult({ network: "ETH_MAINNET", address: owner, approvals: [] }, owner);
  assert.match(incomplete, /不能据此断定没有有效授权/);
  const complete = formatQueryResult({ network: "ETH_MAINNET", address: owner, approvals: [], exhaustive: true }, owner);
  assert.match(complete, /未发现有效授权/);
  assert.throws(() => formatQueryResult({ network: "TRON", address: owner, approvals: [] }, owner), /invalid_query_result/);
});
test("signal-cli SSE JSON-RPC event decoding", () => {
  const parsed = parseSseBlock('id: 42\n' + 'data: {"method":"receive","params":{}}\n');
  assert.equal(parsed.id, "42");
  assert.equal(parsed.value.method, "receive");
  assert.equal(parseSseBlock("id: 45\n\n"), null);
});
