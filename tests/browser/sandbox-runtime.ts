import { UserScriptsPermissionDialog } from "../../src/dialogs/UserScriptsPermissionDialog.js";
import { RUNTIME_MESSAGE_ROUTER } from "../../src/sandbox/RuntimeMessageRouter.js";
import { SandboxIframe } from "../../src/sandbox/SandboxIframe.js";
import type { RuntimeMessage, RuntimeResponse, SandboxRuntimeProvider } from "../../src/sandbox/types.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";
import { NativeInputEventsRuntimeProvider } from "../../src/tools/NativeInputEventsRuntimeProvider.js";
import { NavigateTool } from "../../src/tools/navigate.js";
import { registerOverlayAbortHandler } from "../../src/tools/repl/overlay-abort.js";
import { executeJavaScript } from "../../src/tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "../../src/tools/repl/runtime-providers.js";
import { checkUserScriptsAvailability } from "../../src/tools/repl/userscripts-helpers.js";

setAppStorage(new SitegeistAppStorage());
const native = new NativeInputEventsRuntimeProvider();
const browser = new BrowserJsRuntimeProvider([native]);
const navigation = new NavigateRuntimeProvider(new NavigateTool());
const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) =>
	violations.push(`${event.violatedDirective}: ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`),
);
let probeCalls = 0;
const senders: chrome.runtime.MessageSender[] = [];
let productionController: AbortController | undefined;
let productionWindowId: number | undefined;
let productionResult: Promise<{ output?: string; error?: string }> | undefined;
chrome.runtime.onUserScriptMessage.addListener((_message, sender) => {
	senders.push(sender);
});
registerOverlayAbortHandler(
	() => {
		if (!productionController || productionController.signal.aborted) return false;
		productionController.abort();
		return true;
	},
	() => productionWindowId,
);
const probeCapability = crypto.randomUUID();

class AsyncProvider implements SandboxRuntimeProvider {
	getData() {
		return {};
	}
	getDescription() {
		return "Async fixture";
	}
	getRuntime() {
		return (_sandboxId: string) => {
			const runtime = window as unknown as {
				sendRuntimeMessage: (message: RuntimeMessage) => Promise<RuntimeResponse>;
				echoAsync: (value: number) => Promise<unknown>;
			};
			runtime.echoAsync = async (value) => (await runtime.sendRuntimeMessage({ type: "fixture-echo", value })).value;
		};
	}
	async handleMessage(message: RuntimeMessage, respond: (response: RuntimeResponse) => void) {
		if (message.type !== "fixture-echo") return;
		probeCalls++;
		await new Promise((resolve) => setTimeout(resolve, 10));
		respond({ success: true, value: message.value });
	}
}

const executions = new Map<
	string,
	{ element: SandboxIframe; controller: AbortController; result: ReturnType<SandboxIframe["execute"]> }
>();
let permissionResult: Promise<boolean> | undefined;
const fixture = {
	violations,
	senders,
	availability: checkUserScriptsAvailability,
	openPermission() {
		permissionResult = UserScriptsPermissionDialog.request();
	},
	permissionResult() {
		return permissionResult;
	},
	async activeTab() {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		return tab;
	},
	activate(tabId: number) {
		return chrome.tabs.update(tabId, { active: true });
	},
	begin(code: string, id = "browser-fixture") {
		const element = new SandboxIframe();
		element.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
		document.body.append(element);
		const controller = new AbortController();
		const result = element.execute(id, code, [browser, navigation, new AsyncProvider()], [], controller.signal);
		executions.set(id, { element, controller, result });
	},
	async result(id = "browser-fixture") {
		const execution = executions.get(id);
		if (!execution) throw new Error(`Unknown execution: ${id}`);
		try {
			return await execution.result;
		} finally {
			execution.element.remove();
			executions.delete(id);
		}
	},
	abort(id = "browser-fixture") {
		executions.get(id)?.controller.abort();
	},
	disconnect(id = "browser-fixture") {
		executions.get(id)?.element.remove();
	},
	async callBrowser(code: string) {
		let response: RuntimeResponse | undefined;
		await browser.handleMessage({ type: "browser-js", code, args: "[]" }, (value) => {
			response = value;
		});
		return response;
	},
	async beginProduction(code: string) {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
		productionWindowId = tab.windowId;
		productionController = new AbortController();
		productionResult = executeJavaScript(
			code,
			[browser, navigation],
			productionController.signal,
			() => chrome.runtime.getURL("sandbox.html"),
			"Cancellation fixture",
		).then(
			(result) => result,
			(error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
		);
	},
	async productionResult() {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				productionResult,
				new Promise<never>((_, reject) => {
					timeout = setTimeout(() => reject(new Error("Production REPL cancellation did not settle")), 10000);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
	},
	registerProbe(tabId: number) {
		probeCalls = 0;
		RUNTIME_MESSAGE_ROUTER.registerSandbox("bound-probe", [new AsyncProvider()], [], {
			transport: "user-script",
			tabId,
			frameId: 0,
			worldId: "sitegeist-browser-script",
			capability: probeCapability,
		});
	},
	probeCalls() {
		return probeCalls;
	},
	unregisterProbe() {
		RUNTIME_MESSAGE_ROUTER.unregisterSandbox("bound-probe");
	},
	frames(tabId: number) {
		return chrome.webNavigation.getAllFrames({ tabId });
	},
	async probe(tabId: number, frameId = 0, worldId = "sitegeist-browser-script", channel = "sitegeist-runtime") {
		await chrome.userScripts.configureWorld({ worldId, messaging: true });
		const message = {
			channel,
			sandboxId: "bound-probe",
			messageId: crypto.randomUUID(),
			type: "fixture-echo",
			value: 42,
			worldId: "sitegeist-browser-script",
			...(worldId === "sitegeist-browser-script" ? { capability: probeCapability } : {}),
		};
		return chrome.userScripts.execute({
			target: { tabId, frameIds: [frameId] },
			world: "USER_SCRIPT",
			worldId,
			js: [
				{
					code: `(async () => { try { return await Promise.race([chrome.runtime.sendMessage(${JSON.stringify(message)}), new Promise(resolve => setTimeout(() => resolve({ ignored: true }), 1000))]); } catch (error) { return { error: error.message }; } })()`,
				},
			],
		});
	},
};

declare global {
	interface Window {
		sandboxRuntimeFixture: typeof fixture;
	}
}
window.sandboxRuntimeFixture = fixture;
