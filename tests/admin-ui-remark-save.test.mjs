import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync("src/admin-ui.ts","utf8");
const html=JSON.parse(source.slice("export const ADMIN_HTML=".length).trim().replace(/;$/,""));
const script=html.split("<script>")[1].split("</script>")[0];
const start=script.indexOf("async function saveRemarkInline(");
const end=script.indexOf("\nfunction navigate(",start);
assert.ok(start>0&&end>start,"inline remark saver must exist");
const saverSource=script.slice(start,end);
assert.doesNotMatch(saverSource,/await\s+render\s*\(/,"saving one remark must not rerender the full page");

function saver({api}){
 const messages=[],errors=[],sandbox={api,
  alertMsg:(...args)=>messages.push(args),err:e=>errors.push(e),render:()=>{throw Error("unexpected full rerender")}
 };
 vm.runInNewContext(saverSource,sandbox);
 return {save:sandbox.saveRemarkInline,messages,errors};
}

test("monitoring remark save keeps other unsaved input and does not redraw the page",async()=>{
 const request=[],otherRow={value:"an unsaved draft"},row={remark:"old"},field={value:"new remark"},button={disabled:false,textContent:"保存备注"};
 const {save,messages,errors}=saver({api:async(...args)=>{request.push(args);return {ok:true}}});
 await save("0x"+"11".repeat(20),row,field,button);
 assert.equal(request.length,1);
 assert.equal(request[0][0],"/api/monitoring/remark");
 assert.equal(request[0][2].remark,"new remark");
 assert.equal(row.remark,"new remark");
 assert.equal(otherRow.value,"an unsaved draft");
 assert.equal(button.disabled,false);
 assert.equal(button.textContent,"保存备注");
 assert.equal(errors.length,0);
 assert.equal(messages.length,1);
});

test("duplicate save clicks are ignored while in flight and failures restore the button",async()=>{
 let proceed,calls=0;
 const gate=new Promise(resolve=>proceed=resolve),row={remark:"before"},button={disabled:false,textContent:"保存备注"},field={value:"after"};
 const {save,errors}=saver({api:async()=>{calls++;await gate;throw Error("temporary D1 failure")}});
 const first=save("0x"+"22".repeat(20),row,field,button);
 await save("0x"+"22".repeat(20),row,field,button);
 assert.equal(calls,1);
 assert.equal(button.disabled,true);
 assert.equal(row.remark,"before");
 proceed();
 await first;
 assert.equal(errors.length,1);
 assert.equal(button.disabled,false);
 assert.equal(button.textContent,"保存备注");
 assert.equal(row.remark,"before");
});

test("nonblocking action errors no longer open a modal JavaScript alert",()=>{
 assert.match(script,/function err\(e\)\{alertMsg\("操作失败："/);
 assert.doesNotMatch(script,/function err\(e\)\{[^}]*\balert\(/);
});
