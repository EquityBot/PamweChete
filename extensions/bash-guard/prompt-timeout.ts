export type PromptChoice = "run" | "abort" | "timeout";

type TimerHandle = ReturnType<typeof setTimeout>;

type PromptTimers = {
	setTimeout: (callback: () => void, timeoutMs: number) => TimerHandle;
	clearTimeout: (handle: TimerHandle) => void;
};

const REAL_TIMERS: PromptTimers = {
	setTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
	clearTimeout: (handle) => clearTimeout(handle),
};

export function armFailClosedPromptTimeout(
	done: (choice: PromptChoice) => void,
	timeoutMs: number,
	timers: PromptTimers = REAL_TIMERS,
): (choice: PromptChoice) => void {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new TypeError("timeoutMs must be a positive finite number");
	}

	let settled = false;
	let timer: TimerHandle | undefined;
	const settle = (choice: PromptChoice) => {
		if (settled) return;
		settled = true;
		if (timer !== undefined) timers.clearTimeout(timer);
		done(choice);
	};

	timer = timers.setTimeout(() => settle("timeout"), timeoutMs);
	return settle;
}

export function rememberBlockedCommand(
	entries: Map<string, number>,
	command: string,
	now: () => number = Date.now,
): void {
	entries.set(command, now());
}
