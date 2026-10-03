import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, realpathSync, rmSync, lstatSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, relative, sep } from "node:path";
import { digest } from "./featherless-profile.mjs";

export function temporaryWorkspace(prefix) {
 assert.match(prefix, /^pamwechete-[a-z-]+-$/);
 const parent = realpathSync(tmpdir()), root = mkdtempSync(join(parent, prefix));
 return { root, remove() {
  const target = realpathSync(root);
  assert.ok(dirname(target) === parent && basename(target).startsWith(prefix), "Temporary cleanup escaped its parent");
  rmSync(target, { recursive: true, force: true });
 } };
}

export function piRuntime(cliPath) {
 assert.ok(/\.m?js$/.test(cliPath), "--pi must point to Pi's JavaScript CLI");
 const entry = realpathSync(cliPath);
 for (let dir = dirname(entry), depth = 0; depth < 4; depth++, dir = dirname(dir)) {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent") continue;
  const entryPoint = relative(dir, entry).split(sep).join("/");
  assert.ok(entryPoint.startsWith("dist/"), "Fingerprinting requires Pi's compiled dist entry point");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/, "Invalid Pi package version");
  const records = [];
  let bytes = 0;
  const hashFile = path => {
   const stat = lstatSync(path);
   assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Runtime files must be regular files");
   bytes += stat.size;
   assert.ok(bytes <= 256 * 1024 * 1024 && records.length < 10000, "Runtime fingerprint exceeds its size limit");
   records.push([relative(dir, path).split(sep).join("/"), createHash("sha256").update(readFileSync(path)).digest("hex")]);
  };
  const visit = path => {
   for (const item of readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    // Inspect only shipped executable code, never authentication or session stores.
    if (item.name.startsWith(".") || item.name === "node_modules") continue;
    const child = join(path, item.name);
    assert.ok(!item.isSymbolicLink(), "Runtime links are not supported");
    if (item.isDirectory()) visit(child);
    else if (/\.(?:[cm]?js|node|wasm|exe|dll|so|dylib)$/.test(item.name)) hashFile(child);
   }
  };
  assert.ok(!lstatSync(join(dir, "dist")).isSymbolicLink(), "Runtime links are not supported");
  visit(join(dir, "dist"));
  assert.ok(records.some(([path]) => path === entryPoint), "Pi entry point was not fingerprinted");
  hashFile(manifest);
  if (existsSync(join(dir, "npm-shrinkwrap.json"))) hashFile(join(dir, "npm-shrinkwrap.json"));
  const runtime = { schemaVersion: 1, packageName: pkg.name, version: pkg.version, entryPoint,
   codeDigest: digest(records), fileCount: records.length,
   sourceRevision: /^[a-f0-9]{40}$/i.test(pkg.gitHead ?? "") ? pkg.gitHead : null,
   nodeVersion: process.version, platform: process.platform, arch: process.arch };
  return { ...runtime, digest: digest(runtime) };
 }
 throw new Error("Cannot identify the Pi package");
}

export async function terminatePi(child, agentDir) {
 if (child.exitCode !== null || child.signalCode !== null) return;
 let closed = false;
 const closedPromise = new Promise(done => child.once("close", () => { closed = true; done(); }));
 let treeStopped = true;
 if (process.platform === "win32" && child.pid) {
  treeStopped = await new Promise(done => {
   const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", env: cleanEnvironment(agentDir) });
   const timer = setTimeout(() => { killer.kill(); done(false); }, 3000);
   killer.once("error", () => { clearTimeout(timer); done(false); });
   killer.once("close", code => { clearTimeout(timer); done(code === 0); });
  });
  if (!treeStopped) child.kill("SIGKILL");
 } else {
  try { process.kill(-child.pid, "SIGKILL"); }
  catch (error) { treeStopped = error.code === "ESRCH"; if (!treeStopped) child.kill("SIGKILL"); }
 }
 let timer;
 try { await Promise.race([closedPromise, new Promise(done => { timer = setTimeout(done, 2000); })]); }
 finally { clearTimeout(timer); }
 if (!closed || !treeStopped) {
  child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
  throw new Error("Pi process-tree termination could not be established");
 }
}

export function cleanEnvironment(agentDir) {
 const env = { PI_CODING_AGENT_DIR: agentDir, PI_TELEMETRY: "0", NO_COLOR: "1" };
 for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "ComSpec", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
 }
 return env;
}

export function eventMetrics() {
 return { messages: 0, toolCalls: 0, toolErrors: 0, repeatedCalls: 0, retries: 0, compactions: 0,
  truncated: 0, providerErrors: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  usageKnown: true, settled: false, firstResponseMs: null, stopReasons: [] };
}

export function consumeEvent(metrics, event, elapsedMs, state) {
 if (event.type === "message_update" && metrics.firstResponseMs === null) metrics.firstResponseMs = elapsedMs;
 if (event.type === "tool_execution_start") {
  metrics.toolCalls++;
  const key = digest([event.toolName, event.args]);
  metrics.repeatedCalls += state.calls.has(key) ? 1 : 0;
  state.calls.add(key);
 }
 if (event.type === "tool_execution_end" && event.isError) metrics.toolErrors++;
 if (event.type === "auto_retry_start") metrics.retries++;
 if (event.type === "compaction_start") metrics.compactions++;
 if (event.type === "agent_settled") metrics.settled = true;
 if (event.type !== "message_end" || event.message?.role !== "assistant") return;
 metrics.messages++;
 const msg = event.message;
 if (metrics.firstResponseMs === null) metrics.firstResponseMs = elapsedMs;
 const reason = msg.stopReason;
 if (!metrics.stopReasons.includes(reason)) metrics.stopReasons.push(reason);
 if (reason === "length") metrics.truncated++;
 if (reason === "error" || reason === "aborted") metrics.providerErrors++;
 const usage = msg.usage;
 const counts = usage && [usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0];
 if (!counts || !counts.every(n => Number.isSafeInteger(n) && n >= 0) || counts.reduce((a,b)=>a+b,0) === 0) {
  metrics.usageKnown = false;
 } else {
  metrics.inputTokens += usage.input; metrics.outputTokens += usage.output;
  metrics.cacheReadTokens += usage.cacheRead ?? 0; metrics.cacheWriteTokens += usage.cacheWrite ?? 0;
 }
}

export async function runPi({ cliPath, cwd, agentDir, prompt, timeoutMs = 120000, maxTurns = 24, maxOutputTokens = 32768, extraArgs = [], onEvent, onDiagnostic }) {
 assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 900000, "Invalid task deadline");
 assert.ok(Number.isSafeInteger(maxTurns) && maxTurns > 0 && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0, "Invalid task limits");
 const started = Date.now(), metrics = eventMetrics(), state = { calls: new Set() };
 const args = [cliPath, "--mode", "json", "--no-session", "--no-skills", "--no-themes", "--no-context-files",
  "--append-system-prompt", join(agentDir, "AGENTS.md"), ...extraArgs, prompt];
 const child = spawn(process.execPath, args, { cwd, env: cleanEnvironment(agentDir), windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
 let pending = "", bytes = 0, diagnosticBytes = 0, reason = null, killed = false, termination;
 let finishAbort;
 const aborted = new Promise(done => { finishAbort = done; });
 const abort = (why) => {
  if (killed) return;
  killed = true; reason = why;
  termination = terminatePi(child, agentDir).catch(() => { reason = "termination_failed"; })
   .finally(() => finishAbort({ code: null, signal: null }));
 };
 const timer = setTimeout(() => abort("deadline"), timeoutMs);
 child.stdout.setEncoding("utf8");
 child.stdout.on("data", (chunk) => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 32 * 1024 * 1024) return abort("event_output_limit");
  pending += chunk;
  let end;
  while ((end = pending.indexOf("\n")) >= 0) {
   const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1);
   if (!line) continue;
   try {
    const event = JSON.parse(line);
    consumeEvent(metrics, event, Date.now() - started, state);
    onEvent?.(event);
    if (metrics.messages >= maxTurns && event.type === "message_end" && event.message?.stopReason !== "stop") abort("turn_limit");
    if (metrics.outputTokens > maxOutputTokens) abort("token_limit");
   } catch { abort("invalid_event_stream"); }
  }
  if (pending.length > 1024 * 1024) abort("event_line_limit");
 });
 child.stderr.on("data", chunk => { diagnosticBytes += chunk.length; if (diagnosticBytes > 1024 * 1024) abort("diagnostic_limit"); else onDiagnostic?.(chunk.toString("utf8")); });
 const exit = await Promise.race([aborted, new Promise((done) => {
  child.once("error", () => { reason = "launch_failed"; done({ code: null, signal: null }); });
  child.once("close", (code, signal) => done({ code, signal }));
 })]);
 clearTimeout(timer);
 await termination;
 if (pending.trim()) reason ??= "incomplete_event_stream";
 if (metrics.messages === 0) metrics.usageKnown = false;
 return { ...metrics, elapsedMs: Date.now() - started, exitCode: exit.code, signal: exit.signal, failure: reason, diagnosticBytes };
}
