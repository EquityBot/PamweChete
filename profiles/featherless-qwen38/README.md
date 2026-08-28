# Featherless Qwen3.8 coding profile

This profile configures Pi for `OBLITERATUS/Qwen3.8-27B-OBLITERATED` through Featherless's OpenAI-compatible Chat Completions endpoint. It favours deterministic tool use, a small tool surface, explicit verification and bounded retries.

## What is selected

- Exact provider/model: `featherless/OBLITERATUS/Qwen3.8-27B-OBLITERATED`
- Maximum advertised context: 32,768 tokens, lowered when the authenticated plan reports a smaller limit
- Baseline sampling: temperature `0`, repetition penalty `1.15`, parallel tool calls disabled
- Thinking: off; the profile does not force chat-template thinking flags because that can damage structured tool parsing on this model
- Extensions: ask-user-question, bash-guard, custom header and prompt snippets
- Network, browser, memory and subagent extensions: not loaded by default

The benchmark-generated `settings.windows.json` records the winning tool surface. It is written only after both approved candidates complete the same live fixtures.

## Security boundary

`models.example.json`, settings, prompts and documentation are deliberately secret-free. Never add an `apiKey`, bearer token, `auth.json`, environment file or copied credential to this repository. Store the Featherless credential only in Pi's private `~/.pi/agent/auth.json` entry for provider `featherless`, or enter it through Pi's authentication flow.

## Windows setup

1. Install Pi and verify `pi --version` matches the audited version documented by the setup.
2. Clone this fork to the path referenced by `settings.windows.json`.
3. In `extensions/bash-guard`, run `npm ci --ignore-scripts` and `npm test`.
4. Copy `models.example.json` to `~/.pi/agent/models.json`, adapting only authenticated context-derived limits when necessary.
5. Copy the generated settings and `AGENTS.md` to `~/.pi/agent/` without replacing `auth.json` or session data.
6. Put the credential in Pi's private auth store, then run `pi --list-models featherless` before paid generation.
7. Launch with `pi`.

Run `node scripts/verify-featherless-qwen-profile.mjs profiles/featherless-qwen38` from the repository root to validate the published profile. The machine setup also keeps a timestamped, checksummed pre-change backup for rollback.
