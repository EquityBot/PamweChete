import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

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

const BENIGN_EXEC_VALUES = new Set(["cat", "true", "false", ":", "/bin/cat", "/bin/true", "/bin/false", "/usr/bin/cat"]);

// Environment variables that hand git (or the loader) a program to run. A leading assignment is
// part of the command, not decoration, so it is retained and classified.
const EXEC_ENV_VARS = new Set([
	"GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND",
	"GIT_PROXY_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT",
	"LD_PRELOAD", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "PERL5OPT", "PYTHONSTARTUP",
	"NODE_OPTIONS",
]);

function envExecReason(prefixTokens) {
	for (const token of prefixTokens) {
		const eq = token.indexOf("=");
		if (eq <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.slice(0, eq))) continue;
		const name = token.slice(0, eq).toUpperCase();
		if (!EXEC_ENV_VARS.has(name) && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) continue;
		if (BENIGN_EXEC_VALUES.has(token.slice(eq + 1))) continue;
		return `${name} (environment variable naming an external program)`;
	}
	return null;
}

const ENV_OPTIONS_WITH_VALUES = new Set(["-u", "--unset", "-C", "--chdir"]);
const ENV_SPLIT_STRING_COMMAND = -1;
const UNSAFE_TIME_COMMAND = -2;
const ENV_SPLIT_STRING_PIPE_COMMAND = "env-split-string";

function isOpToken(token) {
	return typeof token === "object" && token !== null && "op" in token;
}

function tokensToStrings(tokens) {
	return tokens.filter((token) => typeof token === "string");
}

// Every operator that starts a new command context. Subshells (`(`/`)`) and background control
// (`&`) are separators just as much as `&&`/`||`/`;`/`|`; leaving them out folded the commands they
// introduce into a neighbouring segment, where they were never classified.
const SPLIT_OPS = ["&&", "||", ";", "|", "(", ")", "&"];

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
	// Skip operators the split list does not consume (a leading redirection, for example) so the
	// command behind them is still classified instead of the whole segment being dropped.
	while (index < tokens.length && isOpToken(tokens[index])) {
		index += 1;
	}
	while (index < tokens.length && typeof tokens[index] === "string" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) {
		index += 1;
	}
	if (typeof tokens[index] !== "string") return null;
	if (tokens[index] === "{") return commandIndex(tokens, index + 1);
	const wrapper = commandName(tokens[index]);
	if (wrapper === "time") {
		let next = index + 1;
		let writesOutput = false;
		while (typeof tokens[next] === "string" && tokens[next].startsWith("-")) {
			const option = tokens[next++];
			if (option === "--") break;
			if (["-p", "--portability", "-v", "--verbose", "-q", "--quiet", "-a", "--append"].includes(option)) continue;
			if (["-f", "--format", "-o", "--output"].includes(option)) {
				if (typeof tokens[next] !== "string" || !tokens[next] || tokens[next].startsWith("-")) return UNSAFE_TIME_COMMAND;
				writesOutput ||= option === "-o" || option === "--output";
				next += 1;
			} else if (/^-[fo].+/.test(option) || /^--(?:format|output)=.+/.test(option)) {
				writesOutput ||= option.startsWith("-o") || option.startsWith("--output=");
			} else {
				return UNSAFE_TIME_COMMAND;
			}
		}
		// Output options can overwrite files, independently of the wrapped command.
		if (writesOutput || typeof tokens[next] !== "string") return UNSAFE_TIME_COMMAND;
		return commandIndex(tokens, next);
	}
	if (["nohup", "command"].includes(wrapper)) {
		if (wrapper === "command" && /^(?:-[p]*[vV]|--(?:help|version))/.test(tokens[index + 1] ?? "")) return index;
		let next = index + 1;
		while (["--", "-p"].includes(tokens[next])) next += 1;
		return commandIndex(tokens, next);
	}
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
	return commandIndex(tokens, index);
}

function hasShortFlag(args, flag) {
	return args.some((arg) => arg === `-${flag}` || (/^-[^-]/.test(arg) && arg.slice(1).includes(flag)));
}

function anyArgStartsWith(args, prefix) {
	return args.some((arg) => arg.startsWith(prefix));
}

const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"]);
const GIT_GLOBAL_VALUE_PREFIX = /^--(?:git-dir|work-tree|namespace|super-prefix|exec-path|config-env)=/;
const GIT_GLOBAL_FLAGS = new Set([
	"--bare", "--no-pager", "--paginate", "-p", "-P", "--exec-path", "--no-replace-objects", "--no-optional-locks",
	"--no-lazy-fetch", "--no-advice", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs",
]);

// Config keys that cannot name a program, a path or a URL. Anything outside this list is treated
// as command execution, so an unknown or novel key fails closed.
const BENIGN_CONFIG_KEYS = new Set([
	"user.name", "user.email", "user.signingkey", "protocol.version", "core.quotepath", "core.abbrev",
	"core.autocrlf", "core.safecrlf", "core.ignorecase", "core.filemode", "core.longpaths", "core.precomposeunicode",
	"core.commitgraph", "core.bare", "diff.noprefix", "diff.algorithm", "diff.renames", "diff.mnemonicprefix",
	"log.date", "log.showsignature", "status.short", "push.default", "pull.rebase", "fetch.prune", "gc.auto",
	"commit.gpgsign", "tag.gpgsign", "rebase.autostash", "init.defaultbranch", "safe.directory", "grep.linenumber",
]);

function configKeyIsBenign(key) {
	const lower = key.toLowerCase();
	return lower.startsWith("color.") || lower.startsWith("advice.") || BENIGN_CONFIG_KEYS.has(lower);
}

// Retains the global options instead of discarding them, so `-c key=value`, `--config-env` and
// `--exec-path=` stay visible to classification and the subcommand is found positionally after them.
function gitCommandParts(args) {
	let index = 0;
	const globals = [];
	while (index < args.length) {
		const arg = args[index];
		if (GIT_GLOBAL_VALUE_OPTIONS.has(arg)) {
			globals.push(arg, args[index + 1] ?? "");
			index += 2;
			continue;
		}
		if (GIT_GLOBAL_VALUE_PREFIX.test(arg) || GIT_GLOBAL_FLAGS.has(arg)) {
			globals.push(arg);
			index += 1;
			continue;
		}
		break;
	}
	return { globals, subcommand: args[index], subArgs: args.slice(index + 1) };
}

function gitGlobalExecReason(globals) {
	for (let index = 0; index < globals.length; index += 1) {
		const arg = globals[index];
		if (arg.startsWith("--exec-path=")) return "git --exec-path= (relocates the git program directory)";
		let setting = null;
		if (arg === "-c" || arg === "--config-env") setting = globals[index + 1] ?? "";
		else if (arg.startsWith("--config-env=")) setting = arg.slice("--config-env=".length);
		if (setting === null) continue;
		const eq = setting.indexOf("=");
		const key = eq === -1 ? setting : setting.slice(0, eq);
		if (configKeyIsBenign(key) || (eq !== -1 && BENIGN_EXEC_VALUES.has(setting.slice(eq + 1)))) continue;
		return `git -c ${key} (config injection that can name an external program)`;
	}
	return null;
}

const GIT_PACK_OPTION = /^--(?:upload-pack|receive-pack)(?:=|$)/;
// ponytail: name-shaped net over options we do not enumerate per subcommand. It catches option
// names that read like they take a program or an output file; a novel option with an innocuous
// name still slips. Upgrade path is a per-subcommand read-only option allowlist.
const GIT_SUSPECT_OPTION = /exec|pager|editor|askpass|ssh|proxy|hook|upload-pack|receive-pack|external|output/i;

function gitOptionExecReason(subcommand, subArgs) {
	for (const arg of subArgs) {
		if (GIT_PACK_OPTION.test(arg)) return `git ${subcommand} --upload-pack/--receive-pack (runs a named program)`;
		if (arg.startsWith("ext::")) return `git ${subcommand} ext:: transport URL (runs an arbitrary program)`;
		if (subcommand === "grep" && /^-[^-]*O/.test(arg)) return "git grep -O (pipes matches into a named program)";
	}
	return null;
}

function isReadOnlyGitCommand(args) {
	const { globals, subcommand, subArgs } = gitCommandParts(args);
	if (gitGlobalExecReason(globals)) return false;
	if (!subcommand || subcommand === "--help" || subcommand === "--version") return true;
	if (gitOptionExecReason(subcommand, subArgs)) return false;
	const optionEnd = subArgs.indexOf("--");
	const optionArgs = optionEnd === -1 ? subArgs : subArgs.slice(0, optionEnd);
	if (optionArgs.some((arg) => arg === "--output" || arg.startsWith("--output="))) return false;
	if (subcommand === "fsck" && optionArgs.includes("--lost-found")) return false;
	if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
		return !optionArgs.some((arg) => arg.startsWith("-") && GIT_SUSPECT_OPTION.test(arg.split("=", 1)[0]));
	}

	if (subcommand === "remote") {
		if (subArgs.some((arg) => ["add", "remove", "rm", "rename", "set-url", "set-head", "set-branches", "prune", "update"].includes(arg))) return false;
		return subArgs.length === 0 || ["-v", "--verbose", "get-url", "show"].includes(subArgs[0]);
	}
	if (subcommand === "stash") return ["list", "show"].includes(subArgs[0]);
	if (subcommand === "worktree") return subArgs[0] === "list";
	if (subcommand === "reflog") return subArgs.length === 0 || subArgs[0] === "show";

	if (subcommand === "branch") {
		if (subArgs.length === 0) return true;
		const mutating = new Set([
			"--delete", "--move", "--copy", "--force", "--edit-description",
			"--set-upstream", "--set-upstream-to", "--unset-upstream", "--track", "--no-track",
		]);
		if (subArgs.some((arg) => mutating.has(arg) || arg.startsWith("--set-upstream-to=") || arg.startsWith("--track="))) return false;
		if (["d", "D", "m", "M", "c", "C", "f", "u", "t"].some((flag) => hasShortFlag(subArgs, flag))) return false;
		return subArgs[0].startsWith("-");
	}

	if (subcommand === "tag") {
		if (subArgs.length === 0) return true;
		if (["d", "a", "s", "f", "m", "F", "e", "u"].some((flag) => hasShortFlag(subArgs, flag))) return false;
		if (subArgs.some((arg) =>
			["--delete", "--force", "--annotate", "--sign", "--message", "--file", "--edit", "--create-reflog", "--local-user", "--cleanup"].includes(arg) ||
			arg.startsWith("--message=") || arg.startsWith("--file=") || arg.startsWith("--local-user=") || arg.startsWith("--cleanup="),
		)) return false;
		return ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"].includes(subArgs[0]);
	}

	if (subcommand === "config") {
		const write = new Set([
			"--unset", "--unset-all", "--add", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section",
			"set", "unset", "unset-all", "add", "edit", "rename-section", "remove-section",
		]);
		if (subArgs.some((arg) => write.has(arg))) return false;
		const read = new Set([
			"--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color", "--get-colorbool",
			"--list", "-l", "--show-origin", "--show-scope", "--show-names",
		]);
		if (subArgs.some((arg) => read.has(arg))) return true;
		return ["get", "list"].includes(subArgs[0]);
	}

	return false;
}

function firstCommandAfterPipe(tokens, pipeIndex) {
	const index = commandIndex(tokens, pipeIndex + 1);
	if (index === ENV_SPLIT_STRING_COMMAND || index === UNSAFE_TIME_COMMAND) return ENV_SPLIT_STRING_PIPE_COMMAND;
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

function isInside(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isNullDevice(target) {
	return target === "/dev/null" || (process.platform === "win32" && target.toLowerCase() === "nul");
}

// shell-quote drops `${VAR}` from a word unless an env supplies it, so `> dir/${NAME}.txt` would other-
// wise be checked as the literal `dir/.txt`. Re-parsing with this sentinel as the value of every
// variable leaves a recognisable mark at each expansion site instead.
const EXPANSION_SENTINEL = "__pi_shell_expansion__";

function redirectionTokens(command, fallback) {
	try {
		return shellParse(command, () => EXPANSION_SENTINEL);
	} catch {
		return fallback;
	}
}

// Bash expands these before it opens the target, but shell-quote hands the text back verbatim or drops
// it, so the path checked below would not be the path written. Treat them as ambiguous rather than guess.
function isShellExpandedTarget(target) {
	return target.startsWith("~")
		|| target.includes(EXPANSION_SENTINEL)
		|| target.includes("$")
		|| target.includes("`");
}

// A relative target is only checkable while the working directory is known, and this analyser does not
// track one across a `cd`.
function changesDirectory(tokens) {
	return tokens.some((token, index) => token === "cd" && (index === 0 || isOpToken(tokens[index - 1])));
}

function outputRedirectionReasons(tokens, cwd) {
	const reasons = [];
	const directoryChanged = changesDirectory(tokens);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!isOpToken(token) || ![">", ">>", ">&"].includes(token.op)) continue;

		const target = tokens[index + 1];
		if (token.op === ">&" && typeof target === "string" && /^&?\d+$/.test(target)) continue;
		if (typeof target !== "string" || target.length === 0) {
			reasons.push("shell output redirection has an ambiguous target");
			continue;
		}
		if (isNullDevice(target)) continue;
		if (isShellExpandedTarget(target)) {
			reasons.push("shell output redirection has an ambiguous target");
			continue;
		}
		if (directoryChanged && !isAbsolute(target)) {
			reasons.push("shell output redirection follows a directory change, so its target is ambiguous");
			continue;
		}

		const resolvedTarget = resolve(cwd, target);
		if (!isInside(cwd, resolvedTarget)) {
			reasons.push("shell output redirection targets a path outside the working directory");
			continue;
		}
		if (existsSync(resolvedTarget)) {
			reasons.push("shell output redirection targets an existing file");
		}
	}
	return reasons;
}

function analyzeSegment(segment) {
	const reasons = [];
	let severity = "medium";
	const index = commandIndex(segment);
	if (index === null) return null;
	if (index === UNSAFE_TIME_COMMAND) {
		return { severity, reasons: ["time output or unsupported options require approval"] };
	}
	if (index === ENV_SPLIT_STRING_COMMAND) {
		return { severity, reasons: ["env --split-string (opaque command execution)"] };
	}

	let cmd = commandName(segment[index]);
	let rest = tokensToStrings(segment.slice(index + 1));

	const envReason = envExecReason(tokensToStrings(segment.slice(0, index)));
	if (envReason) reasons.push(envReason);

	// rtk wraps a real command, so classify the wrapped command and keep the git rules below in force.
	if (cmd === "rtk" && commandName(rest[0] ?? "") === "git") {
		cmd = "git";
		rest = rest.slice(1);
	}

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
		const { globals, subcommand, subArgs } = gitCommandParts(rest);
		const execReason = gitGlobalExecReason(globals) ?? gitOptionExecReason(subcommand, subArgs);
		if (execReason) reasons.push(execReason);
		else if (!isReadOnlyGitCommand(rest)) {
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
	if (cmd === "kubectl" && rest.includes("delete")) {
		severity = "high";
		reasons.push("kubectl delete (resource deletion)");
	}
	if (cmd === "terraform" && rest.includes("destroy")) {
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

export function analyzeBashCommand(command, options = {}) {
	let tokens;
	try {
		tokens = shellParse(command);
	} catch {
		return { severity: "medium", reasons: ["unparsed shell command (unable to analyse safely)"] };
	}

	const reasons = [];
	let severity = "medium";
	const ops = tokens.filter(isOpToken).map((token) => token.op);
	reasons.push(...outputRedirectionReasons(redirectionTokens(command, tokens), options.cwd ?? process.cwd()));
	if (ops.includes("<")) reasons.push("shell input redirection (questionable)");
	if (hasPipeToShell(tokens)) {
		reasons.push("pipe to a shell (possible remote code execution)");
		severity = "high";
	}

	for (const segment of splitOnOps(tokens, SPLIT_OPS)) {
		const segmentRisk = analyzeSegment(segment);
		if (!segmentRisk) continue;
		if (segmentRisk.severity === "high") severity = "high";
		reasons.push(...segmentRisk.reasons);
	}

	// Same second net the headless and disabled-mode floors apply, so the interactive analyser is
	// never weaker than the floor that runs when there is nobody to prompt.
	const catastrophicReason = findBlockedReason(command, CATASTROPHIC_BLOCKED);
	if (catastrophicReason) {
		severity = "high";
		reasons.push(catastrophicReason);
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

function catastrophicGitReason(args) {
	const { globals, subcommand, subArgs } = gitCommandParts(args);
	const execReason = gitGlobalExecReason(globals) ?? gitOptionExecReason(subcommand, subArgs);
	if (execReason) return execReason;
	if (subcommand === "push" && (hasShortFlag(subArgs, "f") || anyArgStartsWith(subArgs, "--force"))) return "git push --force (rewrites remote history)";
	if (subcommand === "reset" && subArgs.includes("--hard")) return "discard all uncommitted changes (git reset --hard)";
	if (subcommand === "clean" && (hasShortFlag(subArgs, "f") || subArgs.includes("--force"))) return "delete untracked files (git clean -f)";
	if (subcommand === "reflog" && subArgs.includes("expire")) return "expire reflog (removes recovery history)";
	if (subcommand === "gc" && anyArgStartsWith(subArgs, "--prune")) return "prune unreachable objects (git gc --prune)";
	return null;
}

function catastrophicSegmentReason(segment) {
	const index = commandIndex(segment);
	if (index === UNSAFE_TIME_COMMAND) return "time output or unsupported options cannot be verified safely";
	if (index === null || index === ENV_SPLIT_STRING_COMMAND) return null;
	const envReason = envExecReason(tokensToStrings(segment.slice(0, index)));
	if (envReason) return envReason;
	const cmd = commandName(segment[index]);
	const rest = tokensToStrings(segment.slice(index + 1));

	if (cmd === "git") return catastrophicGitReason(rest);
	if (cmd === "sudo") return "elevated privileges (sudo)";
	if (cmd === "rm" && (hasShortFlag(rest, "r") || hasShortFlag(rest, "R") || rest.includes("--recursive"))) return "recursive delete (rm -r / -rf / -Rf)";
	if (cmd === "find" && rest.includes("-delete")) return "bulk deletion (find -delete)";
	if (cmd === "dd" && rest.some((arg) => arg.startsWith("of=/dev/"))) return "raw disk write (dd of=/dev/...)";
	if (cmd.startsWith("mkfs")) return "filesystem formatting (mkfs)";
	if (cmd.startsWith("newfs_")) return "filesystem formatting (newfs_*)";
	if (cmd === "wipefs") return "disk signature wipe";
	if (cmd === "diskutil" && rest.some((arg) => /^(?:erase|zeroDisk|secureErase|reformat)/i.test(arg))) return "destructive disk operation (diskutil)";
	if (["parted", "fdisk", "gdisk", "sgdisk"].includes(cmd)) return "partition table management";
	if (cmd === "cryptsetup") return "disk encryption management";
	if (cmd === "zpool") return "ZFS pool management";
	if (["shutdown", "reboot", "halt", "poweroff"].includes(cmd)) return "system power operation";
	if (cmd === "terraform" && rest.includes("destroy")) return "infrastructure teardown (terraform destroy)";
	if (cmd === "kubectl" && rest.includes("delete")) return "Kubernetes resource deletion";
	if (cmd === "aws" && rest[0] === "s3" && rest[1] === "rm" && rest.includes("--recursive")) return "bulk S3 deletion (aws s3 rm --recursive)";
	return null;
}

const HEADLESS_GIT_SUBCOMMANDS = new Map([
	["commit", "git commit (commits are main-session operations)"],
	["pull", "git pull (pulls are main-session operations)"],
	["push", "git push (pushes are main-session operations)"],
]);

// Parses first, then classifies. The regex list below is kept only as a second net for text the
// tokeniser drops (quoted `bash -c "..."` payloads and the like).
function parsedBlockReason(command, headless) {
	let tokens;
	try {
		tokens = shellParse(command);
	} catch {
		return "unparseable shell command (cannot verify safety)";
	}
	for (const segment of splitOnOps(tokens, SPLIT_OPS)) {
		const reason = catastrophicSegmentReason(segment);
		if (reason) return reason;
		if (!headless) continue;
		const index = commandIndex(segment);
		if (index === null || index === ENV_SPLIT_STRING_COMMAND) continue;
		if (commandName(segment[index]) !== "git") continue;
		const { subcommand } = gitCommandParts(tokensToStrings(segment.slice(index + 1)));
		const headlessReason = HEADLESS_GIT_SUBCOMMANDS.get(subcommand);
		if (headlessReason) return headlessReason;
	}
	return null;
}

function findBlockedReason(command, rules) {
	const normalizedCommand = command.replace(/(^|(?:&&|\|\||[;|])\s*)rtk(?:\.exe)?\s+git\b/gi, "$1git");
	for (const { pattern, reason } of rules) {
		if (pattern.test(normalizedCommand)) return reason;
	}
	return null;
}

export function headlessBlockReason(command) {
	return parsedBlockReason(command, true) ?? findBlockedReason(command, HEADLESS_BLOCKED);
}

export function disabledModeBlockReason(command) {
	return parsedBlockReason(command, false) ?? findBlockedReason(command, MAIN_DISABLED_BLOCKED);
}
