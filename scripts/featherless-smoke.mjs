import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProfile, loadCatalogue, stageProfile, routingSource } from "./featherless-profile.mjs";
import { piRuntime, runPi, temporaryWorkspace } from "./featherless-runner.mjs";
import { budgetProxy } from "./featherless-proxy.mjs";
import { guardSource } from "./featherless-fixtures.mjs";

export async function smoke(cliPath, scenario = "native") {
 assert.ok(["native", "retry", "truncated", "missing-finish", "stored-auth"].includes(scenario));
 const catalogue = loadCatalogue();
 const runtime = piRuntime(cliPath);
 assert.equal(runtime.version, catalogue.piVersion, "Pi version differs from the pinned integration baseline");
 const workspace = temporaryWorkspace("pamwechete-smoke-"), { root } = workspace;
 const cwd = join(root, "fixture"); mkdirSync(cwd);
 writeFileSync(join(cwd, "seed.txt"), "41\n");
 writeFileSync(join(cwd, ".pamwechete-check.mjs"), 'import assert from "node:assert/strict"; import {readFileSync} from "node:fs"; assert.equal(readFileSync("answer.txt","utf8"),"42\\n");\n');
 const calls = [
  { name: "read", arguments: { path: "seed.txt" } },
  { name: "write", arguments: { path: "answer.txt", content: "42\n" } },
  { name: "bash", arguments: { command: "node --test .pamwechete-check.mjs" } },
  { name: "ask_user_question", arguments: { question: "Choose a synthetic label.", options: [{ label: "Alpha", value: "alpha" }, { label: "Beta", value: "beta" }] } }
 ];
 const requests = [], requestTimes = [], events = [], diagnostics = [];
 const server = createServer(async (req, res) => {
  try {
   let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 2 * 1024 * 1024) throw new Error("request too large"); }
   const body = JSON.parse(text); requests.push(body); requestTimes.push(Date.now());
   if (scenario === "stored-auth") assert.equal(req.headers.authorization, "Bearer synthetic-stored");
   if (scenario === "retry" && requests.length === 1) {
    res.writeHead(429, { "Content-Type": "application/json", "Retry-After-Ms": "900" });
    res.end('{"error":{"message":"Synthetic capacity error"}}'); return;
   }
   const index = requests.length - (scenario === "retry" ? 2 : 1);
   const call = ["truncated", "missing-finish"].includes(scenario) ? null : calls[index];
   res.writeHead(200, { "Content-Type": "text/event-stream" });
   const chunk = (delta, finish_reason = null) => ({ id: "synthetic", object: "chat.completion.chunk", created: 0, model: body.model,
    choices: [{ index: 0, delta, finish_reason }] });
   const send = data => res.write("data: " + JSON.stringify(data) + "\n\n");
   send(chunk(call ? { role: "assistant", tool_calls: [{ index: 0, id: "call_" + index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: "Synthetic fixture complete." }));
   if (scenario !== "missing-finish") send(chunk({}, scenario === "truncated" ? "length" : call ? "tool_calls" : "stop"));
   send({ ...chunk({}), choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
   res.end("data: [DONE]\n\n");
  } catch { res.writeHead(400); res.end(); }
 });
 await new Promise(done => server.listen(0, "127.0.0.1", done));
 const proxy = await budgetProxy({ modelId: catalogue.models[0].id, contextWindow: 32768, maxTokens: 4096,
  pricing: catalogue.models[0].metadata.pricing, maxRequests: 8, maxEstimatedUsd: 1,
  upstream: "http://127.0.0.1:" + server.address().port + "/v1" });
 try {
  const profile = buildProfile(catalogue, catalogue.models[0].key, 32768);
  // If provider routing fails, the test can only reach an unused loopback port.
  profile.models.providers.featherless.baseUrl = "http://127.0.0.1:1/v1";
  const routing = join(root, "routing.mjs");
  const storedAuth = scenario === "stored-auth" ? join(root, "fabricated-auth.json") : undefined;
  if (storedAuth) writeFileSync(storedAuth, JSON.stringify({ featherless: { type: "api_key", key: "synthetic-stored" } }));
  writeFileSync(routing, routingSource(profile, proxy.url, storedAuth));
  const guard = join(root, "guard.mjs");
  writeFileSync(guard, guardSource({ writes: ["answer.txt"] }, cwd));
  const agentDir = join(root, "agent");
  stageProfile(profile, agentDir, { candidate: true });
  const result = await runPi({ cliPath, cwd, agentDir, timeoutMs: 60000, extraArgs: ["--provider", "featherless", "--model", profile.model.id, ...(storedAuth ? [] : ["--api-key", "synthetic"]), "--extension", routing, "--extension", guard], prompt: "Run the synthetic tool round trip.", onEvent: e => events.push(e), onDiagnostic: text => diagnostics.push(text) });
  assert.equal(proxy.counters.requests, requests.length, "A request bypassed the budget proxy");
  assert.equal(requests[0].model, profile.model.id);
  assert.ok(JSON.stringify(requests[0].messages).includes("Coding agreement"), "The staged coding agreement was not loaded");
  assert.equal(requests[0].max_tokens, profile.model.request.maxTokens);
  for (const [key, value] of Object.entries(profile.model.request.samplingParams)) assert.equal(requests[0][key], value, "Sampling setting was lost");
  if (scenario === "truncated") {
   assert.ok(result.truncated > 0, "Truncation was not recorded");
   return { ok: true, scenario, runtime, requests: requests.length, metrics: result };
  }
  if (scenario === "missing-finish") {
   assert.ok(result.providerErrors > 0 || result.failure || result.exitCode !== 0, "Missing finish reason was accepted");
   return { ok: true, scenario, runtime, requests: requests.length, metrics: result };
  }
  assert.equal(result.exitCode, 0, JSON.stringify(result) + diagnostics.join(""));
  assert.equal(result.failure, null, JSON.stringify(result));
  assert.equal(readFileSync(join(cwd, "answer.txt"), "utf8"), "42\n");
  assert.equal(requests.length, scenario === "retry" ? 6 : 5, "Native tool loop did not finish");
  if (scenario === "retry") assert.ok(requestTimes[1] - requestTimes[0] >= 800, "Provider retry guidance was lost");
  assert.ok(requests.at(-1).messages.some(m => m.role === "tool"), "Tool result was not replayed natively");
  const names = requests[0].tools.map(t => t.function.name);
  for (const name of calls.map(c => c.name)) assert.ok(names.includes(name), "Missing real extension/tool: " + name);
  assert.ok(events.some(e => e.type === "tool_execution_end" && e.toolName === "ask_user_question"), "Question extension did not execute");
  assert.equal(result.truncated, 0);
  return { ok: true, scenario, runtime, piVersion: catalogue.piVersion, requests: requests.length, metrics: result };
 } finally { await proxy.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); workspace.remove(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { console.log(JSON.stringify(await smoke(process.argv[2], process.argv[3]), null, 2)); }
 catch (error) { console.error("PI_SMOKE_FAILED: " + error.message); process.exitCode = 1; }
}
