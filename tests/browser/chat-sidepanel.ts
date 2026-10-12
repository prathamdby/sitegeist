import { getModel } from "../../src/pi/models.js";
import { SitegeistAppStorage } from "../../src/storage/app-storage.js";
import type { BackgroundToSidepanelMessage, SidepanelToBackgroundMessage } from "../../src/utils/port.js";

const portListeners: ((message: BackgroundToSidepanelMessage) => void)[] = [];
const noListener = { addListener: () => {}, removeListener: () => {} };
const mockedChrome = {
	runtime: {
		onMessage: noListener,
		getManifest: () => ({ version: "1.0.0" }),
		getURL: (path: string) => new URL(path, location.href).href,
		connect: () => ({
			onMessage: {
				addListener: (listener: (message: BackgroundToSidepanelMessage) => void) => {
					portListeners.push(listener);
				},
			},
			onDisconnect: noListener,
			postMessage: (message: SidepanelToBackgroundMessage) => {
				const response: BackgroundToSidepanelMessage =
					message.type === "acquireLock"
						? { type: "lockResult", sessionId: message.sessionId, success: true }
						: message.type === "getBinding"
							? { type: "bindingResult", tabId: message.tabId }
							: message.type === "clearHostBinding"
								? { type: "bindingCleared", tabId: message.tabId }
								: { type: "lockedSessions", locks: {} };
				queueMicrotask(() => {
					for (const listener of portListeners) listener(response);
				});
			},
		}),
		sendMessage: async () => ({ success: true }),
	},
	storage: { local: { get: async () => ({}), set: async () => {} } },
	windows: { getCurrent: async () => ({ id: 1 }) },
	tabs: {
		onUpdated: noListener,
		onActivated: noListener,
		query: async () => [{ id: 1, windowId: 1, url: "https://fixture.invalid/", title: "Fixture page" }],
		get: async () => ({ id: 1, windowId: 1, url: "https://fixture.invalid/", title: "Fixture page" }),
	},
	userScripts: {},
};
globalThis.chrome = mockedChrome as unknown as typeof chrome;
const storage = new SitegeistAppStorage();
const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
};
const model = getModel("anthropic", "claude-sonnet-4-5");
const timestamp = "2026-10-11T00:00:00.000Z";
await storage.providerKeys.set("anthropic", "fixture-not-a-real-key");
await storage.sessions.save(
	{
		id: "header-fixture",
		title: "Fixture original title",
		model,
		thinkingLevel: "off",
		messages: [
			{ role: "user", content: "Fixture saved request", timestamp: 0 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Fixture saved answer" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage,
				stopReason: "stop",
				timestamp: 1,
			},
		],
		createdAt: timestamp,
		lastModified: timestamp,
	},
	{
		id: "header-fixture",
		title: "Fixture original title",
		createdAt: timestamp,
		lastModified: timestamp,
		messageCount: 2,
		usage,
		thinkingLevel: "off",
		preview: "Fixture saved answer",
	},
);
document.documentElement.style.height = "100%";
document.body.style.cssText = "margin:0;height:100%";
const script = document.createElement("script");
script.type = "module";
script.src = "/sidepanel.js";
document.body.append(script);
window.headerFixture = { storage };
declare global {
	interface Window {
		headerFixture: { storage: SitegeistAppStorage };
	}
}
