import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";

import {
	analyzeBashCommand,
	disabledModeBlockReason,
	headlessBlockReason,
} from "./policy.ts";

type Risk = {
	severity: "high" | "medium";
	reasons: string[];
};

async function promptRunOrAbort(ctx: any, command: string, risk: Risk): Promise<"run" | "abort"> {
	if (!ctx.hasUI) return "abort";

	const reasonsText = risk.reasons.map((reason) => `• ${reason}`).join("\n");
	const body = `Command flagged as ${risk.severity.toUpperCase()} risk:\n\n${reasonsText}\n\nCommand:\n${command}`;
	const items: SelectItem[] = [
		{ value: "run", label: "Run", description: "Execute the command" },
		{ value: "abort", label: "Abort", description: "Block this command" },
	];

	const choice = await ctx.ui.custom<"run" | "abort">((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
		container.addChild(new Text(theme.fg("warning", theme.bold("Potentially destructive bash command")), 1, 0));
		container.addChild(new Text(body, 1, 0));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});

		list.onSelect = (item) => done(item.value as "run" | "abort");
		list.onCancel = () => done("abort");
		container.addChild(list);
		container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));

		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	return choice ?? "abort";
}

const subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const isSubagent = Number.isFinite(subagentDepth) && subagentDepth >= 1;
const BASH_GUARD_STATUS_KEY = " bash-guard";

export default function bashGuard(pi: ExtensionAPI) {
	if (isSubagent) {
		pi.on("tool_call", async (event) => {
			if (!isToolCallEventType("bash", event)) return;
			const reason = headlessBlockReason(event.input.command);
			if (!reason) return;
			return {
				block: true,
				reason:
					`Blocked by bash-guard: ${reason}. ` +
					"This is a non-interactive subagent session, so catastrophic or repository-changing operations are not permitted. " +
					"Propose a safer alternative or ask the parent agent to confirm with the user.",
			};
		});
		return;
	}

	pi.registerFlag("bash-guard-auto-allow", {
		description: "If set, bash-guard will not block when no UI is available (non-interactive modes).",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("bash-guard-disabled", {
		description: "Start with interactive prompts disabled; the catastrophic hard-block floor remains active.",
		type: "boolean",
		default: false,
	});

	let disabled = false;
	const showDisabledStatus = (ctx: any) => {
		const { theme } = ctx.ui;
		const badge = theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ BG OFF ")));
		ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
	};

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--bash-guard-disabled") === true) {
			disabled = true;
			showDisabledStatus(ctx);
		}
	});

	pi.registerCommand("bash-guard", {
		description: "Toggle bash-guard between interactive protection and autonomous mode for this session.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				showDisabledStatus(ctx);
				ctx.ui.notify(
					"bash-guard disabled for this session. Catastrophic operations remain hard-blocked. Run /bash-guard again to re-enable prompts.",
					"warning",
				);
				return;
			}
			ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, undefined);
			ctx.ui.notify("bash-guard re-enabled.", "info");
		},
	});

	const recentlyAborted = new Map<string, number>();
	const abortRememberMs = 60_000;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;
		const command = event.input.command;

		if (disabled) {
			const reason = disabledModeBlockReason(command);
			if (!reason) return;
			return {
				block: true,
				reason:
					`Blocked by bash-guard (disabled-mode floor): ${reason}. ` +
					"Re-enable bash-guard with /bash-guard and confirm interactively, or propose a safer alternative.",
			};
		}

		const risk = analyzeBashCommand(command) as Risk | null;
		if (!risk) return;

		const now = Date.now();
		const lastAbort = recentlyAborted.get(command);
		if (lastAbort && now - lastAbort < abortRememberMs) {
			return {
				block: true,
				reason: "Blocked by bash-guard: this exact command was aborted recently. Do not retry it unchanged.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("--bash-guard-auto-allow")) return;
		if (await promptRunOrAbort(ctx, command, risk) === "run") return;

		recentlyAborted.set(command, now);
		return {
			block: true,
			reason: "Blocked by the user via bash-guard. Ask for confirmation or propose a non-destructive alternative.",
		};
	});
}
