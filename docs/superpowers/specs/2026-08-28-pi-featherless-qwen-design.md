# Pi and Featherless Qwen coding setup

Date: 28 August 2026

Status: Approved in chat; awaiting review of this written specification

## Objective

Install the current official Pi coding agent on Windows, create a public fork of `amosblomqvist/pi-config`, modernise and optimise that fork, and make `OBLITERATUS/Qwen3.8-27B-OBLITERATED` on Featherless the reliable default model for day-to-day coding.

The completed setup must be usable by running `pi` from an ordinary terminal. It must preserve a recoverable copy of the existing Pi configuration, keep the Featherless credential out of Git and logs, and prove the selected profile with live text and tool-loop tests.

## Constraints and observed state

- Install Pi from the current official package scope, `@earendil-works/pi-coding-agent`, pinned to the audited version `0.84.3`.
- Windows already has a compatible Node.js, npm, Git, Git Bash and authenticated GitHub CLI installation.
- The requested upstream repository is a parts library, not a single installable Pi package.
- Several active upstream extensions still import the retired `@mariozechner` Pi packages.
- The upstream bash guard prompts on every Git command and ordinary pipe, which would obstruct routine coding.
- The requested model advertises a 32K context window and OpenAI-compatible tool calling. Its model card recommends temperature `0`, repetition penalty `1.15`, thinking off for direct answers, and at least 2,048 output tokens.
- A Featherless credential already exists in OpenCode's credential store. It may be transferred for this task but must never be printed or committed.
- The original repository has no declared licence. The fork will preserve attribution and will not add licence claims on behalf of the upstream author.

## Approaches considered

### 1. Literal full copy

Copy every extension and skill into Pi's global configuration and install every dependency. This follows the repository superficially but adds browser state, network fetchers, external-service credentials, large tool schemas and unsupported tmux-oriented components. It also copies known compatibility defects. Rejected.

### 2. Static lean profile

Install only the locally useful extensions, patch their imports and use one hand-tuned provider configuration. This is safer and smaller, but it assumes the target model behaves as expected without measuring its actual tool-loop performance. Acceptable fallback.

### 3. Benchmark-guided lean profile

Use the static lean profile as a baseline, compare a small and expanded built-in tool surface with bounded live fixtures, and retain only the more reliable variant. Apply one compatibility adjustment only if the baseline exposes a specific failure. This is the selected approach because it makes optimisation measurable without turning setup into an open-ended benchmark project.

## Architecture

### Source plane

- Create the public GitHub fork `ryanduguid/pi-config` from `amosblomqvist/pi-config`.
- Clone it to `C:\Users\-\Documents\Repos\pi-config`.
- Configure `origin` as the user's fork and `upstream` as the source repository.
- Work on a normal branch based on the upstream default branch, then merge or fast-forward the tested changes into the fork's default branch without rewriting history.
- Keep the working tree clean after the tested commit is pushed.

The fork is the editable source of truth. Pi's global settings will load selected extensions and prompts directly from the clone through absolute paths. This avoids maintaining an untracked second copy under the Pi configuration directory.

### Runtime plane

Pi's runtime state remains under `C:\Users\-\.pi\agent`:

- `settings.json` selects the model, tools, extensions, retry policy and compaction policy.
- `models.json` defines the Featherless provider and model metadata without a credential.
- `auth.json` stores the Featherless credential separately.
- `AGENTS.md` contains a short global coding agreement derived from the fork's profile file.
- Existing sessions and unrelated runtime state remain intact.

Before modifying runtime files, create a timestamped backup outside the auto-discovered agent directory and record a non-secret manifest. The backup happens before credential transfer.

### Credential plane

- Read the `featherless` entry from OpenCode's credential store in memory.
- Merge it into Pi's `auth.json` under the custom provider id `featherless`.
- Do not pass the key on a command line, interpolate it into a patch, print it, or store it in the fork, benchmark report, task record or shell history.
- Restrict the resulting auth file to the current Windows user and required system access as far as Windows ACLs permit.
- Verify secret absence by comparing an in-memory digest and by scanning the fork and generated non-secret artefacts. First prove the scanner detects a synthetic positive-control secret, then run it against the real scoped artefacts. The verifier reports only pass or fail.

## Fork changes

### Compatibility repairs

- Replace retired Pi imports with the current `@earendil-works` packages in active extensions.
- Leave deprecated examples untouched unless a selected runtime component imports them.
- Ensure every selected extension declares the non-core packages it imports and install dependencies with lifecycle scripts disabled where supported.
- Load the selected extensions through Pi itself as the compatibility test. Static import replacement alone is not sufficient evidence.

### Bash guard optimisation

The guard will continue to block or prompt for destructive commands, privilege escalation, remote pipe-to-shell execution, disk operations, irreversible infrastructure actions and history-rewriting Git operations.

It will not prompt for read-only Git commands such as `status`, `diff`, `log`, `show`, `branch --list`, `remote -v` or `rev-parse`, nor for harmless pipes used to filter output. State-changing Git commands remain interactive, while catastrophic patterns keep a hard-block floor. The extension will retain its recent-abort loop protection.

### Selected runtime resources

Enabled by default:

- `ask-user-question.ts`
- `bash-guard/`
- `prompt-snippets/`
- `custom-header.ts`
- the new Featherless Qwen coding profile and prompt templates

Retained in the fork but disabled by default:

- browser automation
- web fetching and web search
- observational memory
- interactive subagents
- session-analysis, PDF, web-debug and YouTube skills

The disabled resources add network exposure, credentials, heavyweight dependencies or tool schemas that are not necessary for the baseline coding loop. They can be enabled later as deliberate additions.

### Reusable profile

Add a secret-free profile directory containing:

- a concise `AGENTS.md`
- example `settings.json` and `models.json`
- a short Windows setup and rollback guide
- reusable prompt templates for implementation and verification
- a standard-library verification script for profile structure

The fork's README will explain that the applied credential remains outside the repository.

## Featherless provider configuration

Provider baseline:

```json
{
  "baseUrl": "https://api.featherless.ai/v1",
  "api": "openai-completions"
}
```

Model baseline:

- id: `OBLITERATUS/Qwen3.8-27B-OBLITERATED`
- display name: `Qwen3.8 27B OBLITERATED (Featherless)`
- reasoning: off initially
- context window: the smaller of 32,768 and the authenticated plan limit
- maximum output: 4,096 at a 32K effective limit, reduced only if the plan limit requires it
- sampling parameters: temperature `0`, repetition penalty `1.15`, parallel tool calls disabled
- cost metadata: current Featherless input, cached-input and output prices recorded for Pi's usage display
- compatibility: system role rather than developer role, `max_tokens`, named tool results and non-strict tool schemas
- image input enabled only if authenticated model metadata and a bounded probe confirm it

Thinking flags will not be forced in the first run. If the model emits unwanted thinking or malformed tool calls, compare Pi's Qwen thinking format with the baseline on the failing fixture. Retain the variant that completes the tool loop correctly; do not keep retrying arbitrary parameter combinations.

### Live compatibility evidence

The authenticated endpoint diverged from the public capability label during implementation:

- authenticated metadata reported native tool calling as unavailable;
- streaming responses omitted `finish_reason`;
- attempted calls arrived as ordinary text, including bounded Qwen-style wrappers;
- leaving `enable_thinking` unset leaked generated reasoning ahead of calls.

The implemented profile therefore sets `supportsFinishReason: false`, explicitly sends
`chat_template_kwargs.enable_thinking: false`, and loads a model-scoped text-tool bridge. The
bridge removes conflicting native tool fields only for the exact provider/model, advertises the
active schemas in the system prompt, converts only tested bounded response forms, and preserves
Pi's normal schema validation, bash guard and tool-call safety hooks. This evidence-backed bridge
supersedes the original single-parameter-adjustment fallback because the live endpoint did not
provide the native protocol the baseline assumed.
## Pi settings

The initial global settings will include:

- provider `featherless`
- the exact requested default model
- default thinking level `off`
- model cycling limited to the requested model
- project trust left at `ask`
- install telemetry disabled
- agent retries enabled with at most two retries and provider-level retries disabled
- a provider timeout long enough for a 4,096-token response without allowing an indefinite wait
- auto-compaction enabled

For a 32K effective context, start with a 6,144-token response reserve and approximately 10,000 recent tokens. If the authenticated plan reports a lower effective context, reduce output, reserve and recent-context values together so their total leaves room for the system prompt, tool schemas and the compacted summary.

## Coding meta-prompt

The global instructions will be short enough to avoid wasting the 32K context. They will require the model to:

1. Read applicable project instructions and defined repository commands.
2. Inspect relevant files before editing.
3. Make the smallest coherent change.
4. Use tool results as evidence and never repeat an unchanged failed call.
5. Work directly without announcing routers, personas or delegation.
6. Ask one concise question only when a missing choice materially changes the result.
7. Run repository-defined verification and report every check not run.
8. Stop after verification and provide a concise outcome instead of repeating status text.

No router, subagent or orchestration prompt is enabled by default.

## Benchmark and selection

Compare two tool profiles:

- Lean: `read`, `bash`, `edit`, `write`, plus `ask_user_question`.
- Expanded: `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, plus `ask_user_question`.

Use deterministic, disposable fixtures and a bounded number of live requests:

1. Read and accurately describe a small project.
2. Locate and repair a seeded defect, then run its declared test.
3. Complete a multi-step read, edit and verification loop and terminate without another prompt.

A profile is eligible only if all required fixture outcomes pass. Invalid tool calls, unchanged retries, repeated routing/status text and failure to terminate are hard reliability defects. When both profiles pass, prefer fewer invalid calls and retries, then lower tool and context overhead. Cold-start latency is recorded but is not a primary tie-breaker.

If neither profile passes, make one evidence-backed compatibility adjustment and rerun only the failing fixture. A persistent model-side failure is reported honestly rather than hidden behind prompt retries.

Record results without prompts containing private data, credentials or raw authorization headers. Commit only the winning profile.

## Error handling and rollback

- Preserve the pre-change Pi backup until all gates pass.
- If an extension prevents Pi from loading, start Pi with extensions disabled, identify the failing selected extension and repair or remove it from the profile.
- Treat authentication failure, plan denial and unavailable model capacity as provider errors, not configuration success.
- Cap automatic retries and honour server retry delays only within the configured maximum.
- Do not delete the existing OpenCode configuration or credential after transfer.
- Rollback restores the backed-up Pi runtime files and leaves the public fork intact for diagnosis.

## Verification and completion

Completion requires all of the following:

- the pinned official Pi version runs through the `pi` command and resolves Git Bash
- the public fork and local clone have the correct parent and remotes
- selected extensions load without current-scope import or dependency errors
- Pi lists and defaults to the exact Featherless model with the effective context limit
- the credential is usable but absent from Git and non-secret artefacts
- live text generation succeeds
- the winning profile completes the seeded coding tool loop and its test
- repetition and unchanged retry checks pass
- the fork's pushed head equals the locally verified head
- the original Pi state remains recoverable from the backup

The exact runnable completion contract is recorded in `work/GATES.md`.

## Out of scope

- Changing or fine-tuning the model weights
- Increasing Featherless plan limits or the model's context window
- Installing every optional upstream extension
- Installing tmux or a Windows compatibility layer for subagent panes
- Publishing a pull request back to the upstream repository
- Rotating or deleting the Featherless key
