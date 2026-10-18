// Dedicated Signal console. Never embedded in the production Telegram admin.
export const signalAdminHtml = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal 账号管理 · Ethereum Monitor</title>
<style>
:root{color-scheme:dark;--bg:#0b0e13;--pane:#151922;--line:#2c3440;--muted:#97a5b4;--text:#edf2f7;--green:#5fd5a5;--danger:#ed8989}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:28px 30px 14px;border-bottom:1px solid var(--line)}.wrap{max-width:980px;margin:auto;padding:26px 20px 60px}
h1{font-size:23px;margin:0 0 6px}h2{font-size:16px;margin:0 0 14px}p{margin:7px 0;color:var(--muted)}
.card{background:var(--pane);border:1px solid var(--line);border-radius:16px;padding:22px;margin-bottom:18px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:3px 12px;color:var(--muted);font-size:12px}
input{background:#0e131a;border:1px solid #384150;border-radius:9px;color:var(--text);padding:10px 12px;min-height:42px;font:inherit;max-width:100%}
input[type=password]{width:min(100%,440px)}button{border:0;background:#3654bf;color:white;font-weight:600;border-radius:9px;padding:11px 16px;cursor:pointer;font:inherit}
button.secondary{background:#303946}button:disabled{opacity:.5;cursor:not-allowed}
.row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.line{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.muted{color:var(--muted)}
.ok{color:var(--green)}.err{color:var(--danger)}.qr{width:248px;height:248px;object-fit:contain;background:white;padding:10px;border-radius:14px}
#qrBox{display:none;margin-top:20px;align-items:start;gap:24px;flex-wrap:wrap}#groups{display:grid;gap:7px;padding-top:8px}
.g{padding:12px;border:1px solid var(--line);border-radius:10px;display:flex;align-items:center;gap:10px;cursor:pointer}
.g input{min-height:0;accent-color:#5fd5a5}.help{font-size:12px}.status{margin-top:12px;min-height:26px}
@media(max-width:700px){.grid{grid-template-columns:1fr}.card{padding:16px}header{padding:20px}h1{font-size:20px}}
</style>
</head><body>
<header><div style="max-width:940px;margin:auto"><h1>Signal 账号管理 <span class="tag">独立服务</span></h1>
<p>Ethereum Monitor · 与 Telegram 生产环境隔离运行。此页面不会修改 Telegram 的配置或登录状态。</p></div></header>
<main class="wrap">
<section class="card">
<h2>管理员身份验证</h2>
<div class="row"><input id="token" type="password" autocomplete="off" placeholder="Signal 专属管理密钥（非 Telegram 密钥）"><button id="loginBtn">连接管理服务</button><button class="secondary" id="clearBtn">清除密钥</button></div>
<p class="help">管理密钥只保留在当前页面内存中，不存入浏览器本地存储。关闭页面后需要重新输入。</p>
<div class="status" id="authStatus" role="status" aria-live="polite"></div>
</section>
<section class="grid">
<div class="card">
<div class="line"><h2>Signal 登录状态</h2><span id="connected" class="tag">尚未连接</span></div>
<p>当前账号：<strong id="account">—</strong></p>
<p>网关：<span id="gateway">未检测</span></p>
<p>消息发送：<span id="sender">已禁用</span></p>
<button id="refreshBtn" class="secondary" disabled>刷新状态</button>
</div>
<div class="card">
<h2>扫码关联 Signal</h2>
<p>使用手机 Signal 的「设置 → 已关联设备 → 关联新设备」扫描二维码，机器人作为该账号的关联设备。</p>
<button id="linkBtn" disabled>生成关联二维码</button>
<div id="qrBox"><img id="qrImg" class="qr" alt="Signal 关联二维码"><div>
<p id="qrHelp">请使用 Signal 手机应用扫码。</p>
<button id="closeQrBtn" class="secondary">隐藏二维码</button>
</div></div>
<p class="status" id="linkStatus" role="status" aria-live="polite"></p>
</div>
</section>
<section class="card">
<div class="line"><h2>Signal 群组管理</h2><button class="secondary" id="groupRefreshBtn" disabled>读取账号群组</button></div>
<p>仅勾选的群组会接受新授权、动账和地址查询消息。群组选择只写入 Signal 独立配置。</p>
<div id="groups"><span class="muted">关联账号后读取群组。</span></div>
<div class="row" style="margin-top:14px"><button id="saveGroupsBtn" disabled>保存群组选择</button><span id="groupStatus" role="status" aria-live="polite"></span></div>
</section>
<section class="card"><h2>运行安全</h2>
<p>Telegram 仍由原 Cloudflare Worker 独立运行；Signal 的扫码登录不要求重启 Telegram。即使此页面显示 Signal 已登录，也不代表通知已正式开启：需要单独接入事件源并通过测试后才能启用。</p>
</section>
</main>
<script>
(function(){
  "use strict";
  var secret="", polling=0, currentGroups=[];
  function id(s){return document.getElementById(s)}
  function msg(target,value,error){var el=id(target);el.textContent=value||"";el.className="status "+(error?"err":"");}
  async function api(path,method,data){
    if(!secret)throw Error("请先输入 Signal 管理密钥");
    var opts={method:method||"GET",headers:{"authorization":"Bearer "+secret}};
    if(data!==undefined){opts.headers["content-type"]="application/json";opts.body=JSON.stringify(data);}
    var r=await fetch("/admin/api/"+path,opts),d=await r.json();
    if(!r.ok)throw Error(d.error||"HTTP "+r.status);
    return d;
  }
  function loginButtons(authorized){
    ["refreshBtn","linkBtn","groupRefreshBtn"].forEach(function(n){id(n).disabled=!authorized;});
    if(!authorized){id("saveGroupsBtn").disabled=true;clearInterval(polling);polling=0;}
  }
  function renderState(d){
    id("connected").textContent=d.account?"已关联":"未关联";
    id("connected").className="tag"+(d.account?" ok":"");
    id("account").textContent=d.account||"—";
    id("gateway").textContent=d.rpc_connected?"已连接":"连接失败";
    id("gateway").className=d.rpc_connected?"ok":"err";
    id("sender").textContent=!d.enabled?"未开启":d.dry_run?"模拟发送（不会发消息）":"正式发送";
    id("sender").className=d.enabled&&!d.dry_run?"ok":"muted";
    if(d.link_status==="linked"){msg("linkStatus","已完成扫码关联，账号已保存");id("qrBox").style.display="none";}
    else if(d.link_status==="failed"){msg("linkStatus","关联失败："+(d.link_error||"请重新扫码"),true);}
    else if(d.link_status==="waiting"){msg("linkStatus","等待手机 Signal 扫码确认……");}
  }
  async function status(){
    var d=await api("status");renderState(d);
  }
  async function groups(){
    var d=await api("groups");
    currentGroups=d.groups||[];
    var root=id("groups");root.replaceChildren();
    if(!currentGroups.length){var el=document.createElement("span");el.textContent="未发现群组。请确认已登录并在手机上加入相应群。";el.className="muted";root.appendChild(el);}
    currentGroups.forEach(function(g){
      var label=document.createElement("label");label.className="g";
      var cb=document.createElement("input");cb.type="checkbox";cb.value=g.id;cb.checked=g.selected;
      var title=document.createElement("span");title.textContent=g.name||"未命名群组";
      label.appendChild(cb);label.appendChild(title);root.appendChild(label);
    });
    id("saveGroupsBtn").disabled=!d.account;msg("groupStatus","");
  }
  id("loginBtn").addEventListener("click",async function(){
    secret=id("token").value.trim();
    if(!secret){msg("authStatus","请输入 Signal 专属管理密钥",true);return;}
    try{await status();loginButtons(true);msg("authStatus","管理服务已连接");}
    catch(e){secret="";loginButtons(false);msg("authStatus",e.message,true);}
  });
  id("clearBtn").addEventListener("click",function(){secret="";id("token").value="";loginButtons(false);msg("authStatus","密钥已从当前页面清除");});
  id("refreshBtn").addEventListener("click",async function(){try{await status();}catch(e){msg("authStatus",e.message,true);}});
  id("linkBtn").addEventListener("click",async function(){
    id("linkBtn").disabled=true;msg("linkStatus","正在准备关联二维码……");
    try{
      var d=await api("start-link","POST",{});
      id("qrImg").src=d.qr;
      id("qrBox").style.display="flex";
      msg("linkStatus","二维码已生成。请在手机 Signal 的已关联设备中扫码。");
      if(polling)clearInterval(polling);
      polling=setInterval(function(){status().catch(function(e){msg("linkStatus",e.message,true);});},4000);
    }catch(e){msg("linkStatus",e.message,true);}
    finally{id("linkBtn").disabled=false;}
  });
  id("closeQrBtn").addEventListener("click",function(){id("qrBox").style.display="none";});
  id("groupRefreshBtn").addEventListener("click",async function(){try{await groups();}catch(e){msg("groupStatus",e.message,true);}});
  id("saveGroupsBtn").addEventListener("click",async function(){
    var selected=[].map.call(id("groups").querySelectorAll("input:checked"),function(c){return c.value});
    try{var r=await api("groups","POST",{groupIds:selected});msg("groupStatus","已保存 "+r.saved+" 个 Signal 群组");}
    catch(e){msg("groupStatus",e.message,true);}
  });
})();
</script></body></html>`;
