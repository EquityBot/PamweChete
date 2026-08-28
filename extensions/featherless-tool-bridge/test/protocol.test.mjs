import assert from "node:assert/strict";
import test from "node:test";

import {
	TARGET_MODEL,
	TARGET_PROVIDER,
	bridgeAssistantMessage,
	bridgeContextForProvider,
	buildBridgeSystemPrompt,
	parseToolEnvelope,
	stripNativeToolFields,
} from "../protocol.ts";
import featherlessToolBridge from "../index.ts";

const allowedTools = ["bash", "edit", "read", "write"];

function assistantMessage(overrides = {}) {
	return {
		role: "assistant",
		provider: TARGET_PROVIDER,
		model: TARGET_MODEL,
		content: [{ type: "text", text: '{"tool":"read","args":{"path":"README.md"}}' }],
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
		...overrides,
	};
}

test("parses only an exact allowed tool envelope", () => {
	assert.deepEqual(
		parseToolEnvelope(' \n {"tool":"read","args":{"path":"README.md","limit":20}} \n', allowedTools),
		{ name: "read", arguments: { path: "README.md", limit: 20 } },
	);
});

test("accepts one exact envelope after the model's explicit reasoning delimiter", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'Planning text that is never executed.\n</think>\n\n{"tool":"read","args":{"path":"README.md"}}',
			allowedTools,
		),
		{ name: "read", arguments: { path: "README.md" } },
	);
});

test("accepts the model's single exact tool wrapper", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'<tool_call>\n{"tool":"read","args":{"path":"README.md"}}\n</tool_call>',
			allowedTools,
		),
		{ name: "read", arguments: { path: "README.md" } },
	);
});

test("accepts the model's one observed malformed closer sequence", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'<tool_call>\n{"tool":"read","args":{"path":"package.json"}}\n</invoke>\n</parameter>\n</function>\n</tool_call>',
			allowedTools,
		),
		{ name: "read", arguments: { path: "package.json" } },
	);
});

test("accepts the model's exact single-parameter bash markup", () => {
	assert.deepEqual(
		parseToolEnvelope(
			"<tool_call>\n<bash>\n<parameter=command>\nnpm run verify:summary\n</parameter>\n</function>\n</tool_call>",
			allowedTools,
		),
		{ name: "bash", arguments: { command: "npm run verify:summary" } },
	);
});

test("accepts the model's exact end-of-response tool wrapper without a closer", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'<tool_call>\n{"tool":"read","args":{"path":"package.json"}}',
			allowedTools,
		),
		{ name: "read", arguments: { path: "package.json" } },
	);
});

test("accepts the model's exact function args wrapper", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'<tool_call>\n<function=read>\n<parameter=args>\n{"path":"package.json"}\n</function>\n</tool_call>',
			allowedTools,
		),
		{ name: "read", arguments: { path: "package.json" } },
	);
});

test("accepts the model's exact function leaf-argument wrapper", () => {
	assert.deepEqual(
		parseToolEnvelope(
			"<tool_call>\n<function=read>\n<path>package.json</path>\n</function>\n</tool_call>",
			allowedTools,
		),
		{ name: "read", arguments: { path: "package.json" } },
	);
});

test("accepts the model's exact named-tool args wrapper", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'<tool_call>\n<bash>{"command":"pwd && ls -la","timeout":60}</bash>',
			allowedTools,
		),
		{ name: "bash", arguments: { command: "pwd && ls -la", timeout: 60 } },
	);
});

test("rejects unsafe function args wrapper variants", () => {
	const rejected = [
		'<tool_call>\n<function=delete_everything>\n<parameter=args>\n{}\n</function>\n</tool_call>',
		'<tool_call>\n<function=read>\n<parameter=args>\n[]\n</function>\n</tool_call>',
		'<tool_call>\n<function=read>\n<parameter=args>\n{"constructor":{"prototype":{"polluted":true}}}\n</function>\n</tool_call>',
		'<tool_call>\n<function=read>\n<parameter=args>\n{}\n<parameter=args>\n{}\n</function>\n</tool_call>',
		'<tool_call>\n<function=read>\n<parameter=args>\n{}\n</parameter>\n</function>\n</tool_call>',
	];

	for (const value of rejected) {
		assert.equal(parseToolEnvelope(value, allowedTools), undefined, value);
	}
});

test("rejects unsafe function leaf-argument wrapper variants", () => {
	const rejected = [
		"<tool_call>\n<function=delete_everything>\n<path>x</path>\n</function>\n</tool_call>",
		"<tool_call>\n<function=read>\n<constructor>x</constructor>\n</function>\n</tool_call>",
		"<tool_call>\n<function=read>\n<path>a</path>\n<path>b</path>\n</function>\n</tool_call>",
		"<tool_call>\n<function=read>\n<path><nested>x</nested></path>\n</function>\n</tool_call>",
		"<tool_call>\n<function=read>\n<path>x</wrong>\n</function>\n</tool_call>",
	];

	for (const value of rejected) {
		assert.equal(parseToolEnvelope(value, allowedTools), undefined, value);
	}
});

test("rejects unsafe named-tool args wrapper variants", () => {
	const rejected = [
		'<tool_call>\n<delete_everything>{}</delete_everything>',
		'<tool_call>\n<read>[]</read>',
		'<tool_call>\n<read>{"constructor":{"prototype":{"polluted":true}}}</read>',
		'<tool_call>\n<read>{}</write>',
		'<tool_call>\n<read>{}</read> trailing',
	];

	for (const value of rejected) {
		assert.equal(parseToolEnvelope(value, allowedTools), undefined, value);
	}
});

test("accepts one final envelope after a separate prose paragraph", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'Now I will create the file.\n\n{"tool":"write","args":{"path":"result.txt","content":"ok"}}',
			allowedTools,
		),
		{ name: "write", arguments: { path: "result.txt", content: "ok" } },
	);
});

test("accepts one final envelope after multiple brace-free prose paragraphs", () => {
	assert.deepEqual(
		parseToolEnvelope(
			'Sum is 15 and count is 5.\n\nNow I will create the file.\n\n{"tool":"write","args":{"path":"result.txt","content":"ok"}}',
			allowedTools,
		),
		{ name: "write", arguments: { path: "result.txt", content: "ok" } },
	);
});

test("rejects prose, Markdown fences, arrays and malformed JSON", () => {
	const rejected = [
		'Use this: {"tool":"read","args":{"path":"README.md"}}',
		'```json\n{"tool":"read","args":{"path":"README.md"}}\n```',
		'Planning without a delimiter. {"tool":"read","args":{"path":"README.md"}}',
		'Planning.\n</think>\n{"tool":"read","args":{}}\n{"tool":"write","args":{}}',
		'Planning.\n</think>\n{"tool":"read","args":{}} trailing prose',
		'<tool_call>\n{"tool":"read","args":{}}\n</tool_call>\n</tool_call>',
		'<tool_call>\n{"tool":"read","args":{}}\n</invoke>\n</parameter>\n</function>\n</tool_call>\n</tool_call>',
		'<tool_call>\n<read>\n<parameter=path>\nREADME.md\n</parameter>\n</function>\n</tool_call>',
		'<tool_call>\n<bash>\n<parameter=command>\nnpm test\n</parameter>\n<parameter=extra>\nbad\n</parameter>\n</function>\n</tool_call>',
		'<tool_call>\n<bash>\n<parameter=command>\n\n</parameter>\n</function>\n</tool_call>',
		'First object.\n\n{"tool":"read","args":{}}\n\n{"tool":"write","args":{}}',
		'[{"tool":"read","args":{"path":"README.md"}}]',
		'{"tool":"read","args":',
	];

	for (const value of rejected) {
		assert.equal(parseToolEnvelope(value, allowedTools), undefined, value);
	}
});

test("rejects unknown tools, extra envelope keys and non-object arguments", () => {
	const rejected = [
		'{"tool":"delete_everything","args":{}}',
		'{"tool":"read","args":{},"note":"please"}',
		'{"tool":"read","args":null}',
		'{"tool":"read","args":[]}',
		'{"tool":"read","args":"README.md"}',
	];

	for (const value of rejected) {
		assert.equal(parseToolEnvelope(value, allowedTools), undefined, value);
	}
});

test("rejects prototype-polluting argument keys at any depth", () => {
	const rejected = [
		'{"tool":"read","args":{"__proto__":{"polluted":true}}}',
		'{"tool":"read","args":{"nested":{"constructor":{"prototype":{"polluted":true}}}}}',
	];

	for (const value of rejected) {
		assert.equal(parseToolEnvelope(value, allowedTools), undefined, value);
	}
});

test("converts a target-model envelope into one Pi tool call", () => {
	const original = assistantMessage();
	const bridged = bridgeAssistantMessage(original, allowedTools, () => "fixed-id");

	assert.deepEqual(bridged, {
		...original,
		content: [
			{
				type: "toolCall",
				id: "featherless_text_fixed-id",
				name: "read",
				arguments: { path: "README.md" },
			},
		],
		stopReason: "toolUse",
	});
});

test("removes a leaked reasoning prefix from a normal final answer", () => {
	const original = assistantMessage({
		content: [{ type: "text", text: "Private reasoning.\n</think>\n\nFINAL_OK" }],
	});
	const adapted = bridgeAssistantMessage(original, allowedTools, () => "unused");

	assert.deepEqual(adapted, {
		...original,
		content: [{ type: "text", text: "FINAL_OK" }],
	});
});

test("does not bridge other models, incomplete responses or mixed content", () => {
	const rejected = [
		assistantMessage({ provider: "other" }),
		assistantMessage({ model: "other" }),
		assistantMessage({ stopReason: "length" }),
		assistantMessage({ stopReason: "error" }),
		assistantMessage({ content: [] }),
		assistantMessage({
			content: [
				{ type: "text", text: '{"tool":"read","args":{"path":"README.md"}}' },
				{ type: "text", text: "extra" },
			],
		}),
		assistantMessage({ content: [{ type: "toolCall", id: "native", name: "read", arguments: {} }] }),
	];

	for (const message of rejected) {
		assert.equal(bridgeAssistantMessage(message, allowedTools, () => "fixed-id"), undefined);
	}
});

test("builds a deterministic prompt with only active tool schemas", () => {
	const prompt = buildBridgeSystemPrompt([
		{
			name: "write",
			description: "Write a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	]);

	assert.match(prompt, /entire assistant message/i);
	assert.match(prompt, /\{"tool":"read","args":\{"path":"README\.md"\}\}/);
	assert.ok(prompt.indexOf("read:") < prompt.indexOf("write:"));
	assert.match(prompt, /parameter schemas/i);
	assert.match(prompt, /tool_result/);
	assert.doesNotMatch(prompt, /bash:/);
});

test("adapts bridged calls and results to plain provider-facing history", () => {
	const messages = [
		{ role: "user", content: "Inspect the file", timestamp: 1 },
		{
			...assistantMessage(),
			content: [
				{
					type: "toolCall",
					id: "featherless_text_call-1",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			stopReason: "toolUse",
		},
		{
			role: "toolResult",
			toolCallId: "featherless_text_call-1",
			toolName: "read",
			content: [{ type: "text", text: "# pi-smoke" }],
			isError: false,
			timestamp: 2,
		},
	];

	const adapted = bridgeContextForProvider(messages);
	assert.equal(adapted[0].role, "user");
	assert.equal(adapted[1].role, "assistant");
	assert.deepEqual(adapted[1].content, [
		{ type: "text", text: '{"tool":"read","args":{"path":"README.md"}}' },
	]);
	assert.equal(adapted[1].stopReason, "stop");
	assert.equal(adapted[2].role, "user");
	assert.deepEqual(JSON.parse(adapted[2].content), {
		tool_result: {
			tool: "read",
			status: "ok",
			content: [{ type: "text", text: "# pi-smoke" }],
		},
	});
});

test("leaves native or unrelated context messages untouched", () => {
	const nativeAssistant = assistantMessage({
		content: [{ type: "toolCall", id: "native-call", name: "read", arguments: {} }],
		stopReason: "toolUse",
	});
	const nativeResult = {
		role: "toolResult",
		toolCallId: "native-call",
		toolName: "read",
		content: [{ type: "text", text: "native" }],
		isError: false,
		timestamp: 2,
	};

	assert.deepEqual(bridgeContextForProvider([nativeAssistant, nativeResult]), [nativeAssistant, nativeResult]);
});

test("removes conflicting native tool fields without mutating the provider payload", () => {
	const payload = {
		model: TARGET_MODEL,
		messages: [{ role: "user", content: "hello" }],
		tools: [{ type: "function" }],
		tool_choice: "auto",
		parallel_tool_calls: false,
		temperature: 0,
	};

	assert.deepEqual(stripNativeToolFields(payload), {
		model: TARGET_MODEL,
		messages: [{ role: "user", content: "hello" }],
		temperature: 0,
	});
	assert.ok("tools" in payload);
	assert.equal(stripNativeToolFields("not-an-object"), "not-an-object");
});

test("wires prompt injection and message replacement through the Pi extension API", async () => {
	const handlers = new Map();
	const pi = {
		on(name, handler) {
			handlers.set(name, handler);
		},
		getActiveTools() {
			return ["read"];
		},
		getAllTools() {
			return [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
				{ name: "bash", description: "Run a command", parameters: { type: "object" } },
			];
		},
	};

	featherlessToolBridge(pi);
	assert.deepEqual([...handlers.keys()], [
		"before_agent_start",
		"context",
		"before_provider_request",
		"message_end",
	]);

	const beforeResult = await handlers.get("before_agent_start")(
		{ systemPrompt: "BASE" },
		{ model: { provider: TARGET_PROVIDER, id: TARGET_MODEL } },
	);
	assert.match(beforeResult.systemPrompt, /^BASE\n\n/);
	assert.match(beforeResult.systemPrompt, /read:/);
	assert.doesNotMatch(beforeResult.systemPrompt, /bash:/);

	const contextResult = await handlers.get("context")({ messages: [] }, {
		model: { provider: TARGET_PROVIDER, id: TARGET_MODEL },
	});
	assert.deepEqual(contextResult, { messages: [] });

	const requestResult = await handlers.get("before_provider_request")(
		{ payload: { model: TARGET_MODEL, tools: [{}], messages: [] } },
		{ model: { provider: TARGET_PROVIDER, id: TARGET_MODEL } },
	);
	assert.deepEqual(requestResult, { model: TARGET_MODEL, messages: [] });

	const messageResult = await handlers.get("message_end")({ message: assistantMessage() }, {});
	assert.equal(messageResult.message.content[0].type, "toolCall");
	assert.equal(messageResult.message.content[0].name, "read");
});
