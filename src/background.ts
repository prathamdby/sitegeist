import {
	clearHostBinding,
	decideLock,
	type PanelBinding,
	releaseLocksForOwner,
	retargetBindings,
	rewriteLockOwner,
	sidePanelPath,
} from "./panel/locks.js";
import { relayOverlayAbortMessage } from "./tools/repl/overlay-abort.js";
import type {
	BindingClearedMessage,
	BindingResultMessage,
	LockedSessionsMessage,
	LockResultMessage,
	SidepanelToBackgroundMessage,
} from "./utils/port.js";

chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	if (tab.id === undefined) return;
	openPanelForTab(tab.id);
});

console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		console.log("[Background] Received userScript message type:", message?.type, "from tab:", sender.tab?.id);
		const abortMessage = relayOverlayAbortMessage(message, sender);
		if (abortMessage) {
			console.log("[Background] Relaying abort-repl to sidepanels");
			void chrome.runtime.sendMessage(abortMessage).catch(() => {});
			sendResponse({ success: true });
			return true;
		}
	});
	console.log("[Background] onUserScriptMessage listener registered");
} else {
	console.error("[Background] onUserScriptMessage NOT available!");
}

const PANEL_MODEL_KEY = "panel_model";
const SESSION_LOCKS_KEY = "session_locks";
const OPEN_PANELS_KEY = "open_panel_tabs";
const BINDINGS_KEY = "panel_bindings";
const LEGACY_OPEN_KEY = "sidepanel_open_windows";

let openPanels = new Set<number>();
let bindings: Record<string, PanelBinding> = {};
let locks: Record<string, number> = {};
const panelRefcounts = new Map<number, number>();

let cacheReady: Promise<void> = Promise.resolve();

function openPanelForTab(tabId: number): void {
	const binding = bindings[String(tabId)];
	const ownerTabId = binding?.ownerTabId ?? tabId;
	const path = sidePanelPath(ownerTabId, binding?.sessionId);
	void chrome.sidePanel.setOptions({ tabId, enabled: true, path });
	void chrome.sidePanel.open({ tabId }).catch((error: unknown) => {
		console.error("[Background] Failed to open side panel", error);
	});
}

async function persist(): Promise<void> {
	await chrome.storage.session.set({
		[PANEL_MODEL_KEY]: "tab",
		[SESSION_LOCKS_KEY]: locks,
		[OPEN_PANELS_KEY]: Array.from(openPanels),
		[BINDINGS_KEY]: bindings,
	});
}

async function applyPanelOptions(): Promise<void> {
	await chrome.sidePanel.setOptions({ enabled: false, path: "sidepanel.html" });
	await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
	for (const [key, binding] of Object.entries(bindings)) {
		const tabId = Number(key);
		try {
			await chrome.tabs.get(tabId);
		} catch {
			continue;
		}
		await chrome.sidePanel.setOptions({
			tabId,
			enabled: true,
			path: sidePanelPath(binding.ownerTabId, binding.sessionId),
		});
	}
}

async function loadCache(): Promise<void> {
	const data = await chrome.storage.session.get([
		PANEL_MODEL_KEY,
		SESSION_LOCKS_KEY,
		OPEN_PANELS_KEY,
		BINDINGS_KEY,
		LEGACY_OPEN_KEY,
	]);
	if (data[PANEL_MODEL_KEY] !== "tab") {
		locks = {};
		openPanels = new Set();
		bindings = {};
		await chrome.storage.session.remove(LEGACY_OPEN_KEY);
		await persist();
	} else {
		locks = (data[SESSION_LOCKS_KEY] as Record<string, number> | undefined) ?? {};
		openPanels = new Set((data[OPEN_PANELS_KEY] as number[] | undefined) ?? []);
		bindings = (data[BINDINGS_KEY] as Record<string, PanelBinding> | undefined) ?? {};
	}
	await applyPanelOptions();
}

cacheReady = loadCache().catch((error: unknown) => {
	console.error("[Background] Failed to load panel state", error);
});

function rememberConnect(ownerTabId: number): void {
	panelRefcounts.set(ownerTabId, (panelRefcounts.get(ownerTabId) ?? 0) + 1);
	openPanels.add(ownerTabId);
	void persist();
}

function rememberDisconnect(ownerTabId: number): void {
	const count = (panelRefcounts.get(ownerTabId) ?? 1) - 1;
	if (count > 0) {
		panelRefcounts.set(ownerTabId, count);
		return;
	}
	panelRefcounts.delete(ownerTabId);
	openPanels.delete(ownerTabId);
	locks = releaseLocksForOwner(locks, ownerTabId);
	void persist();
}

function bindOwner(sessionId: string, ownerTabId: number): void {
	const current = bindings[String(ownerTabId)];
	bindings[String(ownerTabId)] = {
		ownerTabId,
		sessionId,
		role: current?.role === "work" ? "work" : "host",
	};
}

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;
	const ownerTabId = Number(match[1]);
	let connected = false;
	let disconnected = false;
	port.onDisconnect.addListener(() => {
		disconnected = true;
		if (connected) rememberDisconnect(ownerTabId);
	});
	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		void cacheReady.then(() => handlePanelMessage(port, msg));
	});
	void cacheReady.then(() => {
		if (disconnected) return;
		connected = true;
		rememberConnect(ownerTabId);
	});
});

function handlePanelMessage(port: chrome.runtime.Port, msg: SidepanelToBackgroundMessage): void {
	if (msg.type === "acquireLock") {
		const decision = decideLock(locks, openPanels, msg.sessionId, msg.ownerTabId);
		const response: LockResultMessage = decision.granted
			? { type: "lockResult", sessionId: msg.sessionId, success: true }
			: { type: "lockResult", sessionId: msg.sessionId, success: false, ownerTabId: decision.ownerTabId };
		if (decision.granted) {
			locks[msg.sessionId] = msg.ownerTabId;
			bindOwner(msg.sessionId, msg.ownerTabId);
			void persist();
		}
		port.postMessage(response);
		return;
	}
	if (msg.type === "getLockedSessions") {
		const response: LockedSessionsMessage = { type: "lockedSessions", locks };
		port.postMessage(response);
		return;
	}
	if (msg.type === "getBinding") {
		const binding = bindings[String(msg.tabId)];
		const response: BindingResultMessage = {
			type: "bindingResult",
			tabId: msg.tabId,
			ownerTabId: binding?.ownerTabId,
			sessionId: binding?.sessionId,
			role: binding?.role,
		};
		port.postMessage(response);
		return;
	}
	if (msg.type === "clearHostBinding") {
		bindings = clearHostBinding(bindings, msg.tabId);
		void persist();
		const response: BindingClearedMessage = { type: "bindingCleared", tabId: msg.tabId };
		port.postMessage(response);
	}
}

chrome.tabs.onRemoved.addListener((tabId) => {
	void cacheReady.then(() => {
		delete bindings[String(tabId)];
		openPanels.delete(tabId);
		panelRefcounts.delete(tabId);
		locks = releaseLocksForOwner(locks, tabId);
		void persist();
		void chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
	});
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
	void cacheReady.then(async () => {
		bindings = retargetBindings(bindings, removedTabId, addedTabId);
		locks = rewriteLockOwner(locks, removedTabId, addedTabId);
		if (openPanels.has(removedTabId)) {
			openPanels.delete(removedTabId);
			openPanels.add(addedTabId);
		}
		const count = panelRefcounts.get(removedTabId);
		if (count !== undefined) {
			panelRefcounts.delete(removedTabId);
			panelRefcounts.set(addedTabId, count);
		}
		await persist();
		const binding = bindings[String(addedTabId)];
		if (!binding) return;
		await chrome.sidePanel.setOptions({
			tabId: addedTabId,
			enabled: true,
			path: sidePanelPath(binding.ownerTabId, binding.sessionId),
		});
	});
});

chrome.windows.onRemoved.addListener(() => {
	void cacheReady.then(async () => {
		const tabs = await chrome.tabs.query({});
		const live = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
		for (const owner of new Set(Object.values(locks))) {
			if (!live.has(owner)) locks = releaseLocksForOwner(locks, owner);
		}
		for (const owner of [...openPanels]) {
			if (!live.has(owner)) {
				openPanels.delete(owner);
				panelRefcounts.delete(owner);
			}
		}
		for (const key of Object.keys(bindings)) {
			if (!live.has(Number(key))) delete bindings[key];
		}
		await persist();
	});
});

chrome.commands.onCommand.addListener((command: string, tab?: chrome.tabs.Tab) => {
	if (command !== "toggle-sidepanel") return;
	if (tab?.id === undefined) {
		console.log("[Background] Cannot open side panel: command tab id not available");
		return;
	}
	openPanelForTab(tab.id);
});
