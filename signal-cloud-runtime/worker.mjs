import { DurableObject } from "cloudflare:workers";

// Dedicated Signal linked-device runtime. Never call Telegram APIs or write to its D1.
const V="0.14.9";
const ARCHIVE="https://github.com/AsamK/signal-cli/releases/download/v"+V+"/signal-cli-"+V+"-Linux-native.tar.gz";
const SHA="a8fab78b5e8053abf3db5725272957ad11d1745b9a16848ddb2ace4743dfa5d5";
const json=(v,s=200)=>Response.json(v,{status:s,headers:{"cache-control":"no-store"}});
function bearer(req,k){const s=req.headers.get("authorization")||"",v=s.startsWith("Bearer ")?s.slice(7):"";if(!k||v.length!==k.length)return false;let d=0;for(let i=0;i<k.length;i++)d|=v.charCodeAt(i)^k.charCodeAt(i);return d===0;}
export class SignalGateway extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.busy=null;this.linkState="idle";this.linkError="";
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS signal_gateway_health (id INTEGER PRIMARY KEY, running INTEGER NOT NULL DEFAULT 0, installed INTEGER NOT NULL DEFAULT 0, daemon_ok INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    if(ctx.container?.running)void ctx.blockConcurrencyWhile(()=>ctx.container.setInactivityTimeout(21600000));}
  recordHealth(running,installed,daemonOk,error=""){
    try{this.ctx.storage.sql.exec("INSERT INTO signal_gateway_health(id,running,installed,daemon_ok,last_error,checked_at) VALUES(1,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET running=excluded.running, installed=excluded.installed, daemon_ok=excluded.daemon_ok, last_error=excluded.last_error, checked_at=CURRENT_TIMESTAMP",running?1:0,installed?1:0,daemonOk?1:0,String(error).slice(0,180));}
    catch(e){console.error("Gateway diagnostics write failed",String(e))}
  }
  async ensureStarted(){
    if(this.busy)return this.busy;
    this.busy=this.startInternal().finally(()=>{this.busy=null});
    return this.busy;
  }
  async startInternal(){
    const c=this.ctx.container;
    if(!c)throw Error("Container binding not ready");
    if(!c.running){
      const snap=await this.ctx.storage.get("snapshot");
      c.start({image:"cloudflare/debian-trixie",entrypoint:["sleep","infinity"],instance:"basic",enableInternet:true,...(snap?{containerSnapshot:snap}:{})});
    }
    await c.setInactivityTimeout(21600000);
  }
  async command(args){const p=await this.ctx.container.exec(args);const v=await p.output();return {code:v.exitCode,stdout:new TextDecoder().decode(v.stdout).slice(0,25000),stderr:new TextDecoder().decode(v.stderr).slice(0,5000)};}
  async rpc(method,params={},limit=18000){
    const c=this.ctx.container;
    const p=await c.getTcpPort(8080).fetch("http://container/api/v1/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method,params,id:crypto.randomUUID()}),signal:AbortSignal.timeout(limit)});
    if(!p.ok)throw Error("RPC HTTP "+p.status);
    const b=await p.json();if(b.error)throw Error("Signal RPC "+String(b.error.message||b.error.code));return b.result;
  }
  async snapshot(){
    if(!this.ctx.container?.running)throw Error("Cannot snapshot stopped container");
    const snap=await this.ctx.container.snapshotContainer({name:"signal-account-state"});
    await this.ctx.storage.put("snapshot",snap);
    await this.ctx.storage.put("snapshotAt",Date.now());
    await this.ctx.storage.setAlarm(Date.now()+90000);
    return true;
  }
  async alarm(){
    if(this.ctx.container?.running){try{await this.snapshot()}catch(e){console.error("Signal persistence snapshot failed",String(e))}}
    await this.ctx.storage.setAlarm(Date.now()+90000);
  }
  async fetch(req){
    const u=new URL(req.url);
    if(u.pathname==="/state"){
      const running=!!this.ctx.container?.running,installed=!!await this.ctx.storage.get("installed");
      let daemonOk=false;
      if(running&&installed){try{await this.rpc("listAccounts",{},3500);daemonOk=true}catch(e){}}
      this.recordHealth(running,installed,daemonOk);
      return json({running,installed,daemonHealthy:daemonOk,linkedAccount:await this.ctx.storage.get("linkedAccount")||null,
        lastSnapshotAt:await this.ctx.storage.get("snapshotAt")||null,
        linkState:this.linkState,linkError:this.linkError});
    }
    if(u.pathname==="/setup"&&req.method==="POST"){
      await this.ensureStarted();
      const installed=await this.ctx.storage.get("installed");
      if(!installed){
        const script=["set -eu","mkdir -p /opt/signal /var/lib/signal-cli","command -v curl >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq curl ca-certificates)","curl -fLSs --retry 3 --connect-timeout 20 "+JSON.stringify(ARCHIVE)+" -o /tmp/signal-cli.tgz","echo '"+SHA+"  /tmp/signal-cli.tgz' | sha256sum -c -","tar -xzvf /tmp/signal-cli.tgz -C /opt/signal >/tmp/extract.log","npm install --prefix /opt/qr --omit=dev --silent qrcode@1.5.4","find /opt/signal -type f -name signal-cli | head -1"].join("; ");
        const result=await this.command(["sh","-c",script]);
        if(result.code!==0){this.recordHealth(true,false,false,result.stderr||result.stdout);return json({error:"installation_failed",details:result.stderr,output:result.stdout},503);}
        const path=result.stdout.trim().split("\n").pop();if(!path)throw Error("signal-cli binary not found");
        await this.ctx.storage.put("binary",path);
        await this.ctx.storage.put("installed",true);
      }
      const bin=await this.ctx.storage.get("binary");
      let ready=false;
      try{await this.rpc("listAccounts",{},5000);ready=true}catch{}
      const run=ready?{code:0,stderr:""}:await this.command(["sh","-c","nohup "+bin+" --data-dir /var/lib/signal-cli daemon --http 0.0.0.0:8080 >/tmp/signal.log 2>&1 </dev/null & sleep 3"]);
      if(run.code!==0)return json({error:"daemon_start_failed",details:run.stderr},503);
      await this.snapshot();
      let daemonOk=false;try{await this.rpc("listAccounts",{},5000);daemonOk=true}catch(e){}
      this.recordHealth(true,true,daemonOk,daemonOk?"":"Daemon not responding after setup");
      return json({ok:daemonOk,daemon:daemonOk?"started":"not_responding"},daemonOk?200:503);
    }
    if(u.pathname==="/link"&&req.method==="POST"){
      await this.ensureStarted();
      const res=await this.rpc("startLink");
      const uri=res?.deviceLinkUri;
      if(typeof uri!=="string"||!uri.startsWith("sgnl://linkdevice?"))throw Error("Invalid Signal link URI");
      const qr=await this.command(["node","-e","require('/opt/qr/node_modules/qrcode').toDataURL(process.argv[1]).then(x=>process.stdout.write(x))",uri]);
      if(qr.code!==0||!qr.stdout.startsWith("data:image/png;base64,"))throw Error("QR generation failed");
      this.linkState="waiting";this.linkError="";
      this.ctx.waitUntil((async()=>{try{
        const linked=await this.rpc("finishLink",{deviceLinkUri:uri,deviceName:"Ethereum Signal Monitor"},180000);
        const account=linked?.number||linked?.aci;if(!account)throw Error("Account identity absent");
        await this.ctx.storage.put("linkedAccount",account);
        await this.snapshot();
        this.linkState="linked";
      }catch(e){this.linkState="failed";this.linkError=String(e).slice(0,300)}})());
      return json({qr:qr.stdout,expiresIn:120});
    }
    if(u.pathname==="/groups"&&req.method==="GET"){
      await this.ensureStarted();
      const acct=await this.ctx.storage.get("linkedAccount");if(!acct)return json({error:"not_linked"},409);
      return json({groups:await this.rpc("listGroups",{account:acct})});
    }
    if(u.pathname==="/groups-selection"&&req.method==="GET")return json({selected:await this.ctx.storage.get("signalGroups")||[]});
    if(u.pathname==="/groups-selection"&&req.method==="POST"){
      const data=await req.json();if(!Array.isArray(data?.ids)||data.ids.length>60||data.ids.some(x=>typeof x!=="string"))return json({error:"invalid_group_list"},400);
      const acct=await this.ctx.storage.get("linkedAccount");if(!acct)return json({error:"not_linked"},409);
      const available=new Set((await this.rpc("listGroups",{account:acct})).map(g=>g.id));
      if(data.ids.some(id=>!available.has(id)))return json({error:"unknown_group_id"},400);
      await this.ctx.storage.put("signalGroups",data.ids);return json({saved:data.ids.length});
    }
    if(u.pathname==="/rpc"&&req.method==="POST"){
      await this.ensureStarted(); const input=await req.json();
      const methods=new Set(["send","listGroups","listAccounts"]);
      if(!methods.has(input.method))return json({error:"method_restricted"},403);
      if(input.method==="send"){
        const allowed=new Set(await this.ctx.storage.get("signalGroups")||[]);
        if(!allowed.has(input.params?.groupId)||input.params?.account!==(await this.ctx.storage.get("linkedAccount")))return json({error:"invalid_target"},400);
      }
      return json({result:await this.rpc(input.method,input.params||{})});
    }
    return json({error:"not_found"},404);
  }
}
export default {
 async scheduled(event,env,ctx){
  const gateway=env.SIGNAL_GATEWAY.getByName("primary");
  ctx.waitUntil((async()=>{
   const status=await gateway.fetch("https://internal/state");
   const state=await status.json();
   if(!state.installed||(state.linkedAccount&&!state.running)){
    const r=await gateway.fetch("https://internal/setup",{method:"POST"});
    if(!r.ok)console.error("Signal runtime bootstrap",r.status,(await r.text()).slice(0,200));
   }
  })().catch(e=>console.error("Signal runtime scheduled bootstrap",String(e))));
 },
 async fetch(req,env){
  const p=new URL(req.url).pathname;
  if(p==="/health")return json({service:"ethereum-signal-runtime",network:"Ethereum Mainnet",telegramIsolated:true});
  // This Worker has no workers.dev or public route; only an admin-authenticated service binding calls it.
  if(env.SIGNAL_CONTROL_SECRET&&!bearer(req,env.SIGNAL_CONTROL_SECRET))return json({error:"unauthorized"},401);
  if(!["/state","/setup","/link","/groups","/groups-selection","/rpc"].includes(p))return json({error:"not_found"},404);
  const stub=env.SIGNAL_GATEWAY.getByName("primary");
  return stub.fetch(new Request("https://runtime.internal"+p,{method:req.method,body:req.body,headers:{"content-type":req.headers.get("content-type")||"application/json"}}));
 }
};
