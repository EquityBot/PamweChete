import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfile, loadCatalogue, stageProfile, routingSource } from "./featherless-profile.mjs";
import { cleanEnvironment, piRuntime, temporaryWorkspace, terminatePi } from "./featherless-runner.mjs";
import { budgetProxy } from "./featherless-proxy.mjs";
import { guardSource } from "./featherless-fixtures.mjs";

// The smoke client has no access to ordinary Pi configuration or session storage.
export function rpcPi({ cliPath, cwd, agentDir, sessionDir, sessionPath, model, extensions }) {
 const args = [cliPath, "--mode", "rpc", "--no-skills", "--no-themes", "--no-context-files",
  "--append-system-prompt", join(agentDir, "AGENTS.md"), "--session-dir", sessionDir,
  "--provider", "featherless", "--model", model, "--api-key", "synthetic",
  ...extensions.flatMap(path => ["--extension", path])];
 if (sessionPath) {
  assert.ok(!relative(sessionDir, sessionPath).startsWith("..") && dirname(sessionPath) === sessionDir, "Session escaped the fixture");
  args.push("--session", sessionPath);
 }
 const child = spawn(process.execPath, args, { cwd, env: cleanEnvironment(agentDir), windowsHide: true,
  detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
 const events = [], waiting = new Set();
 let pending = "", bytes = 0, diagnosticBytes = 0, failure, termination, id = 0;
 const stop = () => termination ??= terminatePi(child, agentDir).catch(error => { failure ??= error; });
 const fail = message => {
  failure ??= new Error(message);
  for (const waiter of waiting) waiter.reject(failure);
  waiting.clear(); void stop();
 };
 const timer = setTimeout(() => fail("RPC fixture deadline exceeded"), 60000);
 const closed = new Promise(done => child.once("close", (code, signal) => {
  clearTimeout(timer);
  if (waiting.size || pending.trim() || code !== 0) fail("RPC fixture exited before completion");
  done({ code, signal });
 }));
 child.once("error", () => fail("RPC fixture could not start"));
 child.stdin.on("error", () => fail("RPC fixture input failed"));
 child.stdout.setEncoding("utf8");
 child.stdout.on("data", chunk => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 32 * 1024 * 1024) return fail("RPC fixture output exceeded its limit");
  pending += chunk;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
   const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1);
   if (!line) continue;
   try {
    const event = JSON.parse(line); events.push(event);
    for (const waiter of waiting) if (waiter.predicate(event)) { waiting.delete(waiter); waiter.resolve(event); }
   } catch { fail("RPC fixture emitted an invalid record"); }
  }
  if (pending.length > 1024 * 1024) fail("RPC fixture record exceeded its limit");
 });
 child.stderr.on("data", chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1024 * 1024) fail("RPC fixture diagnostics exceeded their limit"); });
 const waitFor = (predicate, after = events.length) => {
  if (failure) return Promise.reject(failure);
  const found = events.slice(after).find(predicate);
  return found ? Promise.resolve(found) : new Promise((resolve, reject) => waiting.add({ predicate, resolve, reject }));
 };
 const command = async (type, fields = {}) => {
  const requestId = "fixture_" + ++id, result = waitFor(event => event.type === "response" && event.id === requestId);
  child.stdin.write(JSON.stringify({ ...fields, type, id: requestId }) + "\n");
  const response = await result;
  assert.equal(response.success, true, "RPC command failed: " + type);
  return response.data;
 };
 return { events, waitFor, command,
  async prompt(message) {
   const settled = waitFor(event => event.type === "agent_settled");
   await Promise.all([command("prompt", { message }), settled]);
  },
  async close() {
   child.stdin.end();
   let timer;
   const stopped = new Promise(done => { timer = setTimeout(() => { void stop().finally(done); }, 2000); });
   try {
    await Promise.race([closed, stopped]);
    await termination;
    if (failure) throw failure;
   } finally { clearTimeout(timer); }
  }
 };
}

export async function sessionSmoke(cliPath, scenario = "compaction") {
 assert.ok(["compaction", "pressure", "interrupted-tool"].includes(scenario), "Unknown session scenario");
 const catalogue = loadCatalogue(), runtime = piRuntime(cliPath);
 assert.equal(runtime.version, catalogue.piVersion, "Pi version differs from the integration baseline");
 const workspace = temporaryWorkspace("pamwechete-session-"), { root } = workspace;
 const cwd = join(root, "fixture"), sessionDir = join(root, "sessions");
 mkdirSync(cwd); mkdirSync(sessionDir);
 const requests = [], clients = [], summary = "SUMMARY_SENTINEL: answer.txt contains 42. The write_once tool completed. Read the file to confirm; do not write it again.";
 let phase = "initial", initialCalls = 0, resumedCalls = 0, summaries = 0;
 const server = createServer(async (req, res) => {
  try {
   let text = "";
   for await (const chunk of req) { text += chunk; if (text.length > 2 * 1024 * 1024) throw new Error("Request too large"); }
   const body = JSON.parse(text); requests.push({ phase, body });
   const compacting = !body.tools?.length;
   let call, answer = "Synthetic work complete.", input = 40;
   if (compacting) { summaries++; answer = summary; }
   else if (phase === "initial") {
    initialCalls++;
    if (initialCalls === 1) call = { id: "write_once", name: "write", args: { path: "answer.txt", content: "42\n" } };
    else if (scenario === "interrupted-tool" && initialCalls === 2) call = { id: "wait_once", name: "fixture_wait", args: {} };
    else { answer += " Evidence for context retention. ".repeat(120); if (scenario === "pressure") input = 30000; }
   } else if (++resumedCalls === 1) call = { id: "read_after_resume", name: "read", args: { path: "answer.txt" } };
   res.writeHead(200, { "Content-Type": "text/event-stream" });
   const chunk = (delta, finish_reason = null) => ({ id: "synthetic", object: "chat.completion.chunk", created: 0, model: body.model,
    choices: [{ index: 0, delta, finish_reason }] });
   const send = data => res.write("data: " + JSON.stringify(data) + "\n\n");
   send(chunk(call ? { role: "assistant", tool_calls: [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: "assistant", content: answer }));
   send(chunk({}, call ? "tool_calls" : "stop"));
   send({ ...chunk({}), choices: [], usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 } });
   res.end("data: [DONE]\n\n");
  } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
 });
 let proxy;
 try {
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const profile = buildProfile(catalogue, catalogue.models[0].key, 32768);
  profile.settings.compaction.keepRecentTokens = 64;
  profile.settings.compaction.enabled = scenario === "pressure";
  profile.models.providers.featherless.baseUrl = "http://127.0.0.1:1/v1";
  proxy = await budgetProxy({ modelId: profile.model.id, contextWindow: profile.contextWindow, maxTokens: profile.model.request.maxTokens,
   pricing: profile.model.metadata.pricing, maxRequests: 9, maxEstimatedUsd: 1,
   upstream: "http://127.0.0.1:" + server.address().port + "/v1" });
  const routing = join(root, "routing.mjs"), guard = join(root, "guard.mjs"), agentDir = join(root, "agent");
  writeFileSync(routing, routingSource(profile, proxy.url));
  writeFileSync(guard, guardSource({ writes: ["answer.txt"], tools: scenario === "interrupted-tool" ? ["fixture_wait"] : [] }, cwd));
  stageProfile(profile, agentDir, { candidate: true });
  const extensions = [routing, guard];
  if (scenario === "interrupted-tool") {
   const waitTool = join(root, "wait-tool.mjs");
   writeFileSync(waitTool, 'import {Type} from "@sinclair/typebox";\nexport default function(pi) { pi.registerTool({ name:"fixture_wait", label:"Wait fixture", description:"Wait until the fabricated tool is cancelled.", parameters:Type.Object({}), execute:async (_id,_params,signal,onUpdate) => { const waiting=new Promise((_done,reject)=> { const cancel=()=>reject(new Error("Synthetic tool cancelled")); if(signal.aborted) cancel(); else signal.addEventListener("abort",cancel,{once:true}); }); onUpdate({content:[{type:"text",text:"WAIT_STARTED"}]}); await waiting; } }); }\n');
   extensions.push(waitTool);
  }
  const start = sessionPath => {
   const client = rpcPi({ cliPath, cwd, agentDir, sessionDir, sessionPath, model: profile.model.id, extensions });
   clients.push(client); return client;
  };
  const first = start();
  if (scenario === "interrupted-tool") {
   const begun = first.waitFor(e => e.type === "tool_execution_update" && e.toolName === "fixture_wait" && JSON.stringify(e.partialResult).includes("WAIT_STARTED"));
   const settled = first.waitFor(e => e.type === "agent_settled");
   await first.command("prompt", { message: "Write the synthetic answer, then wait." });
   await begun; await first.command("abort"); await settled;
  } else {
   await first.prompt("Write the synthetic answer once and retain the evidence.");
   if (scenario === "compaction") {
    const compacted = await first.command("compact", { customInstructions: "Keep the completed write and its exact result." });
    assert.ok(compacted.summary.includes("SUMMARY_SENTINEL"), "Manual compaction summary was lost");
   }
  }
  const before = (await first.command("get_entries")).entries;
  const writes = before.filter(e => e.message?.role === "toolResult" && e.message.toolCallId === "write_once");
  assert.equal(writes.length, 1, "The completed write result was not retained");
  if (scenario === "interrupted-tool") {
   assert.ok(before.some(e => e.message?.toolCallId === "wait_once" && e.message.isError), "Cancellation did not leave an explicit failed tool result");
   assert.ok(before.some(e => e.message?.toolCallId === "wait_once" && JSON.stringify(e.message.content).includes("Synthetic tool cancelled")), "The waiting tool never reached its cancellation handler");
  } else {
   assert.ok(summaries > 0 && before.some(e => e.type === "compaction"), "No real compaction entry was persisted");
   assert.ok(first.events.some(e => e.type === "compaction_start" && e.reason === (scenario === "pressure" ? "threshold" : "manual")), "Compaction used the wrong trigger");
  }
  const state = await first.command("get_state");
  assert.equal(state.model.contextWindow, profile.contextWindow, "The staged context limit was lost");
  assert.ok(state.sessionFile, "The fixture session was not saved");
  await first.close();
  phase = "resume";
  const resumed = start(state.sessionFile);
  await resumed.prompt("Resume the synthetic task and verify the saved answer.");
  const after = (await resumed.command("get_entries")).entries;
  assert.deepEqual(after.find(e => e.id === writes[0].id), writes[0], "Resume changed a completed tool result");
  assert.equal(after.filter(e => e.message?.role === "toolResult" && e.message.toolCallId === "write_once").length, 1, "Resume replayed the completed write");
  assert.equal(readFileSync(join(cwd, "answer.txt"), "utf8"), "42\n", "Resume damaged the saved file");
  const resumedRequest = requests.find(r => r.phase === "resume" && r.body.tools?.length)?.body;
  assert.ok(resumedRequest?.tools.some(t => t.function.name === "write"), "Resume lost native tool schemas");
  assert.ok(resumedRequest.tools.some(t => t.function.name === "ask_user_question"), "Resume lost extension tool schemas");
  if (scenario !== "interrupted-tool") assert.ok(JSON.stringify(resumedRequest.messages).includes("SUMMARY_SENTINEL"), "The resumed provider did not receive the summary");
  else assert.ok(resumedRequest.messages.some(m => m.role === "tool" && m.tool_call_id === "write_once"), "The resumed provider lost the completed tool result");
  assert.equal(proxy.counters.requests, requests.length, "A session request bypassed the proxy");
  return { ok: true, scenario, runtime, requests: requests.length, summaries, resumed: true, completedWrites: writes.length };
 } finally {
  const closed = await Promise.allSettled(clients.map(client => client.close()));
  try { await proxy?.close(); }
  finally {
   server.closeAllConnections();
   try { await new Promise(done => server.close(done)); }
   finally { workspace.remove(); }
  }
  const failure = closed.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { console.log(JSON.stringify(await sessionSmoke(process.argv[2], process.argv[3]), null, 2)); }
 catch (error) { console.error("PI_SESSION_SMOKE_FAILED: " + error.message); process.exitCode = 1; }
}
