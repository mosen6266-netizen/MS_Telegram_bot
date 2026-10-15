import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync("src/admin-ui.ts","utf8");
const html=JSON.parse(source.trim().slice("export const ADMIN_HTML=".length,-1));
const script=html.split("<script>")[1].split("</script>")[0];
const i=script.indexOf("function action(p,name,fn,style){");
const j=script.indexOf("\nfunction table(",i);
assert.ok(i>0&&j>i);
function setup(){
 const failures=[],ctx={
  put(parent,obj){parent.children.push(obj);return obj},
  node(tag,text,cls){return {tag,textContent:text,className:cls,disabled:false}},
  err(e){failures.push(e)}
 };
 vm.runInNewContext(script.slice(i,j),ctx);
 return {create:ctx.action,failures};
}
test("a pending asynchronous button action cannot be triggered twice",async()=>{
 const {create,failures}=setup(),p={children:[]};
 let release,requests=0;
 const gate=new Promise(resolve=>release=resolve);
 const btn=create(p,"保存",async()=>{requests++;await gate});
 const running=btn.onclick();
 assert.equal(btn.disabled,true);
 assert.equal(btn.textContent,"保存");
 const duplicate=btn.onclick();
 assert.equal(duplicate,undefined);
 assert.equal(requests,1);
 release();
 await running;
 assert.equal(btn.disabled,false);
 await btn.onclick();
 assert.equal(requests,2);
 assert.equal(failures.length,0);
});
test("failed actions restore their button state and expose the error",async()=>{
 const {create,failures}=setup();
 const button=create({children:[]},"重新排队",async()=>{throw Error("test write failure")});
 await button.onclick();
 assert.equal(button.disabled,false);
 assert.equal(failures.length,1);
 assert.match(failures[0].message,/test write failure/);
});
test("instant navigation does not lock sidebar buttons",()=>{
 const {create}=setup(),events=[];
 const button=create({children:[]},"系统总览",()=>{events.push("navigate")});
 button.onclick();button.onclick();
 assert.deepEqual(events,["navigate","navigate"]);
 assert.equal(button.disabled,false);
});
