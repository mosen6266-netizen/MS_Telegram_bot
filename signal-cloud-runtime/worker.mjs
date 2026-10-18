import { DurableObject } from "cloudflare:workers";

// Dedicated Signal linked-device runtime. Never call Telegram APIs or write to its D1.
const V="0.14.9";
const ARCHIVE="https://github.com/AsamK/signal-cli/releases/download/v"+V+"/signal-cli-"+V+"-Linux-native.tar.gz";
const SHA="a8fab78b5e8053abf3db5725272957ad11d1745b9a16848ddb2ace4743dfa5d5";
const json=(v,s=200)=>Response.json(v,{status:s,headers:{"cache-control":"no-store"}});
function bearer(req,k){const s=req.headers.get("authorization")||"",v=s.startsWith("Bearer ")?s.slice(7):"";if(!k||v.length!==k.length)return false;let d=0;for(let i=0;i<k.length;i++)d|=v.charCodeAt(i)^k.charCodeAt(i);return d===0;}
export class SignalGateway extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.busy=null;this.linkState="idle";this.linkError="";if(ctx.container?.running)void ctx.blockConcurrencyWhile(()=>ctx.container.setInactivityTimeout(21600000));}
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
      return json({running:!!this.ctx.container?.running,linkedAccount:await this.ctx.storage.get("linkedAccount")||null,
        installed:!!await this.ctx.storage.get("installed"),lastSnapshotAt:await this.ctx.storage.get("snapshotAt")||null,
        linkState:this.linkState,linkError:this.linkError});
    }
    if(u.pathname==="/setup"&&req.method==="POST"){
      await this.ensureStarted();
      const installed=await this.ctx.storage.get("installed");
      if(!installed){
        const script=["set -eu","mkdir -p /opt/signal /var/lib/signal-cli","curl -fLSs --retry 3 --connect-timeout 20 "+JSON.stringify(ARCHIVE)+" -o /tmp/signal-cli.tgz","echo '"+SHA+"  /tmp/signal-cli.tgz' | sha256sum -c -","tar -xzvf /tmp/signal-cli.tgz -C /opt/signal >/tmp/extract.log","npm install --prefix /opt/qr --omit=dev --silent qrcode@1.5.4","find /opt/signal -type f -name signal-cli | head -1"].join("; ");
        const result=await this.command(["sh","-c",script]);
        if(result.code!==0)return json({error:"installation_failed",details:result.stderr,output:result.stdout},503);
        const path=result.stdout.trim().split("\n").pop();if(!path)throw Error("signal-cli binary not found");
        await this.ctx.storage.put("binary",path);
        await this.ctx.storage.put("installed",true);
      }
      const bin=await this.ctx.storage.get("binary");
      const run=await this.command(["sh","-c","pgrep -f 'signal-cli.*daemon' >/dev/null || ("+bin+" --data-dir /var/lib/signal-cli daemon --http 0.0.0.0:8080 >/tmp/signal.log 2>&1 </dev/null &); sleep 2"]);
      if(run.code!==0)return json({error:"daemon_start_failed",details:run.stderr},503);
      await this.snapshot();
      return json({ok:true,daemon:"started"});
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
    if(u.pathname==="/rpc"&&req.method==="POST"){
      await this.ensureStarted(); const input=await req.json();
      const methods=new Set(["send","listGroups","listAccounts"]);
      if(!methods.has(input.method))return json({error:"method_restricted"},403);
      if(input.method==="send"&&(!input.params?.groupId||input.params?.account!==(await this.ctx.storage.get("linkedAccount"))))return json({error:"invalid_target"},400);
      return json({result:await this.rpc(input.method,input.params||{})});
    }
    return json({error:"not_found"},404);
  }
}
export default {
 async fetch(req,env){
  const p=new URL(req.url).pathname;
  if(p==="/health")return json({service:"ethereum-signal-runtime",network:"Ethereum Mainnet",telegramIsolated:true});
  if(!bearer(req,env.SIGNAL_CONTROL_SECRET))return json({error:"unauthorized"},401);
  if(!["/state","/setup","/link","/groups","/rpc"].includes(p))return json({error:"not_found"},404);
  const stub=env.SIGNAL_GATEWAY.getByName("primary");
  return stub.fetch(new Request("https://runtime.internal"+p,{method:req.method,body:req.body,headers:{"content-type":req.headers.get("content-type")||"application/json"}}));
 }
};
