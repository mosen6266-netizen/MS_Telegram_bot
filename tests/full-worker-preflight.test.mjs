import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {buildSync} from "esbuild";
import {Miniflare,convertV4MiniflareOptions} from "miniflare";

// Unlike direct function tests, this executes the bundled, unmodified Worker
// entrypoint with real request routing, session checks and a separate D1.
// All data is synthetic. No production Cloudflare or Alchemy access is used.
const script=buildSync({entryPoints:["src/index.ts"],bundle:true,platform:"browser",
  format:"esm",target:"es2022",write:false}).outputFiles[0].text;
const domain="https://preflight.example.invalid";
const wallet=i=>"0x"+i.toString(16).padStart(40,"0");

test("full Worker preflight: admin routes, authentication, pagination and privacy",async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({
  name:"isolated-worker-preflight",modules:true,script,
  d1Databases:{DB:"isolated-worker-preflight"}
 }));
 try{
  const db=await mf.getD1Database("DB");
  for(const filename of readdirSync("migrations").filter(x=>x.endsWith(".sql")).sort()){
    for(const statement of readFileSync("migrations/"+filename,"utf8").split(";").map(x=>x.trim()).filter(Boolean))
      await db.prepare(statement).run();
  }
  const chat="-1001100110011",owner=wallet(1),sessionToken="synthetic_local_test_session";
  await db.prepare("INSERT INTO telegram_chats(chat_id,title,chat_type,active) VALUES(?,'Preflight room','supergroup',1)").bind(chat).run();
  await db.prepare("INSERT INTO wallets(address,first_user_name,discovery_source) VALUES(?,'Preflight User','manual')").bind(owner).run();
  await db.prepare("INSERT INTO wallet_watches(address,state) VALUES(?,'active')").bind(owner).run();
  await db.prepare("INSERT INTO subscriptions(chat_id,address,remark,status) VALUES(?,?,'Synthetic wallet note','active')").bind(chat,owner).run();
  await db.prepare("INSERT INTO wallet_global_remarks(address,remark) VALUES(?,'Global test remark')").bind(owner).run();
  const tokenHash=createHash("sha256").update(sessionToken).digest("hex");
  await db.prepare("INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)")
   .bind(tokenHash,new Date(Date.now()+3600000).toISOString()).run();
  const cookie="__Host-ethadmin="+sessionToken;

  async function request(path,headers={},method="GET",body){
    const response=await mf.dispatchFetch(domain+path,{method,headers,body:body?JSON.stringify(body):undefined});
    const type=response.headers.get("content-type")||"";
    return {status:response.status,headers:response.headers,content:type.includes("application/json")?await response.json():await response.text()};
  }
  const health=await request("/health");
  assert.equal(health.status,200);
  assert.equal(health.content.service,"ethereum-usdt-monitor");
  assert.equal(health.content.database_configured,true);
  assert.equal((await request("/auth/status")).content.authenticated,false);
  const admin=await request("/admin");
  assert.equal(admin.status,200);
  assert.match(admin.content,/Ethereum Monitor/);
  assert.match(admin.headers.get("content-security-policy"),/frame-ancestors 'none'/);

  const unauthorized=await request("/api/summary");
  assert.equal(unauthorized.status,401);
  assert.equal((await request("/api/wallets?page=0")).status,401);
  const deniedPost=await request("/api/subscriptions",{"content-type":"application/json"},
   "PATCH",{chat_id:chat,address:owner,status:"removed"});
  assert.equal(deniedPost.status,401);
  assert.equal((await db.prepare("SELECT status FROM subscriptions WHERE address=?").bind(owner).first()).status,"active");

  const headers={cookie};
  assert.equal((await request("/auth/status",headers)).content.authenticated,true);
  const summary=await request("/api/summary",headers);
  assert.equal(summary.status,200);assert.equal(summary.content.wallets,1);
  assert.equal(summary.content.subscriptions,1);

  const wallets=await request("/api/wallets?page=0&search=Global%20test",headers);
  assert.equal(wallets.status,200);
  assert.equal(wallets.content.total,1);
  assert.equal(wallets.content.rows[0].remark,"Global test remark");

  const group=await request("/api/subscriptions?page=0&status=active&search=Preflight",headers);
  assert.equal(group.status,200);assert.equal(group.content.total,1);
  assert.equal(group.content.rows[0].address,owner);

  const monitoring=await request("/api/monitoring?page=0&status=active",headers);
  assert.equal(monitoring.status,200);
  assert.equal(monitoring.content.total,1);
  assert.equal(monitoring.content.rows[0].address,owner);

  const errors=await request("/api/subscriptions?status=not-a-state",headers);
  assert.equal(errors.status,400);
  const audit=await request("/api/audit?page=0",headers);
  assert.equal(audit.status,200);assert.ok(Array.isArray(audit.content.rows));
  const transfers=await request("/api/transfers?page=0",headers);
  assert.equal(transfers.status,200);assert.equal(transfers.content.total,0);
  const reconciliation=await request("/api/monitoring/reconciliation",headers);
  assert.equal(reconciliation.status,200);
  assert.equal(reconciliation.content.report,null);

  // CSRF also applies to a valid session for write requests.
  const csrfDenied=await request("/api/subscriptions",{...headers,"content-type":"application/json"},
   "PATCH",{chat_id:chat,address:owner,status:"removed"});
  assert.equal(csrfDenied.status,401);
  assert.equal((await db.prepare("SELECT status FROM subscriptions WHERE address=?").bind(owner).first()).status,"active");

  const remarkUpdate=await request("/api/monitoring/remark",{...headers,"origin":domain,
    "x-app-action":"1","content-type":"application/json"},"POST",
    {address:owner,remark:"Synced from the staging Worker"});
  assert.equal(remarkUpdate.status,200);
  assert.equal(remarkUpdate.content.remark,"Synced from the staging Worker");
  const persisted=await db.prepare("SELECT remark FROM wallet_global_remarks WHERE address=?").bind(owner).first();
  assert.equal(persisted.remark,"Synced from the staging Worker");
  const syncedSubscription=await db.prepare("SELECT remark FROM subscriptions WHERE address=? AND chat_id=?").bind(owner,chat).first();
  assert.equal(syncedSubscription.remark,"Synced from the staging Worker");
  const newWalletPage=await request("/api/wallets?search=Synced",headers);
  assert.equal(newWalletPage.content.total,1,"new remark must be searchable without a worker restart");
  const remarkAudit=await db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action='global_wallet_remark'").first();
  assert.equal(remarkAudit.n,1,"global edit must be audited");

  const validPost=await request("/api/subscriptions",{...headers,"origin":domain,"x-app-action":"1",
    "content-type":"application/json"},"PATCH",{chat_id:chat,address:owner,status:"paused"});
  assert.equal(validPost.status,200);
  assert.equal((await db.prepare("SELECT status FROM subscriptions WHERE address=?").bind(owner).first()).status,"paused");
 }finally{await mf.dispose()}
});
