import type { WorkTabInfo } from "../utils/port.js";
import * as port from "../utils/port.js";

export interface TaskContext {
	sessionId?: string;
	ownerTabId?: number;
}

let readContext: () => TaskContext = () => ({});

export function setTaskContext(read: () => TaskContext): void {
	readContext = read;
}

export function taskContext(): TaskContext {
	return readContext();
}

function unwrap<T extends { error?: string }>(result: T): T {
	if (result.error) throw new Error(result.error);
	return result;
}

export async function ensureWorkTab(
	sessionId: string,
	ownerTabId: number,
	url: string,
	newTab: boolean,
): Promise<{ tab: WorkTabInfo; navigated: boolean }> {
	const result = unwrap(await port.sendMessage({ type: "ensureWorkTab", sessionId, ownerTabId, url, newTab }));
	if (!result.tab) throw new Error("The task tab was not created");
	return { tab: result.tab, navigated: result.navigated === true };
}

export async function listWorkTabs(sessionId: string): Promise<WorkTabInfo[]> {
	const result = unwrap(await port.sendMessage({ type: "listWorkTabs", sessionId }));
	return result.tabs;
}

export async function selectWorkTab(sessionId: string, tabId: number, reveal: boolean): Promise<WorkTabInfo> {
	const result = unwrap(await port.sendMessage({ type: "selectWorkTab", sessionId, tabId, reveal }));
	if (!result.tab) throw new Error(`Tab ${tabId} is not in this task`);
	return result.tab;
}

export async function getWorkTarget(sessionId: string): Promise<WorkTabInfo | undefined> {
	const result = await port.sendMessage({ type: "getWorkTarget", sessionId });
	if (result.tabId === undefined || result.windowId === undefined) return undefined;
	return {
		id: result.tabId,
		windowId: result.windowId,
		url: result.url ?? "",
		title: result.title ?? "Untitled",
		favIconUrl: result.favIconUrl,
		active: true,
	};
}

export async function shareActiveTab(sessionId: string, ownerTabId: number): Promise<WorkTabInfo> {
	const result = unwrap(await port.sendMessage({ type: "shareActiveTab", sessionId, ownerTabId }));
	if (!result.tab) throw new Error("No tab was shared");
	return result.tab;
}

export async function renameWorkGroup(sessionId: string, title: string): Promise<void> {
	await port.sendMessage({ type: "renameWorkGroup", sessionId, title });
}

export async function captureWorkTab(sessionId: string): Promise<string> {
	const result = unwrap(await port.sendMessage({ type: "captureWorkTab", sessionId }));
	if (!result.dataUrl) throw new Error("Screenshot returned no image");
	return result.dataUrl;
}

export async function getPageTab(): Promise<{ id: number; windowId: number; url?: string } | undefined> {
	const context = taskContext();
	if (context.sessionId) {
		const target = await getWorkTarget(context.sessionId);
		if (!target) return undefined;
		return { id: target.id, windowId: target.windowId, url: target.url };
	}
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (tab?.id === undefined || tab.windowId === undefined) return undefined;
	return { id: tab.id, windowId: tab.windowId, url: tab.url };
}
