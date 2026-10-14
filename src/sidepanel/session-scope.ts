/**
 * Session tab-group lifecycle for the side panel.
 *
 * Flag off: every helper returns without touching tabs, groups, or scopes.
 * Flag on: the agent works only on the session's worker tab and later tabs
 * in its group. The bound panel tab is never the work tab.
 */

import { resolveGroupClick } from "../browser/group-open.js";
import { attachPanelToTab, isFocusSessionTabEnabled, sessionForGroup } from "../browser/session-panels.js";
import {
	chooseActingTabId,
	clearCurrentScope,
	createTabInScope,
	ensureGroupForTabs,
	getCurrentScope,
	getGroupTabIds,
	isTabScopeEnabled,
	resolveActingTab,
	setActingTab,
	setCurrentScope,
	TAB_GROUPS_KEY,
	type TabGroupAssignment,
} from "../browser/session-tabs.js";
import { createNavigationMessage } from "../messages/NavigationMessage.js";
import type { Agent, AgentState } from "../pi/agent.js";
import { isToolNavigating } from "../tools/navigate.js";
import * as port from "../utils/port.js";

export interface SessionPanel {
	isMirror(): boolean;
	getWindowId(): number;
	getTitle(): string;
	setTitle(title: string): void;
	getTabId(): number | undefined;
	setTabId(tabId: number): void;
	getSessionId(): string | undefined;
	setSessionId(sessionId: string): void;
	setPendingSessionId(sessionId: string | undefined): void;
	getAgent(): Agent | undefined;
	render(): void;
	updateAuthLabel(): Promise<void>;
	requestChatUpdate(): void;
	prepareRun(): Promise<void>;
	createAgent(initialState?: Partial<AgentState>, shouldSave?: boolean, mirrorOf?: string): Promise<void>;
}

let panel: SessionPanel | undefined;
let groupPanelSessionId: string | undefined;
let tabListenersInstalled = false;

export function bindSessionPanel(next: SessionPanel): void {
	panel = next;
}

export function sessionPanel(): SessionPanel {
	if (!panel) throw new Error("Session panel is not bound");
	return panel;
}

/** Session a group tab's panel is registered for, if this document is one. */
export function noteGroupPanel(sessionId: string | undefined): void {
	groupPanelSessionId = sessionId;
}

async function readAssignedGroupId(sessionId: string): Promise<number | undefined> {
	try {
		const stored = await chrome.storage.session.get(TAB_GROUPS_KEY);
		const assignments = (stored[TAB_GROUPS_KEY] as Record<string, TabGroupAssignment>) || {};
		return assignments[sessionId]?.groupId;
	} catch {
		return undefined;
	}
}

async function clearAssignment(sessionId: string): Promise<void> {
	try {
		const stored = await chrome.storage.session.get(TAB_GROUPS_KEY);
		const assignments = ((stored[TAB_GROUPS_KEY] as Record<string, TabGroupAssignment>) || {}) as Record<
			string,
			TabGroupAssignment
		>;
		if (assignments[sessionId] !== undefined) {
			delete assignments[sessionId];
			await chrome.storage.session.set({ [TAB_GROUPS_KEY]: assignments });
		}
	} catch {
		// Best effort.
	}
}

async function saveAssignment(sessionId: string, groupId: number): Promise<void> {
	try {
		const stored = await chrome.storage.session.get(TAB_GROUPS_KEY);
		const assignments = ((stored[TAB_GROUPS_KEY] as Record<string, TabGroupAssignment>) || {}) as Record<
			string,
			TabGroupAssignment
		>;
		assignments[sessionId] = { groupId };
		await chrome.storage.session.set({ [TAB_GROUPS_KEY]: assignments });
	} catch (err) {
		console.warn("[Sidepanel] Failed to save tab group assignment:", err);
	}
}

/** The group is the session's visible handle in the tab strip: name it after the chat. */
export async function updateGroupTitle(): Promise<void> {
	const groupId = getCurrentScope()?.groupId;
	const title = sessionPanel().getTitle();
	if (groupId === undefined || !title) return;
	try {
		await chrome.tabGroups.update(groupId, { title });
	} catch {
		// Title is cosmetic; the group may be gone.
	}
}

/**
 * Give the session its own background worker tab inside its own tab group.
 * The bound panel tab is never grouped and never acted on. Never throws:
 * failures leave the caller on legacy window-scoped behavior.
 */
export async function ensureSessionScope(
	sessionId: string,
	boundTabId: number,
	options: { focusNewWorker?: boolean } = {},
): Promise<void> {
	try {
		if (!(await isTabScopeEnabled())) return;
		// One tab group per session: reuse the persistently assigned group
		// when it is still alive. A new group is created only when the
		// recorded group is gone. The assignment survives session switches;
		// only the panel binding is released on switch.
		const assignedGroupId = await readAssignedGroupId(sessionId);
		if (assignedGroupId !== undefined) {
			try {
				await chrome.tabGroups.get(assignedGroupId);
				// Every member is a work tab. The panel's own tab is a member
				// only when it is a group tab hosting the session's panel.
				const live = await getGroupTabIds(assignedGroupId);
				if (live.length > 0) {
					let recorded: number | undefined;
					try {
						const existing = await port.sendMessage({ type: "getTabScopes" });
						recorded = existing.scopes[sessionId]?.actingTabId;
					} catch {
						// Chooser picks a non-panel member when no acting id is recorded.
					}
					const acting = chooseActingTabId({ actingTabId: recorded, boundTabId }, live);
					if (acting !== undefined) {
						const request: port.AcquireTabScopeMessage = {
							type: "acquireTabScope",
							sessionId,
							tabId: boundTabId,
							windowId: sessionPanel().getWindowId(),
							actingTabId: acting,
							groupId: assignedGroupId,
						};
						const acquired = await port.sendMessage(request);
						if (!acquired.success) return;
						const tabIds = new Set<number>(live);
						for (const id of acquired.tabIds) {
							if (id !== boundTabId) tabIds.add(id);
						}
						setCurrentScope({
							sessionId,
							tabIds,
							groupId: acquired.groupId ?? assignedGroupId,
							boundTabId,
							actingTabId: acting,
						});
						for (const id of live) await attachPanelToTab(id, sessionId);
						void updateGroupTitle();
						return;
					}
				}
			} catch {
				// Assigned group is gone; fall through and spawn a fresh one.
			}
			await clearAssignment(sessionId);
		}
		// Spawn a dedicated inactive worker tab, never touching the user's tab.
		const worker = await createTabInScope();
		if (worker.id === undefined) {
			console.warn("[Sidepanel] Worker tab has no id; staying window-scoped");
			return;
		}
		let groupId: number | undefined;
		try {
			groupId = await ensureGroupForTabs([worker.id]);
			try {
				await chrome.tabGroups.update(groupId, { title: "Sitegeist" });
			} catch {
				// Title is cosmetic; ignore.
			}
		} catch (err) {
			console.warn("[Sidepanel] Failed to group worker tab:", err);
		}
		if (groupId !== undefined) {
			await saveAssignment(sessionId, groupId);
		}
		// Register the worker's panel before anything can activate the tab.
		await attachPanelToTab(worker.id, sessionId);
		try {
			const request: port.AcquireTabScopeMessage = {
				type: "acquireTabScope",
				sessionId,
				tabId: boundTabId,
				windowId: sessionPanel().getWindowId(),
				actingTabId: worker.id,
				...(groupId !== undefined ? { groupId } : {}),
			};
			const acquired = await port.sendMessage(request);
			if (!acquired.success) return;
			const tabIds = new Set<number>([worker.id]);
			for (const id of acquired.tabIds) {
				if (id !== boundTabId) tabIds.add(id);
			}
			setCurrentScope({
				sessionId,
				tabIds,
				groupId: acquired.groupId ?? groupId,
				boundTabId,
				actingTabId: worker.id,
			});
			if (groupId !== undefined && acquired.groupId === undefined) {
				// Background reports the group dead; drop the assignment so
				// the next ensure spawns fresh instead of reusing a corpse.
				await clearAssignment(sessionId);
			}
		} catch (err) {
			console.warn("[Sidepanel] Failed to acquire tab scope:", err);
		}
		void updateGroupTitle();
		if (options.focusNewWorker && (await isFocusSessionTabEnabled())) {
			try {
				await chrome.tabs.update(worker.id, { active: true });
			} catch (err) {
				console.warn("[Sidepanel] Failed to focus session tab:", err);
			}
		}
	} catch (err) {
		console.warn("[Sidepanel] ensureSessionScope failed:", err);
	}
}

/**
 * Refresh the local mirror of group membership. The acting tab stays put
 * when it is still in the group; it moves to a survivor only when it is gone.
 */
export async function refreshScopeTabIds(): Promise<void> {
	const scope = getCurrentScope();
	if (!scope) return;
	try {
		if (!(await isTabScopeEnabled())) return;
		if (scope.groupId === undefined) return;
		// Group members are the work tabs; the user's own tab is never grouped.
		const live = await getGroupTabIds(scope.groupId);
		if (live.length === 0) return;
		const acting = chooseActingTabId(scope, live);
		if (acting === undefined) return;
		setCurrentScope({ ...scope, tabIds: new Set(live), actingTabId: acting });
	} catch (err) {
		console.warn("[Sidepanel] refreshScopeTabIds failed:", err);
	}
}

/** Bound panel tab, or the active tab when this document was opened without one. */
export async function resolveBoundTab(): Promise<number | undefined> {
	const existing = sessionPanel().getTabId();
	if (existing !== undefined) return existing;
	const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (active?.id === undefined) return undefined;
	sessionPanel().setTabId(active.id);
	return active.id;
}

/** Own a tab group for a session that was just persisted. No-op when the flag is off or the scope already matches. */
export async function scopeNewSession(sessionId: string): Promise<void> {
	try {
		if (!(await isTabScopeEnabled())) return;
		if (getCurrentScope()?.sessionId === sessionId) return;
		const bound = await resolveBoundTab();
		if (bound === undefined) return;
		await ensureSessionScope(sessionId, bound);
	} catch (err) {
		console.warn("[Sidepanel] Failed to scope new session:", err);
	}
}

/**
 * Tab a run should record navigation against.
 * Flag off: the active tab in the current window.
 * Flag on: the acting group tab, and never a tab outside the session group.
 */
export async function resolveRunTab(ensureOwner: () => Promise<void>): Promise<chrome.tabs.Tab | undefined> {
	if (await isTabScopeEnabled()) {
		await ensureOwner();
		await refreshScopeTabIds();
		const tab = await resolveActingTab().catch(() => undefined);
		const scope = getCurrentScope();
		if (tab?.id !== undefined && scope?.tabIds.has(tab.id)) return tab;
		return undefined;
	}
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	return tab;
}

export function releaseOwnScope(): void {
	// A mirror never owned the scope. Flag off still releases, so a scope
	// recorded by another build is not left stuck.
	const host = sessionPanel();
	if (host.isMirror()) return;
	const sessionId = host.getSessionId();
	if (!sessionId) return;
	void port.sendMessage({ type: "releaseTabScope", sessionId }).catch(() => {});
	clearCurrentScope();
}

/** Open a fresh panel on a new tab. Must run inside a user gesture. */
async function openPanelInNewTab(query: string): Promise<void> {
	try {
		const tab = await chrome.tabs.create({ active: true });
		if (tab.id === undefined) return;
		try {
			await chrome.sidePanel.setOptions({
				tabId: tab.id,
				path: `sidepanel.html?${query}&tabId=${tab.id}`,
				enabled: true,
			});
		} catch {
			// Panel falls back to the default path without tab routing.
		}
		await chrome.sidePanel.open({ tabId: tab.id });
	} catch (err) {
		console.warn("[Sidepanel] Failed to open session in new tab:", err);
	}
}

export function loadSession(sessionId: string): void {
	// A group tab's panel belongs to its session; other sessions open beside it.
	if (groupPanelSessionId !== undefined && groupPanelSessionId !== sessionId) {
		void openPanelInNewTab(`session=${encodeURIComponent(sessionId)}`);
		return;
	}
	releaseOwnScope();
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
}

export function newSessionInNewTab(): void {
	void openPanelInNewTab("new=true");
}

export function newSession(inPlace = false): void {
	if (!inPlace && groupPanelSessionId !== undefined) {
		void newSessionInNewTab();
		return;
	}
	releaseOwnScope();
	const url = new URL(window.location.href);
	const tabId = url.searchParams.get("tabId");
	url.search = "?new=true";
	if (tabId !== null) {
		url.searchParams.set("tabId", tabId);
	}
	window.location.href = url.toString();
}

export function rememberSessionInUrl(sessionId: string): void {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	const tabId = sessionPanel().getTabId();
	if (tabId !== undefined) {
		url.searchParams.set("tabId", String(tabId));
	}
	window.history.replaceState({}, "", url);
}

/** Read ?tabId=, and bind the active tab when tab scope is on and the URL has none. */
export async function bindPanelTab(): Promise<number | undefined> {
	const params = new URLSearchParams(window.location.search);
	const tabIdParam = params.get("tabId");
	const parsed = tabIdParam !== null ? Number(tabIdParam) : NaN;
	let tabId = tabIdParam !== null && Number.isInteger(parsed) ? parsed : undefined;
	clearCurrentScope();
	if (tabId === undefined && (await isTabScopeEnabled())) {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (active?.id !== undefined) {
			tabId = active.id;
			const url = new URL(window.location.href);
			url.searchParams.set("tabId", String(active.id));
			window.history.replaceState({}, "", url);
		}
	}
	if (tabId !== undefined) sessionPanel().setTabId(tabId);
	return tabId;
}

function installUpdatedListener(): void {
	chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
		const host = sessionPanel();
		// Only the owning panel steers its agent; mirrors only display it.
		if (host.isMirror()) return;
		if (
			changeInfo.url &&
			tab.active &&
			tab.url &&
			tab.windowId === host.getWindowId() &&
			host.getAgent()?.state.isStreaming &&
			!tab.url.startsWith("chrome-extension://") &&
			!tab.url.startsWith("moz-extension://") &&
			!isToolNavigating()
		) {
			// Tab scope: only tabs inside the session group may steer this agent.
			if (await isTabScopeEnabled()) {
				const scope = getCurrentScope();
				if (!scope || tab.id === undefined || !scope.tabIds.has(tab.id)) return;
			}
			const agent = host.getAgent();
			if (!agent) return;
			const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
			agent.steer(navMessage);
			console.log("Queued navigation message for tab switch to", tab.url);
		}
	});
}

function installActivatedListener(): void {
	chrome.tabs.onActivated.addListener(async (activeInfo) => {
		const host = sessionPanel();
		if (activeInfo.windowId !== host.getWindowId()) return;
		// Showing a session on its group tabs needs no handling here: every
		// group tab carries its own registered panel for the session.
		if (host.isMirror()) return;

		if (await isTabScopeEnabled()) {
			const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => undefined);
			const stored = (await chrome.storage.session.get([TAB_GROUPS_KEY, "tab_scopes"]).catch(() => ({}))) as Record<
				string,
				unknown
			>;
			const assignments = (stored[TAB_GROUPS_KEY] as Record<string, { groupId: number }>) || {};
			const scopes = (stored.tab_scopes as Record<string, { boundTabId: number }>) || {};
			const clickedSessionId = sessionForGroup(assignments, tab?.groupId);
			const currentSessionId = host.getSessionId();
			const owner = clickedSessionId ? scopes[clickedSessionId] : undefined;
			const ownerAlive =
				owner !== undefined &&
				(await chrome.tabs
					.get(owner.boundTabId)
					.then(() => true)
					.catch(() => false));
			const decision = resolveGroupClick({
				toolNavigating: isToolNavigating(),
				clickedSessionId,
				currentSessionId,
				ownerAlive,
				boundTabId: owner?.boundTabId,
				streaming: host.getAgent()?.state.isStreaming === true,
			});
			if (decision.action === "reveal") {
				await chrome.sidePanel.open({ tabId: decision.boundTabId }).catch(() => {});
				return;
			}
			if (decision.action === "adopt") {
				await chrome.storage.session.set({ "tabGroup.pendingSession": decision.sessionId }).catch(() => {});
				await chrome.sidePanel
					.setOptions({
						tabId: activeInfo.tabId,
						path: `sidepanel.html?session=${encodeURIComponent(decision.sessionId)}&tabId=${activeInfo.tabId}`,
						enabled: true,
					})
					.catch(() => {});
				await chrome.sidePanel.open({ tabId: activeInfo.tabId }).catch(() => {});
				return;
			}
		}

		// Tab scope: track the acting tab inside the group, ignore foreign tabs.
		if (await isTabScopeEnabled()) {
			const scope = getCurrentScope();
			if (!scope || !scope.tabIds.has(activeInfo.tabId)) return;
			setActingTab(activeInfo.tabId);
		}

		const tab = await chrome.tabs.get(activeInfo.tabId);
		const agent = host.getAgent();
		if (
			tab.url &&
			agent?.state.isStreaming &&
			!tab.url.startsWith("chrome-extension://") &&
			!tab.url.startsWith("moz-extension://") &&
			!isToolNavigating()
		) {
			const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
			agent.steer(navMessage);
			console.log("Queued navigation message for tab switch to", tab.url);
		}
	});
}

export function installSessionTabListeners(): void {
	if (tabListenersInstalled) return;
	tabListenersInstalled = true;
	installUpdatedListener();
	installActivatedListener();
}
