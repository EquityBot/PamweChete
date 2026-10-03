# Featherless model selection

Use this workflow to compare models covered by [Abliterlitics](https://abliterlitics.dev/)
in Pi through Featherless. The catalogue contains candidates to test. It has no
default. Ryan supplied the DavidAU model below as his current baseline on
26 September 2026; the other entries are alternatives to test.

Abliterlitics supplies screening evidence. Its raw completion evaluations do not
establish whether a model completes coding work through Pi's tools. Qualification
requires repeated live fixtures and review of the resulting evidence.

## Candidate catalogue

Public Featherless metadata was checked on 26 September 2026. These exact IDs
advertised native tool use and a 32,768-token context. Provider revisions were not
available. Availability and prices can change, so the live runner checks them again.

| Catalogue key | Featherless model ID | Abliterlitics source |
| --- | --- | --- |
| `qwen38-trohrbaugh` | `trohrbaugh/Qwen3.8-27B-heretic-ara` | [Qwen3.8 27B](https://abliterlitics.dev/models/qwen38-27b/) |
| `qwen38-coder3101` | `coder3101/Qwen3.8-27B-heretic` | [Qwen3.8 27B](https://abliterlitics.dev/models/qwen38-27b/) |
| `gemma4-trevorjs` | `TrevorJS/gemma-4-12B-it-uncensored` | [Gemma 4 12B](https://abliterlitics.dev/models/gemma4-12b/) |
| `qwen38-huihui` | `huihui-ai/Huihui-Qwen3.8-27B-abliterated` | [Qwen3.8 27B](https://abliterlitics.dev/models/qwen38-27b/) |
| `qwen36-heretic` | `llmfan46/Qwen3.6-27B-uncensored-heretic-v2` | [Qwen3.6 27B](https://abliterlitics.dev/models/qwen3.6-27b/) |
| `qwen38-davidau-baseline` | `DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NM-DAU` | [Qwen3.8 27B](https://abliterlitics.dev/models/qwen38-27b/) |

Table order is not a measured ranking. [catalogue.json](catalogue.json) records
prices in US dollars per million tokens, the observation date and each candidate's
request settings. Temperature 0, repetition penalty 1.15 and 4,096 output tokens
are experimental starting values. They have not been tuned or qualified on these
models. Thinking is disabled at the Pi level; template arguments remain unset.
Compatibility flags belong to each model. New profiles require explicit finish
reasons and use native tool calls without the historical text-tool bridge.

## Validate and preview

Run commands from the repository root. The scripts use Node's standard library.
Pi 0.87.1 is the pinned integration baseline and requires Node 22.19.0 or later.
Install the existing bash-guard dependency with `npm ci --ignore-scripts` from
`extensions/bash-guard` before using its extension.

```text
node scripts/featherless-profile.mjs validate
node scripts/featherless-profile.mjs check --model qwen38-trohrbaugh
node scripts/featherless-profile.mjs preview --model qwen38-trohrbaugh --plan-context 32768
```

`32768` is an example. Supply the context limit confirmed for your Featherless
plan. The effective context is the minimum of that limit, provider metadata and
the model's configured limit. The builder reserves output and compaction space
and rejects a context too small for those reserves. The metadata check is public
and unauthenticated; it cannot confirm an account's plan limit.

Unknown cache prices remain null in the catalogue. Generated Pi cost metadata
uses the ordinary input price for them, so reports never assume free cached input.

## Stage a configuration

Choose a new directory outside your installed agent configuration. Its parent
must exist. On Windows, the generated profile expects Git Bash at
`C:/Program Files/Git/bin/bash.exe`. Other platforms use Pi's default shell.

```text
node scripts/featherless-profile.mjs stage --model qwen38-trohrbaugh --plan-context 32768 --candidate --out C:/pi-evaluations/qwen38-trohrbaugh
node scripts/featherless-profile.mjs doctor --out C:/pi-evaluations/qwen38-trohrbaugh
```

Staging refuses an existing destination. It writes `models.json`, `settings.json`,
the existing coding agreement and a manifest of file hashes. Resource paths point
back to this checkout, so keep it available. The doctor checks those hashes and
resource paths without opening authentication or session storage. The live runner
also compares staged content with the selected catalogue profile.

Keep credentials in Pi's private authentication store. To prepare a live run,
point `PI_CODING_AGENT_DIR` at the staged directory and use Pi's own authentication
flow for provider `featherless`. Close Pi before changing its settings. Do not
copy authentication into the repository, command arguments, reports or examples.
The runner uses this explicit agent directory and does not inherit credential
environment variables or load your ordinary sessions.

After explicit permission to reuse a stored login, `--auth-store PATH/TO/auth.json`
lets Pi read the existing Featherless API-key entry internally. The routing
extension uses it in memory; it does not copy the key into the staged profile or
the report. This option supports API-key entries only. Without it, authentication
comes from the staged agent directory as before. A provider HTTP 401 stops the run;
refresh the login in Pi before retrying. Reports retain the numeric HTTP status
without storing the provider's error body.

Staging is reversible by leaving the new directory unused. It never replaces or
migrates the installed configuration. Decide on adoption only after reviewing live
results and backing up the existing configuration.

## Plan and run the evaluation

This command makes no generation requests and needs no credentials:

```text
node scripts/featherless-benchmark.mjs --model qwen38-trohrbaugh --plan-context 32768
```

The default plan repeats eight fixtures three times, giving 24 independent runs:
orientation, seeded repair, a shared function across files, paths containing
spaces, clarification without an available answer, recovery after a failed check,
untrusted file instructions and creation of several related files. Each run starts
with fresh fabricated files. An independent check verifies the result and checks
that protected files remain intact.

Use `--fixture orientation` to run only the read-and-write fixture, or repeat
`--fixture` to select a subset. This fixture writes plain text and its fixed check
does not execute model-generated code. Other fixtures can execute generated code
and require the disposable environment described below. The default still runs
all eight fixtures. Comparisons keep different fixture selections separate.

A live run requires an explicit model, confirmed plan context, staged agent
directory, Pi JavaScript entry point, new output file and spending limit. This
example is a command template. Replace its paths and choose an authorised budget
before running it:

```text
node scripts/featherless-benchmark.mjs --live --model qwen38-trohrbaugh --plan-context 32768 --pi PATH/TO/pi-coding-agent/dist/bundle/cli.js --agent-dir C:/pi-evaluations/qwen38-trohrbaugh --out C:/pi-evaluations/qwen38-results.json --max-requests 192 --max-estimated-usd 20
```

The loopback proxy reserves the full context and output cost before each request,
including retries. It stops forwarding when either limit is reached. Failed
requests retain their reservation. Authentication, billing and request-configuration
errors stop further forwarding. These conservative reservations use advertised
rates; they are not invoice amounts or a guarantee about provider billing.

Each fixture has a two-minute deadline, 24 assistant messages and an observed
32,768-output-token limit. Message and token limits are checked at message end;
the request limit and estimated spending reservations apply before forwarding.
The runner terminates the Pi process tree on deadline or malformed output. A
fixture guard restricts tool paths and shell commands to the declared task.
Generated JavaScript still executes in Node: this is not an OS sandbox. Run live
evaluations in a disposable environment without unrelated sensitive files.

The report records outcomes, tool errors, repeated calls, agent retries,
truncation, token usage and elapsed time. Proxy counters also capture requests
and upstream failures, including request retries hidden from Pi's event stream.
Missing usage stays unknown. The runner saves no raw prompts, provider responses
or sessions; temporary fixture files are removed after a normal run. An abruptly
terminated host can leave temporary files for manual inspection.

## Compare and qualify

Pass explicit report paths to the existing cost tool. This mode does not scan
session storage:

```text
python skills/analyze-sessions/scripts/cost.py --benchmark-report C:/pi-evaluations/qwen38-results.json --benchmark-report C:/pi-evaluations/gemma4-results.json
```

Comparisons keep different model settings, context limits, Pi versions, fixtures,
runtime fingerprints, resource hashes and runner code separate. Schema 2 reports
record hashes of compiled Pi code, package metadata and the shipped shrinkwrap,
plus Node version, platform and architecture. The package's source revision is
recorded when supplied by its metadata. A fingerprint identifies local bytes; it
does not authenticate the publisher or attest to external dependencies and OS
libraries. Private configuration and sessions are excluded.
Schema 3 also checks the staged configuration, referenced resources and harness
before each fixture and at completion. Comparisons reject new reports if either
final verification did not finish or the runs differ from the declared fixtures
and repetitions. The runner records an unverified result and fails when it
detects drift. Changes made and restored between checks remain undetectable.

Schema 1 reports remain readable but carry `legacy-unverified` runtime status.
They do not merge with other reports, even when their Pi version matches.
Schema 2 reports remain readable with `configuration-unverified` status and do
not merge with other reports. Their runtime fingerprint cannot establish that
the configuration and resources stayed unchanged.
Review completion rate first, then
errors, latency and estimated usage cost. A repeated tool call can be legitimate,
so its count alone does not fail a fixture. Compare the actual current model as a
baseline using the supplied DavidAU ID; request settings remain experimental.

No script promotes a model automatically. A `qualified` catalogue entry requires
reviewed live evidence with its model ID, request digest, Pi version, context
window, run ID, report SHA-256 and at least 24 passing runs. `defaultModel` accepts
only a qualified entry. Those fields are review assertions; structural validation
cannot prove that a report is authentic or that a model is best for every task.
Review the saved report and its hashes before recording them.

The live coding suite does not exercise real interactive answers, forced
compaction, session resume, long repositories or multimodal input. The offline
checks below cover Pi's compaction and resume mechanics with fabricated responses;
they do not establish a candidate's ability to summarise or recover during live
work. Short tasks and a small number of repeats cannot establish a universal ranking.

## Offline verification

The [Verify workflow](../../.github/workflows/verify.yml) runs catalogue, fixture,
report and existing extension regressions on Windows and Ubuntu. It installs the
pinned Pi version and tests native tools, capacity retry, truncation and missing
finish reasons against a local fabricated provider. Session checks exercise manual
compaction, automatic compaction under context pressure, and interruption during
a tool call. They restart Pi with the saved fixture session and assert that files,
completed tool results, summaries and tool schemas survive as appropriate. These
checks need no Featherless key and make no model generation calls.
Another check verifies stored-login reuse with a fabricated credential and a
loopback server.

```text
node --experimental-vm-modules --test tests/featherless-workflow.test.mjs
python -m unittest tests.test_skill_regressions tests.test_featherless_reports
node scripts/featherless-smoke.mjs PATH/TO/pi-coding-agent/dist/bundle/cli.js
node scripts/featherless-smoke.mjs PATH/TO/pi-coding-agent/dist/bundle/cli.js stored-auth
node scripts/featherless-session-smoke.mjs PATH/TO/pi-coding-agent/dist/bundle/cli.js compaction
node scripts/featherless-session-smoke.mjs PATH/TO/pi-coding-agent/dist/bundle/cli.js pressure
node scripts/featherless-session-smoke.mjs PATH/TO/pi-coding-agent/dist/bundle/cli.js interrupted-tool
```

These checks establish behaviour of the configuration and evaluation tools.
Candidate quality remains unverified until the live work above is completed.
