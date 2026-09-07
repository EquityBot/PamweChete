import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyProfile } from "../scripts/verify-featherless-qwen-profile.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIER = join(ROOT, "scripts", "verify-featherless-qwen-profile.mjs");
const MODEL_ID = "DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NM-DAU";

function toConfigPath(path) {
	return path.replaceAll("\\", "/");
}

function createValidProfile(parent) {
	const profile = join(parent, "profile");
	const prompts = join(profile, "prompts");
	mkdirSync(prompts, { recursive: true });
	writeFileSync(join(profile, "AGENTS.md"), "# Coding agreement\n\nInspect, change, verify, and report.\n");
	writeFileSync(join(profile, "README.md"), "# Test profile\n");
	writeFileSync(join(prompts, "implement.md"), "---\ndescription: Implement a scoped task\n---\nImplement $ARGUMENTS.\n");
	writeFileSync(join(prompts, "verify.md"), "---\ndescription: Verify the current work\n---\nVerify $ARGUMENTS.\n");

	writeFileSync(join(profile, "models.example.json"), JSON.stringify({
		providers: {
			featherless: {
				baseUrl: "https://api.featherless.ai/v1",
				api: "openai-completions",
				compat: {
					supportsDeveloperRole: false,
					supportsReasoningEffort: false,
					supportsFinishReason: false,
					maxTokensField: "max_tokens",
					requiresToolResultName: true,
					supportsStrictMode: false,
				},
				models: [{
					id: MODEL_ID,
					reasoning: false,
					input: ["text"],
					contextWindow: 32768,
					maxTokens: 4096,
					samplingParams: {
						temperature: 0,
						repetition_penalty: 1.15,
					},
				}],
			},
		},
	}, null, 2));

	writeFileSync(join(profile, "settings.windows.json"), JSON.stringify({
		defaultProvider: "featherless",
		defaultModel: MODEL_ID,
		defaultThinkingLevel: "off",
		enabledModels: [`featherless/${MODEL_ID}`],
		defaultTools: ["read", "bash", "edit", "write", "ask_user_question"],
		shellPath: "C:/Program Files/Git/bin/bash.exe",
		defaultProjectTrust: "ask",
		enableInstallTelemetry: false,
		compaction: { enabled: true, reserveTokens: 6144, keepRecentTokens: 10000 },
		retry: {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 5000,
			provider: { maxRetries: 2, maxRetryDelayMs: 30000 },
		},
		extensions: [
			toConfigPath(join(ROOT, "extensions", "ask-user-question.ts")),
			toConfigPath(join(ROOT, "extensions", "bash-guard")),
			toConfigPath(join(ROOT, "extensions", "rtk")),
			toConfigPath(join(ROOT, "extensions", "featherless-tool-bridge")),
			toConfigPath(join(ROOT, "extensions", "custom-header.ts")),
			toConfigPath(join(ROOT, "extensions", "prompt-snippets")),
		],
		prompts: [
			toConfigPath(join(prompts, "implement.md")),
			toConfigPath(join(prompts, "verify.md")),
		],
	}, null, 2));

	return profile;
}

function runVerifier(profile) {
	return spawnSync(process.execPath, [VERIFIER, profile], {
		cwd: ROOT,
		encoding: "utf8",
		timeout: 30_000,
		windowsHide: true,
	});
}

test("accepts an exact secret-free Featherless profile", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-valid-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const result = runVerifier(createValidProfile(parent));

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), "FEATHERLESS_QWEN_PROFILE_OK");
});

test("accepts the profile shipped in this repository on any platform", () => {
	verifyProfile(join(ROOT, "profiles", "featherless-qwen38"));
});

test("rejects RTK when it loads before bash-guard", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-extension-order-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const settingsPath = join(profile, "settings.windows.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	[settings.extensions[1], settings.extensions[2]] = [settings.extensions[2], settings.extensions[1]];
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
	const result = runVerifier(profile);

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /bash-guard must load before RTK/i);
});

test("rejects an apiKey field without echoing its value", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-secret-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const modelsPath = join(profile, "models.example.json");
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	models.providers.featherless.apiKey = "synthetic-secret";
	writeFileSync(modelsPath, JSON.stringify(models, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /apiKey/);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /synthetic-secret/);
});

test("rejects a key-like string without echoing it", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-prefix-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const synthetic = `rc_${"A".repeat(40)}`;
	writeFileSync(join(profile, "README.md"), `bad value: ${synthetic}\n`);

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /key-like/i);
	assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(synthetic));
});

// The reverse of the rule the previous model needed: setting enable_thinking false makes this model
// print a <tool_call> envelope as ordinary text instead of emitting a native tool call.
test("rejects a profile that disables template thinking", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-thinking-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const modelsPath = join(profile, "models.example.json");
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	models.providers.featherless.models[0].samplingParams.chat_template_kwargs = { enable_thinking: false };
	writeFileSync(modelsPath, JSON.stringify(models, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /chat_template_kwargs/i);
});

test("rejects a benchmark tool surface with the question tool omitted", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-tools-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const settingsPath = join(profile, "settings.windows.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	settings.defaultTools = settings.defaultTools.filter((name) => name !== "ask_user_question");
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /defaultTools/i);
});

test("rejects a profile that disables transient provider retries", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-provider-retry-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const settingsPath = join(profile, "settings.windows.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	settings.retry.provider.maxRetries = 0;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /provider retries/i);
});

test("rejects a provider retry delay above the interactive bound", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-provider-delay-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const settingsPath = join(profile, "settings.windows.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	settings.retry.provider.maxRetryDelayMs = 60001;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /retry delay/i);
});

test("rejects an agent retry window shorter than the observed capacity period", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-agent-retry-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const settingsPath = join(profile, "settings.windows.json");
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	settings.retry.maxRetries = 2;
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /retry window/i);
});
