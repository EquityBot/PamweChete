import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFIER = join(ROOT, "scripts", "verify-featherless-qwen-profile.mjs");
const MODEL_ID = "OBLITERATUS/Qwen3.8-27B-OBLITERATED";

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
						parallel_tool_calls: false,
						chat_template_kwargs: { enable_thinking: false },
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
		retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 0 } },
		extensions: [
			toConfigPath(join(ROOT, "extensions", "ask-user-question.ts")),
			toConfigPath(join(ROOT, "extensions", "bash-guard")),
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

test("rejects a profile that does not explicitly disable template thinking", (context) => {
	const parent = mkdtempSync(join(tmpdir(), "pi-profile-thinking-"));
	context.after(() => rmSync(parent, { recursive: true, force: true }));
	const profile = createValidProfile(parent);
	const modelsPath = join(profile, "models.example.json");
	const models = JSON.parse(readFileSync(modelsPath, "utf8"));
	delete models.providers.featherless.models[0].samplingParams.chat_template_kwargs;
	writeFileSync(modelsPath, JSON.stringify(models, null, 2));

	const result = runVerifier(profile);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /enable_thinking/i);
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
