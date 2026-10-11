import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { RuntimeMessageBridge } from "../src/sandbox/RuntimeMessageBridge.ts";
import { RUNTIME_MESSAGE_ROUTER } from "../src/sandbox/RuntimeMessageRouter.ts";
import { SitegeistAppStorage, setAppStorage } from "../src/storage/app-storage.ts";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "../src/tools/repl/runtime-providers.ts";
import { buildWrapperCode, requestUserScriptsPermission } from "../src/tools/repl/userscripts-helpers.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const worldId = "sitegeist-browser-script";
const tick = () => new Promise((resolve) => setImmediate(resolve));

class ChromeEvent {
	listeners = new Set();
	addListener(listener) {
		this.listeners.add(listener);
	}
	removeListener(listener) {
		this.listeners.delete(listener);
	}
	emit(...args) {
		return [...this.listeners].map((listener) => listener(...args));
	}
}

function harness(options = {}) {
	const onUserScriptMessage = new ChromeEvent();
	const onActivated = new ChromeEvent();
	const onRemoved = new ChromeEvent();
	const window = new EventTarget();
	const chrome = {
		runtime: { id: "runtime-fixture", onUserScriptMessage },
		tabs: {
			onActivated,
			onRemoved,
			query: options.query ?? (async () => [{ id: 7, windowId: 1, url: "https://fixture.invalid" }]),
		},
		userScripts: {
			configureWorld: async () => {},
			execute: options.execute ?? (async () => [{ result: { success: true, lastValue: 42 } }]),
			...options.userScripts,
		},
	};
	globalThis.window = window;
	globalThis.chrome = chrome;
	globalThis.indexedDB = new IDBFactory();
	globalThis.IDBKeyRange = IDBKeyRange;
	const storage = new SitegeistAppStorage();
	setAppStorage(storage);
	return { chrome, window, onUserScriptMessage, onActivated, onRemoved, storage };
}

function browserCall(provider, sandboxId = "parent-execution") {
	const responses = [];
	const done = provider.handleMessage(
		{ type: "browser-js", sandboxId, code: "async () => 42", args: "[]" },
		(response) => responses.push(response),
	);
	return { responses, done };
}

async function eventually(predicate) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.ok(predicate(), "Expected async fixture condition");
}

test("browserjs unregisters, settles once, and terminates the original tab on abort", async () => {
	let injected;
	let complete;
	const terminated = [];
	const h = harness({
		execute: (config) => {
			injected = config;
			return new Promise((resolve) => {
				complete = resolve;
			});
		},
		userScripts: { terminate: async (...args) => terminated.push(args) },
	});
	const provider = new BrowserJsRuntimeProvider([]);
	const controller = new AbortController();
	provider.onExecutionStart("parent-execution", controller.signal);
	const call = browserCall(provider);
	await eventually(() => !!injected);
	assert.equal(injected.target.tabId, 7);
	assert.equal(injected.worldId, worldId);
	assert.equal(h.onUserScriptMessage.listeners.size, 1);
	controller.abort();
	await call.done;
	assert.equal(call.responses[0].cancelled, true);
	assert.deepEqual(terminated, [[7, injected.executionId]]);
	assert.equal(h.onUserScriptMessage.listeners.size, 0);
	assert.equal(h.onActivated.listeners.size, 0);
	assert.equal(h.onRemoved.listeners.size, 0);
	complete([{ result: { success: true, lastValue: "late" } }]);
	await tick();
	assert.equal(call.responses.length, 1);
	provider.onExecutionEnd("parent-execution");
});

test("browserjs cancellation without terminate cleans up on tab/session/provider changes", async (t) => {
	for (const reason of ["abort", "tab", "closed-tab", "session", "provider"]) {
		await t.test(reason, async () => {
			let injected = false;
			const h = harness({
				execute: () => {
					injected = true;
					return new Promise(() => {});
				},
			});
			const provider = new BrowserJsRuntimeProvider([]);
			const controller = new AbortController();
			provider.onExecutionStart("parent-execution", controller.signal);
			const call = browserCall(provider);
			await eventually(() => injected);
			h.onActivated.emit({ tabId: 8, windowId: 99 });
			await tick();
			assert.equal(call.responses.length, 0, "Other windows must not cancel this execution");
			if (reason === "abort") controller.abort();
			if (reason === "tab") h.onActivated.emit({ tabId: 8, windowId: 1 });
			if (reason === "closed-tab") h.onRemoved.emit(7);
			if (reason === "session") provider.onExecutionEnd("parent-execution");
			if (reason === "provider") provider.cleanupAll();
			await call.done;
			assert.equal(call.responses.length, 1);
			assert.equal(call.responses[0].cancelled, true);
			assert.equal(h.onUserScriptMessage.listeners.size, 0);
			assert.equal(h.onActivated.listeners.size, 0);
			assert.equal(h.onRemoved.listeners.size, 0);
		});
	}
});

test("a pre-aborted call or abort during tab lookup never registers or injects", async () => {
	for (const beforeStart of [true, false]) {
		let resolveQuery;
		let executions = 0;
		const h = harness({
			query: () =>
				new Promise((resolve) => {
					resolveQuery = resolve;
				}),
			execute: async () => {
				executions++;
				return [];
			},
		});
		const provider = new BrowserJsRuntimeProvider([]);
		const controller = new AbortController();
		provider.onExecutionStart("parent-execution", controller.signal);
		if (beforeStart) controller.abort();
		const call = browserCall(provider);
		if (!beforeStart) {
			await eventually(() => !!resolveQuery);
			controller.abort();
		}
		await call.done;
		resolveQuery?.([{ id: 7, windowId: 1, url: "https://fixture.invalid" }]);
		await tick();
		assert.equal(call.responses[0].cancelled, true);
		assert.equal(executions, 0);
		assert.equal(h.onUserScriptMessage.listeners.size, 0);
	}
});

test("browser children start/end shared provider lifecycles with an aborted cleanup signal", async () => {
	let injected = false;
	const h = harness({
		execute: () => {
			injected = true;
			return new Promise(() => {});
		},
	});
	const events = [];
	const shared = {
		getData: () => ({}),
		getRuntime: () => (_id) => {},
		onExecutionStart(id, signal) {
			events.push({ kind: "start", id, signal });
		},
		onExecutionEnd(id) {
			events.push({ kind: "end", id });
		},
	};
	const provider = new BrowserJsRuntimeProvider([shared]);
	const call = browserCall(provider);
	await eventually(() => injected);
	provider.cleanupAll();
	await call.done;
	assert.equal(events.length, 2);
	assert.equal(events[0].kind, "start");
	assert.equal(events[1].kind, "end");
	assert.equal(events[0].id, events[1].id);
	assert.equal(events[0].signal.aborted, true);
	assert.equal(h.onUserScriptMessage.listeners.size, 0);
});

test("abort during skill lookup or world configuration prevents late injection", async () => {
	for (const phase of ["skills", "world"]) {
		let entered = false;
		let finish;
		let executions = 0;
		const pending = () => {
			entered = true;
			return new Promise((resolve) => {
				finish = resolve;
			});
		};
		const h = harness({
			execute: async () => {
				executions++;
				return [];
			},
		});
		if (phase === "skills") h.storage.skills.getSkillsForUrl = pending;
		else h.chrome.userScripts.configureWorld = pending;
		const provider = new BrowserJsRuntimeProvider([]);
		const controller = new AbortController();
		provider.onExecutionStart("parent-execution", controller.signal);
		const call = browserCall(provider);
		await eventually(() => entered);
		controller.abort();
		await call.done;
		finish(phase === "skills" ? [] : undefined);
		await tick();
		assert.equal(executions, 0);
		assert.equal(call.responses[0].cancelled, true);
		assert.equal(h.onUserScriptMessage.listeners.size, 0);
		assert.equal(h.onActivated.listeners.size, 0);
	}
});

test("wrapper async arguments/skills and completion cleanup work on success and error", async () => {
	for (const code of [
		"async value => { console.log(value); return fixtureSkill(value); }",
		"async () => { throw new Error('fixture failure'); }",
	]) {
		harness();
		const timers = new Set();
		const window = Object.assign(new EventTarget(), { __completionCallbacks: [async () => {}] });
		const wrapper = buildWrapperCode(code, "const fixtureSkill = value => value * 2;", false, [], "wrapper", [21], {
			transport: "user-script",
			tabId: 7,
			frameId: 0,
			worldId,
		});
		const result = await runInNewContext(wrapper, {
			__name: (fn) => fn,
			window,
			console: { log() {}, error() {} },
			setTimeout(callback, delay) {
				const timer = setTimeout(callback, delay);
				timers.add(timer);
				return timer;
			},
			clearTimeout(timer) {
				timers.delete(timer);
				clearTimeout(timer);
			},
		});
		assert.equal(result.success, !code.includes("throw"));
		if (result.success) assert.equal(result.lastValue, 42);
		else assert.equal(result.error, "fixture failure");
		assert.equal(timers.size, 0);
		RUNTIME_MESSAGE_ROUTER.unregisterSandbox("wrapper");
	}
});

test("a late user-script wrapper runs only its own completion callbacks and cleanup", async () => {
	harness();
	const timers = new Set();
	const window = Object.assign(new EventTarget(), { oldCompleted: 0, newCompleted: 0, newCleaned: 0 });
	const wrapper = buildWrapperCode(
		"async () => { onCompleted(() => { window.oldCompleted++; }); await new Promise(resolve => { window.finishOld = resolve; }); return 1; }",
		"",
		false,
		[],
		"old-wrapper",
		[],
		{ transport: "user-script", tabId: 7, frameId: 0, worldId },
	);
	const pending = runInNewContext(wrapper, {
		__name: (fn) => fn,
		window,
		console: { error() {} },
		onCompleted: (callback) => window.onCompleted(callback),
		setTimeout(callback, delay) {
			const timer = setTimeout(callback, delay);
			timers.add(timer);
			return timer;
		},
		clearTimeout(timer) {
			timers.delete(timer);
			clearTimeout(timer);
		},
	});
	try {
		window.__completionCallbacks = [
			() => {
				window.newCompleted++;
			},
		];
		window.__consoleRuntimeCleanup = () => {
			window.newCleaned++;
		};
		window.__runtimeBridgeCleanup = () => {
			window.newCleaned++;
		};
		window.finishOld();
		const result = await pending;
		assert.equal(result.success, true);
		assert.equal(result.lastValue, 1);
		assert.equal(window.oldCompleted, 1);
		assert.equal(window.newCompleted, 0);
		assert.equal(window.newCleaned, 0);
		assert.equal(timers.size, 0);
	} finally {
		for (const timer of timers) clearTimeout(timer);
		RUNTIME_MESSAGE_ROUTER.unregisterSandbox("old-wrapper");
	}
});

test("bridge rejects failed requests by default but opt-out retains error console payloads", async () => {
	const window = new EventTarget();
	const timers = new Set();
	runInNewContext(RuntimeMessageBridge.generateBridgeCode({ context: "user-script", sandboxId: "raw-response" }), {
		window,
		__name: (fn) => fn,
		chrome: {
			runtime: {
				sendMessage: async (message) => ({
					...message,
					type: "runtime-response",
					success: false,
					error: "fixture error",
					console: [{ type: "error", text: "before failure" }],
				}),
			},
		},
		setTimeout(callback, delay) {
			const timer = setTimeout(callback, delay);
			timers.add(timer);
			return timer;
		},
		clearTimeout(timer) {
			timers.delete(timer);
			clearTimeout(timer);
		},
	});
	await assert.rejects(window.sendRuntimeMessage({ type: "failed-request" }), /fixture error/);
	const response = await window.sendRuntimeMessage({ type: "failed-request" }, { rejectOnError: false });
	assert.equal(response.success, false);
	assert.equal(response.error, "fixture error");
	assert.equal(response.console[0].text, "before failure");
	assert.equal(timers.size, 0);
	window.__runtimeBridgeCleanup();
});

test("Firefox permission is requested synchronously; navigation gets its execution signal", async () => {
	const h = harness();
	delete h.chrome.userScripts;
	const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
	Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Firefox/144" }, configurable: true });
	try {
		let called = false;
		h.chrome.permissions = {
			request: () => {
				called = true;
				return Promise.resolve(false);
			},
		};
		const permission = requestUserScriptsPermission();
		assert.equal(called, true);
		assert.equal((await permission).granted, false);
		const controller = new AbortController();
		let received;
		const navigation = new NavigateRuntimeProvider({
			async execute(_id, _args, signal) {
				received = signal;
				return { details: { finalUrl: "https://fixture.invalid/next", title: "Next", skills: [] } };
			},
		});
		navigation.onExecutionStart("nav", controller.signal);
		let response;
		await navigation.handleMessage(
			{ type: "navigate", sandboxId: "nav", args: { url: "https://fixture.invalid/next" } },
			(value) => {
				response = value;
			},
		);
		assert.equal(received, controller.signal);
		assert.equal(response.result.title, "Next");
		navigation.onExecutionEnd("nav");
	} finally {
		if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
		else delete globalThis.navigator;
	}
});

test("the retained no-execute fallback returns an actionable error and cleans routing", async () => {
	const h = harness({ userScripts: { execute: undefined } });
	const provider = new BrowserJsRuntimeProvider([]);
	const call = browserCall(provider);
	await call.done;
	assert.equal(call.responses[0].success, false);
	assert.match(call.responses[0].error, /Firefox is currently not supported/);
	assert.equal(h.onUserScriptMessage.listeners.size, 0);
	assert.equal(h.onActivated.listeners.size, 0);
});

test("missing Chrome execution results fail instead of returning undefined successfully", async () => {
	for (const results of [[], [{ frameId: 0 }]]) {
		const h = harness({ execute: async () => results });
		const provider = new BrowserJsRuntimeProvider([]);
		const call = browserCall(provider);
		await call.done;
		assert.deepEqual(call.responses, [
			{ success: false, error: "No result returned from script execution", console: [] },
		]);
		assert.equal(h.onUserScriptMessage.listeners.size, 0);
		assert.equal(h.onActivated.listeners.size, 0);
		assert.equal(h.onRemoved.listeners.size, 0);
	}
});

test(
	"unpacked Chromium: permission fallback, async browserjs, trusted input, navigation and sender isolation",
	{ timeout: 120000 },
	async (t) => {
		const directory = mkdtempSync(join(tmpdir(), "sitegeist-sandbox-runtime-"));
		let context;
		const server = createServer((request, response) => {
			response.setHeader("content-type", "text/html");
			response.end(`<!doctype html><title>${request.url === "/next" ? "Navigated fixture" : "Browser fixture"}</title>
<button id="trusted">Click</button><input id="text">${request.url === "/" || request.url === "/other" ? '<iframe src="/child"></iframe>' : ""}
<script>window.fixtureEvents=[]; document.querySelector('#trusted').addEventListener('click', event => fixtureEvents.push({type:'click',trusted:event.isTrusted})); document.querySelector('#text').addEventListener('input', event => fixtureEvents.push({type:'input',trusted:event.isTrusted}));</script>`);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const extension = join(directory, "extension");
			mkdirSync(extension);
			const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
			writeFileSync(
				join(extension, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					minimum_chrome_version: manifest.minimum_chrome_version,
					name: "Sandbox runtime migration fixture",
					version: "1.0.0",
					background: { service_worker: "background.js" },
					permissions: ["tabs", "storage", "userScripts", "webNavigation", "debugger"],
					host_permissions: manifest.host_permissions,
					sandbox: manifest.sandbox,
					content_security_policy: manifest.content_security_policy,
				}),
			);
			writeFileSync(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});");
			writeFileSync(
				join(extension, "fixture.html"),
				'<!doctype html><style>.fixed{position:fixed}.inset-0{inset:0}.absolute{position:absolute}svg{width:24px;height:24px}.p-6{padding:24px}</style><script type="module" src="fixture.js"></script>',
			);
			for (const file of ["sandbox.html", "sandbox.js"])
				copyFileSync(join(root, "static", file), join(extension, file));
			await build({
				entryPoints: ["tests/browser/sandbox-runtime.ts"],
				absWorkingDir: root,
				bundle: true,
				platform: "browser",
				format: "esm",
				outfile: join(extension, "fixture.js"),
				plugins: [
					{
						name: "sandbox-fixture-shown-skills",
						setup(builder) {
							builder.onResolve({ filter: /sidepanel\.js$/ }, (args) => {
								if (args.importer !== join(root, "src/utils/format-skills.ts")) return;
								return { path: "shown-skills", namespace: "sandbox-fixture" };
							});
							builder.onLoad({ filter: /^shown-skills$/, namespace: "sandbox-fixture" }, () => ({
								contents: "const shown = new Map(); export const getShownSkills = () => shown;",
								loader: "js",
							}));
						},
					},
				],
				define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
				inject: [join(root, "scripts/process-shim.js")],
				alias: {
					process: join(root, "scripts/process-shim.js"),
					"@mariozechner/mini-lit": join(root, "node_modules/@mariozechner/mini-lit"),
					lit: join(root, "node_modules/lit"),
				},
			});
			context = await chromium.launchPersistentContext(join(directory, "profile"), {
				channel: "chromium",
				headless: true,
				args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
			});
			const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
			const id = new URL(worker.url()).hostname;
			const page = await context.newPage();
			await page.goto(`chrome-extension://${id}/fixture.html`);
			await page.waitForFunction(() => !!window.sandboxRuntimeFixture);
			const availability = await page.evaluate(() => window.sandboxRuntimeFixture.availability());
			assert.equal(availability.available, false);
			assert.match(availability.message, /Allow User Scripts/);
			const unavailable = await page.evaluate(() => window.sandboxRuntimeFixture.callBrowser("async () => 42"));
			assert.equal(unavailable.success, false);
			await page.evaluate(() => window.sandboxRuntimeFixture.openPermission());
			await page.getByRole("button", { name: "Grant Permission" }).click();
			await page
				.getByText(/Allow User Scripts/)
				.first()
				.waitFor();
			await page.getByRole("button", { name: "Continue Anyway" }).click();
			assert.equal(await page.evaluate(() => window.sandboxRuntimeFixture.permissionResult()), false);

			const settings = await context.newPage();
			await settings.goto(`chrome://extensions/?id=${id}`);
			await settings.locator("extensions-detail-view").waitFor();
			await settings.locator("#allow-user-scripts cr-toggle").click();
			await settings.close();
			await page.reload();
			await page.waitForFunction(() => !!window.sandboxRuntimeFixture);
			assert.equal((await page.evaluate(() => window.sandboxRuntimeFixture.availability())).available, true);
			t.diagnostic(
				JSON.stringify(
					await page.evaluate(() => ({
						userAgent: navigator.userAgent,
						terminate: typeof chrome.userScripts.terminate === "function",
					})),
				),
			);

			const url = `http://127.0.0.1:${server.address().port}`;
			const target = await context.newPage();
			await target.goto(url);
			await target.bringToFront();
			const tab = await page.evaluate(() => window.sandboxRuntimeFixture.activeTab());
			await page.evaluate(() =>
				window.sandboxRuntimeFixture.begin("console.log('async fixture'); return await echoAsync(42);"),
			);
			const asyncResult = await page.evaluate(() => window.sandboxRuntimeFixture.result());
			assert.equal(asyncResult.success, true, JSON.stringify(asyncResult));
			assert.equal(asyncResult.returnValue, 42);
			assert.ok(asyncResult.console.some((entry) => entry.text === "async fixture"));
			await page.evaluate(() =>
				window.sandboxRuntimeFixture.begin(
					`return await browserjs(async (value) => { console.log('page async', value); await nativeClick('#trusted'); await nativeType('#text', 'trusted text'); return { title: document.title, value, text: document.querySelector('#text').value }; }, 42);`,
				),
			);
			const browserResult = await page.evaluate(() => window.sandboxRuntimeFixture.result());
			assert.equal(
				browserResult.success,
				true,
				JSON.stringify({
					result: browserResult,
					senders: await page.evaluate(() => window.sandboxRuntimeFixture.senders),
				}),
			);
			assert.deepEqual(browserResult.returnValue, { title: "Browser fixture", value: 42, text: "trusted text" });
			assert.ok(browserResult.console.some((entry) => entry.text.includes("[browserjs] page async 42")));
			assert.deepEqual(await target.evaluate(() => window.fixtureEvents), [
				{ type: "click", trusted: true },
				...Array.from("trusted text", () => ({ type: "input", trusted: true })),
			]);
			const selector = `[data-missing="' + (window.selectorInjected = true) + '"]`;
			assert.equal(await target.evaluate((value) => document.querySelector(value) === null, selector), true);
			assert.equal(await target.evaluate(() => Object.hasOwn(window, "selectorInjected")), false);
			for (const helper of ["nativeClick", "nativeType"]) {
				await page.evaluate(
					({ helper, selector }) =>
						window.sandboxRuntimeFixture.begin(
							`await browserjs(async selector => { await ${helper}(selector${helper === "nativeType" ? ", 'ignored'" : ""}); }, ${JSON.stringify(selector)});`,
						),
					{ helper, selector },
				);
				const rejected = await page.evaluate(() => window.sandboxRuntimeFixture.result());
				assert.equal(rejected.success, false, helper);
				assert.match(rejected.error.message, /Selector not found/);
				assert.ok(rejected.error.message.includes(selector), rejected.error.message);
				assert.equal(await target.evaluate(() => Object.hasOwn(window, "selectorInjected")), false, helper);
				assert.equal(await target.evaluate(() => window.selectorInjected), undefined, helper);
			}
			await page.evaluate(() =>
				window.sandboxRuntimeFixture.begin(
					`await browserjs(async () => { console.error('page error fixture'); throw new Error('page exception'); });`,
				),
			);
			const failed = await page.evaluate(() => window.sandboxRuntimeFixture.result());
			assert.equal(failed.success, false);
			assert.equal(failed.error.message, "page exception");
			assert.ok(failed.console.some((entry) => entry.text === "[browserjs] page error fixture"));

			await page.evaluate(() =>
				window.sandboxRuntimeFixture.beginProduction(
					`await browserjs(async () => { document.body.dataset.pendingBrowserScript = 'overlay'; await new Promise(() => {}); });`,
				),
			);
			await target.locator('body[data-pending-browser-script="overlay"]').waitFor();
			await target.evaluate(() => document.querySelector("#sitegeist-repl-overlay button").click());
			assert.equal(await target.locator("#sitegeist-repl-overlay").count(), 1);
			if (process.env.SITEGEIST_SANDBOX_EVIDENCE) {
				mkdirSync(process.env.SITEGEIST_SANDBOX_EVIDENCE, { recursive: true });
				await target.screenshot({ path: join(process.env.SITEGEIST_SANDBOX_EVIDENCE, "overlay-abort.png") });
			}
			await target.locator("#sitegeist-repl-overlay").getByRole("button", { name: "Stop" }).click();
			const stopped = await page.evaluate(() => window.sandboxRuntimeFixture.productionResult());
			assert.match(stopped.error, /Execution aborted/);
			await target.locator("#sitegeist-repl-overlay").waitFor({ state: "detached" });
			assert.equal(await page.locator("sitegeist-sandbox iframe").count(), 0);
			if (process.env.SITEGEIST_SANDBOX_EVIDENCE)
				await target.screenshot({ path: join(process.env.SITEGEIST_SANDBOX_EVIDENCE, "overlay-cleaned.png") });

			await page.evaluate(() =>
				window.sandboxRuntimeFixture.beginProduction(
					`await browserjs(async () => { document.body.dataset.pendingBrowserScript = 'tab'; await new Promise(() => {}); });`,
				),
			);
			await target.locator('body[data-pending-browser-script="tab"]').waitFor();
			const switched = await context.newPage();
			await switched.goto(`${url}/switch`);
			await switched.bringToFront();
			const tabCancelled = await page.evaluate(() => window.sandboxRuntimeFixture.productionResult());
			assert.match(tabCancelled.error, /cancelled/);
			await target.locator("#sitegeist-repl-overlay").waitFor({ state: "detached" });
			assert.equal(await switched.locator("#sitegeist-repl-overlay").count(), 0);
			assert.equal(await page.locator("sitegeist-sandbox iframe").count(), 0);
			await page.evaluate((tabId) => window.sandboxRuntimeFixture.activate(tabId), tab.id);

			await page.evaluate((tabId) => window.sandboxRuntimeFixture.registerProbe(tabId), tab.id);
			const valid = await page.evaluate((tabId) => window.sandboxRuntimeFixture.probe(tabId), tab.id);
			assert.equal(valid[0].result.value, 42, JSON.stringify(valid));
			assert.equal(await page.evaluate(() => window.sandboxRuntimeFixture.probeCalls()), 1);
			const frames = await page.evaluate((tabId) => window.sandboxRuntimeFixture.frames(tabId), tab.id);
			const child = frames.find((frame) => frame.frameId !== 0);
			assert.ok(child);
			await page.evaluate(({ tabId, frameId }) => window.sandboxRuntimeFixture.probe(tabId, frameId), {
				tabId: tab.id,
				frameId: child.frameId,
			});
			await page.evaluate((tabId) => window.sandboxRuntimeFixture.probe(tabId, 0, "wrong-world"), tab.id);
			await page.evaluate(
				(tabId) => window.sandboxRuntimeFixture.probe(tabId, 0, "sitegeist-browser-script", "wrong-channel"),
				tab.id,
			);
			const other = await context.newPage();
			await other.goto(`${url}/other`);
			await other.bringToFront();
			const otherTab = await page.evaluate(() => window.sandboxRuntimeFixture.activeTab());
			await page.evaluate((tabId) => window.sandboxRuntimeFixture.probe(tabId), otherTab.id);
			assert.equal(await page.evaluate(() => window.sandboxRuntimeFixture.probeCalls()), 1);
			await page.evaluate(() => window.sandboxRuntimeFixture.unregisterProbe());
			await page.evaluate((tabId) => window.sandboxRuntimeFixture.activate(tabId), tab.id);

			await page.evaluate(
				(nextUrl) =>
					window.sandboxRuntimeFixture.begin(`return await navigate({ url: ${JSON.stringify(nextUrl)} });`),
				`${url}/next`,
			);
			const navigation = await page.evaluate(() => window.sandboxRuntimeFixture.result());
			assert.equal(navigation.success, true, JSON.stringify(navigation));
			assert.equal(navigation.returnValue.finalUrl, `${url}/next`);
			assert.equal(navigation.returnValue.title, "Navigated fixture");
			assert.equal(target.url(), `${url}/next`);
			assert.deepEqual(await page.evaluate(() => window.sandboxRuntimeFixture.violations), []);
		} finally {
			await context?.close();
			await new Promise((resolve) => server.close(resolve));
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
