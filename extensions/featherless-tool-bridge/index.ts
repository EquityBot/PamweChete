import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	bridgeAssistantMessage,
	bridgeContextForProvider,
	buildBridgeSystemPrompt,
	isTargetModel,
	stripNativeToolFields,
} from "./protocol.ts";

export default function featherlessToolBridge(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event, ctx) => {
		if (!isTargetModel(ctx.model?.provider, ctx.model?.id)) {
			return;
		}

		const activeTools = new Set(pi.getActiveTools());
		const toolInfo = pi.getAllTools().filter((tool) => activeTools.has(tool.name));
		if (toolInfo.length === 0) {
			return;
		}

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildBridgeSystemPrompt(toolInfo)}`,
		};
	});

	pi.on("context", (event, ctx) => {
		if (!isTargetModel(ctx.model?.provider, ctx.model?.id)) {
			return;
		}
		return { messages: bridgeContextForProvider(event.messages) as typeof event.messages };
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isTargetModel(ctx.model?.provider, ctx.model?.id)) {
			return;
		}
		return stripNativeToolFields(event.payload);
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") {
			return;
		}

		const bridged = bridgeAssistantMessage(event.message, pi.getActiveTools());
		if (!bridged) {
			return;
		}

		return { message: bridged as typeof event.message };
	});
}
