# Repository maintenance instructions

Read [README.md](README.md) before changing an extension or skill. This repository
contains pieces to copy individually; changes here do not authorise replacing
the user's installed Pi configuration. Preserve the upstream attribution and
distinguish Ryan's additions from the original author's narrative.

For profile work, read
[profiles/featherless-qwen38/README.md](profiles/featherless-qwen38/README.md).
Its `AGENTS.md` is the shipped model profile. Keep profile prompts distinct from
these contributor instructions and use fabricated inputs for checks.

Dependencies belong to the extension that uses them. Inspect its `package.json`
and run its defined checks from that directory. Before handoff, run the affected
profile and extension gates in [verify.yml](.github/workflows/verify.yml).
Structural tests do not establish live model quality; report that separately.
Keep credentials and local session data outside the repository.
