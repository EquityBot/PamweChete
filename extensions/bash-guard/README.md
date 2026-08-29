# bash-guard (pi extension)

Intercepts agent-issued `bash` tool calls and applies different protection depending on whether
the session is interactive (main session) or non-interactive (spawned subagent).

## Modes

Behaviour is determined at registration time via the `PI_SUBAGENT_DEPTH` environment variable,
which pi-subagents injects into every spawned process.

### Main session (`PI_SUBAGENT_DEPTH` = 0 or unset) — interactive prompt

- Heuristically detects destructive/questionable commands via shell-aware parsing
- Allows read-only Git inspection without interruption (`status`, `diff`, `log`, `show`,
  `rev-parse`, `remote -v`, and list/query forms)
- Treats Git options and variables that name an external program as command execution rather
  than inspection: `-c <key>=<value>` and `--config-env` config injection, `--exec-path=`,
  `--upload-pack`/`--receive-pack`, `git grep -O`, `ext::` transport URLs, `--output` on the
  diff family, and `GIT_EXTERNAL_DIFF`, `GIT_SSH_COMMAND`, `LD_PRELOAD` and similar leading
  environment assignments
- Fails closed: an unrecognised subcommand, or an option on a read-only subcommand whose name
  reads like it takes a program or an output file, escalates to a prompt
- Prompts for Git operations that change repository or remote state, escalating destructive
  operations such as `git reset --hard`, `git clean -fdx`, and `git push --force`
- Prompts for disk/volume tooling: `diskutil`, `hdiutil`, `mkfs*`, `newfs_*`, `wipefs`, `parted`,
  `fdisk`, `gdisk/sgdisk`, `cryptsetup`, `pvcreate/vgcreate/lvcreate`, `zpool`, `lsblk`
- Prompts for: `rm`/`rmdir`/`unlink`, `sudo`, `find -delete`, `dd`, `truncate`, `sed -i`,
  `perl -pi`, `chmod/chown -R`, `mv/cp --force`, `kill`/`pkill`/`killall`, `shutdown`/`reboot`,
  `systemctl stop/disable`, `curl|sh`/`wget|sh`, `kubectl delete`, `terraform destroy`,
  `aws s3 rm --recursive`, `gcloud delete`, and shell redirections (`>`, `>>`, `2>`)
- Allows harmless pipelines such as `git log | head`; pipe-to-shell execution remains high risk
- Shows a 2-option dialog: **Run** / **Abort**
- If aborted, the tool call is blocked and the model receives a clear reason
- Remembers recently aborted commands for 60 s to prevent retry loops

### Subagent (`PI_SUBAGENT_DEPTH` ≥ 1) — headless hard-block

Spawned subagents have no UI (stdin is `/dev/null`), so prompting is impossible. Instead,
a focused set of catastrophic/unrecoverable operations is blocked with no user interaction.
The command is tokenised first and the Git subcommand is identified positionally after the
global options, so `git -C /other/repo push --force` and `dd if=/dev/zero of="/dev/sda"` are
classified the same way as their bare forms. The floor is a denylist, so it is best effort
rather than a guarantee:

| Pattern | Reason |
|---|---|
| `rm -r` / `-rf` / `-Rf` | Recursive deletion |
| `sudo` | Elevated privileges |
| `curl\|sh`, `wget\|sh` | Pipe to shell (remote code execution) |
| `mkfs*`, `newfs_*` | Filesystem formatting |
| `wipefs` | Disk signature wipe |
| `diskutil erase/zeroDisk/secureErase/reformat` | Destructive disk operation |
| `dd of=/dev/…` | Raw disk write |
| `parted`, `fdisk`, `gdisk`, `sgdisk` | Partition table management |
| `cryptsetup` | Disk encryption management |
| `zpool` | ZFS pool management |
| `shutdown`, `reboot`, `halt`, `poweroff` | System power operation |
| `terraform destroy` | Infrastructure teardown |
| `kubectl delete` | Kubernetes resource deletion |
| `aws s3 rm --recursive` | Bulk S3 deletion |
| `git commit` | Main-session operation |
| `git pull` | Main-session operation |
| `git push` | Main-session operation |
| `git reset --hard` | Discard all uncommitted changes |
| `git clean -f` | Delete untracked files |
| `git reflog expire` | Remove recovery history |
| `git gc --prune` | Prune unreachable objects |
| `git -c <key>=<program>`, `--config-env`, `--exec-path=` | Git config injection naming a program |
| `GIT_EXTERNAL_DIFF=…`, `GIT_SSH_COMMAND=…`, `LD_PRELOAD=…` | Environment variable naming a program |
| `--upload-pack`, `--receive-pack`, `git grep -O`, `ext::` | Externally named program on a Git command |

All other commands (including routine git operations) pass through unaffected.

## Install

Auto-discovered from `~/.pi/agent/extensions/bash-guard/`. Run `/reload` in pi.

## Notes

- Scope: `bash` tool calls only (`write`/`edit` and user `!` commands are not intercepted).
- Policy behaviour is covered by `npm test` in this directory.
- `--bash-guard-auto-allow`: main-session flag that allows flagged commands when there is no UI
  (e.g. running pi non-interactively). Has no effect in subagent sessions.
