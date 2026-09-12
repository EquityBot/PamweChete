import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_ID = "DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NM-DAU";
const MODEL_REF = `featherless/${MODEL_ID}`;
const KEY_LIKE_PATTERN = /\b(?:rc_[A-Za-z0-9]{32,}|sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9._~+\/-]{20,}=*)/gi;
const LEAN_TOOLS = ["read", "bash", "edit", "write", "ask_user_question"];
const EXPANDED_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write", "ask_user_question"];

function requiredFile(path, label) {
	assert.ok(existsSync(path) && statSync(path).isFile(), `${label} is missing`);
	return readFileSync(path, "utf8");
}

function readJson(path, label) {
	const text = requiredFile(path, label);
	try {
		return { value: JSON.parse(text), text };
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
}

function rejectCredentialMaterial(value, location = "configuration") {
	if (Array.isArray(value)) {
		for (const item of value) rejectCredentialMaterial(item, location);
		return;
	}
	if (value && typeof value === "object") {
		for (const [key, item] of Object.entries(value)) {
			const normalised = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
			if (["apikey", "accesstoken", "refreshtoken", "authorization"].includes(normalised)) {
				throw new Error(`${location} contains an apiKey or credential field`);
			}
			rejectCredentialMaterial(item, location);
		}
		return;
	}
	if (typeof value === "string" && value.match(KEY_LIKE_PATTERN)) {
		throw new Error(`${location} contains a key-like string`);
	}
}

function collectFiles(directory) {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

function isInside(parent, child) {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function canonical(path) {
	const value = resolve(path);
	return process.platform === "win32" ? value.toLowerCase() : value;
}

// A relative entry is read against the same approved root the entry has to stay inside, so the
// profile can ship checkout-independent paths without loosening the containment check below.
function resolveConfigPath(value, base, label) {
	assert.equal(typeof value, "string", `${label} must be a path string`);
	return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function assertExactPaths(actual, expected, parent, label) {
	assert.ok(Array.isArray(actual), `${label} must be an array`);
	const resolved = actual.map((value, index) => resolveConfigPath(value, parent, `${label}[${index}]`));
	for (const path of resolved) {
		assert.ok(isInside(parent, path), `${label} contains a path outside its approved root`);
		assert.ok(existsSync(path), `${label} references a missing path`);
	}
	assert.deepEqual(resolved.map(canonical), expected.map(canonical), `${label} differs from the approved resource set`);
}

function validateModels(models) {
	rejectCredentialMaterial(models, "models.example.json");
	const provider = models.providers?.featherless;
	assert.ok(provider && typeof provider === "object", "Featherless provider is missing");
	assert.equal(provider.baseUrl, "https://api.featherless.ai/v1", "Featherless base URL differs");
	assert.equal(provider.api, "openai-completions", "Featherless API mode differs");
	assert.deepEqual(provider.compat, {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsFinishReason: false,
		maxTokensField: "max_tokens",
		requiresToolResultName: true,
		supportsStrictMode: false,
	}, "Featherless compatibility settings differ");
	assert.ok(Array.isArray(provider.models), "Featherless model list is missing");
	assert.equal(provider.models.length, 1, "Profile must declare exactly one Featherless model");
	const model = provider.models[0];
	assert.equal(model.id, MODEL_ID, "Featherless model id differs");
	assert.equal(model.reasoning, false, "Baseline model reasoning must be disabled");
	assert.deepEqual(model.input, ["text"], "Image input must stay disabled until metadata proves support");
	assert.equal(model.contextWindow, 32768, "Reusable profile context window differs");
	assert.equal(model.maxTokens, 4096, "Reusable profile output limit differs");
	// The previous model needed enable_thinking false to stop reasoning leaking ahead of its text-tool
	// envelopes. This one is the reverse: with that flag set it stops emitting native tool calls and
	// prints a <tool_call> envelope as ordinary text, inventing tool names as it goes. Leave it unset.
	assert.equal(
		model.samplingParams?.chat_template_kwargs,
		undefined,
		"chat_template_kwargs must stay unset, because enable_thinking false stops native tool calls",
	);
	assert.deepEqual(
		model.samplingParams,
		{ temperature: 0, repetition_penalty: 1.15 },
		"Sampling parameters differ from the verified set",
	);
}

function validateSettings(settings, profileDirectory) {
	rejectCredentialMaterial(settings, "settings.windows.json");
	assert.equal(settings.defaultProvider, "featherless", "Default provider differs");
	assert.equal(settings.defaultModel, MODEL_ID, "Default model differs");
	assert.equal(settings.defaultThinkingLevel, "off", "Default thinking level differs");
	assert.deepEqual(settings.enabledModels, [MODEL_REF], "Enabled model set differs");
	assert.ok(
		JSON.stringify(settings.defaultTools) === JSON.stringify(LEAN_TOOLS) ||
		JSON.stringify(settings.defaultTools) === JSON.stringify(EXPANDED_TOOLS),
		"defaultTools is neither approved benchmark candidate",
	);
	assert.equal(settings.shellPath, "C:/Program Files/Git/bin/bash.exe", "Git Bash path differs");
	assert.equal(settings.defaultProjectTrust, "ask", "Project trust default differs");
	assert.equal(settings.enableInstallTelemetry, false, "Install telemetry must be disabled");
	assert.equal(settings.compaction?.enabled, true, "Compaction must be enabled");
	assert.equal(settings.compaction?.reserveTokens, 6144, "Compaction reserve differs");
	assert.equal(settings.compaction?.keepRecentTokens, 10000, "Recent-context retention differs");
	assert.equal(settings.retry?.enabled, true, "Agent retry must be enabled");
	const agentRetryCount = settings.retry?.maxRetries;
	const agentRetryBaseDelayMs = settings.retry?.baseDelayMs;
	assert.ok(
		Number.isInteger(agentRetryCount) && agentRetryCount >= 1 && agentRetryCount <= 5 &&
			Number.isInteger(agentRetryBaseDelayMs) && agentRetryBaseDelayMs >= 1000,
		"Agent retry policy is malformed",
	);
	const agentRetryWindowMs = agentRetryBaseDelayMs * (2 ** agentRetryCount - 1);
	assert.ok(
		agentRetryWindowMs >= 35000 && agentRetryWindowMs <= 60000,
		"Agent retry window must be between 35 and 60 seconds",
	);
	assert.equal(settings.retry?.provider?.maxRetries, 2, "Provider retries must handle transient capacity failures");
	assert.ok(
		Number.isInteger(settings.retry?.provider?.maxRetryDelayMs) &&
			settings.retry.provider.maxRetryDelayMs > 0 &&
			settings.retry.provider.maxRetryDelayMs <= 30000,
		"Provider retry delay must be bounded to 30 seconds",
	);

	// RTK rewrites command output, so bash-guard has to be loaded ahead of it to classify the raw command.
	const extensionOrder = settings.extensions.map((value) => String(value).replaceAll("\\", "/"));
	assert.ok(
		extensionOrder.findIndex((path) => path.endsWith("extensions/bash-guard")) <
			extensionOrder.findIndex((path) => path.endsWith("extensions/rtk")),
		"bash-guard must load before RTK",
	);
	assertExactPaths(settings.extensions, [
		join(ROOT, "extensions", "ask-user-question.ts"),
		join(ROOT, "extensions", "bash-guard"),
		join(ROOT, "extensions", "rtk"),
		join(ROOT, "extensions", "featherless-tool-bridge"),
		join(ROOT, "extensions", "custom-header.ts"),
		join(ROOT, "extensions", "prompt-snippets"),
	], ROOT, "extensions");
	assertExactPaths(settings.prompts, [
		join(profileDirectory, "prompts", "implement.md"),
		join(profileDirectory, "prompts", "verify.md"),
	], profileDirectory, "prompts");
}

export function verifyProfile(profileDirectory) {
	assert.equal(typeof profileDirectory, "string", "profile directory argument is required");
	const profile = resolve(profileDirectory);
	assert.ok(existsSync(profile) && statSync(profile).isDirectory(), "profile directory is missing");

	for (const path of collectFiles(profile)) {
		const text = readFileSync(path, "utf8");
		if (text.match(KEY_LIKE_PATTERN)) throw new Error("profile contains a key-like string");
	}

	const agents = requiredFile(join(profile, "AGENTS.md"), "AGENTS.md");
	const wordCount = agents.trim().split(/\s+/).filter(Boolean).length;
	assert.ok(wordCount > 0 && wordCount <= 350, "AGENTS.md must contain 1 to 350 words");
	requiredFile(join(profile, "README.md"), "README.md");
	for (const name of ["implement.md", "verify.md"]) {
		const prompt = requiredFile(join(profile, "prompts", name), `prompts/${name}`);
		assert.match(prompt, /^---\r?\n[\s\S]*?\r?\n---\r?\n/, `prompts/${name} lacks frontmatter`);
		assert.match(prompt, /\bdescription:/, `prompts/${name} lacks a description`);
	}

	const models = readJson(join(profile, "models.example.json"), "models.example.json").value;
	validateModels(models);
	const settingsPath = join(profile, "settings.windows.json");
	if (!existsSync(settingsPath)) throw new Error("settings.windows.json has not been selected by the benchmark");
	const settings = readJson(settingsPath, "settings.windows.json").value;
	validateSettings(settings, profile);
}

function safeMessage(error) {
	const message = error instanceof Error ? error.message : "unknown verification failure";
	return message.replace(KEY_LIKE_PATTERN, "[REDACTED]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		verifyProfile(process.argv[2]);
		process.stdout.write("FEATHERLESS_QWEN_PROFILE_OK\n");
	} catch (error) {
		process.stderr.write(`PROFILE_INVALID: ${safeMessage(error)}\n`);
		process.exitCode = 1;
	}
}
