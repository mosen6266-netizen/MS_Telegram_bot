import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const source=readFileSync("src/admin-ui.ts","utf8");
const html=JSON.parse(source.trim().slice("export const ADMIN_HTML=".length,-1));
const script=html.split("<script>")[1].split("</script>")[0];
const start=script.indexOf(" if(loadError&&sameView&&liveRoot.hasChildNodes()){");
const end=script.indexOf("\n renderedView=activeRoute;",start);
assert.ok(start>=0&&end>start,"refresh-failure preservation must run before page replacement");
const commit=script.slice(start,end);

function simulate({sameView,failed,hasPage}){
 const state={replacements:0,messages:[],draft:"a draft not yet saved"};
 const scope={
  sameView,loadError:failed?Error("synthetic HTTP 503"):null,
  liveRoot:{hasChildNodes:()=>hasPage,replaceChildren:()=>{state.replacements++;state.draft="erased"}},
  root:{childNodes:[{tag:"new page"}]},
  alertMsg:(...a)=>state.messages.push(a)
 };
 vm.runInNewContext("(function(){"+commit+"})()",scope);
 return state;
}
test("failed refresh keeps the previous view and any unsaved form data",()=>{
 const x=simulate({sameView:true,failed:true,hasPage:true});
 assert.equal(x.replacements,0);
 assert.equal(x.draft,"a draft not yet saved");
 assert.equal(x.messages.length,1);
 assert.match(x.messages[0][0],/已保留当前页面/);
});
test("successful refresh commits replacement content",()=>{
 const x=simulate({sameView:true,failed:false,hasPage:true});
 assert.equal(x.replacements,1);
});
test("navigating to another page can display its error state without reusing the wrong view",()=>{
 const x=simulate({sameView:false,failed:true,hasPage:true});
 assert.equal(x.replacements,1);
});
test("left navigation is sticky with independent scrolling",()=>{
 assert.match(html,/aside\{position:sticky;top:0;/);
 assert.match(html,/overflow-y:auto;overscroll-behavior:contain/);
});
