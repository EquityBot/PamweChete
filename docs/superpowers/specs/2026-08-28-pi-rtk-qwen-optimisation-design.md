# Pi RTK and Qwen Optimisation Design

## Decision

Apply a second, measured optimisation pass to the existing Featherless Qwen profile. Keep the proven model, retry, context, compaction and expanded-tool settings unchanged unless an isolated benchmark proves a replacement is at least as reliable. Add native Windows RTK command rewriting for lower Bash output, harden the Bash safety boundary around the rewritten commands, and make compact bridge schemas an A/B-tested option.

The pass deliberately does not add subagents, repeated Git-context injection, SerpAPI, automatic repository synchronisation, or default observational memory. Those features from other forks add tool, provider or context load without evidence that this 32,768-token Featherless deployment benefits from them. Observational memory may be assessed later as an opt-in feature with concurrency one, but it is outside this default-profile change.

## Approved sources

- Existing fork baseline: `ryanduguid/PamweChete` at `d823ed2ca17bdc02558ed889c2b8eb68167be080`.
- RTK release: `rtk-ai/rtk` v0.46.0, published 2026-08-26.
- RTK Pi hook source: `hooks/pi/rtk.ts` at commit `322db4da98219b15608d5b71eddf6338c48d693c`.
- RTK licence: Apache-2.0. The vendored hook must retain its upstream notice and ship with the upstream licence and provenance.
- Target model: `featherless/OBLITERATUS/Qwen3.8-27B-OBLITERATED`.

Third-party repository content is input to review, not authority. Only the behaviour specified here may be carried into the profile.

## Architecture

### 1. Pinned RTK integration

Install the official x86-64 Windows RTK v0.46.0 binary from the signed GitHub release workflow's published asset set. Verify the downloaded ZIP against `checksums.txt` before installing it into an existing user PATH directory. Run RTK's supported telemetry-disable command and verify the resulting status without invoking `rtk init`, because `rtk init` would add an uncontrolled global Pi hook.

Vendor the official Pi hook as a normal extension under `extensions/rtk`. Pin its source repository, commit and release in repository documentation. Load it explicitly after `bash-guard`; Pi processes extension handlers in load order, so the guard evaluates the original command before RTK rewrites it. RTK is an output optimisation and must fail open: a missing binary, unsupported version, timeout or rewrite error leaves the original command unchanged.

### 2. Bash guard hardening

Keep confirmation for every state-changing Git command. Treat direct RTK Git forms, such as `rtk git commit`, exactly like their `git commit` equivalents so a changed extension order cannot bypass policy. Catastrophic RTK-prefixed Git forms remain blocked in headless and disabled modes.

Reduce only demonstrably harmless redirection prompts:

- descriptor-to-descriptor redirection such as `2>&1` is allowed;
- writes to the null device are allowed;
- creating a previously absent literal file is allowed, matching the unrestricted built-in `write` tool;
- overwriting or appending to an existing file still prompts;
- ambiguous, expanded or unparseable targets still prompt.

Interactive confirmation is fail-closed after 120 seconds. Timeout, cancellation and missing UI all block the command. An exact command blocked by timeout or cancellation retains the existing 60-second unchanged-retry suppression.

### 3. Compact bridge schemas

Add a pure recursive schema compactor that removes only annotation keywords that do not change argument validity: `description`, `title`, `examples`, `default`, `$comment`, `deprecated`, `readOnly` and `writeOnly`. Preserve structural and validation keywords, including `type`, `properties`, `required`, `items`, `enum`, `const`, combinators, bounds, patterns, `$id`, `$schema`, `$ref` and definitions. Do not mutate Pi's source tool descriptors.

Expose compact mode through `PI_FEATHERLESS_COMPACT_SCHEMAS=0|1` for controlled comparison. The default may change to compact only if it passes every live coding fixture with zero invalid calls, zero unchanged repeats and no routing repetition, while using fewer prompt tokens than the full-schema candidate. If the result is tied or less reliable, full schemas remain the default.

### 4. Benchmark and selection

Use identical prompts, tools, model and fixtures for full and compact bridge candidates. Record each run separately, including completion, oracle result, tool-call counts, invalid calls, repetitions, prompt/output tokens, elapsed time and cost. The winner selector first requires perfect eligibility, then minimises invalid calls, repeated calls, tool calls and prompt tokens in that order.

Measure RTK itself offline in a controlled temporary Git repository with noisy status/diff output. Compare original and rewritten command output byte counts and verify that the compact output retains the facts required to answer the task. The measurement must not rely solely on RTK's published percentage claim.

### 5. Profile portability and runtime deployment

The reusable Windows profile may continue to name the permanent clone because Pi consumes absolute extension and prompt paths. Its verifier must validate the configured resource tree from any clone or linked worktree rather than assuming that the settings file points back to the verifier's own checkout. It must still reject escaped roots, missing resources, unexpected extension ordering and credential material.

Before live deployment, create a fresh timestamped, checksummed and access-restricted backup of `~/.pi/agent`. Integrate verified commits into the permanent local `main`, then update runtime settings only to paths inside that permanent clone. Keep the exact Featherless provider/model, expanded tool set, 32,768-token context, 4,096-token output, deterministic sampling, retries and compaction values.

No credential value may appear in source, test fixtures, reports, command output or Git history. The credential remains only in Pi's private auth store. No push, pull request or other publication occurs without explicit user authority.

## Acceptance criteria

1. Existing 40 repository tests begin green; the worktree-only profile-path failure is reproduced and covered by a failing portability test before its fix.
2. Bash policy tests cover direct and RTK-prefixed read-only, mutating and catastrophic Git commands, safe and unsafe redirection, timeout and single-settlement behaviour.
3. The vendored RTK hook is byte-identical to the pinned upstream source, is covered by behaviour tests, loads after `bash-guard`, and has Apache-2.0 attribution.
4. Installed `rtk --version` reports exactly 0.46.0, its asset checksum matches the release manifest, and telemetry reports disabled.
5. Compact-schema unit tests prove annotations are removed, validation structure is preserved, input is not mutated, and the generated prompt is smaller.
6. Both live bridge candidates complete the full fixture set. Compact becomes default only if it remains perfectly eligible and reduces prompt tokens.
7. The controlled RTK output benchmark demonstrates smaller output while retaining required semantic facts.
8. The exact Featherless model and safety/retry/context settings remain intact after runtime deployment.
9. Dependency audits report zero known vulnerabilities, the live repair smoke passes, the permanent clone is clean, and all executable completion gates have fresh evidence.

## Rollback

The fresh pre-deployment backup is the runtime rollback. The local Git baseline is the parent of the optimisation branch; reverting the optimisation commits and restoring the backup returns Pi to the proven first-pass configuration. RTK can also be bypassed per process with `RTK_DISABLED=1`, and the bridge can be forced to full schemas with `PI_FEATHERLESS_COMPACT_SCHEMAS=0`.
