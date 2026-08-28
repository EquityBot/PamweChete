import { randomUUID } from "node:crypto";

export const TARGET_PROVIDER = "featherless";
export const TARGET_MODEL = "OBLITERATUS/Qwen3.8-27B-OBLITERATED";

const MAX_ENVELOPE_LENGTH = 64 * 1024;
const UNSAFE_ARGUMENT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

interface TextContent {
	type: "text";
	text: string;
}

interface BridgeAssistantMessage {
	role: string;
	provider?: string;
	model?: string;
	content?: unknown[];
	stopReason?: string;
	[key: string]: unknown;
}

interface BridgeContextMessage {
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

interface BridgeToolInfo {
	name: string;
	description?: string;
	parameters: unknown;
}

export interface ParsedToolEnvelope {
	name: string;
	arguments: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasUnsafeKey(value: unknown): boolean {
	if (Array.isArray(value)) {
		return value.some(hasUnsafeKey);
	}
	if (!isPlainObject(value)) {
		return false;
	}
	for (const [key, child] of Object.entries(value)) {
		if (UNSAFE_ARGUMENT_KEYS.has(key) || hasUnsafeKey(child)) {
			return true;
		}
	}
	return false;
}

function parseObservedBashMarkup(text: string, allowedTools: Set<string>): ParsedToolEnvelope | undefined {
	if (!allowedTools.has("bash")) {
		return undefined;
	}
	const match = text.match(
		/^<tool_call>\s*<bash>\s*<parameter=command>\s*([\s\S]*?)\s*<\/parameter>\s*<\/function>\s*<\/tool_call>$/,
	);
	const command = match?.[1]?.trim();
	if (!command || /<\/?parameter(?:=|>)|<\/?(?:tool_call|function|bash)>/i.test(command)) {
		return undefined;
	}
	return { name: "bash", arguments: { command } };
}

function unwrapObservedJsonToolCall(text: string): string | undefined {
	const malformedClosers = text.match(
		/^<tool_call>\s*(\{[\s\S]*\})\s*<\/invoke>\s*<\/parameter>\s*<\/function>\s*<\/tool_call>$/,
	);
	if (malformedClosers) {
		return malformedClosers[1].trim();
	}
	const standard = text.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/);
	return standard?.[1]?.trim();
}

export function parseToolEnvelope(text: string, allowedTools: Iterable<string>): ParsedToolEnvelope | undefined {
	if (text.length === 0 || text.length > MAX_ENVELOPE_LENGTH) {
		return undefined;
	}
	const allowedToolSet = new Set(allowedTools);
	let candidate = text.trim();
	const directBashMarkup = parseObservedBashMarkup(candidate, allowedToolSet);
	if (directBashMarkup) {
		return directBashMarkup;
	}
	if (!candidate.startsWith("{")) {
		const wrapped = unwrapObservedJsonToolCall(candidate);
		if (wrapped) {
			candidate = wrapped;
		} else {
			const reasoningEnd = candidate.lastIndexOf("</think>");
			if (reasoningEnd !== -1) {
				candidate = candidate.slice(reasoningEnd + "</think>".length).trim();
				const reasoningBashMarkup = parseObservedBashMarkup(candidate, allowedToolSet);
				if (reasoningBashMarkup) {
					return reasoningBashMarkup;
				}
				const reasoningWrapped = unwrapObservedJsonToolCall(candidate);
				if (reasoningWrapped) {
					candidate = reasoningWrapped;
				}
			} else {
				const boundaries = [...candidate.matchAll(/\r?\n\r?\n/g)];
				const lastBoundary = boundaries.at(-1);
				if (!lastBoundary || lastBoundary.index === undefined) {
					return undefined;
				}
				const prefix = candidate.slice(0, lastBoundary.index).trim();
				if (prefix.length === 0 || /[{}]|<\/?tool_call\b|```/i.test(prefix)) {
					return undefined;
				}
				candidate = candidate.slice(lastBoundary.index + lastBoundary[0].length).trim();
			}
		}
	}

	let value: unknown;
	try {
		value = JSON.parse(candidate);
	} catch {
		return undefined;
	}

	if (!isPlainObject(value)) {
		return undefined;
	}
	const keys = Object.keys(value).sort();
	if (keys.length !== 2 || keys[0] !== "args" || keys[1] !== "tool") {
		return undefined;
	}
	if (typeof value.tool !== "string" || !allowedToolSet.has(value.tool)) {
		return undefined;
	}
	if (!isPlainObject(value.args) || hasUnsafeKey(value.args)) {
		return undefined;
	}

	return { name: value.tool, arguments: value.args };
}

export function isTargetModel(provider: string | undefined, model: string | undefined): boolean {
	return provider === TARGET_PROVIDER && model === TARGET_MODEL;
}

export function bridgeAssistantMessage(
	message: BridgeAssistantMessage,
	allowedTools: Iterable<string>,
	idFactory: () => string = randomUUID,
): BridgeAssistantMessage | undefined {
	if (
		message.role !== "assistant" ||
		!isTargetModel(message.provider, message.model) ||
		message.stopReason !== "stop" ||
		!Array.isArray(message.content) ||
		message.content.length !== 1
	) {
		return undefined;
	}

	const content = message.content[0] as Partial<TextContent> | undefined;
	if (content?.type !== "text" || typeof content.text !== "string") {
		return undefined;
	}
	const envelope = parseToolEnvelope(content.text, allowedTools);
	if (!envelope) {
		const reasoningEnd = content.text.lastIndexOf("</think>");
		if (reasoningEnd === -1) {
			return undefined;
		}
		const finalText = content.text.slice(reasoningEnd + "</think>".length).trim();
		if (finalText.length === 0) {
			return undefined;
		}
		return {
			...message,
			content: [{ type: "text", text: finalText }],
		};
	}

	return {
		...message,
		content: [
			{
				type: "toolCall",
				id: `featherless_text_${idFactory()}`,
				name: envelope.name,
				arguments: envelope.arguments,
			},
		],
		stopReason: "toolUse",
	};
}

function isBridgedToolCall(value: unknown): value is {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
} {
	if (!isPlainObject(value)) {
		return false;
	}
	return value.type === "toolCall" &&
		typeof value.id === "string" &&
		value.id.startsWith("featherless_text_") &&
		typeof value.name === "string" &&
		isPlainObject(value.arguments);
}

function providerSafeToolContent(content: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(content)) {
		return [];
	}
	return content.map((item) => {
		if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") {
			return { type: "text", text: item.text };
		}
		if (isPlainObject(item) && item.type === "image" && typeof item.mimeType === "string") {
			return { type: "text", text: `[image result omitted: ${item.mimeType}]` };
		}
		return { type: "text", text: "[unsupported tool result content omitted]" };
	});
}

export function bridgeContextForProvider(messages: BridgeContextMessage[]): BridgeContextMessage[] {
	return messages.map((message) => {
		if (message.role === "assistant" && Array.isArray(message.content) && message.content.length === 1) {
			const toolCall = message.content[0];
			if (isBridgedToolCall(toolCall)) {
				return {
					...message,
					content: [
						{
							type: "text",
							text: JSON.stringify({ tool: toolCall.name, args: toolCall.arguments }),
						},
					],
					stopReason: "stop",
				};
			}
		}

		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			message.toolCallId.startsWith("featherless_text_") &&
			typeof message.toolName === "string"
		) {
			return {
				role: "user",
				content: JSON.stringify({
					tool_result: {
						tool: message.toolName,
						status: message.isError === true ? "error" : "ok",
						content: providerSafeToolContent(message.content),
					},
				}),
				timestamp: message.timestamp,
			};
		}

		return message;
	});
}

export function stripNativeToolFields(payload: unknown): unknown {
	if (!isPlainObject(payload)) {
		return payload;
	}
	const sanitized = { ...payload };
	delete sanitized.tools;
	delete sanitized.tool_choice;
	delete sanitized.parallel_tool_calls;
	return sanitized;
}

export function buildBridgeSystemPrompt(tools: BridgeToolInfo[]): string {
	const schemas = [...tools]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((tool) => `${tool.name}: ${JSON.stringify(tool.parameters)}`)
		.join("\n");

	return [
		"Featherless text-tool compatibility mode is active for this model.",
		"Native tool-call transport is disabled for this request; use only the text envelope below.",
		"If you need a tool, your entire assistant message must be exactly one JSON object with the keys tool and args.",
		'Example: {"tool":"read","args":{"path":"README.md"}}',
		"Use exactly one allowed tool per message and use the exact parameter names and types in its schema.",
		"Do not wrap the object in Markdown, add prose, add extra keys, or emit a JSON array.",
		"Never describe, announce, or promise a tool action in prose; emit its envelope and wait for the result.",
		'Completed tool output arrives as a user message with one tool_result key, for example {"tool_result":{"tool":"read","status":"ok","content":[{"type":"text","text":"..."}]}}.',
		"After each tool result, either request the next tool using the same envelope or give the final answer as normal text.",
		"Allowed active tools and parameter schemas:",
		schemas,
	].join("\n");
}
