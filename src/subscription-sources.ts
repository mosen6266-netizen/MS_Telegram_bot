// @ts-nocheck
// A subscription may belong to multiple independent producers.
// An existing subscription with unknown provenance stays protected as "legacy".
export function sourceInsert(db,chat,address,sourceType,sourceId){
  return db.prepare(
    "INSERT OR IGNORE INTO subscription_sources(chat_id,address,source_type,source_id) VALUES(?,?,?,?)"
  ).bind(String(chat),address,sourceType,String(sourceId));
}

// Must run after the matching subscriptions INSERT, in the same D1.batch.
export function assignSpenderSourcesForRoute(db,spender,chat){
  return db.prepare(
    "INSERT OR IGNORE INTO subscription_sources(chat_id,address,source_type,source_id) "+
    "SELECT ?,h.owner,'spender',? FROM spender_history_addresses h "+
    "JOIN subscriptions s ON s.chat_id=? AND s.address=h.owner "+
    "WHERE h.spender=? AND s.status IN ('active','pending','paused')"
  ).bind(String(chat),spender,String(chat),spender);
}

// Remove only attribution owned by THIS spender. The parent subscription is
// removed only when there are no remaining manual, admin, legacy or other-Spender
// sources. The route deletion is also part of the caller's D1 transaction.
export function removeSpenderRouteSourceStatements(db,spender,chat){
  return [
    db.prepare("DELETE FROM subscription_sources WHERE chat_id=? AND source_type='spender' AND source_id=?")
      .bind(String(chat),spender),
    db.prepare(
      "UPDATE subscriptions SET status='removed',updated_at=CURRENT_TIMESTAMP "+
      "WHERE chat_id=? AND status IN ('active','pending') "+
      "AND address IN (SELECT owner FROM spender_history_addresses WHERE spender=?) "+
      "AND NOT EXISTS (SELECT 1 FROM subscription_sources src WHERE src.chat_id=subscriptions.chat_id AND src.address=subscriptions.address)"
    ).bind(String(chat),spender)
  ];
}

// Deleting a Spender rule should not kill existing wallet monitoring or its
// Telegram subscriptions (current product behavior). Relabel its ownership so
// future route changes can never accidentally drop the retained notifications.
export function retainDeletedSpenderSources(db,spender){
  return [
    db.prepare(
      "INSERT OR IGNORE INTO subscription_sources(chat_id,address,source_type,source_id) "+
      "SELECT chat_id,address,'retained',source_id FROM subscription_sources "+
      "WHERE source_type='spender' AND source_id=?"
    ).bind(spender),
    db.prepare("DELETE FROM subscription_sources WHERE source_type='spender' AND source_id=?").bind(spender)
  ];
}
