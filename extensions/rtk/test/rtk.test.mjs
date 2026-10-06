import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, "..", "index.ts");
const PINNED_HOOK_SHA256 = "1ce1bee849472954eff6bda492ac39c2ae5d0645ee1ecf262b721541fc61a1fe";

const rtkModule = await import("../index.ts").catch(() => ({}));

function extensionFactory() {
	assert.equal(typeof rtkModule.default, "function", "the RTK extension must export a default factory");
	return rtkModule.default;
}

test("local hook matches its recorded LF-normalised digest", () => {
	assert.equal(existsSync(INDEX_PATH), true, "the vendored RTK hook is missing");
	const digest = createHash("sha256").update(readFileSync(INDEX_PATH, "utf8").replaceAll("\r\n", "\n")).digest("hex");
	assert.equal(digest, PINNED_HOOK_SHA256);
});

async function loadExtension({
	version = { code: 0, stdout: "rtk 0.46.0\n", stderr: "", killed: false },
	rewrite = { code: 3, stdout: "rtk git status --short\n", stderr: "", killed: false },
} = {}) {
	const handlers = new Map();
	const calls = [];
	const pi = {
		async exec(command, args, options) {
			calls.push({ command, args, options });
			return args[0] === "--version" ? version : rewrite;
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
	};

	await extensionFactory()(pi);
	return { calls, handlers };
}

async function captureWarnings(callback) {
	const previous = console.warn;
	const warnings = [];
	console.warn = (...parts) => warnings.push(parts.map(String).join(" "));
	try {
		return { value: await callback(), warnings };
	} finally {
		console.warn = previous;
	}
}

test("a supported advisory rewrite mutates the real Bash event", async () => {
	const { calls, handlers } = await loadExtension();
	const event = { toolName: "bash", input: { command: "git status --short" } };
	await handlers.get("tool_call")(event, { signal: new AbortController().signal });

	assert.equal(event.input.command, "rtk git status --short");
	assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
		["rtk", ["--version"]],
		["rtk", ["rewrite", "git status --short"]],
	]);
});

test("non-Bash and already-RTK commands bypass rewriting", async () => {
	const { calls, handlers } = await loadExtension();
	const handler = handlers.get("tool_call");
	const readEvent = { toolName: "read", input: { path: "README.md" } };
	const rtkEvent = { toolName: "bash", input: { command: "rtk git status" } };

	await handler(readEvent, { signal: new AbortController().signal });
	await handler(rtkEvent, { signal: new AbortController().signal });

	assert.equal(rtkEvent.input.command, "rtk git status");
	assert.equal(calls.length, 1);
});

test("missing, killed and unsupported rewrites fail open", async (context) => {
	for (const rewrite of [
		{ code: 1, stdout: "", stderr: "", killed: false },
		{ code: 0, stdout: "rtk git status\n", stderr: "", killed: true },
		{ code: 2, stdout: "rtk git status\n", stderr: "bad", killed: false },
	]) {
		await context.test(`code=${rewrite.code} killed=${rewrite.killed}`, async () => {
			const { handlers } = await loadExtension({ rewrite });
			const event = { toolName: "bash", input: { command: "git status" } };
			await handlers.get("tool_call")(event, { signal: new AbortController().signal });
			assert.equal(event.input.command, "git status");
		});
	}
});

test("RTK_DISABLED bypasses rewriting without disabling the version probe", { concurrency: false }, async () => {
	const previous = process.env.RTK_DISABLED;
	process.env.RTK_DISABLED = "1";
	try {
		const { calls, handlers } = await loadExtension();
		const event = { toolName: "bash", input: { command: "git status" } };
		await handlers.get("tool_call")(event, { signal: new AbortController().signal });
		assert.equal(event.input.command, "git status");
		assert.equal(calls.length, 1);
	} finally {
		if (previous === undefined) delete process.env.RTK_DISABLED;
		else process.env.RTK_DISABLED = previous;
	}
});

test("an RTK version older than the pinned release registers no handler", { concurrency: false }, async (context) => {
	for (const stdout of ["rtk 0.22.9\n", "rtk 0.45.9\n"]) {
		await context.test(stdout.trim(), async () => {
			const { value: { calls, handlers }, warnings } = await captureWarnings(() => loadExtension({
				version: { code: 0, stdout, stderr: "", killed: false },
			}));

			assert.deepEqual([...handlers.keys()], []);
			assert.equal(calls.length, 1);
			assert.match(warnings.join("\n"), /too old \(need >= 0\.46\.0\)/i);
		});
	}
});

test("a missing RTK binary registers no handler", { concurrency: false }, async () => {
	const { value: { handlers }, warnings } = await captureWarnings(() => loadExtension({
		version: { code: 127, stdout: "", stderr: "not found", killed: false },
	}));

	assert.deepEqual([...handlers.keys()], []);
	assert.match(warnings.join("\n"), /not found/i);
});

// Drives the hook with a real rtk binary. CI installs the pinned release and sets
// RTK_CONTRACT_BIN; locally, point it at any rtk build to check that build's contract.
const CONTRACT_BIN = process.env.RTK_CONTRACT_BIN;

test("the hook keeps its contract with a real rtk binary", { concurrency: false, skip: CONTRACT_BIN ? false : "RTK_CONTRACT_BIN is not set" }, async () => {
	const home = mkdtempSync(join(tmpdir(), "rtk-contract-"));
	const env = {
		...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local", "share"), APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
	};
	delete env.RTK_DISABLED;
	const handlers = new Map();
	const pi = {
		async exec(_command, args, options) {
			const run = spawnSync(CONTRACT_BIN, args, { env, encoding: "utf8", timeout: options?.timeout });
			return { code: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "", killed: run.signal !== null };
		},
		on(name, handler) {
			handlers.set(name, handler);
		},
	};
	await extensionFactory()(pi);
	assert.equal(handlers.has("tool_call"), true, "the real rtk version was rejected");

	async function hook(command) {
		const event = { toolName: "bash", input: { command } };
		await handlers.get("tool_call")(event, { signal: new AbortController().signal });
		return event.input.command;
	}

	assert.equal(await hook("git status --short"), "rtk git status --short");
	assert.equal(await hook('git log --format="%h %s" -3'), 'rtk git log --format="%h %s" -3');
	assert.equal(await hook("cd sub && git status"), "cd sub && rtk git status");
	assert.equal(await hook("FOO=1 git status"), "FOO=1 rtk git status");
	for (const unchanged of ["echo hello", "cat <<'EOF'\nhi\nEOF", "rm -rf build", "rtk git status"]) {
		assert.equal(await hook(unchanged), unchanged);
	}
	// 0.46.0 passes a pipeline through; later releases rewrite its first command.
	assert.ok(["git status | head -5", "rtk git status | head -5"].includes(await hook("git status | head -5")));
});
