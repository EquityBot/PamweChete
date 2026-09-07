# Pi RTK and Qwen Optimisation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce Pi's Bash and bridge prompt token load without weakening the proven Featherless Qwen coding profile or command-safety boundary.

**Architecture:** A pinned, explicitly loaded RTK hook rewrites supported Bash commands after `bash-guard` has approved the original command. The bridge gains a non-mutating annotation-only schema compactor selected by a controlled environment toggle, and live/offline benchmarks decide whether compact mode becomes the default. Repository and runtime verifiers protect the exact model, extension order, credential boundary and rollback.

**Tech Stack:** Pi 0.84.3 TypeScript extensions, Node.js 24 built-in test runner, PowerShell 7, Git for Windows, RTK 0.46.0, Featherless OpenAI-compatible completions API.

**Spec:** `docs/superpowers/specs/2026-08-28-pi-rtk-qwen-optimisation-design.md`

## Global Constraints

- Keep `featherless/OBLITERATUS/Qwen3.8-27B-OBLITERATED` as the only enabled default model.
- Keep the 32,768 context window, 4,096 output limit, temperature 0, repetition penalty 1.15, expanded eight-tool surface, bounded retries and existing compaction values.
- Use RTK v0.46.0 and the exact official hook from `rtk-ai/rtk` commit `322db4da98219b15608d5b71eddf6338c48d693c`.
- Load `bash-guard` before `rtk`; every state-changing Git command must still prompt.
- Keep RTK telemetry disabled and do not run `rtk init`.
- Compact schemas may become default only after perfect live eligibility and lower prompt-token use.
- Keep all credential values outside source, fixtures, reports and terminal output.
- Keep optional memory and subagent extensions out of the default profile.
- Do not push or otherwise publish the optimisation without explicit user authority.

---

### Task 1: Portable Profile Verification

**Files:**
- Modify: `tests/verify-featherless-qwen-profile.test.mjs`
- Modify: `scripts/verify-featherless-qwen-profile.mjs`

**Interfaces:**
- Consumes: absolute Windows paths in `profiles/featherless-qwen38/settings.windows.json`.
- Produces: `assertConfiguredResourceSet(actual, expectedRelativePaths, label)` that infers one configured root, rejects escapes and verifies existing resources independently of the verifier checkout.

- [ ] **Step 1: Write the failing portability and escape tests**

Add a fixture option that points extensions and prompts at a second temporary resource tree. Assert that the verifier accepts that valid external tree, then replace one extension path with a sibling escape and assert rejection:

```js
test("accepts a profile whose absolute resources belong to another valid clone", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "pi-profile-portable-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const { profile, configuredRoot } = createPortableProfile(parent);
  const result = runVerifier(profile);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /FEATHERLESS_QWEN_PROFILE_OK/);
  assert.notEqual(configuredRoot, ROOT);
});

test("rejects a configured resource that escapes its inferred clone root", (context) => {
  const parent = mkdtempSync(join(tmpdir(), "pi-profile-escape-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const { profile } = createPortableProfile(parent);
  replaceConfiguredExtension(profile, 2, join(parent, "outside", "index.ts"));
  const result = runVerifier(profile);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /approved resource tree/i);
});
```

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `node --test --test-name-pattern="another valid clone|escapes its inferred" tests\verify-featherless-qwen-profile.test.mjs`

Expected: the valid external-clone test fails because the current verifier requires paths inside its own `ROOT`; the escape test must fail for the intended policy reason after its positive-control fixture is corrected.

- [ ] **Step 3: Implement inferred-root resource validation**

Replace checkout-bound absolute-path comparison with a relative-set validator. Infer the root from `extensions/ask-user-question.ts`, require every configured extension and prompt under that same root, verify exact relative paths and existence, and keep canonical Windows comparison:

```js
const EXPECTED_EXTENSIONS = [
  "extensions/ask-user-question.ts",
  "extensions/bash-guard",
  "extensions/rtk",
  "extensions/featherless-tool-bridge",
  "extensions/custom-header.ts",
  "extensions/prompt-snippets",
];

function configuredRootFromFirstExtension(paths) {
  const first = resolveAbsoluteConfigPath(paths[0], "extensions[0]");
  return resolve(dirname(first), "..");
}
```

Normalise relative paths to `/`, reject `..` and absolute relative results, and compare the full ordered set. Validate prompts as `profiles/featherless-qwen38/prompts/implement.md` and `profiles/featherless-qwen38/prompts/verify.md` under the same configured root.

- [ ] **Step 4: Run all profile tests and CLI verification**

Run: `node --test tests\verify-featherless-qwen-profile.test.mjs`

Run: `node scripts\verify-featherless-qwen-profile.mjs profiles\featherless-qwen38`

Expected: all tests pass and the CLI prints `FEATHERLESS_QWEN_PROFILE_OK` from the linked worktree.

- [ ] **Step 5: Commit the portable verifier**

```powershell
git add tests/verify-featherless-qwen-profile.test.mjs scripts/verify-featherless-qwen-profile.mjs
git commit -m "fix: verify profiles across linked worktrees"
```

### Task 2: Bash Guard Safety and Prompt Precision

**Files:**
- Modify: `extensions/bash-guard/test/policy.test.mjs`
- Create: `extensions/bash-guard/test/prompt-timeout.test.mjs`
- Modify: `extensions/bash-guard/policy.ts`
- Create: `extensions/bash-guard/prompt-timeout.ts`
- Modify: `extensions/bash-guard/index.ts`
- Modify: `extensions/bash-guard/package.json`
- Modify: `extensions/bash-guard/README.md`

**Interfaces:**
- Consumes: `analyzeBashCommand(command, { cwd })` and RTK-prefixed Git command strings.
- Produces: `armFailClosedPromptTimeout(done, timeoutMs, timers)` returning a single-settlement callback; `PromptChoice = "run" | "abort" | "timeout"`.

- [ ] **Step 1: Write failing RTK Git and redirection policy tests**

Add literal table tests proving `rtk git status` is read-only, `rtk git add/commit/push` prompts, RTK-prefixed force/reset/clean forms are high-risk or blocked, null/fd/new-file redirects are allowed, and existing-file overwrite/append prompts. Use one temporary directory with a real existing file and pass it as `cwd`.

- [ ] **Step 2: Run the policy tests and verify RED**

Run: `npm test -- --test-name-pattern="RTK-prefixed|redirection"`

Expected: RTK mutations are not classified as Git changes, and the current blanket redirection rule prompts for null and new-file targets.

- [ ] **Step 3: Implement minimal policy changes**

Unwrap only a leading `rtk git` command for Git policy analysis. For blocked-mode regular expressions, evaluate a normalised command in which command-segment `rtk git` prefixes become `git`. Add a redirection analyser that permits literal null/fd targets and absent literal files, but reports existing, ambiguous or expanded destinations. Preserve parse failure as medium risk.

- [ ] **Step 4: Run policy tests and verify GREEN**

Run: `npm test`

Expected: all policy tests pass with no warnings.

- [ ] **Step 5: Write failing timeout tests**

```js
test("timeout settles once with the fail-closed choice", () => {
  const choices = [];
  let fire;
  const settle = armFailClosedPromptTimeout(
    (choice) => choices.push(choice),
    120_000,
    { setTimeout: (callback) => { fire = callback; return 1; }, clearTimeout: () => {} },
  );
  fire();
  settle("run");
  assert.deepEqual(choices, ["timeout"]);
});

test("an explicit choice cancels the timeout path", () => {
  const choices = [];
  let fire;
  const cleared = [];
  const settle = armFailClosedPromptTimeout(
    (choice) => choices.push(choice),
    120_000,
    { setTimeout: (callback) => { fire = callback; return 7; }, clearTimeout: (id) => cleared.push(id) },
  );
  settle("abort");
  fire();
  assert.deepEqual(choices, ["abort"]);
  assert.deepEqual(cleared, [7]);
});
```

- [ ] **Step 6: Run timeout tests and verify RED**

Run: `node --test extensions\bash-guard\test\prompt-timeout.test.mjs`

Expected: assertion failure because `armFailClosedPromptTimeout` is not implemented.

- [ ] **Step 7: Implement and wire the timeout**

Implement a single-settlement callback with injected real timers by default. Arm it inside `ctx.ui.custom`, route selection and cancel through it, return `timeout` distinctly, and block with a timeout-specific reason. Set `PROMPT_TIMEOUT_MS` to `120_000` and include the timeout in the unchanged-command suppression.

- [ ] **Step 8: Run all Bash guard tests and commit**

Run: `npm test`

```powershell
git add extensions/bash-guard
git commit -m "feat: harden guarded RTK command handling"
```

### Task 3: Pinned RTK Extension

**Files:**
- Create: `extensions/rtk/test/rtk.test.mjs`
- Create: `extensions/rtk/index.ts`
- Create: `extensions/rtk/package.json`
- Create: `extensions/rtk/README.md`
- Create: `extensions/rtk/LICENSE`
- Modify: `profiles/featherless-qwen38/settings.windows.json`
- Modify: `tests/verify-featherless-qwen-profile.test.mjs`

**Interfaces:**
- Consumes: Pi `tool_call` events and `pi.exec("rtk", ["rewrite", command], options)`.
- Produces: an extension that mutates `event.input.command` only for successful RTK rewrite exit codes 0 or 3 and otherwise passes through.

- [ ] **Step 1: Write failing extension behaviour tests**

Use a complete fake Pi boundary whose `exec` returns `rtk 0.46.0` for the version probe. Assert the registered real handler mutates a Bash event from `git status --short` to the returned `rtk git status --short`; assert non-Bash, `RTK_DISABLED=1`, old version, killed rewrite and nonzero rewrite leave input unchanged.

- [ ] **Step 2: Run the extension test and verify RED**

Run: `node --test extensions\rtk\test\rtk.test.mjs`

Expected: assertion failure that the extension export is unavailable.

- [ ] **Step 3: Vendor the exact official hook and attribution**

Create `index.ts` byte-for-byte from `hooks/pi/rtk.ts` at commit `322db4da98219b15608d5b71eddf6338c48d693c`. Add a private extension manifest:

```json
{
  "name": "pi-rtk-output-compression",
  "private": true,
  "type": "module",
  "scripts": { "test": "node --test ./test/*.test.mjs" },
  "pi": { "extensions": ["./index.ts"] }
}
```

Add the upstream Apache-2.0 licence verbatim. Document repository, commit, release, minimum RTK version, explicit load ordering, `RTK_DISABLED=1`, telemetry state and the rule that local rewrite logic is not added to the hook.

- [ ] **Step 4: Verify behaviour and pinned bytes**

Run: `npm test` from `extensions/rtk`.

Compute the local SHA-256 and compare it with the decoded GitHub API content for the pinned commit. Expected: identical hashes.

- [ ] **Step 5: Add RTK after Bash guard in the reusable profile**

Insert `C:/Users/-/Documents/Repos/PamweChete/extensions/rtk` immediately after the Bash guard path. Update the profile fixture and expected ordered set so moving RTK before the guard fails verification.

- [ ] **Step 6: Run profile and extension tests, then commit**

Run: `node --test tests\verify-featherless-qwen-profile.test.mjs`

Run: `node scripts\verify-featherless-qwen-profile.mjs profiles\featherless-qwen38`

Run: `npm test` from `extensions/rtk`.

```powershell
git add extensions/rtk profiles/featherless-qwen38/settings.windows.json tests/verify-featherless-qwen-profile.test.mjs
git commit -m "feat: add pinned RTK output compression"
```

### Task 4: Compact Bridge Schema Candidate

**Files:**
- Modify: `extensions/featherless-tool-bridge/test/protocol.test.mjs`
- Modify: `extensions/featherless-tool-bridge/protocol.ts`
- Modify: `extensions/featherless-tool-bridge/index.ts`
- Modify: `extensions/featherless-tool-bridge/README.md`

**Interfaces:**
- Produces: `compactToolSchema(value): unknown`, `bridgeSchemaMode(env): "full" | "compact"`, and `buildBridgeSystemPrompt(tools, { compactSchemas })`.

- [ ] **Step 1: Write failing compaction tests**

Use a literal nested schema containing annotation and validation keywords. Assert that compact output removes only the approved annotations, keeps `required`, bounds, pattern, enum, `$ref`, `$id` and `$schema`, leaves the input deeply equal to a saved literal, and produces a shorter serialised prompt. Test environment values `0`, `1`, invalid and unset without changing `process.env` globally.

- [ ] **Step 2: Run the targeted tests and verify RED**

Run: `npm test -- --test-name-pattern="compact|schema mode"`

Expected: assertion failure because the compactor and mode selector do not exist.

- [ ] **Step 3: Implement the pure compactor and candidate toggle**

Recursively copy arrays and plain objects. Skip exactly `description`, `title`, `examples`, `default`, `$comment`, `deprecated`, `readOnly` and `writeOnly`; copy every other key. `bridgeSchemaMode` accepts only `0` and `1`, uses the benchmark-selected default constant for unset/invalid values, and never mutates its input.

- [ ] **Step 4: Pass the candidate mode into prompt construction**

In `before_agent_start`, compute the mode once and call:

```ts
buildBridgeSystemPrompt(toolInfo, { compactSchemas: bridgeSchemaMode(process.env) === "compact" })
```

Keep target-model scoping, active-tool filtering and all message/prototype-pollution validation unchanged.

- [ ] **Step 5: Run all bridge tests and commit the candidate**

Run: `npm test`

```powershell
git add extensions/featherless-tool-bridge
git commit -m "feat: add benchmarkable compact tool schemas"
```

### Task 5: Controlled Benchmark and Winner Selection

**Files:**
- Create: `work/run-pi-optimisation-benchmark.test.mjs`
- Create: `work/run-pi-optimisation-benchmark.mjs`
- Create: `work/benchmark-rtk-output.mjs`
- Create: `work/verify-pi-optimisation.mjs`
- Create: `outputs/pi-optimisation-benchmark-report.json`
- Create: `outputs/rtk-output-benchmark.json`

**Interfaces:**
- Produces: `selectBridgeWinner(candidates)` and safe reports containing no environment values or credentials.
- Consumes: the existing `runPi` JSON runner and `work/fixtures/pi-smoke` oracles.

- [ ] **Step 1: Write failing winner-selection and path-boundary tests**

Assert that an ineligible compact candidate cannot win, an eligible compact candidate with fewer prompt tokens wins, an exact tie keeps full schemas, and report paths outside `outputs` are rejected. Hand-derive fixture totals rather than using the selector under test.

- [ ] **Step 2: Run the benchmark harness tests and verify RED**

Run: `node --test work\run-pi-optimisation-benchmark.test.mjs`

Expected: assertion failure because the selector and safe report resolver are unavailable.

- [ ] **Step 3: Implement the benchmark harness**

Run the existing description, seeded repair and multi-step termination tasks once with full schemas and once with compact schemas, always with the expanded tool set and RTK enabled. Record both candidates in one versioned report. Eligibility requires every fixture to pass with zero invalid calls, zero repeated identical calls, zero routing repetition, zero malformed lines and no runner errors. Select by reliability, then tool calls, then prompt tokens; exact ties select `full`.

- [ ] **Step 4: Implement the controlled RTK output benchmark**

Create a temporary Git repository inside the system temp directory, validate the resolved deletion target before cleanup, seed tracked modifications and at least 150 untracked files, ask `rtk rewrite` for supported Git commands, run original and rewritten commands in the same repository, and verify both outputs retain the changed tracked filename and untracked count/facts. Require rewritten bytes to be less than original bytes and record only counts, commands and semantic booleans.

- [ ] **Step 5: Run tests, baseline and live A/B**

Run: `node --test work\run-pi-optimisation-benchmark.test.mjs`

Run: `node work\benchmark-rtk-output.mjs`

Run: `node work\run-pi-optimisation-benchmark.mjs`

Expected: both live candidates are eligible; the selector records one winner; RTK output is smaller with required facts preserved.

- [ ] **Step 6: Apply the measured bridge default**

If and only if the report names `compact`, change the bridge's unset-value default to compact with a failing default-mode test first. Otherwise retain full. Re-run bridge tests and the benchmark report verifier.

### Task 6: Verified RTK Install and Runtime Deployment

**Files:**
- Modify: `work/verify-pi-optimisation.mjs`
- Modify: `C:\Users\-\.pi\agent\settings.json`
- Create: a fresh timestamped directory under `C:\Users\-\Documents\Pi Backups`

**Interfaces:**
- Consumes: release `checksums.txt`, `rtk-x86_64-pc-windows-msvc.zip`, verified local Git commits and the benchmark winner.
- Produces: `rtk.exe` v0.46.0 on PATH, disabled telemetry, permanent-clone extension paths and a verified rollback manifest.

- [ ] **Step 1: Add failing installation/runtime verifier tests**

The verifier must require exact RTK version 0.46.0, disabled telemetry, hook after Bash guard, benchmark-selected bridge default, unchanged Featherless model settings, a recoverable backup and no key-like material in reports/source. Run it before installation and confirm it fails specifically because RTK is absent or the extension is not deployed.

- [ ] **Step 2: Download and checksum RTK**

Download `checksums.txt` and `rtk-x86_64-pc-windows-msvc.zip` from GitHub release v0.46.0 into a newly created system-temp directory. Parse the manifest, compute SHA-256 independently with `Get-FileHash`, and stop on mismatch. Extract only after the target paths resolve inside that temp directory.

- [ ] **Step 3: Install and disable telemetry**

Place `rtk.exe` in an existing per-user PATH directory without replacing another binary. Run `rtk --version`, `rtk telemetry disable`, then `rtk telemetry status`. Expected: version 0.46.0 and disabled telemetry. Do not invoke `rtk init`.

- [ ] **Step 4: Back up the live Pi runtime**

Run: `pwsh -NoProfile -File work\backup-pi-runtime.ps1`

Expected: `PI_BACKUP_OK`, a new non-overwritten backup path, a non-empty SHA-256 manifest and ACLs restricted to the current user and SYSTEM.

- [ ] **Step 5: Integrate verified commits into permanent local main**

After fresh repository tests, use the finishing-branch workflow to fast-forward local `main` from the optimisation branch. Do not push. Verify the permanent clone is clean and the optimisation branch is an ancestor of `main`.

- [ ] **Step 6: Deploy settings from the permanent clone**

Update `~/.pi/agent/settings.json` so its extension order is ask-question, Bash guard, RTK, Featherless bridge, header and prompt snippets, all under `C:/Users/-/Documents/Repos/PamweChete`. Preserve every unrelated runtime setting and select only the benchmark winner's bridge default.

- [ ] **Step 7: Run installation and runtime verification**

Run: `node work\verify-pi-optimisation.mjs runtime`

Expected: `PI_OPTIMISATION_RUNTIME_OK` without printing credential content.

### Task 7: Full Verification and Handoff

**Files:**
- Modify: `work/GATES-rtk-optimisation.md`
- Modify: `outputs/pi-setup-summary.md`
- Modify: `C:\agent-hub\tasks\pi-featherless-qwen-setup.md`

**Interfaces:**
- Consumes: all repository tests, dependency audits, live smoke, benchmark reports, runtime state and Git ancestry.
- Produces: fresh gate evidence and a concise local-ready handoff that explicitly identifies the unpushed commit.

- [ ] **Step 1: Run repository regression tests and audits**

Run all Bash guard, RTK, bridge and profile tests. Run `npm audit --audit-level=high` in every active extension with a lockfile. Run the profile CLI verifier from both linked worktree and permanent clone.

- [ ] **Step 2: Run live repair smoke on deployed runtime**

Run: `node work\run-pi-live-smoke.mjs`

Expected: `PI_LIVE_SMOKE_OK`, zero invalid calls, zero repeated identical calls and a passing seeded repair oracle.

- [ ] **Step 3: Inspect and approve every completion oracle**

Run `gate-check.mjs --status`, read every `CHECK`, `EXPECT`, resolved working directory, called verifier and environment boundary, then run `gate-lint.mjs`. Execute with `--approve` only after this inspection.

- [ ] **Step 4: Reverify all gates from fresh state**

Run `gate-check.mjs --reverify` after the final source/runtime bytes are fixed. Expected: every gate met, no abandonment and no unmet manual gate.

- [ ] **Step 5: Inspect final Git and runtime state**

Require a clean permanent `main`, clean linked worktree or safely removed worktree, local `main` descended from unchanged `origin/main`, exact model/runtime settings and a valid backup. Record that publication remains unauthorised unless the user separately asks for a push.

- [ ] **Step 6: Update durable handoff and report**

Update the Agent Hub task with exact commit, test/gate counts, benchmark figures, RTK version/telemetry state, backup path and the one optional next action: push the verified local commit if explicitly authorised.
