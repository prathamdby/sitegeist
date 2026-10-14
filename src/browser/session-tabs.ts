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
let flagWatchInstalled = false;
let flagEpoch = 0;

/** Test-only override for the flag. Pass undefined to clear. */
export function setTabScopeEnabledForTests(value: boolean | undefined): void {
	testOverride = value;
	if (value !== undefined) lastKnownEnabled = value;
}

/**
 * Prime the sync mirror from storage and keep it current. One listener for
 * the process; a later toggle must not leave `isTabScopeEnabledSync` stuck
 * at the default false.
 */
function ensureTabScopeFlagWatcher(): void {
	if (flagWatchInstalled) return;
	if (typeof chrome === "undefined" || !chrome.storage?.onChanged || !chrome.storage.local) return;
	flagWatchInstalled = true;
	chrome.storage.onChanged.addListener((changes, areaName) => {
		if (areaName !== "local") return;
		const change = changes[TAB_SCOPE_FLAG_KEY];
		if (!change) return;
		flagEpoch += 1;
		if (testOverride !== undefined) return;
		lastKnownEnabled = change.newValue === true;
	});
	const epoch = flagEpoch;
	void chrome.storage.local.get(TAB_SCOPE_FLAG_KEY).then(
		(stored) => {
			if (testOverride !== undefined || epoch !== flagEpoch) return;
			lastKnownEnabled = stored[TAB_SCOPE_FLAG_KEY] === true;
		},
		() => {},
	);
}

export async function isTabScopeEnabled(): Promise<boolean> {
	if (testOverride !== undefined) return testOverride;
	ensureTabScopeFlagWatcher();
	try {
		if (typeof chrome === "undefined" || !chrome.storage?.local) return false;
		const epoch = flagEpoch;
		const stored = await chrome.storage.local.get(TAB_SCOPE_FLAG_KEY);
		if (testOverride !== undefined) return testOverride;
		if (epoch !== flagEpoch) return lastKnownEnabled;
		lastKnownEnabled = stored[TAB_SCOPE_FLAG_KEY] === true;
		return lastKnownEnabled;
	} catch {
		return false;
	}
}

/**
 * Sync mirror of the flag for renderers and other sync contexts.
 * Reflects the last async resolution, the storage listener, or a test override.
 * Defaults false until the first storage read lands.
 */
export function isTabScopeEnabledSync(): boolean {
	if (testOverride !== undefined) return testOverride;
	ensureTabScopeFlagWatcher();
	return lastKnownEnabled;
}

ensureTabScopeFlagWatcher();

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
		if (tab.id !== undefined && tab.groupId === groupId) ids.push(tab.id);
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
 * Next acting tab id, or undefined when the live group has none.
 *
 * The result is always a member of `liveGroupTabIds`. The recorded acting
 * tab wins when it is live. Otherwise the first live id that is not the
 * bound panel tab is chosen. The bound panel tab is returned only when it
 * is itself in the live group and no other member is. Never a foreign id.
 */
/**
 * Ids the acting-tab chooser may see.
 *
 * A recorded group uses the group query, including an empty or failed query.
 * No group uses the recorded tab ids. Those two sets are never mixed.
 */
export function actingCandidates(
	scope: { groupId?: number; tabIds: ReadonlySet<number> | readonly number[] },
	groupMemberIds: readonly number[] | undefined,
): number[] {
	if (scope.groupId !== undefined) return groupMemberIds === undefined ? [] : [...groupMemberIds];
	return [...scope.tabIds];
}

export function chooseActingTabId(
	scope: { actingTabId?: number; boundTabId?: number },
	liveGroupTabIds: ReadonlySet<number> | readonly number[],
): number | undefined {
	const live = liveGroupTabIds instanceof Set ? liveGroupTabIds : new Set(liveGroupTabIds);
	if (live.size === 0) return undefined;
	if (scope.actingTabId !== undefined && live.has(scope.actingTabId)) return scope.actingTabId;
	for (const id of live) {
		if (id !== scope.boundTabId) return id;
	}
	if (scope.boundTabId !== undefined && live.has(scope.boundTabId)) return scope.boundTabId;
	return undefined;
}

/**
 * Tab the agent should act on.
 *
 * Flag off, or no current scope: the legacy active tab in the current window.
 * Flag on with a scope: `actingCandidates` then `chooseActingTabId`. A missing
 * group uses recorded tab ids that still exist. A present group uses the
 * group query, and a failed query is empty. Throws when the chooser returns
 * undefined. Does not query the window's active tab on this branch.
 * Adopting a sibling records that id, and the candidate ids, on the scope.
 */
export async function resolveActingTab(): Promise<chrome.tabs.Tab> {
	if ((await isTabScopeEnabled()) && currentScope) {
		let groupMemberIds: number[] | undefined;
		if (currentScope.groupId !== undefined) {
			try {
				groupMemberIds = await getGroupTabIds(currentScope.groupId);
			} catch {
				groupMemberIds = [];
			}
		}
		let candidates = actingCandidates(currentScope, groupMemberIds);
		if (currentScope.groupId === undefined) {
			const alive: number[] = [];
			for (const id of candidates) {
				try {
					const tab = await chrome.tabs.get(id);
					if (tab.id !== undefined) alive.push(tab.id);
				} catch {
					// Recorded id is gone.
				}
			}
			candidates = alive;
		}
		const chosen = chooseActingTabId(currentScope, candidates);
		if (chosen === undefined) {
			throw new Error("No acting tab in the session tab group");
		}
		if (chosen !== currentScope.actingTabId) {
			currentScope.actingTabId = chosen;
			for (const id of candidates) currentScope.tabIds.add(id);
		}
		try {
			const tab = await chrome.tabs.get(chosen);
			if (tab.id !== undefined) return tab;
		} catch {
			// The chosen id vanished between the group query and the get.
		}
		throw new Error("No acting tab in the session tab group");
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

// ============================================================================
// SCOPE OWNERSHIP (background applies these; no second store)
// ============================================================================

/**
 * Whether this port may write the session's scope record.
 *
 * A tab-bound port's tab id is the requester and must equal `requestedTabId`.
 * A live foreign owner is never overwritten. A dead owner may be replaced.
 * A legacy window port (no tab id) cannot take a live tab-bound owner, even
 * if it claims that owner's tab id. `ownerAlive` is ignored when there is
 * no existing record.
 */
export function mayAcquireTabScope(
	callerTabId: number | undefined,
	requestedTabId: number,
	existingBoundTabId: number | undefined,
	ownerAlive: boolean,
): boolean {
	if (callerTabId !== undefined && callerTabId !== requestedTabId) return false;
	if (existingBoundTabId !== undefined && ownerAlive) {
		if (callerTabId === undefined) return false;
		return callerTabId === existingBoundTabId;
	}
	return true;
}

/**
 * Whether this port may delete the session's scope record.
 *
 * The owning tab may always release. A different tab never deletes, even
 * when the owner is already dead (reclaim goes through acquire). A legacy
 * window port may delete only when the bound tab is gone.
 */
export function mayReleaseTabScope(
	callerTabId: number | undefined,
	existingBoundTabId: number | undefined,
	ownerAlive: boolean,
): boolean {
	if (existingBoundTabId === undefined) return false;
	if (callerTabId !== undefined) return callerTabId === existingBoundTabId;
	return !ownerAlive;
}

/**
 * Whether `tab` may become the session's acting tab.
 *
 * With a group, the tab must belong to that group. Without one, only the
 * recorded acting tab id is accepted: no expansion to an arbitrary tab.
 */
export function mayUpdateActingTab(
	record: { actingTabId: number; groupId?: number },
	tab: { id?: number; groupId?: number },
): boolean {
	if (tab.id === undefined) return false;
	if (record.groupId !== undefined) return tab.groupId === record.groupId;
	return tab.id === record.actingTabId;
}
