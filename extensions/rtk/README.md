# RTK output compression

This directory maintains a local adaptation of the thin Pi hook from [rtk-ai/rtk](https://github.com/rtk-ai/rtk). It asks the installed `rtk` binary to rewrite supported Bash commands so their output is compact before it enters Pi's context.

## Pin and provenance

- RTK release: `v0.46.0`
- Source repository: `https://github.com/rtk-ai/rtk`
- Source path: `hooks/pi/rtk.ts`
- Release commit: `8dae5a750fe307d1fee105a2ff4a9d1ca54ac791`
- Release source SHA-256: `d278508809a5379e506384eabb19e17a672806c4eac7eabc1cd634699aea8c33`
- Local source SHA-256 (LF): `1ce1bee849472954eff6bda492ac39c2ae5d0645ee1ecf262b721541fc61a1fe`
- Licence: Apache-2.0; the upstream licence is included as `LICENSE`.

`index.ts` replaces the release source's runtime type-guard import with a local guard and type-only imports, and refuses `rtk` releases older than the pinned 0.46.0, where upstream accepts 0.23.0. It is maintained in this repository; its LF-normalised digest and observable behaviour are checked locally. Rewrite rules stay in RTK itself rather than being copied into this configuration.

## Runtime contract

- Install `rtk` 0.46.0 on `PATH` and keep RTK telemetry disabled. Older releases disable the extension with a warning.
- Load `bash-guard` before this extension. The guard must evaluate the original command before RTK rewrites it.
- RTK rewrite exit codes 0 and 3 may replace the command. Missing, old, killed, timed-out or unsupported rewrites pass the original command through.
- Set `RTK_DISABLED=1` to bypass rewriting for one process.
- Do not run `rtk init --agent pi` for this profile. It would add a separately discovered global hook outside the pinned extension order.

Run `npm test` in this directory to verify the hook's observable Pi event behaviour and pinned source digest. Set `RTK_CONTRACT_BIN` to an `rtk` executable to also run the hook against that real binary; CI does this with the pinned 0.46.0 Linux release after checking its SHA-256.
