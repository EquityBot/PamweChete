import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadCatalogue, selectModel, buildProfile, inspectStage, checkProvider, routingSource, executionIdentity, verifyExecution } from "./featherless-profile.mjs";
import { FIXTURES, fixtureDigest, prepareFixture, verifyFixture, guardSource } from "./featherless-fixtures.mjs";
import { piRuntime, runPi, temporaryWorkspace } from "./featherless-runner.mjs";
import { budgetProxy } from "./featherless-proxy.mjs";
import { safeMessage } from "./verify-featherless-qwen-profile.mjs";

export function summariseRuns(runs) {
 const finite = values => values.filter(Number.isFinite);
 const median = values => { const a = finite(values).sort((x,y)=>x-y); return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2 : null; };
 return { total: runs.length, passed: runs.filter(r => r.passed).length, failed: runs.filter(r => !r.passed && !r.skipped).length,
  skipped: runs.filter(r => r.skipped).length, medianElapsedMs: median(runs.filter(r=>r.passed).map(r=>r.metrics?.elapsedMs)),
  estimatedUsageUsd: runs.every(r => Number.isFinite(r.estimatedUsageUsd)) ? runs.reduce((n,r)=>n+r.estimatedUsageUsd,0) : null,
  toolErrors: runs.reduce((n,r)=>n+(r.metrics?.toolErrors??0),0), repeatedCalls: runs.reduce((n,r)=>n+(r.metrics?.repeatedCalls??0),0),
  retries: runs.reduce((n,r)=>n+(r.metrics?.retries??0),0), truncated: runs.reduce((n,r)=>n+(r.metrics?.truncated??0),0) };
}

export async function main(args = process.argv.slice(2), { createWorkspace = temporaryWorkspace, runFixture = runPi } = {}) {
 const { values } = parseArgs({ args, options: {
  model: { type: "string" }, "plan-context": { type: "string" }, repeat: { type: "string", default: "3" },
  pi: { type: "string" }, "agent-dir": { type: "string" }, out: { type: "string" }, live: { type: "boolean" },
  "auth-store": { type: "string" }, fixture: { type: "string", multiple: true },
  "max-requests": { type: "string", default: "192" }, "max-estimated-usd": { type: "string" }
 }});
 const catalogue = loadCatalogue(), model = selectModel(catalogue, values.model);
 const profile = buildProfile(catalogue, model.key, Number(values["plan-context"]));
 const repeat = Number(values.repeat), maxRequests = Number(values["max-requests"]);
 assert.ok(Number.isInteger(repeat) && repeat >= 1 && repeat <= 10, "Repeat must be between one and ten");
 assert.ok(Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 10000, "Invalid request limit");
 const selected = values.fixture ?? FIXTURES.map(f => f.id);
 assert.ok(selected.length > 0 && new Set(selected).size === selected.length && selected.every(id => FIXTURES.some(f => f.id === id)), "Select unique known fixtures");
 const fixtures = FIXTURES.filter(f => selected.includes(f.id));
 const reservation = Math.ceil(profile.contextWindow * model.metadata.pricing.input + model.request.maxTokens * model.metadata.pricing.output) / 1_000_000;
 const plan = { modelId: model.id, piVersion: catalogue.piVersion, repeats: repeat, fixtures: fixtures.map(f=>f.id), runs: fixtures.length * repeat,
  contextWindow: profile.contextWindow, maxRequests, reservationPerRequestUsd: reservation, maximumReservedUsd: reservation * maxRequests,
  fixtureDigest: fixtureDigest(), requestDigest: profile.requestDigest, live: Boolean(values.live) };
 if (!values.live) return plan;
 assert.ok(values.pi && values["agent-dir"] && values.out, "Live runs require --pi, --agent-dir and --out");
 const runtime = piRuntime(values.pi);
 assert.equal(runtime.version, catalogue.piVersion, "Pi version differs from the tested baseline");
 const manifest = inspectStage(values["agent-dir"], profile);
 assert.equal(manifest.modelId, model.id, "Staged model differs");
 assert.equal(manifest.requestDigest, profile.requestDigest, "Staged request settings differ");
 assert.equal(manifest.contextWindow, profile.contextWindow, "Staged context differs");
 const metadata = await checkProvider(model);
 assert.equal(metadata.usable, true, "Provider metadata changed; review the catalogue before a live run");
 const maxEstimatedUsd = Number(values["max-estimated-usd"]);
 assert.ok(Number.isFinite(maxEstimatedUsd) && maxEstimatedUsd > 0, "Live runs need --max-estimated-usd");
 const execution = executionIdentity(profile, values["agent-dir"]);
 // Claim the result path before starting anything billable, without replacing an older result.
 writeFileSync(resolve(values.out), "", { flag: "wx", mode: 0o600 });
 const workspace = createWorkspace("pamwechete-benchmark-"), { root } = workspace;
 let proxy;
 const report = { schemaVersion: 3, kind: "live", runId: "run_" + Date.now(), startedAt: new Date().toISOString(), runtime, runtimeVerified: false, executionVerified: false, cleanupVerified: false,
  modelId: model.id, piVersion: catalogue.piVersion, requestDigest: profile.requestDigest, fixtureDigest: fixtureDigest(),
  resourcesDigest: execution.resourcesDigest, harnessDigest: execution.harnessDigest,
  profileFiles: manifest.files, plan, maxEstimatedUsd, runs: [], proxy: null,
  limitations: ["Synthetic fixtures are not an OS sandbox.", "Interactive answers and explicit compaction/resume are not exercised by this JSON-mode suite.",
   "Reserved spending uses current advertised rates and full token ceilings; it is not an invoice."] };
 const save = () => {
  report.summary = summariseRuns(report.runs);
  writeFileSync(resolve(values.out), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
 };
 try {
  proxy = await budgetProxy({ modelId: model.id, contextWindow: profile.contextWindow, maxTokens: model.request.maxTokens,
   pricing: model.metadata.pricing, maxRequests, maxEstimatedUsd });
  report.proxy = proxy.counters;
  const routing = join(root, "routing.mjs");
  writeFileSync(routing, routingSource(profile, proxy.url, values["auth-store"]));
  for (let repetition = 1; repetition <= repeat; repetition++) {
   for (const fixture of fixtures) {
    if (proxy.counters.stopReason || proxy.counters.rejected || proxy.counters.requests >= maxRequests || proxy.counters.reservedUsd + reservation > maxEstimatedUsd + 1e-12) {
     report.runs.push({ fixture: fixture.id, repetition, passed: false, skipped: true, reason: proxy.counters.stopReason ?? "budget_exhausted", estimatedUsageUsd: null });
     save(); continue;
    }
    const cwd = join(root, fixture.id + "-" + repetition);
    prepareFixture(fixture, cwd);
    const guard = join(root, fixture.id + "-" + repetition + "-guard.mjs");
    writeFileSync(guard, guardSource(fixture, cwd));
    const observed = { question: false, failedCheck: false, successfulCheck: false, changedBeforeFailure: false }, checks = new Set();
    verifyExecution(profile, values["agent-dir"], execution);
    assert.equal(piRuntime(values.pi).digest, runtime.digest, "Pi runtime changed before a fixture");
    const metrics = await runFixture({ cliPath: values.pi, cwd, agentDir: resolve(values["agent-dir"]), prompt: fixture.prompt,
     extraArgs: ["--provider", "featherless", "--model", model.id, "--extension", routing, "--extension", guard], onEvent: event => {
      if (event.type === "tool_execution_start") {
       if (event.toolName === "ask_user_question" && /alpha/i.test(JSON.stringify(event.args)) && /beta/i.test(JSON.stringify(event.args))) observed.question = true;
       if (event.toolName === "bash" && event.args?.command === "node --test .pamwechete-check.mjs") checks.add(event.toolCallId);
       if (["write", "edit"].includes(event.toolName) && !observed.failedCheck) observed.changedBeforeFailure = true;
      }
      if (event.type === "tool_execution_end" && checks.delete(event.toolCallId)) {
       if (event.isError) { observed.failedCheck = true; observed.successfulCheck = false; }
       else if (observed.failedCheck) observed.successfulCheck = true;
      }
     } });
    let verdict;
    try { verdict = verifyFixture(fixture, cwd, metrics, observed); }
    catch { verdict = { passed: false, reason: "fixture_verification_error" }; }
    const estimatedUsageUsd = metrics.usageKnown ? ((metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens) * model.metadata.pricing.input +
     metrics.outputTokens * model.metadata.pricing.output) / 1_000_000 : null;
    report.runs.push({ fixture: fixture.id, repetition, ...verdict, metrics, estimatedUsageUsd });
    save();
    assert.notEqual(metrics.failure, "termination_failed", "Pi process-tree termination was not established");
   }
  }
 } finally {
  try {
   await proxy?.close();
   report.runtimeVerified = piRuntime(values.pi).digest === runtime.digest;
   verifyExecution(profile, values["agent-dir"], execution);
   report.executionVerified = true;
  } finally {
   try { workspace.remove(); report.cleanupVerified = true; }
   finally { report.finishedAt = new Date().toISOString(); save(); }
  }
 }
 assert.ok(report.runtimeVerified, "Pi runtime changed during the evaluation");
 assert.ok(report.executionVerified, "Evaluation configuration was not verified");
 return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const result = await main();
  console.log(JSON.stringify(result.kind === "live" ? { runId: result.runId, summary: result.summary, proxy: result.proxy } : result, null, 2));
  if (result.summary && result.summary.passed !== result.summary.total) process.exitCode = 1;
 } catch (error) { console.error("FEATHERLESS_BENCHMARK_FAILED: " + safeMessage(error)); process.exitCode = 1; }
}
