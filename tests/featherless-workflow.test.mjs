import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadCatalogue, validateCatalogue, buildProfile, stageProfile, inspectStage, checkProvider, normaliseMetadata, routingSource, executionIdentity, verifyExecution } from "../scripts/featherless-profile.mjs";
import { eventMetrics, consumeEvent, cleanEnvironment, temporaryWorkspace, runPi, piRuntime } from "../scripts/featherless-runner.mjs";
import { budgetProxy } from "../scripts/featherless-proxy.mjs";
import { FIXTURES, prepareFixture, verifyFixture, guardSource } from "../scripts/featherless-fixtures.mjs";
import { main, summariseRuns } from "../scripts/featherless-benchmark.mjs";
import { rpcPi } from "../scripts/featherless-session-smoke.mjs";
import vm from "node:vm";

function temporary(t) { const workspace=temporaryWorkspace("pamwechete-tests-"); t.after(()=>workspace.remove()); return workspace.root; }
const snapshot=()=>loadCatalogue();
function fakePi(root) {
 mkdirSync(join(root,"dist","bundle","chunks"),{recursive:true});
 writeFileSync(join(root,"package.json"),JSON.stringify({name:"@earendil-works/pi-coding-agent",version:"0.87.1",gitHead:"a".repeat(40)}));
 const cli=join(root,"dist","bundle","cli.js");
 writeFileSync(cli,'import "./chunks/runtime.js";\n');
 writeFileSync(join(root,"dist","bundle","chunks","runtime.js"),'export const build = "official-fixture";\n');
 return cli;
}
test("runtime fingerprints detect changed implementation with the same package name and version",t=>{
 const root=temporary(t),cli=fakePi(join(root,"first")),first=piRuntime(cli);
 assert.equal(first.version,"0.87.1");assert.equal(first.sourceRevision,"a".repeat(40));assert.equal(first.fileCount,3);
 assert.deepEqual(piRuntime(fakePi(join(root,"second"))),first,"Installation path changed the fingerprint");
 writeFileSync(join(root,"first","dist","bundle","chunks","runtime.js"),'export const build = "fork-fixture";\n');
 const changed=piRuntime(cli);assert.equal(changed.version,first.version);assert.notEqual(changed.digest,first.digest);
 assert.notEqual(changed.codeDigest,first.codeDigest);
});
test("runtime fingerprint scope excludes settings, sessions and documentation",t=>{
 const root=temporary(t),cli=fakePi(root),first=piRuntime(cli);
 writeFileSync(join(root,"auth.json"),"fabricated unparsed data");
 writeFileSync(join(root,"dist","auth.json"),"fabricated unparsed data");
 writeFileSync(join(root,"README.md"),"changed documentation");
 assert.deepEqual(piRuntime(cli),first);
 writeFileSync(join(root,"npm-shrinkwrap.json"),'{}');assert.notEqual(piRuntime(cli).digest,first.digest);
});
test("runtime identity refuses links and source entry points",t=>{
 const root=temporary(t),cli=fakePi(root),external=join(temporary(t),"external");mkdirSync(external);
 symlinkSync(external,join(root,"dist","linked"),process.platform==="win32"?"junction":"dir");
 assert.throws(()=>piRuntime(cli),/links/);
 const source=join(root,"source.js");writeFileSync(source,"");assert.throws(()=>piRuntime(source),/compiled dist/);
});
test("catalogue has no assumed default and requires explicit model selection",()=>{
 const c=snapshot();assert.equal(c.defaultModel,null);
 assert.equal(c.models.find(m=>m.key==="qwen38-davidau-baseline").status,"candidate");
 assert.throws(()=>buildProfile(c,undefined,32768),/Select a model explicitly/);
 c.defaultModel=c.models[0].key;assert.throws(()=>validateCatalogue(c),/qualified/);
});
test("catalogue rejects duplicate IDs, credentials and request-body injection",()=>{
 for(const change of [
  c=>c.models.push(structuredClone(c.models[0])),
  c=>c.models[0].request.apiKey="synthetic",
  c=>c.models[0].request.samplingParams.messages=[],
  c=>c.models[0].request.samplingParams.chat_template_kwargs={enable_thinking:"false"},
  c=>c.models[0].request.compat.supportsFinishReason=false,
  c=>c.models[0].request.baseUrl="https://example.invalid",
  c=>delete c.models[0].metadata.pricing.input
 ]) {const c=snapshot();change(c);assert.throws(()=>validateCatalogue(c));}
});
test("a rewritten manifest cannot qualify different staged settings",t=>{
 const root=temporary(t),c=snapshot(),p=buildProfile(c,c.models[0].key,32768),dest=join(root,"agent");
 const altered=structuredClone(p);altered.settings.defaultTools=["read"];
 stageProfile(altered,dest,{candidate:true});
 assert.throws(()=>inspectStage(dest,p),/differs/);
});
test("qualification cannot come from a synthetic or stale record",()=>{
 const c=snapshot(),m=c.models[0];m.status="qualified";m.qualification={kind:"synthetic",reviewed:true};assert.throws(()=>validateCatalogue(c),/live evidence/);
 m.qualification.kind="live";m.qualification.modelId=m.id;m.qualification.requestDigest="stale";assert.throws(()=>validateCatalogue(c),/stale/);
});
test("effective context is capped by plan, output is reserved and guard order is retained",()=>{
 const c=snapshot(), p=buildProfile(c,c.models[0].key,16384);
 assert.equal(p.contextWindow,16384);
 assert.ok(p.settings.compaction.keepRecentTokens+p.settings.compaction.reserveTokens < p.contextWindow);
 assert.ok(p.settings.extensions.findIndex(p=>p.endsWith("bash-guard"))<p.settings.extensions.findIndex(p=>p.endsWith("rtk")));
 assert.ok(!p.settings.extensions.some(p=>p.endsWith("featherless-tool-bridge")));
 assert.equal(p.models.providers.featherless.compat,undefined);
 assert.throws(()=>buildProfile(c,c.models[0].key,4096),/too small/);
 assert.throws(()=>buildProfile(c,c.models[0].key,NaN),/confirmed plan/);
});
test("staging requires candidate opt-in, never overwrites and detects changed files",t=>{
 const root=temporary(t),c=snapshot(),p=buildProfile(c,c.models[0].key,32768),dest=join(root,"agent");
 assert.throws(()=>stageProfile(p,dest),/--candidate/);
 stageProfile(p,dest,{candidate:true});assert.equal(inspectStage(dest).modelId,p.model.id);
 assert.throws(()=>stageProfile(p,dest,{candidate:true}),/already exists/);
 writeFileSync(join(dest,"settings.json"),"{}");assert.throws(()=>inspectStage(dest),/changed/);
});
test("staging refuses even synthetic credential fields before writing",t=>{
 const c=snapshot(),p=buildProfile(c,c.models[0].key,32768);p.models.providers.featherless.apiKey="synthetic";
 assert.throws(()=>stageProfile(p,join(temporary(t),"agent"),{candidate:true}),/credential field/);
});
const metadata=id=>({id,status:"active",context_length:32768,max_completion_tokens:32768,features:{tool_use:true},pricing:{prompt:"0.0000016",completion:"0.000012"}});
test("provider lookup is unauthenticated, bounded and reports metadata drift",async()=>{
 const m=snapshot().models[0];
 const result=await checkProvider(m,async(url,options)=>{
  assert.ok(url.endsWith(encodeURIComponent(m.id)));assert.equal(options.redirect,"error");assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers["User-Agent"],"PamweChete/1.0");
  return new Response(JSON.stringify({...metadata(m.id),context_length:16384}));
 });
 assert.deepEqual(result.changed,["contextLength"]);assert.equal(result.usable,false);
 await assert.rejects(checkProvider(m,async()=>new Response("x".repeat(140*1024))),/too large/);
 await assert.rejects(checkProvider(m,async()=>new Response("{}",{status:404})),/HTTP 404/);
 assert.throws(()=>normaliseMetadata({...metadata(m.id),features:{tool_use:false}},m.id),/tool use/);
});
test("usage sums authoritative message ends, with missing usage kept unknown",()=>{
 const metrics=eventMetrics(),state={calls:new Set()};
 const end={type:"message_end",message:{role:"assistant",stopReason:"stop",usage:{input:20,output:5}}};
 consumeEvent(metrics,{type:"message_update",usage:{input:20,output:4}},1,state);
 consumeEvent(metrics,end,2,state);assert.equal(metrics.inputTokens,20);assert.equal(metrics.outputTokens,5);
 consumeEvent(metrics,{type:"message_end",message:{role:"assistant",stopReason:"length"}},3,state);
 assert.equal(metrics.usageKnown,false);assert.equal(metrics.truncated,1);
 consumeEvent(metrics,{type:"tool_execution_start",toolName:"read",args:{path:"x"}},4,state);
 consumeEvent(metrics,{type:"tool_execution_start",toolName:"read",args:{path:"x"}},5,state);assert.equal(metrics.repeatedCalls,1);
 assert.equal(summariseRuns([{passed:true,metrics,estimatedUsageUsd:null}]).estimatedUsageUsd,null);
 assert.ok(!Object.keys(cleanEnvironment("synthetic-dir")).some(k=>/KEY|TOKEN|AUTH/i.test(k)));
});
test("dry-run plans all fixtures without a Pi path, credentials or generation",async()=>{
 const plan=await main(["--model","qwen38-trohrbaugh","--plan-context","32768"]);
 assert.equal(plan.live,false);assert.equal(plan.runs,24);assert.equal(plan.fixtures.length,8);
});
test("a bounded pilot selects explicit fixtures and rejects unknown or duplicate names",async()=>{
 const args=["--model","qwen38-davidau-baseline","--plan-context","32768","--fixture","orientation"];
 const plan=await main(args);assert.equal(plan.runs,3);assert.deepEqual(plan.fixtures,["orientation"]);
 await assert.rejects(main([...args,"--fixture","orientation"]),/unique known/);
 await assert.rejects(main([...args,"--fixture","unknown"]),/unique known/);
});
test("credential reuse stays inside Pi and never enters generated source",async()=>{
 const c=snapshot(),p=buildProfile(c,c.models[0].key,32768),captured=[];
 const source=routingSource(p,"http://127.0.0.1:1234/v1","fabricated-store.json");
 const context=vm.createContext({}),module=new vm.SourceTextModule(source,{context});
 const credential={type:"api_key",key:"fabricated-private-value"};
 await module.link(async name=>{
  assert.equal(name,"@earendil-works/pi-coding-agent");
  return new vm.SyntheticModule(["readStoredCredential"],function(){this.setExport("readStoredCredential",provider=>{assert.equal(provider,"featherless");return credential;});},{context});
 });
 await module.evaluate();module.namespace.default({registerProvider:(name,provider)=>captured.push([name,provider])});
 assert.equal(captured[0][1].apiKey,credential.key);assert.ok(!source.includes(credential.key));
 credential.type="oauth";assert.throws(()=>module.namespace.default({registerProvider(){}}),/login is unavailable/);
 assert.ok(!routingSource(p,"http://127.0.0.1:1234/v1").includes("readStoredCredential"));
});
test("independent fixture checks reject a broken solution, accept repair and reject tampered tests",t=>{
 const root=temporary(t),fixture=FIXTURES.find(f=>f.id==="seeded-repair"),cwd=join(root,"fixture");
 prepareFixture(fixture,cwd);
 const metrics={exitCode:0,failure:null,settled:true,truncated:0,providerErrors:0};
 assert.equal(verifyFixture(fixture,cwd,metrics).passed,false);
 writeFileSync(join(cwd,"sum.mjs"),"export const sum = values => values.reduce((a,b)=>a+b,0);");
 assert.equal(verifyFixture(fixture,cwd,metrics).passed,true);
 writeFileSync(join(cwd,"sum.mjs"),"export const sum = () => 0; process.exit(0);\n");
 assert.equal(verifyFixture(fixture,cwd,metrics).passed,false,"An exit before the outcome check passed");
 writeFileSync(join(cwd,"sum.mjs"),'console.log("# Subtest: sum"); console.log(JSON.stringify({type:"test:pass",name:"sum"})); process.exit(0);\n');
 assert.equal(verifyFixture(fixture,cwd,metrics).passed,false,"Generated stdout spoofed assertion completion");
 writeFileSync(join(cwd,".pamwechete-check.mjs"),"");assert.equal(verifyFixture(fixture,cwd,metrics).reason,"protected_file_changed");
});

test("passing generated code cannot change protected files during verification",t=>{
 const root=temporary(t),fixture=FIXTURES.find(f=>f.id==="multi-step-create");
 const metrics={exitCode:0,failure:null,settled:true,truncated:0,providerErrors:0};
 for(const [index,mutation] of [
  'writeFileSync("sum.mjs","changed");',
  'writeFileSync(".pamwechete-check.mjs","");',
  'renameSync("sum.mjs","saved.mjs");writeFileSync("sum.mjs",readFileSync("saved.mjs"));'
 ].entries()) {
  const cwd=join(root,"fixture-"+index);prepareFixture(fixture,cwd);
  writeFileSync(join(cwd,"result.json"),'{"average":4}');
  writeFileSync(join(cwd,"average.mjs"),'import {sum} from "./sum.mjs"; import {writeFileSync,renameSync,readFileSync} from "node:fs"; '+mutation+
   ' export const average = values => values.length ? sum(values)/values.length : null;');
  assert.equal(verifyFixture(fixture,cwd,metrics).reason,"protected_file_changed");
 }
});

function fabricatedEvaluation(t,fixtures=["orientation"]) {
 const root=temporary(t),agentDir=join(root,"agent"),cliPath=fakePi(join(root,"runtime")),out=join(root,"report.json");
 const profile=buildProfile(snapshot(),"qwen38-trohrbaugh",32768);
 stageProfile(profile,agentDir,{candidate:true});
 const previousFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=previousFetch;});
 globalThis.fetch=async url=>{
  assert.ok(String(url).startsWith("https://api.featherless.ai/v1/models/"),"Fabricated evaluation attempted generation");
  const model=profile.model;
  return new Response(JSON.stringify({id:model.id,status:"active",features:{tool_use:true},context_length:model.metadata.contextLength,
   max_completion_tokens:model.metadata.maxCompletionTokens,pricing:{prompt:model.metadata.pricing.input/1e6,completion:model.metadata.pricing.output/1e6}}));
 };
 return {out,args:["--live","--model",profile.model.key,"--plan-context","32768","--repeat","1",
  ...fixtures.flatMap(id=>["--fixture",id]),"--pi",cliPath,"--agent-dir",agentDir,"--out",out,"--max-estimated-usd","1"]};
}
const completedMetrics=()=>({exitCode:0,failure:null,settled:true,truncated:0,providerErrors:0,usageKnown:false});

test("owned cleanup failure leaves a report that is explicitly unverified",async t=>{
 const evaluation=fabricatedEvaluation(t);
 await assert.rejects(main(evaluation.args,{
  createWorkspace:prefix=>{const workspace=temporaryWorkspace(prefix);return {root:workspace.root,remove(){workspace.remove();throw new Error("Synthetic cleanup failure");}};},
  runFixture:async({cwd})=>{writeFileSync(join(cwd,"answer.txt"),"This project totals integer cents without floating-point rounding.\n");return completedMetrics();}
 }),/Synthetic cleanup failure/);
 const report=JSON.parse(readFileSync(evaluation.out,"utf8"));
 assert.equal(report.runs[0].passed,true);assert.equal(report.executionVerified,true);
 assert.equal(report.cleanupVerified,false);assert.equal(report.proxy.requests,0);
});

test("uncertain process-tree termination stops evaluation before the next fixture",async t=>{
 const evaluation=fabricatedEvaluation(t,["orientation","seeded-repair"]);let started=0;
 await assert.rejects(main(evaluation.args,{runFixture:async()=>{started++;return {...completedMetrics(),failure:"termination_failed"};}}),/termination was not established/);
 const report=JSON.parse(readFileSync(evaluation.out,"utf8"));
 assert.equal(started,1);assert.equal(report.runs.length,1);assert.equal(report.runs[0].passed,false);
 assert.equal(report.proxy.requests,0);assert.equal(report.cleanupVerified,true);
});

for(const rerun of [false,true]) test("failed-check recovery requires a successful later check: "+rerun,async t=>{
 const evaluation=fabricatedEvaluation(t,["failed-check-recovery"]);
 const report=await main(evaluation.args,{runFixture:async({cwd,onEvent})=>{
  const check=(id,isError)=>{
   onEvent({type:"tool_execution_start",toolName:"bash",toolCallId:id,args:{command:"node --test .pamwechete-check.mjs"}});
   onEvent({type:"tool_execution_end",toolCallId:id,isError});
  };
  check("failed",true);
  onEvent({type:"tool_execution_start",toolName:"write"});
  writeFileSync(join(cwd,"even.mjs"),"export const isEven = value => value % 2 === 0;");
  if(rerun) check("repaired",false);
  return completedMetrics();
 }});
 assert.equal(report.runs[0].passed,rerun);assert.equal(report.cleanupVerified,true);assert.equal(report.proxy.requests,0);
});

test("execution identity detects staged and referenced resource drift between fixtures",t=>{
 const root=temporary(t),resource=join(root,"extension.mjs"),agentDir=join(root,"agent");
 writeFileSync(resource,"export default () => {};\n");
 const profile=buildProfile(snapshot(),"qwen38-trohrbaugh",32768);
 profile.settings.extensions=[resource];profile.settings.prompts=[];
 stageProfile(profile,agentDir,{candidate:true});
 const identity=executionIdentity(profile,agentDir);
 verifyExecution(profile,agentDir,identity);
 writeFileSync(resource,"export default () => { throw new Error('drift'); };\n");
 assert.throws(()=>verifyExecution(profile,agentDir,identity),/resources changed/);
 writeFileSync(resource,"export default () => {};\n");
 writeFileSync(join(agentDir,"AGENTS.md"),"Changed staged instructions.\n");
 assert.throws(()=>verifyExecution(profile,agentDir,identity),/Staged file has changed/);
});

test("fabricated evaluation saves an unverified report and fails after staged drift",async t=>{
 const root=temporary(t),agentDir=join(root,"agent"),cliPath=fakePi(join(root,"runtime")),out=join(root,"report.json");
 const profile=buildProfile(snapshot(),"qwen38-trohrbaugh",32768);
 stageProfile(profile,agentDir,{candidate:true});
 writeFileSync(cliPath,'import {writeFileSync,appendFileSync} from "node:fs"; import {join} from "node:path";\n'+
  'writeFileSync("answer.txt","This project totals integer cents without floating-point rounding.\\n");\n'+
  'appendFileSync(join(process.env.PI_CODING_AGENT_DIR,"AGENTS.md"),"\\nSynthetic drift.\\n");\n'+
  'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",usage:{input:10,output:2}}}));\n'+
  'console.log(JSON.stringify({type:"agent_settled"}));\n');
 const previousFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=previousFetch;});
 globalThis.fetch=async url=>{
  assert.ok(String(url).startsWith("https://api.featherless.ai/v1/models/"),"Fabricated test attempted generation");
  const model=profile.model;
  return new Response(JSON.stringify({id:model.id,status:"active",features:{tool_use:true},context_length:model.metadata.contextLength,
   max_completion_tokens:model.metadata.maxCompletionTokens,pricing:{prompt:model.metadata.pricing.input/1e6,completion:model.metadata.pricing.output/1e6}}));
 };
 await assert.rejects(main(["--live","--model",profile.model.key,"--plan-context","32768","--repeat","1","--fixture","orientation",
  "--pi",cliPath,"--agent-dir",agentDir,"--out",out,"--max-estimated-usd","1"]),/Staged file has changed/);
 const report=JSON.parse(readFileSync(out,"utf8"));
 assert.equal(report.schemaVersion,3);assert.equal(report.runtimeVerified,true);assert.equal(report.executionVerified,false);
 assert.equal(report.runs.length,1);assert.equal(report.proxy.requests,0);
});
test("fixture guard rejects escape paths, protected writes and undeclared commands",async t=>{
 const cwd=temporary(t),handlers={};const source=guardSource(FIXTURES[1],cwd);
 const module=new vm.SourceTextModule(source,{context:vm.createContext({})});
 await module.link(async name=>{const exports=await import(name);return new vm.SyntheticModule(Object.keys(exports),function(){for(const k of Object.keys(exports))this.setExport(k,exports[k]);},{context:module.context});});
 await module.evaluate();module.namespace.default({on:(name,handler)=>handlers[name]=handler});
 const call=(toolName,input)=>handlers.tool_call({toolName,input});
 assert.equal(call("write",{path:"../escape.txt"}).block,true);
 assert.equal(call("write",{path:".pamwechete-check.mjs"}).block,true);
 assert.equal(call("bash",{command:"node -e anything"}).block,true);
 assert.equal(call("fixture_wait",{}).block,true,"Undeclared tools must remain blocked");
 assert.equal(call("write",{path:"sum.mjs"}),undefined);
});
test("proxy reserves before forwarding and never exceeds request or estimated spending limits",async t=>{
 let forwarded=0;
 const proxy=await budgetProxy({modelId:"test/model",contextWindow:1000,maxTokens:100,pricing:{input:1,output:2},maxRequests:2,maxEstimatedUsd:0.0013,
  fetcher:async()=>{forwarded++;return new Response("data: [DONE]\n\n",{headers:{"Content-Type":"text/event-stream"}});}});
 t.after(()=>proxy.close());
 const payload={model:"test/model",stream:true,max_tokens:100,messages:[]};
 const call=body=>fetch(proxy.url+"/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer synthetic"},body:JSON.stringify(body)});
 const [a,b]=await Promise.all([call(payload),call(payload)]);assert.deepEqual([a.status,b.status].sort(),[200,400]);
 await a.text();await b.text();assert.equal(forwarded,1);assert.ok(proxy.counters.reservedUsd<=0.0013);
 const invalid=await call({...payload,max_tokens:101});assert.equal(invalid.status,400);await invalid.text();assert.equal(forwarded,1);
});
test("provider failures consume a reservation and redirects are never followed",async t=>{
 let calls=0;
 const proxy=await budgetProxy({modelId:"test/model",contextWindow:1000,maxTokens:100,pricing:{input:1,output:2},maxRequests:1,maxEstimatedUsd:1,
  fetcher:async(_url,options)=>{calls++;assert.equal(options.redirect,"error");return new Response("synthetic",{status:503});}});
 t.after(()=>proxy.close());
 const call=()=>fetch(proxy.url+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer synthetic","Content-Type":"application/json"},body:JSON.stringify({model:"test/model",stream:true,max_tokens:100})});
 const a=await call();assert.equal(a.status,503);await a.text();const b=await call();assert.equal(b.status,400);await b.text();assert.equal(calls,1);
});

test("proxy forwards only bounded provider retry controls and keeps error bodies private",async t=>{
 const proxy=await budgetProxy({modelId:"test/model",contextWindow:1000,maxTokens:100,pricing:{input:1,output:2},maxRequests:1,maxEstimatedUsd:1,
  fetcher:async()=>new Response("Synthetic private provider detail",{status:429,headers:{"retry-after":"2","retry-after-ms":"900","x-should-retry":"true","x-private-detail":"synthetic-hidden"}})});
 t.after(()=>proxy.close());
 const response=await fetch(proxy.url+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer synthetic","Content-Type":"application/json"},
  body:JSON.stringify({model:"test/model",stream:true,max_tokens:100})});
 assert.equal(response.status,429);assert.equal(response.headers.get("retry-after"),"2");
 assert.equal(response.headers.get("retry-after-ms"),"900");assert.equal(response.headers.get("x-should-retry"),"true");
 assert.equal(response.headers.get("x-private-detail"),null);assert.ok(!(await response.text()).includes("private provider detail"));
 assert.equal(proxy.counters.requests,1);
});
test("provider configuration errors stop further forwarding",async t=>{
 let calls=0;
 const proxy=await budgetProxy({modelId:"test/model",contextWindow:1000,maxTokens:100,pricing:{input:1,output:2},maxRequests:10,maxEstimatedUsd:1,
  fetcher:async()=>{calls++;return new Response("synthetic",{status:401});}});
 t.after(()=>proxy.close());
 const call=()=>fetch(proxy.url+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer synthetic","Content-Type":"application/json"},body:JSON.stringify({model:"test/model",stream:true,max_tokens:100})});
 const a=await call();assert.equal(a.status,401);await a.text();const b=await call();assert.equal(b.status,400);await b.text();
 assert.equal(calls,1);assert.equal(proxy.counters.stopReason,"provider_configuration_error");
 assert.equal(proxy.counters.lastStatus,401);
});

const solutions = {
 "orientation": { "answer.txt": "This project totals integer cents without floating-point rounding.\n" },
 "seeded-repair": { "sum.mjs": "export const sum = values => values.reduce((a,b)=>a+b,0);\n" },
 "multi-file": { "sum.mjs": "export const sum = values => values.reduce((a,b)=>a+b,0);\n", "render.mjs": "import {sum} from './sum.mjs'; export const render = values => 'Total: ' + sum(values);\n" },
 "paths-with-spaces": { "src files/label.mjs": "export const label = () => 'ready';\n" },
 "clarification": {},
 "failed-check-recovery": { "even.mjs": "export const isEven = value => value % 2 === 0;\n" },
 "untrusted-file": { "add.mjs": "export const add = (a,b) => a+b;\n" },
 "multi-step-create": { "average.mjs": "import {sum} from './sum.mjs'; export const average = values => values.length ? sum(values)/values.length : null;\n", "result.json": '{"average":4}\n' }
};
for (const fixture of FIXTURES) test("fixture controls: " + fixture.id,t=>{
 const cwd=join(temporary(t),"fixture");prepareFixture(fixture,cwd);
 const metrics={exitCode:0,failure:null,settled:true,truncated:0,providerErrors:0};
 assert.equal(verifyFixture(fixture,cwd,metrics).passed,false,"An unfinished fixture passed");
 for(const [name,text] of Object.entries(solutions[fixture.id])) writeFileSync(join(cwd,name),text);
 const observed={question:true,failedCheck:true,successfulCheck:true};
 assert.equal(verifyFixture(fixture,cwd,metrics,observed).passed,true,"A correct fixture failed");
 assert.equal(verifyFixture(fixture,cwd,{...metrics,truncated:1},observed).passed,false,"Truncated agent output passed");
});
test("negative, non-finite and absent usage remain unknown",()=>{
 for(const usage of [{input:-1,output:3},{input:1,output:2,cacheRead:NaN},{input:1,output:0,cacheWrite:-1},undefined]) {
  const metrics=eventMetrics();consumeEvent(metrics,{type:"message_end",message:{role:"assistant",stopReason:"stop",usage}},1,{calls:new Set()});
  assert.equal(metrics.usageKnown,false);
 }
 const metrics=eventMetrics();consumeEvent(metrics,{type:"message_end",message:{role:"assistant",stopReason:"stop",usage:{input:0,output:0,cacheRead:10}}},1,{calls:new Set()});
 assert.equal(metrics.usageKnown,true);assert.equal(metrics.cacheReadTokens,10);
});
test("the runner bounds a stalled process and refuses malformed event output",async t=>{
 const cwd=temporary(t),cliPath=join(cwd,"synthetic.mjs");
 writeFileSync(cliPath,"setInterval(()=>{},1000);\n");
 const stalled=await runPi({cliPath,cwd,agentDir:join(cwd,"agent"),prompt:"synthetic",timeoutMs:1000});
 assert.equal(stalled.failure,"deadline");assert.equal(stalled.usageKnown,false);
 writeFileSync(cliPath,'console.log("not JSON"); setInterval(()=>{},1000);\n');
 const malformed=await runPi({cliPath,cwd,agentDir:join(cwd,"agent"),prompt:"synthetic",timeoutMs:1000});
 assert.equal(malformed.failure,"invalid_event_stream");
});

test("deadline termination removes the parent and its fabricated descendant",async t=>{
 const cwd=temporary(t),cliPath=join(cwd,"synthetic-tree.mjs");let identifiers;
 writeFileSync(cliPath,'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});\n'+
  'console.log(JSON.stringify({type:"synthetic_tree",parent:process.pid,descendant:child.pid})); setInterval(()=>{},1000);\n');
 const result=await runPi({cliPath,cwd,agentDir:join(cwd,"agent"),prompt:"synthetic",timeoutMs:1000,
  onEvent:event=>{if(event.type==="synthetic_tree") identifiers=[event.parent,event.descendant];}});
 assert.equal(result.failure,"deadline");assert.equal(identifiers?.length,2);
 const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){assert.equal(error.code,"ESRCH");return false;}};
 const limit=Date.now()+3000;while(identifiers.some(alive)&&Date.now()<limit) await new Promise(done=>setTimeout(done,25));
 assert.ok(identifiers.every(pid=>!alive(pid)),"A fabricated process survived the deadline");
});

test("a nonzero Windows taskkill exits through a bounded failure",{skip:process.platform!=="win32"},async t=>{
 const cwd=temporary(t),cliPath=join(cwd,"synthetic.mjs"),fakeBin=join(cwd,"bin");
 mkdirSync(fakeBin);copyFileSync(process.execPath,join(fakeBin,"taskkill.exe"));
 writeFileSync(cliPath,"setInterval(()=>{},1000);\n");
 const previousPath=process.env.PATH;t.after(()=>{process.env.PATH=previousPath;});process.env.PATH=fakeBin;
 const started=Date.now();
 const result=await runPi({cliPath,cwd,agentDir:join(cwd,"agent"),prompt:"synthetic",timeoutMs:1000});
 assert.equal(result.failure,"termination_failed");assert.ok(Date.now()-started<8000,"Termination hung after taskkill failure");
});

test("RPC close propagates a nonzero fixture exit",async t=>{
 const cwd=temporary(t),cliPath=join(cwd,"synthetic-rpc.mjs");writeFileSync(cliPath,"process.exit(5);\n");
 const client=rpcPi({cliPath,cwd,agentDir:join(cwd,"agent"),sessionDir:cwd,model:"synthetic",extensions:[]});
 await assert.rejects(client.close(),/exited before completion/);
});
