import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { rejectCredentialMaterial, safeMessage } from "./verify-featherless-qwen-profile.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CATALOGUE = join(ROOT, "profiles/featherless/catalogue.json");
export const TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user_question"];
const PROFILE = join(ROOT, "profiles/featherless-qwen38");
const API = "https://api.featherless.ai/v1";
const SETTINGS = JSON.parse(readFileSync(join(PROFILE, "settings.windows.json"), "utf8"));
const SAMPLING = new Set(["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty", "frequency_penalty", "seed", "chat_template_kwargs"]);
const COMPAT = new Set(["supportsDeveloperRole", "supportsReasoningEffort", "supportsFinishReason", "supportsStrictMode", "supportsUsageInStreaming", "requiresToolResultName", "maxTokensField"]);
const positiveInt = (value) => Number.isSafeInteger(value) && value > 0;

export const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

export function validateCatalogue(catalogue) {
 rejectCredentialMaterial(catalogue, "catalogue");
 assert.equal(catalogue.schemaVersion, 1, "Unsupported catalogue version");
 assert.match(catalogue.piVersion, /^\d+\.\d+\.\d+$/, "Pi version must be pinned");
 assert.ok(Array.isArray(catalogue.models) && catalogue.models.length > 0, "Catalogue needs models");
 const keys = new Set(), ids = new Set();
 for (const model of catalogue.models) {
  assert.match(model.key, /^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid model key");
  assert.match(model.id, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "Invalid model ID");
  assert.ok(!keys.has(model.key) && !ids.has(model.id), "Duplicate model");
  keys.add(model.key); ids.add(model.id);
  assert.ok(["candidate", "qualified", "historical"].includes(model.status), "Invalid model status");
  assert.match(model.source?.url, /^https:\/\/abliterlitics\.dev\/models\/[a-zA-Z0-9.-]+\/$/, "Model needs an Abliterlitics source");
  for (const date of [model.source.checkedAt, model.metadata?.checkedAt]) {
   assert.match(date, /^\d{4}-\d{2}-\d{2}$/, "Missing observation date");
   assert.ok(Number.isFinite(Date.parse(date)), "Invalid observation date");
  }
  const { metadata, request } = model;
  assert.deepEqual(Object.keys(request).sort(), ["compat", "contextWindow", "input", "maxTokens", "reasoning", "samplingParams"], "Unexpected request setting");
  assert.deepEqual(Object.keys(metadata.pricing).sort(), ["cacheRead", "cacheWrite", "input", "output"], "Missing or unexpected price fields");
  assert.ok(positiveInt(metadata.contextLength) && positiveInt(metadata.maxCompletionTokens), "Invalid metadata limits");
  assert.equal(metadata.toolUse, true, "Native tool support is required");
  assert.equal(metadata.status, "active", "Provider model must be active");
  for (const rate of Object.values(metadata.pricing)) assert.ok(rate === null || (Number.isFinite(rate) && rate >= 0), "Invalid price");
  assert.ok(positiveInt(request.contextWindow) && request.contextWindow <= metadata.contextLength, "Context exceeds provider metadata");
  assert.ok(positiveInt(request.maxTokens) && request.maxTokens <= metadata.maxCompletionTokens && request.maxTokens < request.contextWindow, "Output exceeds usable context");
  assert.equal(typeof request.reasoning, "boolean", "Reasoning selection is required");
  assert.deepEqual(request.input, ["text"], "Only the tested text input surface is supported");
  assert.ok(request.compat && request.samplingParams, "Model-specific request settings are required");
  for (const [key, value] of Object.entries(request.compat)) {
   assert.ok(COMPAT.has(key), "Unknown compatibility setting");
   assert.ok(key === "maxTokensField" ? ["max_tokens", "max_completion_tokens"].includes(value) : typeof value === "boolean", "Invalid compatibility setting");
  }
  assert.equal(request.compat.supportsFinishReason, true, "New native profiles require explicit finish reasons");
  for (const [key, value] of Object.entries(request.samplingParams)) {
   assert.ok(SAMPLING.has(key), "Unknown sampling setting");
   if (key === "chat_template_kwargs") {
    assert.deepEqual(Object.keys(value), ["enable_thinking"], "Unsupported template argument");
    assert.equal(typeof value.enable_thinking, "boolean", "Invalid template thinking selection");
   } else {
    assert.ok(Number.isFinite(value), "Sampling values must be finite numbers");
    if (["temperature", "top_p", "min_p", "repetition_penalty"].includes(key)) assert.ok(value >= 0, "Negative sampling value");
    if (["top_p", "min_p"].includes(key)) assert.ok(value <= 1, "Sampling probability exceeds one");
   }
  }
  if (model.status === "qualified") {
   const q = model.qualification;
   assert.ok(q && q.kind === "live" && q.reviewed === true, "Qualification needs reviewed live evidence");
   assert.equal(q.modelId, model.id, "Qualification model differs");
   assert.equal(q.requestDigest, digest(request), "Qualification settings are stale");
   assert.equal(q.piVersion, catalogue.piVersion, "Qualification Pi version differs");
   assert.match(q.runId, /^[A-Za-z0-9_-]+$/, "Qualification run ID is missing");
   assert.match(q.reportSha256, /^[a-f0-9]{64}$/, "Qualification needs a report digest");
   assert.ok(q.total >= 24 && Number.isSafeInteger(q.total) && q.passed === q.total, "Qualification needs at least 24 passing runs");
   assert.ok(positiveInt(q.contextWindow), "Qualification context is missing");
   assert.ok(q.contextWindow <= request.contextWindow, "Qualification context exceeds the request");
  } else assert.equal(model.qualification, null, "Unqualified models cannot claim qualification");
 }
 assert.ok(catalogue.defaultModel === null || catalogue.models.some(m => m.key === catalogue.defaultModel && m.status === "qualified"), "Only a qualified model can be the default");
 return catalogue;
}

export function loadCatalogue(path = CATALOGUE) {
 return validateCatalogue(JSON.parse(readFileSync(path, "utf8")));
}

export function routingSource(profile, url, authStore) {
 const parsed = new URL(url);
 assert.ok(parsed.protocol === "http:" && parsed.hostname === "127.0.0.1" && parsed.pathname === "/v1" && !parsed.username && !parsed.password && !parsed.search && !parsed.hash, "Routing must use the local qualification proxy");
 const provider = { ...profile.models.providers.featherless, baseUrl: url };
 rejectCredentialMaterial(provider, "provider routing");
 // Registration replaces a custom provider, so retain the complete model list.
 const storedAuth = authStore ? 'const credential=readStoredCredential("featherless",' + JSON.stringify(resolve(authStore)) + '); if(credential?.type!=="api_key" || typeof credential.key!=="string" || !credential.key) throw new Error("Featherless API-key login is unavailable in the selected store"); provider.apiKey=credential.key;' : "";
 const imports = authStore ? 'import {readStoredCredential} from "@earendil-works/pi-coding-agent";\n' : "";
 return imports + 'export default function(pi) { const provider=' + JSON.stringify(provider) + ';' + storedAuth + 'pi.registerProvider("featherless",provider); }\n';
}

export function selectModel(catalogue, key) {
 const model = catalogue.models.find(m => m.key === (key ?? catalogue.defaultModel));
 assert.ok(model, "Select a model explicitly; no qualified default is assumed");
 assert.notEqual(model.status, "historical", "Historical models cannot be staged");
 return model;
}

export function buildProfile(catalogue, key, planContext) {
 validateCatalogue(catalogue);
 const model = selectModel(catalogue, key);
 assert.ok(positiveInt(planContext), "Supply the confirmed plan context limit");
 const contextWindow = Math.min(planContext, model.request.contextWindow, model.metadata.contextLength);
 if (model.status === "qualified") assert.equal(model.qualification.contextWindow, contextWindow, "Qualify this plan context separately");
 const reserveTokens = Math.max(6144, model.request.maxTokens + 2048);
 assert.ok(contextWindow > reserveTokens + 2048, "Context is too small for output and prompt reserves");
 const pricing = model.metadata.pricing;
 assert.ok(Number.isFinite(pricing.input) && Number.isFinite(pricing.output), "Input/output prices are unknown");
 const config = {
  providers: { featherless: {
   baseUrl: API, api: "openai-completions",
   models: [{ id: model.id, name: model.key, ...structuredClone(model.request), contextWindow,
    cost: { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead ?? pricing.input, cacheWrite: pricing.cacheWrite ?? pricing.input } }]
  }}
 };
 const settings = {
  ...structuredClone(SETTINGS), defaultModel: model.id, enabledModels: ["featherless/" + model.id],
  defaultTools: [...TOOLS],
  compaction: { enabled: true, reserveTokens, keepRecentTokens: Math.min(10000, contextWindow - reserveTokens - 2048) },
  branchSummary: { reserveTokens, skipPrompt: false },
  extensions: SETTINGS.extensions.filter(p => !p.endsWith("featherless-tool-bridge")).map(p => join(ROOT, p).replaceAll("\\", "/")),
  prompts: SETTINGS.prompts.map(p => join(PROFILE, p).replaceAll("\\", "/"))
 };
 if (process.platform !== "win32") delete settings.shellPath;
 return { model, models: config, settings, planContext, contextWindow, requestDigest: digest(model.request), piVersion: catalogue.piVersion };
}

export function profileFiles(profile) {
 return {
  "models.json": JSON.stringify(profile.models, null, 2) + "\n",
  "settings.json": JSON.stringify(profile.settings, null, 2) + "\n",
  "AGENTS.md": readFileSync(join(PROFILE, "AGENTS.md"), "utf8")
 };
}

export function executionDigests(profile) {
 const records = [];
 const collect = path => {
  assert.ok(!lstatSync(path).isSymbolicLink(), "Profile resources cannot be symbolic links");
  if (lstatSync(path).isDirectory()) {
   for (const name of readdirSync(path).sort()) if (name !== "node_modules" && !name.startsWith(".")) collect(join(path, name));
  } else if (/\.(ts|m?js|md)$|[\\/]package(-lock)?\.json$/.test(path)) {
   records.push([relative(ROOT, path).replaceAll("\\", "/"), digest(readFileSync(path, "utf8"))]);
  }
 };
 for (const path of [...profile.settings.extensions, ...profile.settings.prompts]) collect(path);
 const scripts = ["profile", "runner", "proxy", "fixtures", "test-reporter", "benchmark"];
 return { resourcesDigest: digest(records), harnessDigest: digest(scripts.map(name => readFileSync(join(ROOT, "scripts", "featherless-" + name + ".mjs"), "utf8"))) };
}

export function executionIdentity(profile, agentDir) {
 return { stage: inspectStage(agentDir, profile), ...executionDigests(profile) };
}

export function verifyExecution(profile, agentDir, expected) {
 assert.deepEqual(executionIdentity(profile, agentDir), expected, "Evaluation configuration or resources changed");
}

export function stageProfile(profile, destination, { candidate = false } = {}) {
 rejectCredentialMaterial(profile.models, "staged models");
 rejectCredentialMaterial(profile.settings, "staged settings");
 assert.ok(profile.model.status === "qualified" || candidate, "Candidate staging requires explicit --candidate");
 const target = resolve(destination);
 assert.ok(!existsSync(target), "Destination already exists; staging never replaces a configuration");
 const files = profileFiles(profile);
 mkdirSync(target, { recursive: false });
 for (const [name, text] of Object.entries(files)) writeFileSync(join(target, name), text, { flag: "wx", mode: 0o600 });
 const manifest = { schemaVersion: 1, kind: "pamwechete-staged-profile", modelId: profile.model.id, status: profile.model.status,
  piVersion: profile.piVersion, planContext: profile.planContext, contextWindow: profile.contextWindow, requestDigest: profile.requestDigest,
  files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, digest(text)])) };
 writeFileSync(join(target, "profile-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
 return manifest;
}

export function inspectStage(destination, expectedProfile) {
 const target = resolve(destination);
 const manifest = JSON.parse(readFileSync(join(target, "profile-manifest.json"), "utf8"));
 assert.equal(manifest.kind, "pamwechete-staged-profile", "Not a staged PamweChete profile");
 assert.equal(manifest.schemaVersion, 1, "Unknown staged profile version");
 assert.deepEqual(Object.keys(manifest.files).sort(), ["AGENTS.md", "models.json", "settings.json"], "Unexpected staged files");
 for (const [name, hash] of Object.entries(manifest.files)) {
  const file = join(target, name);
  assert.ok(!lstatSync(file).isSymbolicLink(), "Staged files cannot be links");
  const text = readFileSync(file, "utf8");
  assert.equal(digest(text), hash, "Staged file has changed");
  if (expectedProfile) assert.equal(text, profileFiles(expectedProfile)[name], "Staged configuration differs from the selected catalogue profile");
  if (name.endsWith(".json")) rejectCredentialMaterial(JSON.parse(text), "staged profile");
 }
 const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
 for (const resource of [...settings.extensions, ...settings.prompts]) assert.ok(existsSync(resource), "Staged resource is missing");
 if (settings.shellPath) assert.ok(existsSync(settings.shellPath), "Configured shell is missing");
 return manifest;
}

export function normaliseMetadata(data, expectedId) {
 assert.equal(data.id, expectedId, "Provider returned another model");
 assert.equal(data.status, "active", "Model is not active");
 assert.equal(data.features?.tool_use, true, "Provider does not advertise tool use");
 assert.ok(positiveInt(data.context_length) && positiveInt(data.max_completion_tokens), "Provider limits are invalid");
 const rate = (name) => {
  const v = data.pricing?.[name];
  return v === undefined || v === null || v === "" ? null : Number((Number(v) * 1_000_000).toPrecision(12));
 };
 const input = rate("prompt"), output = rate("completion");
 assert.ok([input, output].every(v => v === null || (Number.isFinite(v) && v >= 0)), "Provider prices are invalid");
 return { id: data.id, status: data.status, contextLength: data.context_length, maxCompletionTokens: data.max_completion_tokens, toolUse: true, pricing: { input, output } };
}

export async function checkProvider(model, fetcher = fetch) {
 const response = await fetcher(API + "/models/" + encodeURIComponent(model.id), { signal: AbortSignal.timeout(15000), redirect: "error", headers: { Accept: "application/json", "User-Agent": "PamweChete/1.0" } });
 assert.equal(response.status, 200, "Model lookup failed (HTTP " + response.status + ")");
 const reader = response.body.getReader();
 const chunks = []; let size = 0;
 try {
  while (true) {
   const { done, value } = await reader.read();
   if (done) break;
   size += value.byteLength;
   assert.ok(size <= 128 * 1024, "Model metadata response is too large");
   chunks.push(Buffer.from(value));
  }
 } finally { await reader.cancel(); }
 const current = normaliseMetadata(JSON.parse(Buffer.concat(chunks).toString("utf8")), model.id);
 const changed = ["contextLength", "maxCompletionTokens"].filter(k => current[k] !== model.metadata[k]);
 for (const k of ["input", "output"]) if (current.pricing[k] !== model.metadata.pricing[k]) changed.push("pricing." + k);
 return { key: model.key, checkedAt: new Date().toISOString(), current, changed, usable: changed.length === 0 };
}

export async function main(args = process.argv.slice(2)) {
 const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
  model: { type: "string" }, "plan-context": { type: "string" }, out: { type: "string" }, candidate: { type: "boolean" }
 }});
 const [command] = positionals;
 assert.equal(positionals.length, 1, "Choose validate, preview, check, stage or doctor");
 if (command === "doctor") {
  assert.ok(values.out, "Doctor needs --out with a staged directory");
  return inspectStage(values.out);
 }
 const catalogue = loadCatalogue();
 if (command === "validate") return { ok: true, models: catalogue.models.length, defaultModel: catalogue.defaultModel, piVersion: catalogue.piVersion };
 if (command === "check") return checkProvider(selectModel(catalogue, values.model));
 assert.ok(["preview", "stage"].includes(command), "Unknown profile command");
 const profile = buildProfile(catalogue, values.model, Number(values["plan-context"]));
 if (command === "preview") return profile;
 assert.ok(values.out, "Stage needs --out with a new directory");
 return stageProfile(profile, values.out, { candidate: values.candidate });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try {
  const result = await main();
  console.log(JSON.stringify(result, null, 2));
  if (result.usable === false) process.exitCode = 1;
 } catch (error) { console.error("FEATHERLESS_PROFILE_INVALID: " + safeMessage(error)); process.exitCode = 1; }
}
