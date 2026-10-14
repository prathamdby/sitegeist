import {
	attachPanelToTab,
	forgetPanelForTab,
	GROUP_PANEL_KEY_PREFIX,
	sessionForGroup,
} from "./browser/session-panels.js";
import {
	mayAcquireTabScope,
	mayGrantTabBoundLock,
	mayReleaseTabScope,
	mayUpdateActingTab,
	remapReplacedTabId,
	TAB_GROUPS_KEY,
	TAB_SCOPE_FLAG_KEY,
} from "./browser/session-tabs.js";
import { relayOverlayAbortMessage } from "./tools/repl/overlay-abort.js";
import type {
	LockedSessionsMessage,
	LockResultMessage,
	SidepanelToBackgroundMessage,
	TabScopeRecord,
} from "./utils/port.js";

// Called when Sitegeist icon is clicked - opens sidepanel for current tab
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		chrome.sidePanel.open({ tabId });
	}
});

// Listen for messages from userScripts (overlay in page)
console.log("[Background] onUserScriptMessage available:", !!chrome.runtime.onUserScriptMessage);
if (chrome.runtime.onUserScriptMessage) {
	chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
		console.log("[Background] Received userScript message type:", message?.type, "from tab:", sender.tab?.id);
		const abortMessage = relayOverlayAbortMessage(message, sender);
		if (abortMessage) {
			// Forward to all open sidepanels (they'll check if they're streaming)
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

// Storage keys for tracking state (persists across service worker sleep)
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
const SESSION_LOCKS_KEY = "session_locks"; // sessionId -> windowId mapping
const TAB_SCOPES_KEY = "tab_scopes"; // sessionId -> TabScopeRecord (M2/M4)

// Synchronously readable cache of which sidepanels are open
// Gets populated on startup and updated by port events
let openSidepanels = new Set<number>();
const sessionClaimTail = new Map<string, Promise<void>>();

function claimSessionTurn<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
	const previous = sessionClaimTail.get(sessionId) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	sessionClaimTail.set(
		sessionId,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	return run;
}

// Initialize cache from storage on startup
chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
	openSidepanels = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
	console.log("[Background] Initialized openSidepanels cache:", Array.from(openSidepanels));
});

// Handle port connections from sidepanels
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name formats (dual-accept through the tab-scope cutover):
	//   legacy: "sidepanel:${windowId}"
	//   tab-bound: "sidepanel:tab:${tabId}:${sessionId|-}"
	const legacyMatch = /^sidepanel:(\d+)$/.exec(port.name);
	const tabMatch = /^sidepanel:tab:(\d+):(.*)$/.exec(port.name);
	if (!legacyMatch && !tabMatch) return;

	const windowId = legacyMatch ? Number(legacyMatch[1]) : undefined;
	const tabBoundPort = tabMatch
		? { tabId: Number(tabMatch[1]), sessionId: tabMatch[2] === "-" ? undefined : tabMatch[2] }
		: undefined;

	// Legacy cache bookkeeping only applies to window-bound ports. Tab-bound
	// ports resolve their window from the tab at message time.
	if (windowId !== undefined) {
		openSidepanels.add(windowId);
	}

	// Mark sidepanel as open in persistent storage (survives service worker sleep)
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		if (windowId !== undefined) {
			openWindows.add(windowId);
			chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
		} else if (tabBoundPort) {
			// Resolve the tab's window so toggle/lock heuristics keep working.
			chrome.tabs.get(tabBoundPort.tabId).then(
				(tab) => {
					if (tab.windowId !== undefined) {
						openWindows.add(tab.windowId);
						chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
					}
				},
				() => {},
			);
		}
	});

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;

			// Tab-bound panels own sessions per tab: a session bound to one
			// tab cannot be taken by another tab's panel, even in the same
			// window. This is what keeps two tabs' sessions independent.
			// Legacy window-bound panels keep the original window logic.
			if (tabBoundPort) {
				const callerTabId = tabBoundPort.tabId;
				void claimSessionTurn(sessionId, async () => {
					const data = await chrome.storage.session.get([TAB_SCOPES_KEY, SESSION_LOCKS_KEY]);
					const scopes = ((data[TAB_SCOPES_KEY] as Record<string, TabScopeRecord>) || {}) as Record<
						string,
						TabScopeRecord
					>;
					const sessionLocks = ((data[SESSION_LOCKS_KEY] as Record<string, number>) || {}) as Record<
						string,
						number
					>;
					const record = scopes[sessionId];
					const ownerAlive =
						record !== undefined &&
						(await chrome.tabs
							.get(record.boundTabId)
							.then(() => true)
							.catch(() => false));
					const lockWindowId = sessionLocks[sessionId];
					if (
						!mayGrantTabBoundLock({
							callerTabId,
							callerWindowId: reqWindowId,
							boundTabId: record?.boundTabId,
							ownerAlive,
							lockWindowId,
							lockWindowOpen: lockWindowId !== undefined && openSidepanels.has(lockWindowId),
						})
					) {
						const denied: LockResultMessage = { type: "lockResult", sessionId, success: false };
						port.postMessage(denied);
						return;
					}
					const actingTabId =
						record !== undefined && ownerAlive && record.actingTabId !== record.boundTabId
							? record.actingTabId
							: callerTabId;
					scopes[sessionId] = {
						sessionId,
						boundTabId: callerTabId,
						actingTabId,
						windowId: reqWindowId,
						...(record?.groupId !== undefined ? { groupId: record.groupId } : {}),
					};
					sessionLocks[sessionId] = reqWindowId;
					await chrome.storage.session.set({
						[TAB_SCOPES_KEY]: scopes,
						[SESSION_LOCKS_KEY]: sessionLocks,
					});
					const written = await chrome.storage.session.get(TAB_SCOPES_KEY);
					const stored = (written[TAB_SCOPES_KEY] as Record<string, TabScopeRecord> | undefined)?.[sessionId];
					if (stored?.boundTabId !== callerTabId) {
						const denied: LockResultMessage = { type: "lockResult", sessionId, success: false };
						port.postMessage(denied);
						return;
					}
					const granted: LockResultMessage = { type: "lockResult", sessionId, success: true };
					port.postMessage(granted);
				});
				return;
			}

			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const ownerWindowId = sessionLocks[sessionId];
				const ownerSidepanelOpen = ownerWindowId !== undefined && openSidepanels.has(ownerWindowId);

				// Grant lock if: no owner, owner sidepanel closed, or requesting window is owner
				const success = !ownerWindowId || !ownerSidepanelOpen || ownerWindowId === reqWindowId;

				const response: LockResultMessage = success
					? {
							type: "lockResult",
							sessionId,
							success: true,
						}
					: {
							type: "lockResult",
							sessionId,
							success: false,
							ownerWindowId,
						};

				if (success) {
					// Update locks in storage
					sessionLocks[sessionId] = reqWindowId;
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: sessionLocks });
				}

				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const locks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
				const response: LockedSessionsMessage = {
					type: "lockedSessions",
					locks,
				};
				port.postMessage(response);
			});
		} else if (msg.type === "acquireTabScope") {
			void handleAcquireTabScope(port, msg, tabBoundPort?.tabId);
		} else if (msg.type === "updateActingTab") {
			void handleUpdateActingTab(port, msg);
		} else if (msg.type === "releaseTabScope") {
			void handleReleaseTabScope(port, msg, tabBoundPort?.tabId);
		} else if (msg.type === "getTabScopes") {
			chrome.storage.session.get(TAB_SCOPES_KEY, (data) => {
				const scopes = ((data[TAB_SCOPES_KEY] as Record<string, TabScopeRecord>) || {}) as Record<
					string,
					TabScopeRecord
				>;
				port.postMessage({ type: "tabScopes", scopes });
			});
		}
	});

	port.onDisconnect.addListener(() => {
		if (windowId !== undefined) {
			closeSidepanel(windowId, false);
			return;
		}
		// Tab-bound port: keep the scope record so a reload re-adopts its
		// group instead of orphaning it. Tab/window close cleans up via
		// onRemoved handlers; dead owners are verified at acquire time.
	});
});

// Clean up locks when entire window closes (belt-and-suspenders)
chrome.windows.onRemoved.addListener((windowId: number) => {
	closeSidepanel(windowId, false);
	void releaseScopesForWindow(windowId);
});

// ============================================================================
// TAB-SCOPE LIFECYCLE (M4)
// ============================================================================

async function readScopes(): Promise<Record<string, TabScopeRecord>> {
	const data = await chrome.storage.session.get(TAB_SCOPES_KEY);
	return ((data[TAB_SCOPES_KEY] as Record<string, TabScopeRecord>) || {}) as Record<string, TabScopeRecord>;
}

async function tabStillExists(tabId: number): Promise<boolean> {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}

function denyTabScope(port: chrome.runtime.Port, sessionId: string): void {
	port.postMessage({ type: "tabScopeAcquired", sessionId, success: false, tabIds: [] });
}

/**
 * Bind the session to the port's tab. A live foreign owner is left in place.
 * A legacy window port cannot steal that owner; a dead owner is overwritten.
 */
async function handleAcquireTabScope(
	port: chrome.runtime.Port,
	msg: Extract<SidepanelToBackgroundMessage, { type: "acquireTabScope" }>,
	callerTabId: number | undefined,
): Promise<void> {
	const { sessionId, tabId, windowId: reqWindowId, groupId: reqGroupId, actingTabId: reqActingTabId } = msg;
	const scopes = await readScopes();
	const existing = scopes[sessionId];
	const ownerAlive = existing !== undefined && (await tabStillExists(existing.boundTabId));
	if (!mayAcquireTabScope(callerTabId, tabId, existing?.boundTabId, ownerAlive)) {
		denyTabScope(port, sessionId);
		return;
	}
	const boundTabId = callerTabId ?? tabId;
	let tab: chrome.tabs.Tab;
	try {
		tab = await chrome.tabs.get(boundTabId);
	} catch {
		denyTabScope(port, sessionId);
		return;
	}
	let groupId = reqGroupId ?? existing?.groupId;
	if (groupId !== undefined) {
		try {
			await chrome.tabGroups.get(groupId);
		} catch {
			groupId = undefined;
		}
	}
	scopes[sessionId] = {
		sessionId,
		boundTabId,
		actingTabId: reqActingTabId ?? existing?.actingTabId ?? boundTabId,
		windowId: tab.windowId ?? reqWindowId,
		...(groupId !== undefined ? { groupId } : {}),
	};
	await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
	let tabIds = [boundTabId];
	if (groupId !== undefined) {
		try {
			const grouped = await chrome.tabs.query({ groupId });
			const ids = grouped.map((t) => t.id).filter((id): id is number => id !== undefined);
			if (ids.length > 0) tabIds = ids;
		} catch {
			// Fall through with the bound tab only.
		}
	}
	port.postMessage({ type: "tabScopeAcquired", sessionId, success: true, groupId, tabIds });
	void setPanelForTab(boundTabId, true);
}

/** Move the acting tab only inside the recorded group, or not at all. */
async function handleUpdateActingTab(
	port: chrome.runtime.Port,
	msg: Extract<SidepanelToBackgroundMessage, { type: "updateActingTab" }>,
): Promise<void> {
	const { sessionId, tabId } = msg;
	const fail = () => {
		port.postMessage({ type: "actingTabUpdated", sessionId, success: false });
	};
	const scopes = await readScopes();
	const existing = scopes[sessionId];
	if (!existing) {
		fail();
		return;
	}
	let tab: chrome.tabs.Tab;
	try {
		tab = await chrome.tabs.get(tabId);
	} catch {
		fail();
		return;
	}
	if (!mayUpdateActingTab(existing, tab)) {
		fail();
		return;
	}
	existing.actingTabId = tabId;
	await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
	port.postMessage({ type: "actingTabUpdated", sessionId, success: true });
}

/**
 * Delete only for the owning tab, or for a legacy port whose bound tab is
 * already gone. A different tab cannot drop the record; it reclaims through
 * acquire once the owner is dead. The reply is unconditional so the port
 * client does not time out; a refusal leaves the record in place.
 */
async function handleReleaseTabScope(
	port: chrome.runtime.Port,
	msg: Extract<SidepanelToBackgroundMessage, { type: "releaseTabScope" }>,
	callerTabId: number | undefined,
): Promise<void> {
	const { sessionId } = msg;
	const scopes = await readScopes();
	const existing = scopes[sessionId];
	const ownerAlive = existing !== undefined && (await tabStillExists(existing.boundTabId));
	if (mayReleaseTabScope(callerTabId, existing?.boundTabId, ownerAlive)) {
		delete scopes[sessionId];
		await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
	}
	port.postMessage({ type: "tabScopeReleased", sessionId });
}

async function releaseScopesForWindow(windowId: number): Promise<void> {
	const scopes = await readScopes();
	let changed = false;
	for (const sessionId of Object.keys(scopes)) {
		if (scopes[sessionId].windowId === windowId) {
			delete scopes[sessionId];
			changed = true;
		}
	}
	if (changed) {
		await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
	}
}

/** Best-effort per-tab panel enable/disable. Never throws; flag-gated callers only. */
export async function setPanelForTab(tabId: number, enabled: boolean, path?: string): Promise<void> {
	try {
		const api = chrome.sidePanel as unknown as {
			setOptions?: (options: { tabId: number; enabled: boolean; path?: string }) => Promise<void>;
		};
		if (typeof api.setOptions !== "function") return;
		if (path !== undefined) {
			await api.setOptions({ tabId, enabled, path });
		} else {
			await api.setOptions({ tabId, enabled });
		}
	} catch (err) {
		console.warn("[Background] setPanelForTab failed:", err);
	}
}

// ============================================================================
// GROUP PANELS
// ============================================================================
// Every tab in a session's group gets a tab-specific panel for that session,
// registered before the user can activate it: sidePanel.open() needs a user
// gesture, but Chrome shows an already registered tab panel on activation.

async function isTabScopeOn(): Promise<boolean> {
	try {
		const stored = await chrome.storage.local.get(TAB_SCOPE_FLAG_KEY);
		return stored[TAB_SCOPE_FLAG_KEY] === true;
	} catch {
		return false;
	}
}

async function readGroupAssignments(): Promise<Record<string, { groupId: number }>> {
	try {
		const data = await chrome.storage.session.get(TAB_GROUPS_KEY);
		return ((data[TAB_GROUPS_KEY] as Record<string, { groupId: number }>) || {}) as Record<
			string,
			{ groupId: number }
		>;
	} catch {
		return {};
	}
}

async function attachAllGroupPanels(): Promise<void> {
	if (!(await isTabScopeOn())) return;
	const assignments = await readGroupAssignments();
	for (const [sessionId, assignment] of Object.entries(assignments)) {
		let tabs: chrome.tabs.Tab[];
		try {
			tabs = await chrome.tabs.query({ groupId: assignment.groupId });
		} catch {
			continue;
		}
		for (const tab of tabs) {
			if (tab.id !== undefined) await attachPanelToTab(tab.id, sessionId);
		}
	}
}

async function attachGroupPanelForTab(tabId: number, groupId: number | undefined): Promise<void> {
	if (!(await isTabScopeOn())) return;
	const sessionId = sessionForGroup(await readGroupAssignments(), groupId);
	if (sessionId !== undefined) await attachPanelToTab(tabId, sessionId);
}

/** Flag turned off: return registered group tabs to the default panel. */
async function detachAllGroupPanels(): Promise<void> {
	try {
		const all = await chrome.storage.session.get(null);
		for (const key of Object.keys(all)) {
			if (!key.startsWith(GROUP_PANEL_KEY_PREFIX)) continue;
			const tabId = Number(key.slice(GROUP_PANEL_KEY_PREFIX.length));
			if (Number.isInteger(tabId)) {
				await setPanelForTab(tabId, true, `sidepanel.html?tabId=${tabId}`);
			}
			await chrome.storage.session.remove(key);
		}
	} catch (err) {
		console.warn("[Background] Failed to detach group panels:", err);
	}
}

// Tabs join groups by agent creation, Chrome's open-in-group behavior, or
// the user dragging them in; all of them surface as a groupId change.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.groupId !== undefined) void attachGroupPanelForTab(tabId, changeInfo.groupId);
});

chrome.tabs.onCreated.addListener((tab) => {
	if (tab.id !== undefined && tab.groupId !== undefined && tab.groupId !== -1) {
		void attachGroupPanelForTab(tab.id, tab.groupId);
	}
});

chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName === "session" && changes[TAB_GROUPS_KEY]) void attachAllGroupPanels();
	if (areaName === "local" && changes[TAB_SCOPE_FLAG_KEY]) {
		if (changes[TAB_SCOPE_FLAG_KEY].newValue === true) void attachAllGroupPanels();
		else void detachAllGroupPanels();
	}
});

// Service worker start: registrations are browser state, but a missed event
// while the worker slept would leave a group tab without its panel.
void attachAllGroupPanels();

// Bound tab closed: drop the scope (a panel bound to a dead tab is gone).
// Acting tab closed: fall back to the bound tab.
chrome.tabs.onRemoved.addListener((tabId: number) => {
	void forgetPanelForTab(tabId);
	void (async () => {
		const scopes = await readScopes();
		let changed = false;
		for (const sessionId of Object.keys(scopes)) {
			const scope = scopes[sessionId];
			if (scope.boundTabId === tabId) {
				delete scopes[sessionId];
				changed = true;
			} else if (scope.actingTabId === tabId) {
				scope.actingTabId = scope.boundTabId;
				changed = true;
			}
		}
		if (changed) {
			await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
		}
	})();
});

// Group deleted by the user: keep the binding, clear the group id so the
// next ensure recreates it instead of pointing at a dead group. The
// persistent per-session assignment is cleared too: a new group is created
// only when the recorded group is actually gone.
chrome.tabGroups?.onRemoved?.addListener?.((group) => {
	void (async () => {
		const scopes = await readScopes();
		let changed = false;
		for (const sessionId of Object.keys(scopes)) {
			if (scopes[sessionId].groupId === group.id) {
				delete scopes[sessionId].groupId;
				changed = true;
			}
		}
		if (changed) {
			await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
		}
		try {
			const data = await chrome.storage.session.get(TAB_GROUPS_KEY);
			const assignments = ((data[TAB_GROUPS_KEY] as Record<string, { groupId: number }>) || {}) as Record<
				string,
				{ groupId: number }
			>;
			let assignmentsChanged = false;
			for (const sessionId of Object.keys(assignments)) {
				if (assignments[sessionId]?.groupId === group.id) {
					delete assignments[sessionId];
					assignmentsChanged = true;
				}
			}
			if (assignmentsChanged) {
				await chrome.storage.session.set({ [TAB_GROUPS_KEY]: assignments });
			}
		} catch {
			// Assignment cleanup is best effort.
		}
	})();
});

// Tab replaced (e.g. crash restore): remap bound/acting ids.
chrome.webNavigation.onTabReplaced.addListener((details) => {
	void (async () => {
		const scopes = await readScopes();
		let changed = false;
		for (const sessionId of Object.keys(scopes)) {
			const scope = scopes[sessionId];
			const boundTabId = remapReplacedTabId(scope.boundTabId, details.replacedTabId, details.tabId);
			const actingTabId = remapReplacedTabId(scope.actingTabId, details.replacedTabId, details.tabId);
			if (boundTabId !== scope.boundTabId || actingTabId !== scope.actingTabId) {
				scope.boundTabId = boundTabId;
				scope.actingTabId = actingTabId;
				changed = true;
			}
		}
		if (changed) {
			await chrome.storage.session.set({ [TAB_SCOPES_KEY]: scopes });
		}
	});
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener((command: string, sender?: chrome.tabs.Tab) => {
	if (command === "toggle-sidepanel") {
		if (!sender?.windowId) {
			console.log("[Background] Cannot toggle sidepanel: sender windowId not available");
			return;
		}

		const windowId = sender.windowId;

		// Check synchronous cache (populated from storage on startup and updated by port events)
		if (openSidepanels.has(windowId)) {
			// Sidepanel is open - close it using Chrome 141+ API
			closeSidepanel(windowId);
		} else {
			// Sidepanel is closed - open it
			chrome.sidePanel.open({ windowId });
		}
	}
});

function closeSidepanel(windowId: number, callCloseOnSidePanelAPI: boolean = true) {
	if (callCloseOnSidePanelAPI) {
		(chrome.sidePanel as any).close({ windowId });
	}

	// Update cache synchronously
	openSidepanels.delete(windowId);

	// Clean up storage state (same logic as onDisconnect)
	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		// Release session locks for this window
		const sessionLocks: Record<string, number> = (data[SESSION_LOCKS_KEY] as Record<string, number>) || {};
		for (const sessionId in sessionLocks) {
			if (sessionLocks[sessionId] === windowId) {
				delete sessionLocks[sessionId];
			}
		}

		// Mark sidepanel as closed
		const openWindows = new Set<number>((data[SIDEPANEL_OPEN_KEY] as number[]) || []);
		openWindows.delete(windowId);

		// Save both updates atomically
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: sessionLocks,
			[SIDEPANEL_OPEN_KEY]: Array.from(openWindows),
		});
	});
}
