import assert from "node:assert/strict";
import test from "node:test";
import { NativeInputEventsRuntimeProvider } from "../src/tools/NativeInputEventsRuntimeProvider.ts";
import { registerOverlayAbortHandler } from "../src/tools/repl/overlay-abort.ts";

test("native cancellation releases an in-flight key pair, stops later input and detaches the original tab", async () => {
	const previous = globalThis.chrome;
	const controller = new AbortController();
	const commands = [];
	const detached = [];
	let queries = 0;
	globalThis.chrome = {
		runtime: {},
		tabs: {
			query: async () => {
				queries++;
				return [{ id: 99 }];
			},
		},
		debugger: {
			attach: (_target, _version, callback) => callback(),
			sendCommand: async (target, method, params) => {
				commands.push({ tabId: target.tabId, method, params });
				if (params.type === "keyDown") controller.abort();
				return { result: { value: true } };
			},
			detach: async (target) => detached.push(target.tabId),
		},
	};
	try {
		const provider = new NativeInputEventsRuntimeProvider();
		provider.onExecutionStart("child", controller.signal);
		let response;
		await provider.handleMessage(
			{ type: "native-input", action: "type", selector: "#text", text: "abc", sandboxId: "child", runtimeTabId: 17 },
			(value) => {
				response = value;
			},
		);
		assert.equal(queries, 0);
		assert.ok(commands.every((command) => command.tabId === 17));
		assert.deepEqual(
			commands.filter((command) => command.method === "Input.dispatchKeyEvent").map((command) => command.params),
			[
				{ type: "keyDown", text: "a" },
				{ type: "keyUp", text: "a" },
			],
		);
		assert.deepEqual(detached, [17]);
		assert.equal(response.success, false);
		provider.onExecutionEnd("child");
	} finally {
		globalThis.chrome = previous;
	}
});

test("pre-aborted native execution does not query or attach", async () => {
	const previous = globalThis.chrome;
	globalThis.chrome = {
		tabs: {
			query: () => {
				throw new Error("unexpected query");
			},
		},
	};
	try {
		const provider = new NativeInputEventsRuntimeProvider();
		provider.onExecutionStart("closed", AbortSignal.abort());
		await assert.rejects(
			provider.handleMessage({ type: "native-input", action: "click", sandboxId: "closed" }, () => {}),
			{ name: "AbortError" },
		);
		provider.onExecutionEnd("closed");
	} finally {
		globalThis.chrome = previous;
	}
});

test("overlay abort uses both runtime channels, rejects foreign senders and removes its listeners", () => {
	const previous = globalThis.chrome;
	const event = () => {
		const listeners = new Set();
		return {
			listeners,
			addListener: (listener) => listeners.add(listener),
			removeListener: (listener) => listeners.delete(listener),
		};
	};
	const onMessage = event();
	const onUserScriptMessage = event();
	globalThis.chrome = { runtime: { id: "fixture-extension", onMessage, onUserScriptMessage } };
	try {
		let aborts = 0;
		const unregister = registerOverlayAbortHandler(
			() => {
				aborts++;
				return true;
			},
			() => 5,
		);
		for (const source of [onMessage, onUserScriptMessage]) {
			const listener = [...source.listeners][0];
			let response;
			listener({ type: "abort-repl" }, { id: "foreign", tab: { windowId: 5 } }, () =>
				assert.fail("foreign sender responded"),
			);
			listener({ type: "abort-repl" }, { id: "fixture-extension", tab: { windowId: 6 } }, () =>
				assert.fail("foreign window responded"),
			);
			listener({ type: "other" }, {}, () => assert.fail("wrong message responded"));
			listener({ type: "abort-repl" }, { id: "fixture-extension", tab: { windowId: 5 } }, (value) => {
				response = value;
			});
			assert.deepEqual(response, { success: true });
		}
		assert.equal(aborts, 2);
		unregister();
		assert.equal(onMessage.listeners.size, 0);
		assert.equal(onUserScriptMessage.listeners.size, 0);
	} finally {
		globalThis.chrome = previous;
	}
});
