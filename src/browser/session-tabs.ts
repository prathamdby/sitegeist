/**
 * Tab-scope kernel (M1-M4).
 *
 * Flag-gated, off by default. When the flag is off every helper below is
 * inert and all callers must keep legacy window-scoped behavior.
 */

export const TAB_SCOPE_FLAG_KEY = "tabScope.enabled";

/** storage.session key: sessionId -> { groupId }. Persistent group assignment, one per session. */
export const TAB_GROUPS_KEY = "tab_groups";

export interface TabGroupAssignment {
	groupId: number;
}

let testOverride: boolean | undefined;
let lastKnownEnabled = false;

/** Test-only override for the flag. Pass undefined to clear. */
export function setTabScopeEnabledForTests(value: boolean | undefined): void {
	testOverride = value;
	if (value !== undefined) lastKnownEnabled = value;
}

export async function isTabScopeEnabled(): Promise<boolean> {
	if (testOverride !== undefined) return testOverride;
	try {
		if (typeof chrome === "undefined" || !chrome.storage?.local) return false;
		const stored = await chrome.storage.local.get(TAB_SCOPE_FLAG_KEY);
		lastKnownEnabled = stored[TAB_SCOPE_FLAG_KEY] === true;
		return lastKnownEnabled;
	} catch {
		return false;
	}
}

/**
 * Sync mirror of the flag for renderers and other sync contexts.
 * Reflects the last async resolution or test override; defaults false.
 */
export function isTabScopeEnabledSync(): boolean {
	if (testOverride !== undefined) return testOverride;
	return lastKnownEnabled;
}

export interface TabRef {
	id?: number;
	groupId?: number;
}

/** Keep only tabs whose id is in the allowed set. Pure; safe in node tests. */
export function filterTabsToScope<T extends TabRef>(tabs: T[], allowedTabIds: Set<number> | number[]): T[] {
	const allowed = allowedTabIds instanceof Set ? allowedTabIds : new Set(allowedTabIds);
	return tabs.filter((tab) => tab.id !== undefined && allowed.has(tab.id));
}

export function isTabInScope(tabId: number, allowedTabIds: Set<number> | number[]): boolean {
	const allowed = allowedTabIds instanceof Set ? allowedTabIds : new Set(allowedTabIds);
	return allowed.has(tabId);
}

/** Throw before any focus or navigation change when the tab is foreign. */
export function assertTabInScope(tabId: number, allowedTabIds: Set<number> | number[]): void {
	if (!isTabInScope(tabId, allowedTabIds)) {
		throw new Error(`Tab ${tabId} is outside the session tab group`);
	}
}

/** Tab ids currently in a group. Filters locally so ungrouped tabs never leak in. */
export async function getGroupTabIds(groupId: number): Promise<number[]> {
	const tabs = await chrome.tabs.query({ groupId });
	const ids: number[] = [];
	for (const tab of tabs) {
		if (tab.id !== undefined) ids.push(tab.id);
	}
	return ids;
}

/**
 * Create a tab without stealing focus, optionally adding it to a group.
 * Never activates or focuses. Without a url the tab opens the new-tab page.
 * When grouping fails the tab is left in place (deleting a user-visible tab
 * would be worse) and the error names both ids.
 */
export async function createTabInScope(url?: string, groupId?: number): Promise<chrome.tabs.Tab> {
	const tab = await chrome.tabs.create({ ...(url !== undefined ? { url } : {}), active: false });
	if (tab.id === undefined) {
		throw new Error("Failed to create new tab: missing tab id");
	}
	if (groupId === undefined) return tab;
	try {
		await chrome.tabs.group({ tabIds: tab.id, groupId });
	} catch (err) {
		throw new Error(
			`Created tab ${tab.id} but failed to add it to group ${groupId}: ${err instanceof Error ? err.message : String(err)}`,
			{ cause: err },
		);
	}
	return tab;
}

/** Create a group for tabs, or add tabs to an existing group. Returns the group id. */
export async function ensureGroupForTabs(tabIds: number[], groupId?: number): Promise<number> {
	if (tabIds.length === 0) {
		throw new Error("Cannot create a tab group with no tabs");
	}
	const ids = tabIds as [number, ...number[]];
	if (groupId === undefined) {
		return await chrome.tabs.group({ tabIds: ids });
	}
	return await chrome.tabs.group({ tabIds: ids, groupId });
}

// ============================================================================
// CURRENT SCOPE (sidepanel-owned, M2)
// ============================================================================

export interface CurrentTabScope {
	sessionId?: string;
	tabIds: Set<number>;
	groupId?: number;
	boundTabId?: number;
	actingTabId?: number;
}

let currentScope: CurrentTabScope | undefined;

/** Sidepanel sets this after resolving its session-to-group map. */
export function setCurrentScope(scope: CurrentTabScope | undefined): void {
	currentScope = scope;
}

export function getCurrentScope(): CurrentTabScope | undefined {
	return currentScope;
}

export function clearCurrentScope(): void {
	currentScope = undefined;
}

/** Record where the agent last acted inside its group. Ignored when id is not in scope. */
export function setActingTab(tabId: number): void {
	if (!currentScope) return;
	if (!currentScope.tabIds.has(tabId)) return;
	currentScope.actingTabId = tabId;
}

/** Effective scope for a tool: explicit per-tool scope wins, else the current session scope. */
export function getEffectiveScope(
	explicitTabIds?: Set<number>,
	explicitGroupId?: number,
): {
	tabIds?: Set<number>;
	groupId?: number;
} {
	if (explicitTabIds !== undefined) return { tabIds: explicitTabIds, groupId: explicitGroupId };
	if (!currentScope) return {};
	return { tabIds: currentScope.tabIds, groupId: currentScope.groupId ?? explicitGroupId };
}

export function isRestrictedUrl(url: string | undefined): boolean {
	if (!url) return true;
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("moz-extension://") ||
		url.startsWith("about:")
	);
}

/**
 * Resolve the tab the agent should act on. Flag off or no scope means the
 * legacy active tab in the current window. Flag on with scope means the
 * acting tab (falling back to a surviving group sibling, then the bound
 * tab), verified to still exist. Never returns a foreign tab.
 */
export async function resolveActingTab(): Promise<chrome.tabs.Tab> {
	if ((await isTabScopeEnabled()) && currentScope) {
		const preferred = currentScope.actingTabId ?? currentScope.boundTabId;
		if (preferred !== undefined) {
			try {
				const tab = await chrome.tabs.get(preferred);
				if (tab.id !== undefined) return tab;
			} catch {
				// Fall through to the group-sibling lookup below.
			}
		}
		// Preferred tab is gone (e.g. user closed the worker tab): stay
		// inside the group by adopting a surviving sibling instead of
		// falling back to the user's tab.
		if (currentScope.groupId !== undefined) {
			try {
				const siblingIds = await getGroupTabIds(currentScope.groupId);
				for (const siblingId of siblingIds) {
					try {
						const sibling = await chrome.tabs.get(siblingId);
						if (sibling.id !== undefined) {
							currentScope.actingTabId = sibling.id;
							return sibling;
						}
					} catch {
						// Try the next sibling.
					}
				}
			} catch {
				// Fall through to the legacy lookup below.
			}
		}
		if (currentScope.boundTabId !== undefined) {
			try {
				const bound = await chrome.tabs.get(currentScope.boundTabId);
				if (bound.id !== undefined) return bound;
			} catch {
				// Fall through to the legacy lookup below.
			}
		}
	}
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab || tab.id === undefined) {
		throw new Error("No active tab found");
	}
	return tab;
}

/** Acting tab id when the flag is on and a scope exists; undefined otherwise. Testable without chrome. */
export function getScopedActingTabId(): number | undefined {
	if (!isTabScopeEnabledSync() || !currentScope) return undefined;
	return currentScope.actingTabId ?? currentScope.boundTabId;
}
