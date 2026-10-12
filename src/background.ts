import {
	clearHostBinding,
	decideLock,
	foreignLockOwner,
	foreignPanelRequest,
	type PanelBinding,
	releaseLocksForOwner,
	retargetBindings,
	rewriteLockOwner,
	sidePanelPath,
} from "./panel/locks.js";
import { deliverRunnerMessage, type RunnerEndpoint } from "./tasks/router.js";
import { handleWorkMessage, startWorkSessions } from "./tasks/service.js";
import type { WorkSession } from "./tasks/work-session.js";
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
let cacheLoaded = false;

function openPanelForTab(tabId: number): void {
	const binding = cacheLoaded ? bindings[String(tabId)] : undefined;
	const ownerTabId = binding?.ownerTabId ?? tabId;
	const path = sidePanelPath(ownerTabId, binding?.sessionId);
	// open() must be called in this click. Waiting for setOptions drops the user gesture.
	void chrome.sidePanel.setOptions({ tabId, enabled: true, path }).catch((error: unknown) => {
		console.error("[Background] Failed to set side panel options", error);
	});
	void chrome.sidePanel.open({ tabId }).catch((error: unknown) => {
		console.error("[Background] Failed to open side panel", error);
	});
	if (cacheLoaded) return;
	void cacheReady.then(() => {
		const ready = bindings[String(tabId)];
		const readyOwner = ready?.ownerTabId ?? tabId;
		void chrome.sidePanel
			.setOptions({
				tabId,
				enabled: true,
				path: sidePanelPath(readyOwner, ready?.sessionId),
			})
			.catch((error: unknown) => {
				console.error("[Background] Failed to set side panel options", error);
			});
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
	await pruneDeadTabs();
	await applyPanelOptions();
	cacheLoaded = true;
}

async function pruneDeadTabs(): Promise<void> {
	const tabs = await chrome.tabs.query({});
	const live = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
	let changed = false;
	for (const key of Object.keys(bindings)) {
		if (live.has(Number(key))) continue;
		delete bindings[key];
		changed = true;
	}
	for (const owner of [...openPanels]) {
		if (live.has(owner)) continue;
		openPanels.delete(owner);
		panelRefcounts.delete(owner);
		changed = true;
	}
	for (const owner of new Set(Object.values(locks))) {
		if (live.has(owner)) continue;
		locks = releaseLocksForOwner(locks, owner);
		changed = true;
	}
	if (changed) await persist();
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
	// Leave openPanels set. This port also drops on idle timeout and when the
	// user switches tabs, and the session stays with this tab until the tab is gone.
}

function bindOwner(sessionId: string, ownerTabId: number): void {
	const current = bindings[String(ownerTabId)];
	bindings[String(ownerTabId)] = {
		ownerTabId,
		sessionId,
		role: current?.role === "work" ? "work" : "host",
	};
}

const runnerPorts = new Map<number, RunnerEndpoint>();
const runnerViewPorts = new Map<number, Set<RunnerEndpoint>>();

async function ensureOffscreen(): Promise<void> {
	const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
	if (contexts.length > 0) return;
	await chrome.offscreen.createDocument({
		url: "runner-host.html",
		reasons: ["IFRAME_SCRIPTING"],
		justification: "Keep each task running while its side panel is hidden.",
	});
}

async function ensureRunner(ownerTabId: number): Promise<void> {
	await cacheReady;
	const sessionId = bindings[String(ownerTabId)]?.sessionId ?? null;
	await ensureOffscreen();
	await chrome.runtime.sendMessage({ type: "ensureRunnerFrame", ownerTabId, sessionId }).catch((error: unknown) => {
		console.warn("[Background] Task runner frame was not created", error);
	});
}

chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	const runnerMatch = /^runner:(\d+)$/.exec(port.name);
	if (runnerMatch) {
		const ownerTabId = Number(runnerMatch[1]);
		runnerPorts.set(ownerTabId, port);
		port.onMessage.addListener((message: unknown) => {
			deliverRunnerMessage(runnerPorts, runnerViewPorts, ownerTabId, "runner", message);
		});
		port.onDisconnect.addListener(() => {
			if (runnerPorts.get(ownerTabId) === port) runnerPorts.delete(ownerTabId);
		});
		return;
	}
	const viewMatch = /^runner-view:(\d+)$/.exec(port.name);
	if (viewMatch) {
		const ownerTabId = Number(viewMatch[1]);
		const views = runnerViewPorts.get(ownerTabId) ?? new Set<RunnerEndpoint>();
		views.add(port);
		runnerViewPorts.set(ownerTabId, views);
		port.onMessage.addListener((message: unknown) => {
			deliverRunnerMessage(runnerPorts, runnerViewPorts, ownerTabId, "view", message);
		});
		port.onDisconnect.addListener(() => {
			views.delete(port);
		});
		return;
	}
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
		void cacheReady
			.then(() => handlePanelMessage(port, msg, ownerTabId))
			.catch((error: unknown) => {
				console.error("[Background] Panel message failed", error);
			});
	});
	void cacheReady.then(() => {
		if (disconnected) return;
		connected = true;
		rememberConnect(ownerTabId);
		void ensureRunner(ownerTabId);
	});
});

async function bindWorkTab(session: WorkSession, tabId: number): Promise<void> {
	await cacheReady;
	const current = bindings[String(tabId)];
	const keepHost = tabId === session.ownerTabId && current?.role === "host";
	bindings[String(tabId)] = {
		ownerTabId: session.ownerTabId,
		sessionId: session.sessionId,
		role: keepHost ? "host" : "work",
	};
	await persist();
}

async function ownerPromoted(session: WorkSession, previousOwnerTabId: number): Promise<void> {
	await cacheReady;
	locks = rewriteLockOwner(locks, previousOwnerTabId, session.ownerTabId);
	if (locks[session.sessionId] === undefined) locks[session.sessionId] = session.ownerTabId;
	bindings = retargetBindings(bindings, previousOwnerTabId, session.ownerTabId);
	if (openPanels.has(previousOwnerTabId)) {
		openPanels.delete(previousOwnerTabId);
		openPanels.add(session.ownerTabId);
	}
	const count = panelRefcounts.get(previousOwnerTabId);
	if (count !== undefined) {
		panelRefcounts.delete(previousOwnerTabId);
		panelRefcounts.set(session.ownerTabId, count);
	}
	await bindWorkTab(session, session.ownerTabId);
	await chrome.sidePanel
		.setOptions({
			tabId: session.ownerTabId,
			enabled: true,
			path: sidePanelPath(session.ownerTabId, session.sessionId),
		})
		.catch(() => {});
}

async function handlePanelMessage(
	port: chrome.runtime.Port,
	msg: SidepanelToBackgroundMessage,
	ownerTabId: number,
): Promise<void> {
	if (foreignPanelRequest(ownerTabId, msg)) {
		if (msg.type === "acquireLock") {
			const recordedOwner = foreignLockOwner(locks, msg.sessionId);
			const response: LockResultMessage = {
				type: "lockResult",
				sessionId: msg.sessionId,
				success: false,
				...(recordedOwner !== undefined ? { ownerTabId: recordedOwner } : {}),
			};
			port.postMessage(response);
		} else if (msg.type === "getBinding") {
			const response: BindingResultMessage = { type: "bindingResult", tabId: ownerTabId };
			port.postMessage(response);
		} else if (msg.type === "clearHostBinding") {
			const response: BindingClearedMessage = { type: "bindingCleared", tabId: ownerTabId };
			port.postMessage(response);
		} else if (msg.type === "ensureWorkTab") {
			port.postMessage({ type: "workTabResult", error: "That tab belongs to another task" });
		} else if (msg.type === "shareActiveTab") {
			port.postMessage({ type: "shareActiveTabResult", error: "That tab belongs to another task" });
		}
		return;
	}
	const workResponse = await handleWorkMessage(msg, ownerTabId);
	if (workResponse) {
		port.postMessage(workResponse);
		return;
	}
	if (msg.type === "acquireLock") {
		const decision = decideLock(locks, openPanels, msg.sessionId, ownerTabId);
		const response: LockResultMessage = decision.granted
			? { type: "lockResult", sessionId: msg.sessionId, success: true }
			: { type: "lockResult", sessionId: msg.sessionId, success: false, ownerTabId: decision.ownerTabId };
		if (decision.granted) {
			locks[msg.sessionId] = ownerTabId;
			bindOwner(msg.sessionId, ownerTabId);
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
		const binding = bindings[String(ownerTabId)];
		const response: BindingResultMessage = {
			type: "bindingResult",
			tabId: ownerTabId,
			ownerTabId: binding?.ownerTabId,
			sessionId: binding?.sessionId,
			role: binding?.role,
		};
		port.postMessage(response);
		return;
	}
	if (msg.type === "clearHostBinding") {
		bindings = clearHostBinding(bindings, ownerTabId);
		void persist();
		const response: BindingClearedMessage = { type: "bindingCleared", tabId: ownerTabId };
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

startWorkSessions({ bindWorkTab, ownerPromoted });

chrome.commands.onCommand.addListener((command: string, tab?: chrome.tabs.Tab) => {
	if (command !== "toggle-sidepanel") return;
	if (tab?.id === undefined) {
		console.log("[Background] Cannot open side panel: command tab id not available");
		return;
	}
	openPanelForTab(tab.id);
});
