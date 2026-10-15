import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {Script} from "node:vm";

const source=readFileSync("src/admin-ui.ts","utf8");
assert.match(source,/^export const ADMIN_HTML=/);
const html=JSON.parse(source.slice(source.indexOf("=")+1).trim().replace(/;$/,""));
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,"admin HTML should embed a browser controller");

test("admin UI is a syntactically valid standalone browser app",()=>{
  assert.doesNotThrow(()=>new Script(script,{filename:"ethereum-admin-ui.js"}));
  assert.ok(html.includes('id="nav"')&&html.includes('id="content"'));
});

test("navigation reuses fresh view DOM without a fetch or synchronous rebuild",()=>{
  assert.match(script,/function stashCurrentView\(/);
  assert.match(script,/function showCachedView\(/);
  assert.match(script,/if\(logged&&viewCache\.has\(view\)\)/);
  assert.match(script,/if\(cached&&!cached\.stale\)/);
  assert.match(script,/viewCacheMax=5,viewFreshMs=12000/);
  assert.match(script,/if\(!sameView\)stashCurrentView\(\)/);
  assert.match(script,/if\(epoch!==renderEpoch\)return/);
});

test("body and sidebar are independently scrollable at any screen width",()=>{
  assert.match(html,/body\{height:100dvh;overflow:hidden/);
  assert.match(html,/\.app\{height:100vh;height:100dvh/);
  assert.match(html,/aside\{position:relative;top:0;min-height:0;height:100%;overflow-y:auto/);
  assert.match(html,/main\{[^}]*overflow-y:auto/);
  assert.match(html,/@media\(max-width:760px\)\{\.app\{display:flex;flex-direction:column/);
  assert.match(script,/var scrollHost=document\.querySelector\("\.app > main"\)/);
  assert.doesNotMatch(script,/window\.scrollTo\(/);
});

test("fast navigation does not cache secret setup forms",()=>{
  assert.match(script,/renderedView==="setup"/);
  assert.match(script,/function clearViews\(\)/);
  assert.match(script,/if\(!logged\)\{clearViews\(\);renderLogin\(\);return;\}/);
  assert.match(script,/function clearApiCache\(\)\{[^}]*viewCache\.clear\(\)/);
});

test("route refresh preserves editing focus and data-table scroll position",()=>{
  assert.match(script,/const savedTableScrolls=/);
  assert.match(script,/liveRoot\.querySelectorAll\("\.scroll"\)/);
  assert.match(script,/control\.focus\(\{preventScroll:true\}\)/);
  assert.match(script,/control\.setSelectionRange\(\.\.\.focusSelection\)/);
});

test("errors display nonblocking status without browser alert flashing",()=>{
  assert.match(html,/class="toast"/);
  assert.match(script,/function showToast\(/);
  assert.match(script,/function err\(e\)\{[^}]*showToast\(message,true\)/);
  assert.doesNotMatch(script,/\balert\(/);
  assert.match(script,/function prefetchView\(/);
});

test("large administrative lists request only one 50-row page at a time",()=>{
  const admin=readFileSync("src/admin.ts","utf8");
  assert.match(script,/var listPages=\{subscriptions:0,transfers:0,outbox:0,audit:0\}/);
  assert.match(script,/function listPager\(/);
  for(const view of ["subscriptions","transfers","outbox","audit"]){
    assert.ok(script.includes('"/api/'+view+'?paged=1&page="+listPages.'+view),
      view+" view should request paginated records");
    assert.ok(admin.includes('path==="/api/'+view+'"'),
      view+" API should be preserved");
  }
  assert.match(admin,/async function pagedRows\(/);
  assert.match(admin,/LIMIT 50 OFFSET \?/);
  assert.match(admin,/total_pages:Math\.ceil\(total\/50\)/);
});

test("monitor remark changes do not rebuild the entire page",()=>{
  assert.match(script,/x\.remark=field\.value\.trim\(\);alertMsg/);
  assert.doesNotMatch(script,/api\("\/api\/monitoring\/remark","POST",[^\n]*await render\(\)/);
});
