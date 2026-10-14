import assert from "node:assert/strict";
import test from "node:test";
import {
	attachPanelToTab,
	sessionChannelName,
	sessionForGroup,
	sessionOwnerLockName,
	sessionPanelPath,
} from "../src/browser/session-panels.ts";
import {
	MirrorAgent,
	postToChannel,
	reduceMirrorEvent,
	SessionMirrorChannel,
	SessionOwnerChannel,
} from "../src/pi/mirror-agent.ts";

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

const assistant = (text) => ({
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
});

const user = (text) => ({ role: "user", content: text, timestamp: 1 });

const until = async (predicate, label) => {
	for (let i = 0; i < 200; i++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(`timed out waiting for ${label}`);
};

/** Minimal owner-side agent: real state shape, manual event emission. */
function fakeOwnerAgent() {
	const listeners = new Set();
	let idle;
	const agent = {
		state: {
			messages: [],
			isStreaming: false,
			streamingMessage: undefined,
			pendingToolCalls: new Set(),
			model,
			thinkingLevel: "medium",
		},
		aborted: 0,
		steered: [],
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		waitForIdle() {
			return idle?.promise ?? Promise.resolve();
		},
		abort() {
			agent.aborted += 1;
		},
		steer(message) {
			agent.steered.push(message);
		},
		setThinkingLevel(level) {
			agent.state.thinkingLevel = level;
		},
		async emit(event) {
			if (event.type === "agent_start") {
				agent.state.isStreaming = true;
				let resolve = () => {};
				const promise = new Promise((done) => {
					resolve = done;
				});
				idle = { promise, resolve };
			}
			if (event.type === "message_end") agent.state.messages.push(event.message);
			for (const listener of listeners) await listener(event, new AbortController().signal);
			if (event.type === "agent_end") {
				agent.state.isStreaming = false;
				idle.resolve();
				idle = undefined;
			}
		},
	};
	return agent;
}

test("attachPanelToTab skips setOptions when the tab is already registered for that session", async (t) => {
	const setOptions = [];
	const store = {};
	const previous = globalThis.chrome;
	globalThis.chrome = {
		sidePanel: {
			async setOptions(options) {
				setOptions.push(options);
			},
		},
		storage: {
			session: {
				async get(key) {
					return { [key]: store[key] };
				},
				async set(items) {
					Object.assign(store, items);
				},
			},
		},
	};
	t.after(() => {
		globalThis.chrome = previous;
	});

	await attachPanelToTab(7, "alpha");
	await attachPanelToTab(7, "alpha");
	await attachPanelToTab(7, "beta");

	assert.equal(setOptions.length, 2);
	assert.equal(setOptions[0].tabId, 7);
	assert.equal(setOptions[0].path, sessionPanelPath("alpha", 7));
	assert.equal(setOptions[0].enabled, true);
	assert.equal(setOptions[1].path, sessionPanelPath("beta", 7));
	assert.equal(store["group_panel:7"], "beta");
});

test("panel paths, lock and channel names are per session and tab", () => {
	assert.equal(sessionPanelPath("s 1", 7), "sidepanel.html?session=s%201&tabId=7");
	assert.notEqual(sessionOwnerLockName("a"), sessionOwnerLockName("b"));
	assert.notEqual(sessionChannelName("a"), sessionOwnerLockName("a"));
});

test("sessionForGroup maps a group to its session and ignores ungrouped tabs", () => {
	const assignments = { a: { groupId: 3 }, b: { groupId: 9 } };
	assert.equal(sessionForGroup(assignments, 9), "b");
	assert.equal(sessionForGroup(assignments, 4), undefined);
	assert.equal(sessionForGroup(assignments, -1), undefined);
	assert.equal(sessionForGroup(assignments, undefined), undefined);
});

test("reduceMirrorEvent tracks a run like the owner's reducer", () => {
	const state = { messages: [], isStreaming: false, pendingToolCalls: new Set() };
	reduceMirrorEvent(state, { type: "agent_start" });
	assert.equal(state.isStreaming, true);
	const partial = assistant("he");
	reduceMirrorEvent(state, { type: "message_update", message: partial });
	assert.equal(state.streamingMessage, partial);
	reduceMirrorEvent(state, { type: "tool_execution_start", toolCallId: "t1", toolName: "x", args: {} });
	assert.deepEqual([...state.pendingToolCalls], ["t1"]);
	reduceMirrorEvent(state, {
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "x",
		result: {},
		isError: false,
	});
	assert.equal(state.pendingToolCalls.size, 0);
	reduceMirrorEvent(state, { type: "message_end", message: assistant("hello") });
	assert.equal(state.streamingMessage, undefined);
	assert.equal(state.messages.length, 1);
	reduceMirrorEvent(state, { type: "agent_end", messages: state.messages });
	assert.equal(state.isStreaming, false);
});

test("postToChannel falls back to a JSON copy for uncloneable payloads", () => {
	const posted = [];
	let calls = 0;
	const channel = {
		postMessage(value) {
			calls += 1;
			structuredClone(value);
			posted.push(value);
		},
	};
	assert.equal(postToChannel(channel, { ok: 1, fn: () => {} }), true);
	assert.equal(calls, 2);
	assert.deepEqual(posted, [{ ok: 1 }]);
});

test("a mirror follows the owner's run live and forwards user actions", async (t) => {
	const name = `test-session-${Math.random()}`;
	const owner = fakeOwnerAgent();
	owner.state.messages.push(user("earlier"));
	const prompts = [];
	const titles = [];
	const models = [];
	const ownerChannel = new SessionOwnerChannel(name, {
		title: () => titles.at(-1) ?? "Title",
		prompt: async (input, images) => {
			prompts.push({ input, images });
		},
		setModel: (next) => models.push(next),
		setTitle: (title) => titles.push(title),
	});
	ownerChannel.attach(owner);

	const seen = [];
	let snapshots = 0;
	const mirror = new SessionMirrorChannel(
		name,
		(remote) => new MirrorAgent(remote, { systemPrompt: "", model, thinkingLevel: "off", messages: [] }),
		() => {
			snapshots += 1;
		},
	);
	t.after(() => {
		mirror.close();
		ownerChannel.close();
	});
	mirror.agent.subscribe((event) => {
		seen.push(event.type);
	});

	mirror.setProof(ownerChannel.proof);
	await until(() => snapshots === 1, "initial snapshot");
	assert.deepEqual(
		mirror.agent.state.messages.filter((m) => m.role !== "system").map((m) => m.content),
		["earlier"],
	);
	assert.equal(mirror.agent.title, "Title");
	assert.equal(mirror.agent.state.thinkingLevel, "medium");

	await owner.emit({ type: "agent_start" });
	await until(() => mirror.agent.state.isStreaming, "mirror streaming");
	const idle = mirror.agent.waitForIdle();
	await owner.emit({ type: "message_start", message: user("now") });
	await owner.emit({ type: "message_end", message: user("now") });
	await owner.emit({
		type: "message_update",
		message: assistant("par"),
		assistantMessageEvent: { type: "text_delta" },
	});
	await owner.emit({ type: "message_end", message: assistant("done") });
	await owner.emit({ type: "agent_end", messages: owner.state.messages });
	await idle;
	await until(() => !mirror.agent.state.isStreaming, "mirror idle");
	assert.deepEqual(seen.slice(0, 2), ["agent_start", "message_start"]);
	assert.ok(seen.includes("message_update"));
	assert.equal(seen.at(-1), "agent_end");
	const texts = mirror.agent.state.messages
		.filter((m) => m.role !== "system")
		.map((m) => (typeof m.content === "string" ? m.content : m.content[0].text));
	assert.deepEqual(texts, ["earlier", "now", "done"]);

	await mirror.agent.prompt("next");
	await until(() => prompts.length === 1, "forwarded prompt");
	assert.deepEqual(prompts[0], { input: "next", images: undefined });

	mirror.agent.abort();
	await until(() => owner.aborted === 1, "forwarded abort");

	mirror.agent.setTitle("Renamed");
	await until(() => titles.length === 1, "forwarded title");
	assert.equal(titles[0], "Renamed");

	mirror.agent.setThinkingLevel("high");
	await until(() => owner.state.thinkingLevel === "high", "forwarded thinking level");

	mirror.agent.setModel({ ...model, id: "other" });
	await until(() => models.length === 1, "forwarded model");
	assert.equal(models[0].id, "other");
});

test("a mirror joining mid-run starts in the streaming state", async (t) => {
	const name = `test-session-${Math.random()}`;
	const owner = fakeOwnerAgent();
	const ownerChannel = new SessionOwnerChannel(name, {
		title: () => "",
		prompt: async () => {},
		setModel: () => {},
		setTitle: () => {},
	});
	ownerChannel.attach(owner);
	await owner.emit({ type: "agent_start" });

	let snapshots = 0;
	const mirror = new SessionMirrorChannel(
		name,
		(remote) => new MirrorAgent(remote, { systemPrompt: "", model, thinkingLevel: "off", messages: [] }),
		() => {
			snapshots += 1;
		},
	);
	t.after(() => {
		mirror.close();
		ownerChannel.close();
	});
	await until(() => snapshots === 1, "snapshot");
	assert.equal(mirror.agent.state.isStreaming, true);
	let idle = false;
	void mirror.agent.waitForIdle().then(() => {
		idle = true;
	});
	await owner.emit({ type: "agent_end", messages: [] });
	await until(() => idle, "mirror idle after owner run ends");
});
