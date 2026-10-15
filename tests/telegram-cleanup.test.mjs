import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

test("address query preserves final result and schedules deletion of input + progress",()=>{
  const source=readFileSync("src/telegram.ts","utf8");
  const worker=readFileSync("src/index.ts","utf8");
  assert.match(source,/const progress=await send\(env,chatId,"🔎 已收到地址查询/);
  assert.match(source,/scheduleMessageDeletion\(env,chatId,m\.message_id,"query_address_stale",1800\)/);
  assert.match(source,/scheduleMessageDeletion\(env,chatId,progress\.message_id,"query_progress_stale",1800\)/);
  assert.match(source,/user_message_id:m\.message_id,progress_message_id:progress\.message_id/);
  assert.match(worker,/await checkOwner\(configured,item\.owner[\s\S]*?await finishAddressQueryCleanup\(configured,item\)/);
  assert.match(worker,/if\(message\.attempts>=5\)[\s\S]*?finishAddressQueryCleanup\(configured,item\)/);
});
test("remark completion removes only the temporary prompt and member reply",()=>{
  const source=readFileSync("src/telegram.ts","utf8");
  const cleanup=readFileSync("src/cleanup.ts","utf8");
  assert.match(source,/scheduleMessageDeletion\(env,String\(chat\.id\),prompt\.message_id,"remark_prompt_expired",600\)/);
  assert.match(source,/await send\(env,chatId,"✅ 地址备注已更新/);
  assert.match(source,/await finishRemarkCleanup\(env,chatId,m\.reply_to_message\.message_id,m\.message_id\)/);
  assert.doesNotMatch(source,/修改者：/);
  assert.match(cleanup,/scheduleMessageDeletion\(env,chatId,promptMessageId,"remark_prompt"\)/);
  assert.match(cleanup,/scheduleMessageDeletion\(env,chatId,userMessageId,"remark_input"\)/);
});
test("deletion is durable, repeated safely, and never targets final result messages",()=>{
  const cleanup=readFileSync("src/cleanup.ts","utf8");
  const worker=readFileSync("src/index.ts","utf8");
  assert.match(cleanup,/INSERT INTO telegram_message_cleanup/);
  assert.match(cleanup,/ON CONFLICT\(chat_id,message_id\)/);
  assert.match(cleanup,/telegram\(env,"deleteMessage"/);
  assert.match(cleanup,/state='blocked'/);
  assert.doesNotMatch(cleanup,/result_message_id/);
  assert.match(worker,/await flushMessageCleanup\(configured,60\)/);
});
