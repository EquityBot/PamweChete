import { parse as shellParse } from "shell-quote";

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"count-objects",
	"describe",
	"diff",
	"diff-tree",
	"for-each-ref",
	"fsck",
	"grep",
	"help",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"merge-base",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-ref",
	"status",
	"verify-commit",
	"verify-pack",
	"verify-tag",
	"version",
]);

const ENV_OPTIONS_WITH_VALUES = new Set(["-u", "--unset", "-C", "--chdir"]);
const ENV_SPLIT_STRING_COMMAND = -1;
const ENV_SPLIT_STRING_PIPE_COMMAND = "env-split-string";

function isOpToken(token) {
	return typeof token === "object" && token !== null && "op" in token;
}

function tokensToStrings(tokens) {
	return tokens.filter((token) => typeof token === "string");
}

function splitOnOps(tokens, splitOps) {
	const out = [];
	let current = [];
	for (const token of tokens) {
		if (isOpToken(token) && splitOps.includes(token.op)) {
			if (current.length > 0) out.push(current);
			current = [];
			continue;
		}
		current.push(token);
	}
	if (current.length > 0) out.push(current);
	return out;
}

function commandName(value) {
	return value.split(/[\\/]/).at(-1)?.replace(/\.exe$/i, "").toLowerCase() ?? value.toLowerCase();
}

function isEnvSplitStringOption(value) {
	if (/^-[i0v]*S/.test(value)) return true;
	const optionName = value.split("=", 1)[0];
	return optionName.length >= 3 && "--split-string".startsWith(optionName);
}

function commandIndex(tokens, startIndex = 0) {
	let index = startIndex;
	while (index < tokens.length && typeof tokens[index] === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
		index += 1;
	}
	if (typeof tokens[index] !== "string") return null;
	if (commandName(tokens[index]) !== "env") return index;
	index += 1;
	while (index < tokens.length && typeof tokens[index] === "string") {
		if (tokens[index] === "--") {
			index += 1;
			while (index < tokens.length && typeof tokens[index] === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
				index += 1;
			}
			break;
		}
		if (isEnvSplitStringOption(tokens[index])) {
			return ENV_SPLIT_STRING_COMMAND;
		}
		if (ENV_OPTIONS_WITH_VALUES.has(tokens[index])) {
			index += 2;
			continue;
		}
		if (/^-/.test(tokens[index]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
			index += 1;
			continue;
		}
		break;
	}
	return typeof tokens[index] === "string" ? index : null;
}

function hasShortFlag(args, flag) {
	return args.some((arg) => arg === `-${flag}` || (/^-[^-]/.test(arg) && arg.slice(1).includes(flag)));
}

function anyArgStartsWith(args, prefix) {
	return args.some((arg) => arg.startsWith(prefix));
}

function gitCommandParts(args) {
	let index = 0;
	const optionsWithValues = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix"]);
	while (index < args.length) {
		const arg = args[index];
		if (optionsWithValues.has(arg)) {
			index += 2;
			continue;
		}
		if (/^--(?:git-dir|work-tree|namespace|super-prefix)=/.test(arg)) {
			index += 1;
			continue;
		}
		if (["--bare", "--no-pager", "--paginate", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"].includes(arg)) {
			index += 1;
			continue;
		}
		break;
	}
	return { subcommand: args[index], subArgs: args.slice(index + 1) };
}

function isReadOnlyGitCommand(args) {
	const { subcommand, subArgs } = gitCommandParts(args);
	if (!subcommand || subcommand === "--help" || subcommand === "--version") return true;
	const optionEnd = subArgs.indexOf("--");
	const optionArgs = optionEnd === -1 ? subArgs : subArgs.slice(0, optionEnd);
	if (subcommand === "diff" && optionArgs.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
	if (subcommand === "fsck" && optionArgs.includes("--lost-found")) return false;
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return true;

	if (subcommand === "remote") {
		return subArgs.length === 0 || ["-v", "--verbose", "get-url", "show"].includes(subArgs[0]);
	}
	if (subcommand === "stash") return ["list", "show"].includes(subArgs[0]);
	if (subcommand === "worktree") return subArgs[0] === "list";
	if (subcommand === "reflog") return subArgs.length === 0 || subArgs[0] === "show";

	if (subcommand === "branch") {
		if (subArgs.length === 0) return true;
		const mutating = new Set([
			"-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force",
			"--edit-description", "--set-upstream-to", "--unset-upstream", "--track", "--no-track",
		]);
		if (subArgs.some((arg) => mutating.has(arg) || arg.startsWith("--set-upstream-to="))) return false;
		return subArgs[0].startsWith("-");
	}

	if (subcommand === "tag") {
		if (subArgs.length === 0) return true;
		return ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(subArgs[0]);
	}

	if (subcommand === "config") {
		return subArgs.some((arg) =>
			["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope"].includes(arg),
		) || subArgs[0] === "get" || subArgs[0] === "list";
	}

	return false;
}

function firstCommandAfterPipe(tokens, pipeIndex) {
	const index = commandIndex(tokens, pipeIndex + 1);
	if (index === ENV_SPLIT_STRING_COMMAND) return ENV_SPLIT_STRING_PIPE_COMMAND;
	return index === null ? null : commandName(tokens[index]);
}

function hasPipeToShell(tokens) {
	const shells = new Set(["bash", "dash", "fish", "sh", "zsh"]);
	for (let index = 0; index < tokens.length; index += 1) {
		if (!isOpToken(tokens[index]) || tokens[index].op !== "|") continue;
		const receiver = firstCommandAfterPipe(tokens, index);
		if (shells.has(receiver) || receiver === ENV_SPLIT_STRING_PIPE_COMMAND) {
			return true;
		}
	}
	return false;
}

function analyzeSegment(segment) {
	const reasons = [];
	let severity = "medium";
	const index = commandIndex(segment);
	if (index === null) return null;
	if (index === ENV_SPLIT_STRING_COMMAND) {
		return { severity, reasons: ["env --split-string (opaque command execution)"] };
	}

	const cmd = commandName(segment[index]);
	const rest = tokensToStrings(segment.slice(index + 1));

	if (cmd === "sudo") {
		reasons.push("sudo (elevated privileges)");
		severity = "high";
	}

	if (["rm", "rmdir", "unlink"].includes(cmd)) {
		severity = "high";
		reasons.push(`${cmd} (file deletion)`);
		if (hasShortFlag(rest, "r") || hasShortFlag(rest, "R") || rest.includes("--recursive")) reasons.push("recursive delete (-r/-R)");
		if (hasShortFlag(rest, "f") || rest.includes("--force")) reasons.push("forced delete (-f)");
	}

	if (cmd === "find" && rest.includes("-delete")) {
		severity = "high";
		reasons.push("find -delete (bulk deletion)");
	}

	if (cmd === "git") {
		const { subcommand, subArgs } = gitCommandParts(rest);
		if (!isReadOnlyGitCommand(rest)) {
			reasons.push(subcommand ? `git ${subcommand} (repository state change)` : "git (repository command)");
		}
		if (subcommand === "rm") {
			severity = "high";
			reasons.push("git rm (deletes files from the working tree and stages deletions)");
		}
		if (subcommand === "clean" && (hasShortFlag(subArgs, "f") || subArgs.includes("--force"))) {
			severity = "high";
			reasons.push("git clean (can delete untracked files)");
		}
		if (subcommand === "reset" && subArgs.includes("--hard")) {
			severity = "high";
			reasons.push("git reset --hard (discards changes)");
		}
		if (["checkout", "restore"].includes(subcommand) && subArgs.some((arg) => arg === "." || arg === "--" || arg === "--source" || arg.startsWith("--source="))) {
			reasons.push("git checkout/restore (can overwrite the working tree)");
		}
		if (subcommand === "push" && (hasShortFlag(subArgs, "f") || anyArgStartsWith(subArgs, "--force"))) {
			severity = "high";
			reasons.push("git push --force (rewrites remote history)");
		}
		if (subcommand === "reflog" && subArgs.includes("expire")) {
			severity = "high";
			reasons.push("git reflog expire (can remove recovery history)");
		}
		if (subcommand === "gc" && subArgs.some((arg) => arg.startsWith("--prune"))) {
			severity = "high";
			reasons.push("git gc --prune (can permanently delete objects)");
		}
	}

	if (cmd === "truncate") reasons.push("truncate (in-place size change, can erase contents)");
	if (cmd === "dd" && (anyArgStartsWith(rest, "of=") || rest.includes("of"))) {
		severity = "high";
		reasons.push("dd with output file/device (can overwrite data)");
	}
	if (cmd.startsWith("mkfs") || cmd.startsWith("newfs_")) {
		severity = "high";
		reasons.push(`${cmd} (filesystem formatting)`);
	}
	if (["wipefs", "gpt", "asr", "parted", "fdisk", "gdisk", "sgdisk", "cryptsetup", "zpool"].includes(cmd)) {
		severity = "high";
		reasons.push(`${cmd} (disk or volume management)`);
	}
	if (["diskutil", "hdiutil"].includes(cmd)) {
		severity = "high";
		reasons.push(`${cmd} (disk management command)`);
	}
	if (cmd === "lsblk") reasons.push("lsblk (disk listing)");
	if (["pvcreate", "vgcreate", "lvcreate"].includes(cmd)) {
		severity = "high";
		reasons.push(`${cmd} (LVM volume management)`);
	}
	if (["chmod", "chown"].includes(cmd) && (rest.includes("-R") || rest.includes("--recursive"))) {
		reasons.push(`${cmd} -R (recursive permission or ownership changes)`);
	}
	if (["mv", "cp"].includes(cmd) && (hasShortFlag(rest, "f") || rest.includes("--force"))) {
		reasons.push(`${cmd} --force/-f (can overwrite files)`);
	}
	if (cmd === "sed" && (hasShortFlag(rest, "i") || rest.includes("--in-place"))) reasons.push("sed -i (in-place file modification)");
	if (cmd === "perl" && (rest.includes("-pi") || (rest.includes("-p") && rest.includes("-i")))) reasons.push("perl -pi/-i (in-place file modification)");
	if (["kill", "pkill", "killall"].includes(cmd)) {
		reasons.push(`${cmd} (process termination)`);
		if (rest.includes("-9")) severity = "high";
	}
	if (["shutdown", "reboot", "halt", "poweroff"].includes(cmd)) {
		severity = "high";
		reasons.push(`${cmd} (system power operation)`);
	}
	if (cmd === "systemctl" && (rest.includes("stop") || rest.includes("disable"))) reasons.push("systemctl stop/disable (service disruption)");
	if (cmd === "kubectl" && rest[0] === "delete") {
		severity = "high";
		reasons.push("kubectl delete (resource deletion)");
	}
	if (cmd === "terraform" && rest[0] === "destroy") {
		severity = "high";
		reasons.push("terraform destroy (infrastructure teardown)");
	}
	if (cmd === "aws" && rest[0] === "s3" && rest[1] === "rm" && rest.includes("--recursive")) {
		severity = "high";
		reasons.push("aws s3 rm --recursive (bulk deletion)");
	}
	if (cmd === "gcloud" && rest.includes("delete")) {
		severity = "high";
		reasons.push("gcloud delete (resource deletion)");
	}

	return reasons.length === 0 ? null : { severity, reasons };
}

export function analyzeBashCommand(command) {
	let tokens;
	try {
		tokens = shellParse(command);
	} catch {
		return { severity: "medium", reasons: ["unparsed shell command (unable to analyse safely)"] };
	}

	const reasons = [];
	let severity = "medium";
	const ops = tokens.filter(isOpToken).map((token) => token.op);
	if (ops.some((op) => [">", ">>", "2>", "2>>"].includes(op))) reasons.push("shell output redirection (can overwrite files)");
	if (ops.includes("<")) reasons.push("shell input redirection (questionable)");
	if (hasPipeToShell(tokens)) {
		reasons.push("pipe to a shell (possible remote code execution)");
		severity = "high";
	}

	for (const segment of splitOnOps(tokens, ["&&", "||", ";", "|"])) {
		const segmentRisk = analyzeSegment(segment);
		if (!segmentRisk) continue;
		if (segmentRisk.severity === "high") severity = "high";
		reasons.push(...segmentRisk.reasons);
	}

	const uniqueReasons = [...new Set(reasons)];
	return uniqueReasons.length === 0 ? null : { severity, reasons: uniqueReasons };
}

const CATASTROPHIC_BLOCKED = [
	{ pattern: /(?<!\bgit\s+)\brm\b[^#\n]*\s-(?:[a-zA-Z]*[rR]|-recursive\b)/, reason: "recursive delete (rm -r / -rf / -Rf)" },
	{ pattern: /\bfind\b[^#\n]*\s-delete\b/, reason: "bulk deletion (find -delete)" },
	{ pattern: /\bsudo\b/, reason: "elevated privileges (sudo)" },
	{ pattern: /\b(curl|wget)\b[^#\n]*\|\s*(?:env\s+)?(ba?sh|zsh|fish|dash|sh)\b/, reason: "pipe to shell (remote code execution)" },
	{ pattern: /\bmkfs/, reason: "filesystem formatting (mkfs)" },
	{ pattern: /\bnewfs_\w+/, reason: "filesystem formatting (newfs_*)" },
	{ pattern: /\bwipefs\b/, reason: "disk signature wipe" },
	{ pattern: /\bdiskutil\s+(erase|zeroDisk|secureErase|reformat)/i, reason: "destructive disk operation (diskutil)" },
	{ pattern: /\bdd\b[^#\n]*\bof=\/dev\//, reason: "raw disk write (dd of=/dev/...)" },
	{ pattern: /\b(parted|fdisk|gdisk|sgdisk)\b/, reason: "partition table management" },
	{ pattern: /\bcryptsetup\b/, reason: "disk encryption management" },
	{ pattern: /\bzpool\b/, reason: "ZFS pool management" },
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "system power operation" },
	{ pattern: /\bterraform\s+destroy\b/, reason: "infrastructure teardown (terraform destroy)" },
	{ pattern: /\bkubectl\s+delete\b/, reason: "Kubernetes resource deletion" },
	{ pattern: /\baws\s+s3\s+rm\b[^#\n]*--recursive/, reason: "bulk S3 deletion (aws s3 rm --recursive)" },
	{ pattern: /\bgit\s+push\b[^#\n]*(?:--force(?:-with-lease)?|-f(?:\s|$))/, reason: "git push --force (rewrites remote history)" },
	{ pattern: /\bgit\s+reset\b[^#\n]*--hard\b/, reason: "discard all uncommitted changes (git reset --hard)" },
	{ pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/, reason: "delete untracked files (git clean -f)" },
	{ pattern: /\bgit\s+reflog\s+expire\b/, reason: "expire reflog (removes recovery history)" },
	{ pattern: /\bgit\s+gc\b[^#\n]*--prune\b/, reason: "prune unreachable objects (git gc --prune)" },
];

export const HEADLESS_BLOCKED = [
	...CATASTROPHIC_BLOCKED,
	{ pattern: /\bgit\s+commit\b/, reason: "git commit (commits are main-session operations)" },
	{ pattern: /\bgit\s+pull\b/, reason: "git pull (pulls are main-session operations)" },
	{ pattern: /\bgit\s+push\b/, reason: "git push (pushes are main-session operations)" },
];

export const MAIN_DISABLED_BLOCKED = [...CATASTROPHIC_BLOCKED];

function findBlockedReason(command, rules) {
	for (const { pattern, reason } of rules) {
		if (pattern.test(command)) return reason;
	}
	return null;
}

export function headlessBlockReason(command) {
	return findBlockedReason(command, HEADLESS_BLOCKED);
}

export function disabledModeBlockReason(command) {
	return findBlockedReason(command, MAIN_DISABLED_BLOCKED);
}
