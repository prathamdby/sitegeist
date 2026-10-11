import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ConsoleRuntimeProvider } from "../src/sandbox/ConsoleRuntimeProvider.ts";
import { RuntimeMessageBridge } from "../src/sandbox/RuntimeMessageBridge.ts";
import { RuntimeMessageRouter } from "../src/sandbox/RuntimeMessageRouter.ts";

function eventTarget() {
	const listeners = new Map();
	return {
		listeners,
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(listener);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		emit(type, event) {
			for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
		},
	};
}

function routerHarness(t) {
	const previousWindow = globalThis.window;
	const previousChrome = globalThis.chrome;
	const window = eventTarget();
	const userListeners = new Set();
	const onUserScriptMessage = {
		addListener: (listener) => userListeners.add(listener),
		removeListener: (listener) => userListeners.delete(listener),
	};
	globalThis.window = window;
	globalThis.chrome = { runtime: { onUserScriptMessage } };
	const router = new RuntimeMessageRouter();
	const ids = new Set();
	t.after(() => {
		for (const id of ids) router.unregisterSandbox(id);
		globalThis.window = previousWindow;
		globalThis.chrome = previousChrome;
	});
	return {
		router,
		window,
		userListeners,
		register(id, providers = [], consumers = [], binding) {
			ids.add(id);
			router.registerSandbox(id, providers, consumers, binding);
		},
		userMessage(message, sender, respond = () => {}) {
			return [...userListeners][0]?.(message, sender, respond);
		},
	};
}

const envelope = (sandboxId, type = "probe", extras = {}) => ({
	channel: "sitegeist-runtime",
	sandboxId,
	type,
	...extras,
});

function bridgeHarness(contextType = "sandbox-iframe", sendMessage) {
	const window = eventTarget();
	const parent = { postMessage: (message) => messages.push(message) };
	const messages = [];
	const timers = new Map();
	let nextTimer = 0;
	const originalCalls = [];
	const console = Object.fromEntries(
		["log", "warn", "error", "info"].map((method) => [method, (...args) => originalCalls.push({ method, args })]),
	);
	const chrome = { runtime: { sendMessage: sendMessage ?? (async (message) => messages.push(message)) } };
	Object.assign(window, { parent, console });
	const context = vm.createContext({
		window,
		console,
		chrome,
		setTimeout(callback, ms) {
			const id = ++nextTimer;
			timers.set(id, { callback, ms });
			return id;
		},
		clearTimeout: (id) => timers.delete(id),
	});
	vm.runInContext(RuntimeMessageBridge.generateBridgeCode({ context: contextType, sandboxId: "frame" }), context);
	return {
		window,
		parent,
		context,
		messages,
		timers,
		originalCalls,
		respond(message, extras = {}, source = parent) {
			window.emit("message", {
				source,
				data: { ...message, type: "runtime-response", success: true, ...extras },
			});
		},
		async complete(success = true) {
			try {
				await Promise.all(window.__completionCallbacks.map((callback) => callback(success)));
			} finally {
				window.__consoleRuntimeCleanup?.();
				window.__runtimeBridgeCleanup();
			}
		},
	};
}

test("router lazily installs one listener per transport and isolates registered iframe sources", async (t) => {
	const h = routerHarness(t);
	assert.equal(h.window.listeners.size, 0);
	assert.equal(h.userListeners.size, 0);
	const received = [];
	const responses = [];
	const source = { postMessage: (message) => responses.push(message) };
	const provider = {
		async handleMessage(message, respond) {
			received.push(message);
			respond({ success: true, answer: 7 });
		},
	};
	h.register("frame", [provider]);
	h.register("second");
	assert.equal(h.userMessage(envelope("frame", "probe", { messageId: "pre-iframe" }), {}), false);
	assert.equal(h.userMessage(envelope("second", "probe", { messageId: "unbound" }), {}), false);
	h.router.setSandboxIframe("frame", { contentWindow: source });
	assert.equal(h.window.listeners.get("message").size, 1);
	assert.equal(h.userListeners.size, 1);
	for (const data of [
		null,
		envelope("missing"),
		envelope("frame", "probe", { channel: "wrong" }),
		envelope("frame", "probe", { channel: undefined }),
		envelope("frame", "probe", { messageId: 1 }),
		envelope("frame", "probe", { messageId: "" }),
		envelope("frame", "runtime-response"),
		envelope("frame", "probe", { messageType: "request-response" }),
		envelope("frame", "probe", { messageType: "invalid" }),
	])
		h.window.emit("message", { data, source });
	h.window.emit("message", { data: envelope("frame"), source: {} });
	h.userMessage(envelope("frame"), {});
	assert.equal(received.length, 0);
	const request = envelope("frame", "probe", { messageId: "request" });
	h.window.emit("message", { data: request, source });
	h.window.emit("message", { data: request, source });
	assert.equal(received.length, 1);
	assert.deepEqual(responses, [{ ...request, type: "runtime-response", success: true, answer: 7 }]);
	h.router.unregisterSandbox("frame");
	assert.equal(h.window.listeners.get("message").size, 1);
	h.router.unregisterSandbox("second");
	assert.equal(h.window.listeners.get("message").size, 0);
	assert.equal(h.userListeners.size, 0);
});

test("router broadcasts to current consumers and sends at most one correlated provider response", (t) => {
	const h = routerHarness(t);
	const responses = [];
	const source = { postMessage: (message) => responses.push(message) };
	const seen = [];
	const consumer = {
		async handleMessage(message) {
			seen.push(message.type);
		},
	};
	const providers = [1, 2].map((answer) => ({
		async handleMessage(_message, respond) {
			respond({ success: true, answer });
		},
	}));
	h.register("frame", providers, [consumer]);
	h.router.setSandboxIframe("frame", { contentWindow: source });
	h.router.addConsumer("frame", consumer);
	h.window.emit("message", { source, data: envelope("frame", "first", { messageId: "1" }) });
	assert.deepEqual(seen, ["first"]);
	assert.equal(responses.length, 1);
	assert.equal(responses[0].answer, 1);
	h.router.removeConsumer("frame", consumer);
	h.window.emit("message", {
		source,
		data: envelope("frame", "fire", { messageId: "2", messageType: "fire-and-forget" }),
	});
	assert.equal(responses.length, 1);
	assert.deepEqual(seen, ["first"]);
});

test("router drops asynchronous responses after unregister, replacement, abort, or iframe replacement", async (t) => {
	const h = routerHarness(t);
	const responses = [];
	const source = { postMessage: (message) => responses.push(message) };
	for (const action of ["unregister", "replace", "abort", "iframe"]) {
		const controller = new AbortController();
		let release;
		h.register(
			"frame",
			[
				{
					handleMessage: (_message, respond) =>
						new Promise((resolve) => {
							release = () => {
								respond({ success: true });
								resolve();
							};
						}),
				},
			],
			[],
			{ signal: controller.signal },
		);
		h.router.setSandboxIframe("frame", { contentWindow: source });
		h.window.emit("message", { source, data: envelope("frame", "probe", { messageId: action }) });
		if (action === "unregister") h.router.unregisterSandbox("frame");
		if (action === "replace") h.register("frame");
		if (action === "abort") controller.abort();
		if (action === "iframe") h.router.setSandboxIframe("frame", { contentWindow: {} });
		release();
		await Promise.resolve();
	}
	assert.equal(responses.length, 0);
	const alreadyAborted = new AbortController();
	alreadyAborted.abort();
	h.register("frame", [], [], { signal: alreadyAborted.signal });
	assert.equal(h.userListeners.size, 0);
});

test("user-script routing enforces transport, tab, frame and world bindings", async (t) => {
	const h = routerHarness(t);
	const seen = [];
	const responses = [];
	let lateReply;
	h.register(
		"script",
		[
			{
				async handleMessage(message, respond) {
					seen.push(message);
					if (message.type === "hold") lateReply = respond;
					else respond({ success: true });
				},
			},
		],
		[],
		{
			transport: "user-script",
			tabId: 4,
			frameId: 0,
			worldId: "sitegeist-browser-script",
			capability: "fixture-capability",
		},
	);
	const sender = { tab: { id: 4 }, frameId: 0, userScriptWorldId: "sitegeist-browser-script" };
	const request = (id, extras = {}) =>
		envelope("script", "probe", {
			messageId: id,
			worldId: "sitegeist-browser-script",
			capability: "fixture-capability",
			...extras,
		});
	globalThis.chrome.runtime.id = "sitegeist-extension";
	assert.equal(h.userMessage(request("wrong-extension"), { ...sender, id: "other" }), false);
	assert.equal(h.userMessage(request("missing-extension"), sender), false);
	sender.id = "sitegeist-extension";
	for (const badSender of [
		{},
		{ ...sender, tab: { id: 5 } },
		{ ...sender, frameId: 1 },
		{ ...sender, userScriptWorldId: "other" },
	]) {
		assert.equal(h.userMessage(request("bad"), badSender), false);
	}
	for (const extras of [
		{ worldId: undefined },
		{ worldId: "wrong" },
		{ capability: undefined },
		{ capability: "wrong" },
	]) {
		assert.equal(h.userMessage(request("bad-binding", extras), sender), false);
	}
	h.router.setSandboxIframe("script", { contentWindow: {} });
	assert.equal(
		h.userMessage(request("valid", { runtimeTabId: 999 }), sender, (response) => responses.push(response)),
		true,
	);
	assert.equal(seen.length, 1);
	assert.equal(responses[0].messageId, "valid");
	assert.equal(seen[0].runtimeTabId, 4);
	assert.equal(Object.hasOwn(seen[0], "capability"), false);
	assert.equal(Object.hasOwn(responses[0], "capability"), false);
	assert.equal(h.userMessage(request("valid"), sender), false);
	assert.equal(seen.length, 1);
	assert.equal(h.userMessage(request("no-sender-world"), { ...sender, userScriptWorldId: undefined }), true);
	assert.equal(seen.length, 2);
	assert.equal(h.userMessage(request("wrong-channel", { channel: "other" }), sender), false);
	assert.equal(
		h.userMessage(request("late", { type: "hold" }), sender, (response) => responses.push(response)),
		true,
	);
	h.router.unregisterSandbox("script");
	lateReply({ success: true });
	assert.equal(responses.length, 1);
	h.register("iframe-only", [], [], { transport: "sandbox-iframe" });
	assert.equal(h.userMessage(envelope("iframe-only"), sender), false);
});

test("iframe bridge stringifies independently and rejects spoofed responses", async () => {
	const h = bridgeHarness();
	const result = h.window.sendRuntimeMessage({
		type: "artifact-get",
		channel: "override",
		sandboxId: "override",
		messageId: "override",
	});
	const request = h.messages[0];
	assert.equal(request.channel, "sitegeist-runtime");
	assert.equal(request.sandboxId, "frame");
	assert.notEqual(request.messageId, "override");
	for (const extras of [{ channel: "wrong" }, { sandboxId: "other" }, { messageId: "unknown" }, { type: "probe" }])
		h.respond(request, extras);
	h.respond(request, {}, {});
	assert.equal(h.timers.size, 1);
	h.respond(request, { answer: "accepted" });
	assert.equal((await result).answer, "accepted");
	assert.equal(h.timers.size, 0);
	assert.equal(h.window.listeners.get("message").size, 1);
	let completion;
	h.window.onCompleted((success) => {
		completion = success;
	});
	await h.complete();
	assert.equal(completion, true);
	assert.equal(h.window.listeners.get("message").size, 0);
});

test("bridge handles timeouts, failed responses, fire-and-forget and completion cleanup", async () => {
	const h = bridgeHarness();
	const timed = h.window.sendRuntimeMessage({ type: "probe" }, { timeoutMs: 12 });
	const rejected = assert.rejects(timed, /timed out/);
	const timer = [...h.timers.values()][0];
	assert.equal(timer.ms, 12);
	timer.callback();
	await rejected;
	assert.equal(h.timers.size, 0);
	const failed = h.window.sendRuntimeMessage({ type: "probe" });
	h.respond(h.messages.at(-1), { success: false, error: "Provider failed" });
	await assert.rejects(failed, /Provider failed/);
	const abandoned = h.window.sendRuntimeMessage({ type: "probe" });
	const completionRejected = assert.rejects(abandoned, /execution completed/);
	await h.complete();
	await completionRejected;
	assert.equal(h.timers.size, 0);
	await assert.rejects(h.window.sendRuntimeMessage({ type: "probe" }), /execution completed/);
	await h.window.sendRuntimeMessage({ type: "execution-complete" }, "fire-and-forget");
	assert.equal(h.messages.at(-1).messageType, "fire-and-forget");
	assert.equal(h.timers.size, 0);
	await assert.rejects(
		h.window.sendRuntimeMessage({ type: "probe" }, { type: "wrong" }),
		/Invalid runtime message mode/,
	);
});

test("completion callbacks can perform async runtime requests before explicit cleanup", async () => {
	const h = bridgeHarness();
	let callbackSuccess;
	let callbackResult;
	h.window.onCompleted(async (success) => {
		callbackSuccess = success;
		callbackResult = await h.window.sendRuntimeMessage({ type: "artifact-update" });
	});
	const completion = h.complete(false);
	assert.equal(h.timers.size, 1);
	assert.equal(h.window.listeners.get("message").size, 1);
	h.respond(h.messages.at(-1), { value: "saved" });
	await completion;
	assert.equal(callbackSuccess, false);
	assert.equal(callbackResult.value, "saved");
	assert.equal(h.timers.size, 0);
	assert.equal(h.window.listeners.get("message").size, 0);
});

test("bridge reinjection cancels old requests and removes stale completion callbacks", async () => {
	const h = bridgeHarness();
	const oldRequest = h.window.sendRuntimeMessage({ type: "probe" });
	const rejected = assert.rejects(oldRequest, /execution completed/);
	let oldCallback = false;
	h.window.onCompleted(() => {
		oldCallback = true;
	});
	vm.runInContext(
		RuntimeMessageBridge.generateBridgeCode({ context: "sandbox-iframe", sandboxId: "new-frame" }),
		h.context,
	);
	await rejected;
	assert.equal(h.timers.size, 0);
	assert.equal(h.window.listeners.get("message").size, 1);
	assert.equal(h.window.__completionCallbacks.length, 0);
	await h.complete();
	assert.equal(oldCallback, false);
});

test("user-script fire-and-forget returns without awaiting a runtime response", async () => {
	const h = bridgeHarness("user-script", () => new Promise(() => {}));
	assert.equal(await h.window.sendRuntimeMessage({ type: "console" }, { type: "fire-and-forget" }), undefined);
	assert.equal(await h.window.sendRuntimeMessage({ type: "console" }, { messageType: "fire-and-forget" }), undefined);
	assert.equal(h.timers.size, 0);
});

test("user-script bridge stamps the registration world and capability over caller-provided fields", async () => {
	const h = bridgeHarness("user-script");
	vm.runInContext(
		RuntimeMessageBridge.generateBridgeCode({
			context: "user-script",
			sandboxId: "bound",
			worldId: "world",
			capability: "fixture-capability",
		}),
		h.context,
	);
	await h.window.sendRuntimeMessage({ type: "probe", worldId: "spoof", capability: "spoof" }, "fire-and-forget");
	assert.equal(h.messages[0].sandboxId, "bound");
	assert.equal(h.messages[0].worldId, "world");
	assert.equal(h.messages[0].capability, "fixture-capability");
});

test("user-script bridge correlates authenticated runtime responses and cancels stale completions", async () => {
	let release;
	const h = bridgeHarness(
		"user-script",
		(message) =>
			new Promise((resolve) => {
				release = (extras = {}) =>
					resolve({ ...message, type: "runtime-response", success: true, value: 7, ...extras });
			}),
	);
	const result = h.window.sendRuntimeMessage({ type: "probe" });
	release();
	assert.equal((await result).value, 7);
	assert.equal(h.timers.size, 0);
	const mismatched = h.window.sendRuntimeMessage({ type: "probe" });
	const mismatchRejected = assert.rejects(mismatched, /timed out/);
	release({ messageId: "wrong" });
	await Promise.resolve();
	assert.equal(h.timers.size, 1);
	[...h.timers.values()][0].callback();
	await mismatchRejected;
	const stale = h.window.sendRuntimeMessage({ type: "probe" });
	const staleRejected = assert.rejects(stale, /execution completed/);
	await h.complete();
	release();
	await staleRejected;
	assert.equal(h.timers.size, 0);
	const transportFailure = bridgeHarness("user-script", async () => {
		throw new Error("Disconnected");
	});
	await assert.rejects(transportFailure.window.sendRuntimeMessage({ type: "probe" }), /Disconnected/);
	assert.equal(transportFailure.timers.size, 0);
});

test("console runtime captures safe logs and uncaught errors, then reports console-only completion", async () => {
	const h = bridgeHarness();
	const provider = new ConsoleRuntimeProvider();
	vm.runInContext(`(${provider.getRuntime().toString()})("frame")`, h.context);
	vm.runInContext(
		`console.log("hello", {value: 3}); console.warn("warning"); console.info(undefined); const cycle = {}; cycle.self = cycle; console.error(cycle);`,
		h.context,
	);
	assert.equal(h.originalCalls.length, 4);
	assert.equal(h.messages[0].type, "console");
	assert.equal(h.messages[0].text, 'hello {"value":3}');
	assert.equal(h.messages[2].text, "undefined");
	assert.equal(h.messages[3].text, "[object Object]");
	assert.doesNotThrow(() => structuredClone(h.messages));
	vm.runInContext(`console.log({a: 1}, undefined, null, new Error("x"))`, h.context);
	assert.equal(h.messages.at(-1).text, '{"a":1} undefined null {}');
	assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1).args.slice(0, 3))), [{ a: 1 }, null, null]);
	assert.equal(h.messages.at(-1).args[3].name, "Error");
	assert.equal(h.messages.at(-1).args[3].message, "x");
	h.window.emit("error", { message: "uncaught", error: { message: "uncaught", stack: "trace" } });
	h.window.emit("unhandledrejection", { reason: { message: "rejected", stack: "rejection trace" } });
	await h.complete(false);
	assert.equal(h.messages.at(-1).type, "console-complete");
	assert.equal(h.messages.at(-1).success, false);
	assert.equal(
		h.messages.some((message) => message.type === "execution-complete"),
		false,
	);
	assert.equal(h.window.listeners.get("error").size, 0);
	assert.equal(h.window.listeners.get("unhandledrejection").size, 0);
	for (const message of h.messages) await provider.handleMessage(message, () => {});
	assert.equal(provider.getLogs().length, 5);
	assert.equal(provider.isCompleted(), true);
	assert.deepEqual(provider.getCompletionError(), { message: "rejected", stack: "rejection trace" });
	const logs = provider.getLogs();
	logs[0].text = "mutated";
	assert.notEqual(provider.getLogs()[0].text, "mutated");
	let response;
	await provider.handleMessage({ type: "console-get-logs" }, (value) => {
		response = value;
	});
	assert.equal(response.logs.length, 5);
	provider.reset();
	assert.deepEqual(provider.getLogs(), []);
	assert.equal(provider.isCompleted(), false);
	assert.equal(provider.getCompletionError(), null);
});

test("console accepts rich execution status without hiding its error and complete helper remains available", async () => {
	const h = bridgeHarness();
	const provider = new ConsoleRuntimeProvider();
	vm.runInContext(`(${provider.getRuntime().toString()})("frame")`, h.context);
	await h.window.complete({ message: "failed", stack: "trace" }, 3);
	assert.equal(h.messages.at(-2).type, "console-complete");
	assert.equal(h.messages.at(-1).type, "execution-complete");
	assert.equal(h.messages.at(-1).returnValue, 3);
	assert.deepEqual(JSON.parse(JSON.stringify(h.messages.at(-1).error)), { message: "failed", stack: "trace" });
	await provider.handleMessage(
		{ type: "execution-complete", success: false, error: { message: "rich failure", stack: "rich trace" } },
		() => {},
	);
	assert.equal(provider.isCompleted(), true);
	assert.deepEqual(provider.getCompletionError(), { message: "rich failure", stack: "rich trace" });
});

test("console keeps capturing async completion-callback logs until explicit cleanup", async () => {
	const h = bridgeHarness();
	const provider = new ConsoleRuntimeProvider();
	vm.runInContext(`(${provider.getRuntime().toString()})("frame")`, h.context);
	h.window.onCompleted(async () => {
		const response = await h.window.sendRuntimeMessage({ type: "async-number" });
		h.window.console.log(response.value);
	});
	const completion = h.complete();
	assert.equal(h.messages[0].type, "console-complete");
	assert.equal(h.messages[1].type, "async-number");
	h.respond(h.messages[1], { value: 14 });
	await completion;
	assert.equal(h.messages[2].type, "console");
	assert.equal(h.messages[2].text, "14");
	assert.equal(h.window.listeners.get("error").size, 0);
	const count = h.messages.length;
	h.window.console.log("after cleanup");
	assert.equal(h.messages.length, count);
});

test("console runtime reinjection restores root console and prevents stacked interception", async () => {
	const h = bridgeHarness();
	const provider = new ConsoleRuntimeProvider();
	for (let i = 0; i < 2; i++) {
		vm.runInContext(
			RuntimeMessageBridge.generateBridgeCode({ context: "sandbox-iframe", sandboxId: "frame" }),
			h.context,
		);
		vm.runInContext(`(${provider.getRuntime().toString()})("frame")`, h.context);
	}
	assert.equal(h.window.listeners.get("error").size, 1);
	assert.equal(h.window.listeners.get("unhandledrejection").size, 1);
	vm.runInContext(`console.log("once")`, h.context);
	assert.equal(h.messages.length, 1);
	assert.equal(h.originalCalls.length, 1);
	await h.complete();
	assert.equal(h.window.listeners.get("error").size, 0);
	assert.equal(h.window.listeners.get("unhandledrejection").size, 0);
});

test("late callbacks and cleanup from an old console cannot replace the newer runtime", async () => {
	const h = bridgeHarness();
	const provider = new ConsoleRuntimeProvider();
	vm.runInContext(`(${provider.getRuntime().toString()})("frame")`, h.context);
	const oldCallbacks = [...h.window.__completionCallbacks];
	const oldCleanup = h.window.__consoleRuntimeCleanup;
	vm.runInContext(
		RuntimeMessageBridge.generateBridgeCode({ context: "sandbox-iframe", sandboxId: "new-frame" }),
		h.context,
	);
	vm.runInContext(`(${provider.getRuntime().toString()})("new-frame")`, h.context);
	await Promise.all(oldCallbacks.map((callback) => callback(false)));
	oldCleanup();
	assert.equal(h.messages.at(-1).sandboxId, "frame");
	vm.runInContext('console.log("new runtime")', h.context);
	assert.equal(h.messages.at(-1).sandboxId, "new-frame");
	assert.equal(h.messages.at(-1).type, "console");
	assert.equal(h.messages.at(-1).text, "new runtime");
	assert.equal(h.window.listeners.get("error").size, 1);
	await h.complete();
});
