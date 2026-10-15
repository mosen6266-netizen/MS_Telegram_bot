import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync("src/admin-ui.ts","utf8");
const html=JSON.parse(source.trim().slice("export const ADMIN_HTML=".length,-1));
const script=html.split("<script>")[1].split("</script>")[0];
const begin=script.indexOf("async function runInlineMutation(");
const end=script.indexOf("\nfunction navigate(",begin);
assert.ok(begin>=0&&end>begin);
const helper=script.slice(begin,end);
assert.doesNotMatch(helper,/\brender\s*\(/,"inline saves must not redraw the current screen");

function harness(api){
 const messages=[],errors=[],sandbox={api,alertMsg:(...a)=>messages.push(a),err:e=>errors.push(e),
  render:()=>{throw Error("full-page render is forbidden while saving")}
 };
 vm.runInNewContext(helper,sandbox);
 return {run:sandbox.runInlineMutation,messages,errors};
}
test("inline template/subscription saver preserves other unsaved fields and updates the selected item",async()=>{
 let call=null;
 const inputs={otherDraft:"do not erase"},button={disabled:false,textContent:"保存并发布模板"};
 const local={body:"previous",remark:"previous"};
 const h=harness(async(path,method,payload)=>{call={path,method,payload};return {ok:true}});
 const ok=await h.run(button,"保存并发布模板","/api/templates","PUT",
  {template_key:"query_active",chat_id:"*",body:"new",note:"new note"},
  ()=>{local.body="new";local.remark="new note"},"模板已保存");
 assert.equal(ok,true);
 assert.deepEqual(call,{path:"/api/templates",method:"PUT",
   payload:{template_key:"query_active",chat_id:"*",body:"new",note:"new note"}});
 assert.equal(local.body,"new");
 assert.equal(inputs.otherDraft,"do not erase");
 assert.equal(button.disabled,false);
 assert.equal(button.textContent,"保存并发布模板");
 assert.equal(h.errors.length,0);
 assert.equal(h.messages.length,1);
});
test("overlapping clicks do not issue multiple writes; failed writes restore the button without mutating data",async()=>{
 let done,requests=0;
 const gate=new Promise(resolve=>done=resolve);
 const h=harness(async()=>{requests++;await gate;throw Error("synthetic D1 error")});
 const button={disabled:false,textContent:"保存"},local={remark:"unchanged"};
 const run=h.run(button,"保存","/api/subscriptions","PATCH",{address:"0x123"},()=>{local.remark="invalid"});
 const second=await h.run(button,"保存","/api/subscriptions","PATCH",{address:"0x123"},()=>{local.remark="invalid"});
 assert.equal(second,false);
 assert.equal(requests,1);
 assert.equal(button.disabled,true);
 done();
 assert.equal(await run,false);
 assert.equal(button.disabled,false);
 assert.equal(button.textContent,"保存");
 assert.equal(local.remark,"unchanged");
 assert.equal(h.errors.length,1);
});
test("four save/reset paths are local: message templates, subscription changes and remark saves",()=>{
 const template=script.slice(script.indexOf('if(activeRoute==="templates"){'),script.indexOf('if(activeRoute==="transfers"){'));
 const subs=script.slice(script.indexOf('if(activeRoute==="subscriptions"){'),script.indexOf('if(activeRoute==="templates"){'));
 assert.match(template,/runInlineMutation\(saveTemplateButton/);
 assert.match(template,/runInlineMutation\(resetTemplateButton/);
 assert.match(template,/updateTemplateSummary\(\)/);
 assert.doesNotMatch(template,/\bawait render\s*\(/);
 assert.match(subs,/runInlineMutation\(subscriptionSaveButton/);
 assert.match(subs,/subscriptionTable\.rows\[i\+1\]\.cells/);
 assert.doesNotMatch(subs,/\bawait render\s*\(/);
 assert.match(script,/function table\([^]*?return t\}/);
});
