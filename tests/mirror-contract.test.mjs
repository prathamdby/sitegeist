import assert from "node:assert/strict";
import test from "node:test";
import { MirrorAgent, reduceMirrorEvent } from "../src/pi/mirror-agent.ts";

const model = {
	id: "m",
	name: "M",
	api: "openai-completions",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const assistant = (text, extra = {}) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
	...extra,
});

function mirrorAgent() {
	return new MirrorAgent({ send() {} }, { systemPrompt: "", model, thinkingLevel: "off", messages: [] });
}

function snapshot(overrides) {
	return {
		messages: [],
		isStreaming: false,
		pendingToolCalls: [],
		model,
		thinkingLevel: "off",
		title: "Title",
		...overrides,
	};
}

test("duplicate agent_start does not double-count a run", async () => {
	const state = { messages: [], isStreaming: false, pendingToolCalls: new Set() };
	assert.equal(reduceMirrorEvent(state, { type: "agent_start" }), true);
	const partial = assistant("partial");
	state.streamingMessage = partial;
	state.errorMessage = "keep";
	assert.equal(reduceMirrorEvent(state, { type: "agent_start" }), false);
	assert.equal(state.isStreaming, true);
	assert.equal(state.streamingMessage, partial);
	assert.equal(state.errorMessage, "keep");

	const agent = mirrorAgent();
	const starts = [];
	agent.subscribe((event) => {
		if (event.type === "agent_start") starts.push(event);
	});
	await agent.applyEvent({ type: "agent_start" });
	const idle = agent.waitForIdle();
	await agent.applyEvent({ type: "agent_start" });
	assert.equal(starts.length, 1);
	assert.equal(agent.state.isStreaming, true);
	await agent.applyEvent({ type: "agent_end", messages: [] });
	await idle;
	assert.equal(agent.state.isStreaming, false);
});

test("snapshot streaming true then false synthesises the end and resyncs pendingToolCalls", async () => {
	const agent = mirrorAgent();
	const seen = [];
	agent.subscribe((event) => {
		seen.push(event.type);
	});
	const partial = assistant("partial");
	await agent.applySnapshot(snapshot({ isStreaming: true, pendingToolCalls: ["old"], streamingMessage: partial }));
	assert.equal(agent.state.isStreaming, true);
	assert.equal(agent.state.streamingMessage, partial);
	const idle = agent.waitForIdle();
	await agent.applySnapshot(
		snapshot({ isStreaming: false, pendingToolCalls: ["kept"], messages: [assistant("done")] }),
	);
	await idle;
	assert.deepEqual(seen, ["agent_start", "agent_end"]);
	assert.equal(agent.state.isStreaming, false);
	assert.deepEqual([...agent.state.pendingToolCalls], ["kept"]);
	assert.equal(agent.state.messages.length, 1);
});

test("snapshot errorMessage replaces a stale error and clears when the owner has none", async () => {
	const agent = mirrorAgent();
	await agent.applyEvent({ type: "agent_start" });
	await agent.applyEvent({
		type: "turn_end",
		message: assistant("nope", { stopReason: "error", errorMessage: "stale" }),
		toolResults: [],
	});
	await agent.applyEvent({ type: "agent_end", messages: [] });
	assert.equal(agent.state.errorMessage, "stale");

	await agent.applySnapshot(snapshot({ errorMessage: "owner failed" }));
	assert.equal(agent.state.errorMessage, "owner failed");

	await agent.applySnapshot(snapshot({}));
	assert.equal(agent.state.errorMessage, undefined);
});
