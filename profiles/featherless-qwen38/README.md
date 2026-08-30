# Featherless Qwen3.8 coding profile

This profile configures Pi for `OBLITERATUS/Qwen3.8-27B-OBLITERATED` through Featherless's OpenAI-compatible Chat Completions endpoint. It favours deterministic tool use, a small tool surface, explicit verification and bounded retries.

## What is selected

- Exact provider/model: `featherless/OBLITERATUS/Qwen3.8-27B-OBLITERATED`
- Maximum advertised context: 32,768 tokens, lowered when the authenticated plan reports a smaller limit
- Baseline sampling: temperature `0`, repetition penalty `1.15`, parallel tool calls disabled
- Thinking: off at both Pi and chat-template levels; `enable_thinking: false` prevents the endpoint from leaking generated reasoning ahead of text-tool envelopes
- Reliability: two provider-request retries with server-directed delays capped at 30 seconds, plus three state-preserving agent retries after 5, 10 and 20 seconds
- Extensions: ask-user-question, bash-guard, the bounded Featherless text-tool bridge, custom header and prompt snippets
- Network, browser, memory and subagent extensions: not loaded by default

The benchmark-generated `settings.windows.json` records the winning tool surface. It is written only after both approved candidates complete the same live fixtures.

## Benchmark result

The 2026-08-28 live benchmark on Pi 0.84.3 selected the expanded surface:
`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` and
`ask_user_question`. It passed project description, seeded repair and
multi-step create-and-verify fixtures with 10 tool calls, zero invalid calls
and zero repeated calls. The lean surface passed the first two fixtures but
did not complete the multi-step fixture in the selection run.

A repeated live smoke pass later observed Featherless return transient capacity errors after partial tool progress. Pi's request retry implementation safely retries 429 and 5xx responses before a stream begins, while its agent retry path retains completed tool results and continues from the same state. The final profile therefore enables two provider retries, caps a server-requested delay at 30 seconds, and gives a longer 35-second agent backoff window.

The authenticated Featherless endpoint currently reports native tool calling
as unavailable for this model and returns attempted calls as ordinary text.
The model-scoped bridge recognises only the bounded response forms documented
in its README, extracts one call for a currently active tool, and leaves Pi's
normal schema validation and safety hooks in control. Unknown tools, malformed
arguments, repeated envelopes and unrecognised wrappers are not executed.

## Security boundary

`models.example.json`, settings, prompts and documentation are deliberately secret-free. Never add an `apiKey`, bearer token, `auth.json`, environment file or copied credential to this repository. Store the Featherless credential only in Pi's private `~/.pi/agent/auth.json` entry for provider `featherless`, or enter it through Pi's authentication flow.

## Windows setup

1. Install Pi and verify `pi --version` matches the audited version documented by the setup.
2. Clone this fork anywhere; `settings.windows.json` records its `extensions` relative to the repository root and its `prompts` relative to this profile directory.
3. In `extensions/bash-guard`, run `npm ci --ignore-scripts` and `npm test`.
4. Copy `models.example.json` to `~/.pi/agent/models.json`, adapting only authenticated context-derived limits when necessary.
5. Copy the generated settings and `AGENTS.md` to `~/.pi/agent/` without replacing `auth.json` or session data, rewriting the relative `extensions` and `prompts` entries to absolute paths inside the clone (Pi resolves paths in `~/.pi/agent/settings.json` relative to `~/.pi/agent`).
6. Put the credential in Pi's private auth store, then run `pi --list-models featherless` before paid generation.
7. Launch with `pi`.

Run `node scripts/verify-featherless-qwen-profile.mjs profiles/featherless-qwen38` from the repository root to validate the published profile. The machine setup also keeps a timestamped, checksummed pre-change backup for rollback.
