import { sidePanelPath } from "../panel/locks.js";
import type {
	BackgroundToSidepanelMessage,
	CaptureWorkTabMessage,
	EnsureWorkTabMessage,
	GetWorkTargetMessage,
	ListWorkTabsMessage,
	RenameWorkGroupMessage,
	SelectWorkTabMessage,
	ShareActiveTabMessage,
	ShareActiveTabResultMessage,
	SidepanelToBackgroundMessage,
	WorkGroupRenamedMessage,
	WorkTabCaptureMessage,
	WorkTabInfo,
	WorkTabListMessage,
	WorkTabResultMessage,
	WorkTabSelectedMessage,
	WorkTargetMessage,
} from "../utils/port.js";
import { type WorkBackend, type WorkSession, WorkSessionBook, type WorkTab } from "./work-session.js";

const STORAGE_KEY = "work_sessions";

export interface WorkSessionHooks {
	bindWorkTab(session: WorkSession, tabId: number): Promise<void>;
	ownerPromoted(session: WorkSession, previousOwnerTabId: number): Promise<void>;
}

let book: WorkSessionBook | undefined;
let hooks: WorkSessionHooks | undefined;
const attached = new Set<number>();

function info(tab: WorkTab): WorkTabInfo {
	return {
		id: tab.id,
		windowId: tab.windowId,
		url: tab.url,
		title: tab.title,
		favIconUrl: tab.favIconUrl,
		active: tab.active,
	};
}

function fromChrome(tab: chrome.tabs.Tab): WorkTab {
	if (tab.id === undefined) throw new Error("Tab has no id");
	return {
		id: tab.id,
		windowId: tab.windowId,
		url: tab.url ?? "",
		title: tab.title || "Untitled",
		favIconUrl: tab.favIconUrl,
		active: Boolean(tab.active),
		groupId: tab.groupId,
	};
}

async function persist(): Promise<void> {
	if (!book) return;
	await chrome.storage.session.set({ [STORAGE_KEY]: book.snapshot() });
}

async function attach(tabId: number): Promise<void> {
	if (attached.has(tabId)) return;
	await chrome.debugger.attach({ tabId }, "1.3");
	attached.add(tabId);
}

async function detach(tabId: number): Promise<void> {
	if (!attached.has(tabId)) return;
	attached.delete(tabId);
	await chrome.debugger.detach({ tabId }).catch(() => {});
}

async function emulate(tabId: number): Promise<void> {
	const session = book?.findByTab(tabId);
	if (!session || session.debuggerBlockedTabIds.includes(tabId)) return;
	try {
		await attach(tabId);
		await chrome.debugger.sendCommand({ tabId }, "Emulation.setDeviceMetricsOverride", {
			width: 1280,
			height: 800,
			deviceScaleFactor: 1,
			mobile: false,
		});
		await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
	} catch (error) {
		console.warn("[WorkSession] Background emulation failed", error);
	}
}

async function syncEmulation(windowId: number, activeTabId: number): Promise<void> {
	if (!book) return;
	for (const session of book.snapshot()) {
		if (session.windowId !== windowId) continue;
		for (const tabId of session.tabIds) {
			if (tabId === activeTabId) await detach(tabId);
			else await emulate(tabId);
		}
	}
}

async function capture(sessionId: string): Promise<string> {
	if (!book) throw new Error("Task tabs are not ready");
	const tab = await book.current(sessionId);
	if (!tab) throw new Error("No task tab yet. Navigate to a page first.");
	const session = book.get(sessionId);
	if (session?.debuggerBlockedTabIds.includes(tab.id)) {
		throw new Error("The debugger was dismissed on this tab. Navigate again to capture it.");
	}
	const temporary = !attached.has(tab.id);
	if (temporary) await attach(tab.id);
	try {
		const result = (await chrome.debugger.sendCommand({ tabId: tab.id }, "Page.captureScreenshot", {
			format: "png",
		})) as { data?: string };
		if (!result.data) throw new Error("Screenshot returned no image");
		return `data:image/png;base64,${result.data}`;
	} finally {
		if (temporary) await detach(tab.id);
	}
}

function backend(): WorkBackend {
	return {
		async get(tabId) {
			return fromChrome(await chrome.tabs.get(tabId));
		},
		async createInactive(windowId, url) {
			return fromChrome(await chrome.tabs.create({ windowId, url, active: false }));
		},
		async setUrl(tabId, url) {
			await chrome.tabs.update(tabId, { url });
		},
		async activate(tabId) {
			await chrome.tabs.update(tabId, { active: true });
		},
		async focusWindow(windowId) {
			await chrome.windows.update(windowId, { focused: true });
		},
		async group(tabId, windowId, groupId) {
			if (groupId === null) {
				return chrome.tabs.group({ createProperties: { windowId }, tabIds: tabId });
			}
			return chrome.tabs.group({ groupId, tabIds: tabId });
		},
		async retitle(groupId, title, color) {
			await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
		},
		async ungroup(tabIds) {
			if (tabIds.length === 0) return;
			const [first, ...rest] = tabIds;
			await chrome.tabs.ungroup([first, ...rest]);
		},
		async own(session, tabId) {
			await hooks?.bindWorkTab(session, tabId);
			await chrome.sidePanel.setOptions({
				tabId,
				enabled: true,
				path: sidePanelPath(session.ownerTabId, session.sessionId),
			});
		},
		async activeInWindow(windowId) {
			const [tab] = await chrome.tabs.query({ active: true, windowId });
			if (tab?.id === undefined) return undefined;
			return fromChrome(tab);
		},
	};
}

async function restore(): Promise<void> {
	if (!book) return;
	const data = await chrome.storage.session.get(STORAGE_KEY);
	const stored = (data[STORAGE_KEY] as WorkSession[] | undefined) ?? [];
	book.restore(stored);
	const tabs = await chrome.tabs.query({});
	const live = new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])));
	const promoted = await book.discardMissing(live);
	await persist();
	for (const item of promoted) await hooks?.ownerPromoted(item.session, item.previousOwnerTabId);
}

export function startWorkSessions(next: WorkSessionHooks): void {
	hooks = next;
	book = new WorkSessionBook(backend());
	void restore().catch((error: unknown) => console.error("[WorkSession] Restore failed", error));
	chrome.tabs.onActivated.addListener((info) => {
		book?.noteActivation(info.windowId, info.tabId);
		void syncEmulation(info.windowId, info.tabId);
	});
	chrome.tabs.onRemoved.addListener((tabId) => {
		attached.delete(tabId);
		const removed = book?.removeTab(tabId);
		void persist().then(() => {
			if (removed?.promoted)
				return hooks?.ownerPromoted(removed.promoted.session, removed.promoted.previousOwnerTabId);
		});
	});
	chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
		if (attached.delete(removedTabId)) attached.add(addedTabId);
		void book?.replaceTab(removedTabId, addedTabId).then(() => persist());
	});
	chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
		void book?.adoptPopup(details.sourceTabId, details.tabId).then(() => persist());
	});
	chrome.webNavigation.onCommitted.addListener((details) => {
		if (details.frameId !== 0) return;
		book?.clearDebuggerBlock(details.tabId);
	});
	chrome.debugger.onDetach.addListener((source, reason) => {
		if (source.tabId === undefined) return;
		attached.delete(source.tabId);
		if (reason === "canceled_by_user") book?.blockDebugger(source.tabId);
	});
}

export async function handleWorkMessage(
	message: SidepanelToBackgroundMessage,
	portOwnerTabId: number,
): Promise<BackgroundToSidepanelMessage | undefined> {
	if (!book) return undefined;
	if ("sessionId" in message && book.get(message.sessionId)?.ownerTabId !== undefined) {
		const owner = book.get(message.sessionId)?.ownerTabId;
		if (owner !== undefined && owner !== portOwnerTabId) {
			return failure(message, "That tab belongs to another task");
		}
	}
	try {
		if (message.type === "ensureWorkTab") return await ensure(message);
		if (message.type === "listWorkTabs") return await list(message);
		if (message.type === "selectWorkTab") return await select(message);
		if (message.type === "getWorkTarget") return await target(message);
		if (message.type === "shareActiveTab") return await share(message);
		if (message.type === "renameWorkGroup") return await rename(message);
		if (message.type === "captureWorkTab") return await shot(message);
	} catch (error) {
		return failure(message, error instanceof Error ? error.message : String(error));
	}
	return undefined;
}

function failure(message: SidepanelToBackgroundMessage, error: string): BackgroundToSidepanelMessage | undefined {
	if (message.type === "ensureWorkTab") return { type: "workTabResult", error };
	if (message.type === "listWorkTabs") return { type: "workTabList", tabs: [], error };
	if (message.type === "selectWorkTab") return { type: "workTabSelected", error };
	if (message.type === "shareActiveTab") return { type: "shareActiveTabResult", error };
	if (message.type === "captureWorkTab") return { type: "workTabCapture", error };
	if (message.type === "getWorkTarget") return { type: "workTarget", error };
	if (message.type === "renameWorkGroup") return { type: "workGroupRenamed", error };
	return undefined;
}

async function ensure(message: EnsureWorkTabMessage): Promise<WorkTabResultMessage> {
	if (!book) return { type: "workTabResult", error: "Task tabs are not ready" };
	const before = book.get(message.sessionId)?.currentTabId ?? null;
	const tab = await book.open(message.sessionId, message.ownerTabId, message.url, message.newTab);
	await persist();
	return { type: "workTabResult", tab: info(tab), navigated: message.newTab || before === null };
}

async function list(message: ListWorkTabsMessage): Promise<WorkTabListMessage> {
	if (!book) return { type: "workTabList", tabs: [], error: "Task tabs are not ready" };
	const tabs = await book.list(message.sessionId);
	return { type: "workTabList", tabs: tabs.map(info) };
}

async function select(message: SelectWorkTabMessage): Promise<WorkTabSelectedMessage> {
	if (!book) return { type: "workTabSelected", error: "Task tabs are not ready" };
	const tab = await book.select(message.sessionId, message.tabId, message.reveal);
	await persist();
	return { type: "workTabSelected", tab: info({ ...tab, active: true }) };
}

async function target(message: GetWorkTargetMessage): Promise<WorkTargetMessage> {
	if (!book) return { type: "workTarget" };
	const tab = await book.current(message.sessionId);
	if (!tab) return { type: "workTarget" };
	return {
		type: "workTarget",
		tabId: tab.id,
		windowId: tab.windowId,
		url: tab.url,
		title: tab.title,
		favIconUrl: tab.favIconUrl,
	};
}

async function share(message: ShareActiveTabMessage): Promise<ShareActiveTabResultMessage> {
	if (!book) return { type: "shareActiveTabResult", error: "Task tabs are not ready" };
	const tab = await book.shareActive(message.sessionId, message.ownerTabId);
	await persist();
	return { type: "shareActiveTabResult", tab: info(tab) };
}

async function rename(message: RenameWorkGroupMessage): Promise<WorkGroupRenamedMessage> {
	if (!book) return { type: "workGroupRenamed" };
	await book.rename(message.sessionId, message.title);
	await persist();
	return { type: "workGroupRenamed" };
}

async function shot(message: CaptureWorkTabMessage): Promise<WorkTabCaptureMessage> {
	const dataUrl = await capture(message.sessionId);
	return { type: "workTabCapture", dataUrl };
}
