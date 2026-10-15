import test from "node:test";
import assert from "node:assert/strict";
import {build} from "esbuild";

// Bundle the actual production processor. Only chain/RPC and persistence
// dependencies are mocked, so tests cover real event identity/loop behavior.
const bundled=await build({
  entryPoints:["src/transfers.ts"],bundle:true,platform:"node",format:"esm",write:false,logLevel:"silent",
  plugins:[{name:"chain-fixture",setup(b){
    b.onResolve({filter:/^\.\/core$/},()=>({path:"core",namespace:"fixture"}));
    b.onLoad({filter:/.*/,namespace:"fixture"},()=>({loader:"js",contents: