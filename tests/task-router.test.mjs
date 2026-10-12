import assert from "node:assert/strict";
import test from "node:test";
import { deliverRunnerMessage } from "../src/tasks/router.ts";

function endpoint() {
	const messages = [];
	return { messages, postMessage: (message) => messages.push(message) };
}

test("a prompt reaches only the runner for that tab", () => {
	const first = endpoint();
	const second = endpoint();
	const view = endpoint();
	const runners = new Map([
		[1, first],
		[2, second],
	]);
	const views = new Map([[1, new Set([view])]]);
	deliverRunnerMessage(runners, views, 1, "view", { type: "prompt", text: "open example" });
	assert.deepEqual(first.messages, [{ type: "prompt", text: "open example" }]);
	assert.deepEqual(second.messages, []);
	assert.deepEqual(view.messages, []);
});

test("a view disconnect leaves the runner, and a new view receives the snapshot", () => {
	const runner = endpoint();
	const firstView = endpoint();
	const secondView = endpoint();
	const views = new Set([firstView]);
	const runners = new Map([[4, runner]]);
	const viewMap = new Map([[4, views]]);
	views.delete(firstView);
	deliverRunnerMessage(runners, viewMap, 4, "runner", { type: "snapshot", messages: ["kept"] });
	assert.deepEqual(firstView.messages, []);
	assert.equal(runners.has(4), true);
	views.add(secondView);
	deliverRunnerMessage(runners, viewMap, 4, "runner", { type: "snapshot", messages: ["kept"] });
	assert.deepEqual(secondView.messages, [{ type: "snapshot", messages: ["kept"] }]);
	assert.deepEqual(runner.messages, []);
});
