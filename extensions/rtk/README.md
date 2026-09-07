# RTK output compression

This directory vendors the official thin Pi hook from [rtk-ai/rtk](https://github.com/rtk-ai/rtk). It asks the installed `rtk` binary to rewrite supported Bash commands so their output is compact before it enters Pi's context.

## Pin and provenance

- RTK release: `v0.46.0`
- Source repository: `https://github.com/rtk-ai/rtk`
- Source path: `hooks/pi/rtk.ts`
- Source commit: `322db4da98219b15608d5b71eddf6338c48d693c`
- Vendored source SHA-256: `48f07e4fd8e38b350cae84fe0116d2bc29932d535e333a307cb9e477f5272de6`
- Licence: Apache-2.0; the upstream licence is included as `LICENSE`.

`index.ts` is byte-for-byte identical to that upstream file. Rewrite rules stay in RTK itself rather than being copied into this configuration.

## Runtime contract

- Install `rtk` 0.46.0 on `PATH` and keep RTK telemetry disabled.
- Load `bash-guard` before this extension. The guard must evaluate the original command before RTK rewrites it.
- RTK rewrite exit codes 0 and 3 may replace the command. Missing, old, killed, timed-out or unsupported rewrites pass the original command through.
- Set `RTK_DISABLED=1` to bypass rewriting for one process.
- Do not run `rtk init --agent pi` for this profile. It would add a separately discovered global hook outside the pinned extension order.

Run `npm test` in this directory to verify the hook's observable Pi event behaviour and pinned source digest.
