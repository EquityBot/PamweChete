# Featherless Qwen3.8 coding profile

This profile configures Pi for `DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NM-DAU` through Featherless's OpenAI-compatible Chat Completions endpoint. It favours deterministic tool use, a small tool surface, explicit verification and bounded retries.

## What is selected

- Exact provider/model: `featherless/DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NM-DAU`
- Maximum advertised context: 32,768 tokens, lowered when the authenticated plan reports a smaller limit
- Baseline sampling: temperature `0`, repetition penalty `1.15`
- Cost metadata, from the Featherless model page on 2026-09-07: `$1.60` input, `$0.15` cached, `$12.00` output per million tokens. Featherless prices differ per model and change over time, so re-read the model page when switching models rather than carrying the previous figures over.
- Thinking: off at the Pi level only. `chat_template_kwargs` is deliberately unset, because setting `enable_thinking: false` stops this model emitting native tool calls: it prints a `<tool_call>` envelope as ordinary text and invents tool names. The verifier fails the profile if that key comes back.
- Reliability: 2 provider-request retries with server-directed delays capped at 30 seconds, plus 3 state-preserving agent retries after 5, 10 and 20 seconds
- Extensions: ask-user-question, bash-guard, pinned RTK output compression, the bounded Featherless text-tool bridge, custom header and prompt snippets
- Network, browser, memory and subagent extensions: not loaded by default

The benchmark-generated `settings.windows.json` records the winning tool surface. It is written only after both approved candidates complete the same live fixtures.

## Benchmark result

The 2026-08-28 live benchmark on Pi 0.84.3 selected the expanded surface:
`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` and
`ask_user_question`. It passed project description, seeded repair and
multi-step create-and-verify fixtures with 10 tool calls, zero invalid calls
and zero repeated calls. The lean surface passed the first 2 fixtures but
did not complete the multi-step fixture in the selection run.

The second optimisation benchmark kept full bridge schemas. With pinned RTK
enabled, full schemas again passed all 3 fixtures with 10 valid calls,
zero invalid calls, zero repeats and 223 output tokens. The compact-schema
candidate passed the first 2 fixtures but failed the multi-step fixture after
one read, then emitted 4,108 output tokens of malformed wrapper repetition. It
is therefore diagnostic-only; the unset/default bridge mode remains `full`.

In a separate controlled repository containing 81 modified tracked files and
150 untracked files, RTK 0.46.0 reduced verbose `git status` output by 36.56%
and verbose `git diff` output by 44.76% while retaining the required changed
file, untracked-directory and diff facts.

A repeated live smoke pass later observed Featherless return transient capacity errors after partial tool progress. Pi's request retry implementation safely retries 429 and 5xx responses before a stream begins, while its agent retry path retains completed tool results and continues from the same state. The final profile therefore enables 2 provider retries, caps a server-requested delay at 30 seconds, and gives a longer 35-second agent backoff window.

## Model change, 2026-09-07

The profile moved from `OBLITERATUS/Qwen3.8-27B-OBLITERATED` to the DavidAU
model above. Featherless serves the new model at 32k context and it emits
**native** tool calls, so the text-tool bridge is no longer required: it is
scoped to the previous model's exact id and stays inert here. The bridge
extension is still loaded so the older model keeps working if it is selected
again.

Two settings did not carry over. `chat_template_kwargs` is now unset, for the
reason given above. `parallel_tool_calls: false` is also gone, because the
verified configuration does not set it and shipping an untested parameter in a
reproducible profile is worse than omitting it.

`supportsFinishReason` stays `false` even though the new model does return a
`finish_reason`. The compat block is provider-wide and shared with the older
model, which genuinely omits it; `false` is proven against both, so the
conservative value is kept rather than tuned on one model's behaviour.

The benchmark figures above were measured on the previous model and are
retained as the record of that selection. They have not been re-run.

## Security boundary

`models.example.json`, settings, prompts and documentation are deliberately secret-free. Never add an `apiKey`, bearer token, `auth.json`, environment file or copied credential to this repository. Store the Featherless credential only in Pi's private `~/.pi/agent/auth.json` entry for provider `featherless`, or enter it through Pi's authentication flow.

## Windows setup

1. Install Pi and verify `pi --version` matches the audited version documented by the setup.
2. Clone this fork anywhere; `settings.windows.json` records its `extensions` relative to the repository root and its `prompts` relative to this profile directory.
3. In `extensions/bash-guard`, run `npm ci --ignore-scripts` and `npm test`.
4. Install RTK 0.46.0 from its official Windows release asset after checking the ZIP against the release `checksums.txt`; run `rtk telemetry disable` and do not run `rtk init`.
5. In `extensions/rtk`, run `npm test` and confirm `rtk --version` reports 0.46.0.
6. Copy `models.example.json` to `~/.pi/agent/models.json`, adapting only authenticated context-derived limits when necessary.
7. Copy the generated settings and `AGENTS.md` to `~/.pi/agent/` without replacing `auth.json` or session data, rewriting the relative `extensions` and `prompts` entries to absolute paths inside the clone (Pi resolves paths in `~/.pi/agent/settings.json` relative to `~/.pi/agent`).
8. Put the credential in Pi's private auth store, then run `pi --list-models featherless` before paid generation.
9. Launch with `pi`.

Run `node scripts/verify-featherless-qwen-profile.mjs profiles/featherless-qwen38` from the repository root to validate the published profile. The machine setup also keeps a timestamped, checksummed pre-change backup for rollback.
