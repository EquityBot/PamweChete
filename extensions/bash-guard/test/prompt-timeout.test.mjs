import assert from "node:assert/strict";
import test from "node:test";

const timeoutModule = await import("../prompt-timeout.ts").catch(() => ({}));

function armTimeout(...args) {
	assert.equal(
		typeof timeoutModule.armFailClosedPromptTimeout,
		"function",
		"armFailClosedPromptTimeout must be implemented",
	);
	return timeoutModule.armFailClosedPromptTimeout(...args);
}

test("timeout settles once with the fail-closed choice", () => {
	const choices = [];
	let fire;
	const settle = armTimeout(
		(choice) => choices.push(choice),
		120_000,
		{
			setTimeout(callback) {
				fire = callback;
				return 1;
			},
			clearTimeout() {},
		},
	);

	fire();
	settle("run");

	assert.deepEqual(choices, ["timeout"]);
});

test("an explicit choice cancels the timeout path", () => {
	const choices = [];
	const cleared = [];
	let fire;
	const settle = armTimeout(
		(choice) => choices.push(choice),
		120_000,
		{
			setTimeout(callback) {
				fire = callback;
				return 7;
			},
			clearTimeout(id) {
				cleared.push(id);
			},
		},
	);

	settle("abort");
	fire();

	assert.deepEqual(choices, ["abort"]);
	assert.deepEqual(cleared, [7]);
});

test("invalid timeout values fail before a timer is armed", () => {
	let timerArmed = false;
	assert.throws(
		() => armTimeout(() => {}, 0, {
			setTimeout() {
				timerArmed = true;
			},
			clearTimeout() {},
		}),
		/positive finite number/i,
	);
	assert.equal(timerArmed, false);
});

test("blocked-command memory starts when the blocking decision is recorded", () => {
	assert.equal(
		typeof timeoutModule.rememberBlockedCommand,
		"function",
		"rememberBlockedCommand must be implemented",
	);
	const entries = new Map();
	timeoutModule.rememberBlockedCommand(entries, "git commit", () => 120_000);

	assert.equal(entries.get("git commit"), 120_000);
});
