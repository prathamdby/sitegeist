import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { NativeInputEventsRuntimeProvider } from "../src/tools/NativeInputEventsRuntimeProvider.ts";
import {
	createOverlayAbortRequest,
	registerOverlayAbortHandler,
	relayOverlayAbortMessage,
	removeOverlayAbortRequest,
} from "../src/tools/repl/overlay-abort.ts";
import { removeOverlayScript } from "../src/tools/repl/overlay-content.ts";

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

test("overlay abort authenticates owning tab/run on both channels, rejects replays and removes listeners", () => {
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
			const request = createOverlayAbortRequest(17, 5);
			const sender = { id: "fixture-extension", frameId: 0, tab: { id: 17, windowId: 5 } };
			let response;
			listener(request, { ...sender, id: "foreign" }, () => assert.fail("foreign sender responded"));
			listener(request, { ...sender, tab: { id: 17, windowId: 6 } }, () => assert.fail("foreign window responded"));
			for (const changed of [
				{ type: "other" },
				{ channel: "wrong" },
				{ requestId: "wrong" },
				{ capability: "wrong" },
			]) {
				listener({ ...request, ...changed }, sender, () => assert.fail("wrong envelope responded"));
			}
			listener(request, { ...sender, tab: { id: 18, windowId: 5 } }, () => assert.fail("wrong tab responded"));
			listener(request, { ...sender, frameId: 1 }, () => assert.fail("wrong frame responded"));
			listener(request, sender, (value) => {
				response = value;
			});
			assert.deepEqual(response, { success: true });
			listener(request, sender, () => assert.fail("replayed Stop responded"));
			removeOverlayAbortRequest(17, request.requestId);
		}
		assert.equal(aborts, 2);
		unregister();
		assert.equal(onMessage.listeners.size, 0);
		assert.equal(onUserScriptMessage.listeners.size, 0);
	} finally {
		globalThis.chrome = previous;
	}
});

test("overlay relay retains trusted tab metadata and expired cleanup cannot cancel a newer run", () => {
	const previous = globalThis.chrome;
	const listeners = new Set();
	const event = {
		addListener: (listener) => listeners.add(listener),
		removeListener: (listener) => listeners.delete(listener),
	};
	globalThis.chrome = { runtime: { id: "fixture-extension", onMessage: event, onUserScriptMessage: event } };
	try {
		let aborts = 0;
		const unregister = registerOverlayAbortHandler(
			() => {
				aborts++;
				return true;
			},
			() => 5,
		);
		const sender = { id: "fixture-extension", frameId: 0, tab: { id: 17, windowId: 5 } };
		const old = createOverlayAbortRequest(17, 5);
		const current = createOverlayAbortRequest(17, 5);
		assert.equal(removeOverlayAbortRequest(17, old.requestId), false);
		const listener = [...listeners][0];
		listener(relayOverlayAbortMessage(old, sender), { id: "fixture-extension" }, () =>
			assert.fail("expired relay responded"),
		);
		let response;
		const relay = relayOverlayAbortMessage({ ...current, overlayTabId: 99 }, sender);
		assert.equal(relay.overlayTabId, 17);
		listener(relay, { id: "fixture-extension" }, (value) => {
			response = value;
		});
		assert.deepEqual(response, { success: true });
		assert.equal(aborts, 1);
		assert.equal(relayOverlayAbortMessage(current, { ...sender, id: "foreign" }), undefined);
		assert.equal(relayOverlayAbortMessage(current, { ...sender, frameId: 1 }), undefined);
		removeOverlayAbortRequest(17, current.requestId);
		listener(current, sender, () => assert.fail("closed run responded"));
		let removed = 0;
		const element = {
			dataset: { sitegeistRequestId: current.requestId },
			remove: () => {
				removed++;
			},
		};
		const context = vm.createContext({ document: { getElementById: () => element } });
		vm.runInContext(removeOverlayScript(old.requestId), context);
		assert.equal(removed, 0);
		vm.runInContext(removeOverlayScript(current.requestId), context);
		assert.equal(removed, 1);
		unregister();
	} finally {
		globalThis.chrome = previous;
	}
});

test("native click/type selectors stay data in debugger expressions, including error text", async () => {
	const previous = globalThis.chrome;
	const selector = `[data-missing="' + (window.selectorInjected = true) + '"]`;
	const evaluated = [];
	const context = vm.createContext({
		window: {},
		document: {
			querySelector: (value) => {
				assert.equal(value, selector);
				return null;
			},
		},
	});
	globalThis.chrome = {
		runtime: {},
		debugger: {
			attach: (_target, _version, callback) => callback(),
			sendCommand: async (_target, method, params) => {
				assert.equal(method, "Runtime.evaluate");
				evaluated.push(params.expression);
				try {
					vm.runInContext(params.expression, context);
				} catch (error) {
					return { exceptionDetails: { exception: { description: error.message } } };
				}
			},
			detach: async () => {},
		},
	};
	try {
		const provider = new NativeInputEventsRuntimeProvider();
		for (const action of ["click", "type"]) {
			let response;
			await provider.handleMessage(
				{ type: "native-input", action, selector, text: "never", runtimeTabId: 17 },
				(value) => {
					response = value;
				},
			);
			assert.equal(response.success, false);
			assert.equal(response.error, `Selector not found: ${selector}`);
			assert.equal(context.window.selectorInjected, undefined);
			await provider.handleMessage({ type: "native-input", action, selector: null }, (value) => {
				response = value;
			});
			assert.deepEqual(response, { success: false, error: "Selector must be a string" });
		}
		assert.equal(evaluated.length, 2);
	} finally {
		globalThis.chrome = previous;
	}
});
