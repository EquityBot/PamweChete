import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, "..", "index.ts");
const PINNED_HOOK_SHA256 = "48f07e4fd8e38b350cae84fe0116d2bc29932d535e333a307cb9e477f5272de6";

const rtkModule = await import("../index.ts").catch(() => ({}));

function extensionFactory() {
	assert.equal(typeof rtkModule.default, "function", "the RTK extension must export a default factory");
	return rtkModule.default;
}

test("vendored hook bytes match the pinned upstream commit", () => {
	assert.equal(existsSync(INDEX_PATH), true, "the vendored RTK hook is missing");
	const digest = createHash("sha256").update(readFileSync(INDEX_PATH)).digest("hex");
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

test("an RTK version older than rewrite support registers no handler", { concurrency: false }, async () => {
	const { value: { calls, handlers }, warnings } = await captureWarnings(() => loadExtension({
		version: { code: 0, stdout: "rtk 0.22.9\n", stderr: "", killed: false },
	}));

	assert.deepEqual([...handlers.keys()], []);
	assert.equal(calls.length, 1);
	assert.match(warnings.join("\n"), /too old/i);
});

test("a missing RTK binary registers no handler", { concurrency: false }, async () => {
	const { value: { handlers }, warnings } = await captureWarnings(() => loadExtension({
		version: { code: 127, stdout: "", stderr: "not found", killed: false },
	}));

	assert.deepEqual([...handlers.keys()], []);
	assert.match(warnings.join("\n"), /not found/i);
});
