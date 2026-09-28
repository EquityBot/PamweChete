import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { parse as shellParse, quote as shellQuote } from "shell-quote";

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
// `|&` (bash shorthand for `2>&1 |`), `;;` and `<(` are separate operator tokens in
// shell-quote. Omitting them folded the command after the operator into the preceding
// segment, so `curl … |& sh` was classified as a bare `curl` and never blocked.
const SPLIT_OPS = ["&&", "||", ";", ";;", "|", "|&", "(", ")", "&", "<("];

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

// Both pipe forms feed stdout to the receiver; `|&` also redirects stderr.
const PIPE_OPS = new Set(["|", "|&"]);

function hasPipeToShell(tokens) {
	const shells = new Set(["bash", "dash", "fish", "sh", "zsh"]);
	for (let index = 0; index < tokens.length; index += 1) {
		if (!isOpToken(tokens[index]) || !PIPE_OPS.has(tokens[index].op)) continue;
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

// cmd and PowerShell are reachable from Git Bash on Windows, and their payloads use their own
// syntax, so the POSIX rules above never see `rd /s` or `Remove-Item -Recurse`. `block` marks the
// forms the headless and disabled-mode floors refuse, matching the POSIX `rm -r` rule.
// ponytail: statement-level scan, not a PowerShell or cmd parser. A verb hidden behind a variable or
// Invoke-Expression slips; the upgrade path is refusing those wrappers outright.
const CMD_DELETE_VERBS = new Set(["rd", "rmdir", "del", "erase"]);
const PS_DELETE_VERBS = new Set(["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"]);
const PS_DISK_VERBS = new Set(["format-volume", "clear-disk", "initialize-disk", "remove-partition"]);
const PS_POWER_VERBS = new Set(["stop-computer", "restart-computer"]);

const WINDOWS_SHELLS = new Set(["cmd", "powershell", "pwsh"]);
const CMD_DATA_VERBS = new Set(["echo", "rem"]);
const PS_DATA_VERBS = new Set(["write-output", "write-host", "echo"]);
const PS_TRIGGERS = new Set([...PS_DELETE_VERBS, ...PS_DISK_VERBS, ...PS_POWER_VERBS, ...WINDOWS_SHELLS]);
const CMD_TRIGGERS = new Set([...CMD_DELETE_VERBS, "format", ...WINDOWS_SHELLS]);

// Each statement as a word list. Quoted text stays one word, so a verb inside a string is data,
// not a command. Backslashes become slashes first because shell-quote treats `\` as an escape,
// which would fuse `Module\Remove-Item` into one name; commandName() then drops the module part.
function windowsStatements(text) {
	let tokens;
	try {
		// shell-quote treats newlines as spaces. Semicolons preserve command boundaries;
		// inside quoted strings they remain part of the same data argument.
		tokens = shellParse(text.replace(/\\/g, "/").replace(/\r?\n/g, ";"), (name) => `$${name}`);
	} catch {
		tokens = text.split(/\s+/);
	}
	return splitOnOps(tokens, SPLIT_OPS).map((segment) =>
		tokensToStrings(segment).map((word) => word.replace(/^[{(]+|[})]+$/g, "")).filter(Boolean));
}

// `/s`, `/S/Q` and the `//s` form Git Bash needs to stop MSYS path conversion.
function hasCmdSwitch(words, letter) {
	return words.some((word) => word.startsWith("/") && word.slice(1).split("/").some((part) => part.toLowerCase() === letter));
}

// PowerShell accepts any unambiguous prefix of a parameter name, and `-Recurse:$true`;
// `-Recurse:$false` turns recursion off.
function isPowershellRecurse(word) {
	const [name, value] = word.toLowerCase().split(/:(.*)/s);
	if (value === "$false" || value === "0") return false;
	return name.length >= 2 && "-recurse".startsWith(name);
}

function nestedWindowsRisk(shell, args, depth) {
	if (depth >= MAX_NEST_DEPTH) return { reason: "nested shell wrappers too deep to verify", block: true };
	return windowsShellRisk(shell, args, depth + 1);
}

// The first word in a statement that names a destructive command decides its risk. Scanning past
// the first word catches `if exist build rd /s` and `Get-ChildItem | Remove-Item`.
function statementsRisk(statements, triggers, classify) {
	let found = null;
	for (const words of statements) {
		const at = words.findIndex((word) => triggers.has(commandName(word)));
		if (at === -1) continue;
		const risk = classify(commandName(words[at]), words.slice(at + 1), words[at]);
		if (risk?.block) return risk;
		found ??= risk;
	}
	return found;
}

function powershellRisk(args, depth) {
	const lower = args.map((arg) => arg.toLowerCase());
	const commandAt = lower.findIndex((arg) => arg === "-c" || (arg.length >= 4 && "-command".startsWith(arg)));
	const hostArgs = commandAt === -1 ? lower : lower.slice(0, commandAt);
	if (hostArgs.some((arg) => arg === "-e" || arg === "-ec" || (arg.length >= 3 && "-encodedcommand".startsWith(arg)))) {
		return { reason: "powershell -EncodedCommand (opaque command execution)", block: true };
	}
	const payload = (commandAt === -1 ? args : args.slice(commandAt + 1)).join(" ");
	// PowerShell runs `$(...)` even inside double-quoted strings, which windowsStatements keeps as
	// one data word. Finding where a subexpression ends needs PowerShell's quoting rules, so
	// everything after the first `$(` is scanned again with its quotes removed and without the
	// output-verb exemption. This fails closed: words printed after a subexpression, such as
	// `Write-Output "$(Get-Date) Remove-Item -Recurse"`, are treated as commands and can be
	// refused, but a quoted `)` cannot end the scan early and hide a delete.
	const subexpression = payload.indexOf("$(");
	const inner = subexpression === -1 ? null
		: powershellStatementsRisk(windowsStatements(payload.slice(subexpression + 2).replace(/["'`]/g, " ")), depth);
	if (inner?.block) return inner;
	const statements = windowsStatements(payload)
		.filter((words) => !PS_DATA_VERBS.has(commandName(words[0] ?? "")));
	const direct = powershellStatementsRisk(statements, depth);
	return direct?.block ? direct : inner ?? direct;
}

function powershellStatementsRisk(statements, depth) {
	return statementsRisk(statements, PS_TRIGGERS, (name, rest, word) => {
		if (WINDOWS_SHELLS.has(name)) return nestedWindowsRisk(name, rest, depth);
		if (PS_DISK_VERBS.has(name)) return { reason: `${word} (destructive disk operation)`, block: true };
		if (PS_POWER_VERBS.has(name)) return { reason: "system power operation", block: true };
		if (rest.some(isPowershellRecurse)) return { reason: "recursive delete (PowerShell Remove-Item -Recurse)", block: true };
		return { reason: `PowerShell ${word} (file deletion)`, block: false };
	});
}

function cmdRisk(args, depth) {
	const at = args.findIndex((arg) => /^\/{1,2}[ck]$/i.test(arg));
	if (at === -1) return null;
	const statements = windowsStatements(args.slice(at + 1).join(" "))
		.filter((words) => !CMD_DATA_VERBS.has(commandName(words[0] ?? "")));
	return statementsRisk(statements, CMD_TRIGGERS, (name, rest) => {
		if (WINDOWS_SHELLS.has(name)) return nestedWindowsRisk(name, rest, depth);
		if (name === "format") return { reason: "filesystem formatting (format)", block: true };
		if (hasCmdSwitch(rest, "s")) return { reason: `recursive delete (cmd ${name} /s)`, block: true };
		return { reason: `cmd ${name} (file deletion)`, block: false };
	});
}

function windowsShellRisk(cmd, args, depth = 0) {
	if (cmd === "cmd") return cmdRisk(args, depth);
	if (cmd === "powershell" || cmd === "pwsh") return powershellRisk(args, depth);
	return null;
}

// How rtk 0.49 runs the command after these subcommands: proxy executes its arguments as an
// argv, err, test and summary join them and run the result through a shell, and run executes
// its -c/--command string or its joined arguments with sh -c (cmd /C on Windows).
// smart only reads a file.
const RTK_ARGV = new Set(["proxy"]);
const RTK_SHELL = new Set(["err", "test", "summary"]);
// Flags that end rtk before anything runs.
const RTK_STOPS = new Set(["-h", "--help", "-V", "--version"]);

// rtk's options take no value, except run's -c/--command, and come before what they qualify,
// so the subcommand, and after it the command, is the first argument that is not an option.
// A help or version flag runs nothing, which reads as no argument at all.
function rtkSubcommandIndex(args) {
	for (let at = 0; at < args.length; at++) {
		if (RTK_STOPS.has(args[at])) return args.length;
		if (!args[at].startsWith("-")) return at;
	}
	return args.length;
}

// `rtk run` prefers -c/--command over positional arguments. Clap stops parsing options at
// the first positional value (including unknown flags), or at --. Later flags are data.
function rtkRunCommands(args) {
	let command;
	let positionalStart = args.length;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			positionalStart = i + 1;
			break;
		}
		// run has help, but no version flag. Its only short options are h and c; Clap's
		// allow_hyphen_values makes a whole short token positional if any letter is unknown.
		if (arg === "--help" || /^-h[ch]*$/.test(arg)) return [];
		if (arg === "--ultra-compact" || arg === "--skip-env") continue;
		if (arg === "-c" || arg === "--command") {
			if (i + 1 < args.length) command = args[++i];
			continue;
		}
		if (arg.startsWith("--command=")) {
			command = arg.slice("--command=".length);
			continue;
		}
		if (/^-c[ch]+$/.test(arg)) {
			command = arg.slice(2);
			continue;
		}
		positionalStart = i;
		break;
	}
	if (command !== undefined) return [command];
	return positionalStart < args.length ? [args.slice(positionalStart).join(" ")] : [];
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
	if (cmd === "rtk") {
		const at = rtkSubcommandIndex(rest);
		if (commandName(rest[at] ?? "") === "git") {
			cmd = "git";
			rest = rest.slice(at + 1);
		}
	}

	if (cmd === "sudo") {
		reasons.push("sudo (elevated privileges)");
		severity = "high";
	}

	const windowsRisk = windowsShellRisk(cmd, rest);
	if (windowsRisk) {
		severity = "high";
		reasons.push(windowsRisk.reason);
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

// shell-quote treats a newline as ordinary whitespace and emits no operator token for it, so a
// multi-line command parses as one segment: the first command is classified and every later line is
// folded into its arguments. Analysing each line as well catches those later commands. The extra
// pass only ever adds reasons, so a pipeline or quoted payload that spans lines keeps the whole
// command's classification too.
function commandLines(command) {
	return command.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function analyzeOneCommand(command, options, depth = 0) {
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
		if (segmentRisk) {
			if (segmentRisk.severity === "high") severity = "high";
			reasons.push(...segmentRisk.reasons);
		}
		// A `bash -c '...'` payload reaches analyzeSegment as one opaque token, so a wrapped
		// command was classified as nothing at all while the same command typed directly asked
		// for approval. Classify the payload as if it had been typed directly.
		const payloads = nestedShellPayloads(segment);
		if (payloads.length === 0) continue;
		if (depth >= MAX_NEST_DEPTH) {
			severity = "high";
			reasons.push("nested shell wrappers too deep to verify");
			continue;
		}
		for (const payload of payloads) {
			const nested = analyzeOneCommand(payload, options, depth + 1);
			if (!nested) continue;
			if (nested.severity === "high") severity = "high";
			reasons.push(...nested.reasons);
		}
	}

	return reasons.length === 0 ? null : { severity, reasons };
}

export function analyzeBashCommand(command, options = {}) {
	const lines = commandLines(command);
	const passes = lines.length > 1 ? [command, ...lines] : [command];

	const reasons = [];
	let severity = "medium";
	for (const pass of passes) {
		const risk = analyzeOneCommand(pass, options);
		if (!risk) continue;
		if (risk.severity === "high") severity = "high";
		reasons.push(...risk.reasons);
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
	{ pattern: /\b(curl|wget)\b[^#\n]*\|&?\s*(?:env\s+)?(ba?sh|zsh|fish|dash|sh)\b/, reason: "pipe to shell (remote code execution)" },
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
	const windowsRisk = windowsShellRisk(cmd, rest);
	if (windowsRisk?.block) return windowsRisk.reason;
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

const NESTED_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
// A payload strictly shrinks at each level, so recursion terminates on its own; the cap is
// only there so a crafted stack of wrappers cannot spend the guard's time, and it blocks
// rather than returns at the limit.
const MAX_NEST_DEPTH = 4;

// `bash -c '...'` hands the tokeniser one opaque string, so none of the git rules above ever
// see the payload. The payload is analysed by the same code instead of by a wider regex: the
// regex net cannot tell `git -c user.name=x` from `git -c core.pager=evil`, which is exactly
// the distinction gitGlobalExecReason() exists to make.
function nestedShellPayloads(segment) {
	const index = commandIndex(segment);
	// Both sentinels are negative, so one bound covers null, ENV_SPLIT_STRING_COMMAND and
	// UNSAFE_TIME_COMMAND; each already has its own handling where it matters.
	if (index === null || index < 0) return [];
	if (commandName(segment[index]) === "rtk") {
		// Only `rtk git` was unwrapped, so `rtk proxy git checkout -- .` was silent while the
		// bare form prompted. The wrapped command is analysed whole, like a `bash -c` payload,
		// so env hooks, nested shells and further rtk wrappers inside it are all seen, and it
		// is rebuilt the way rtk runs it: proxy's argv stays quoted word by word, so a literal
		// argument such as 'safe; rm -rf /' is not read as a second command.
		const args = tokensToStrings(segment.slice(index + 1));
		const at = rtkSubcommandIndex(args);
		const sub = commandName(args[at] ?? "");
		const rest = args.slice(at + 1);
		if (sub === "run") return rtkRunCommands(rest);
		if (!RTK_ARGV.has(sub) && !RTK_SHELL.has(sub)) return [];
		const command = rest.slice(rtkSubcommandIndex(rest));
		if (command.length === 0) return [];
		if (!RTK_ARGV.has(sub)) return [command.join(" ")];
		// proxy splits a lone argument on whitespace into words, without a shell.
		return [shellQuote(command.length === 1 ? command[0].trim().split(/\s+/) : command)];
	}
	if (!NESTED_SHELLS.has(commandName(segment[index]))) return [];
	// With -c the command string is the first argument that is not an option or an option's
	// value. Which argument that is depends on each shell's option rules (-o and -O take a
	// value, attached or separate, and shells differ), so rather than guess, every argument
	// after the -c that is not itself an option is returned and analysed. An extra one is a
	// positional parameter at worst, and analysing it can only add a finding.
	const rest = tokensToStrings(segment.slice(index + 1));
	const candidates = [];
	let readsCommandString = false;
	let optionsEnded = false;
	for (const arg of rest) {
		if (!optionsEnded && (arg === "--" || arg === "-")) {
			optionsEnded = true;
		} else if (!optionsEnded && /^[-+]/.test(arg)) {
			const attached = /^-[A-Za-z]*c(.*)$/s.exec(arg);
			if (attached) {
				readsCommandString = true;
				// `bash -c'...'` reaches here as one token, payload attached. Whether a shell
				// accepts that or reads it as more flags, analysing the rest costs nothing.
				if (attached[1]) candidates.push(attached[1]);
			}
		} else if (readsCommandString) {
			candidates.push(arg);
		}
	}
	return candidates;
}

// Parses first, then classifies. The regex list below is kept only as a second net for text the
// tokeniser drops.
function parsedBlockReason(command, headless, depth = 0) {
	const lines = commandLines(command);
	const passes = lines.length > 1 ? [command, ...lines] : [command];
	for (const pass of passes) {
		const reason = parsedLineBlockReason(pass, headless, depth);
		if (reason) return reason;
	}
	return null;
}

function parsedLineBlockReason(command, headless, depth = 0) {
	let tokens;
	try {
		tokens = shellParse(command);
	} catch {
		return "unparseable shell command (cannot verify safety)";
	}
	for (const segment of splitOnOps(tokens, SPLIT_OPS)) {
		const reason = catastrophicSegmentReason(segment);
		if (reason) return reason;
		const payloads = nestedShellPayloads(segment);
		if (payloads.length > 0 && depth >= MAX_NEST_DEPTH) return "nested shell wrappers too deep to verify";
		for (const payload of payloads) {
			const nestedReason = parsedBlockReason(payload, headless, depth + 1);
			if (nestedReason) return nestedReason;
		}
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
	const normalizedCommand = command.replace(
		/(^|(?:&&|\|\||[;|])\s*)rtk(?:\.exe)?(?:\s+(?!-[hV]\b|--(?:help|version)\b)-[\w-]+)*\s+(?:(?:proxy|err|test|summary|run)\s+)?git\b/gi,
		"$1git");
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
