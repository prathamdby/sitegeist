/**
 * Session panel attachment for background tab groups.
 *
 * Chrome keeps one side panel document per tab and only allows
 * `sidePanel.open()` inside a user gesture. A tab therefore shows a session
 * on activation only when its tab-specific panel was registered beforehand.
 * Every tab in a session's group is registered with a panel for that
 * session; the panel documents then coordinate through a Web Lock (one owner
 * runs the agent) and a BroadcastChannel (the others mirror it live).
 */

/** storage.session key prefix: `group_panel:<tabId>` -> sessionId the tab's panel is registered for. */
export const GROUP_PANEL_KEY_PREFIX = "group_panel:";

/** Setting: focus a new session's worker tab when the session starts. Default on. */
export const FOCUS_SESSION_TAB_KEY = "tabScope.focusSessionTab";

export function sessionPanelPath(sessionId: string, tabId: number): string {
	return `sidepanel.html?session=${encodeURIComponent(sessionId)}&tabId=${tabId}`;
}

/** Web Lock held for its lifetime by the panel document that runs the session's agent. */
export function sessionOwnerLockName(sessionId: string): string {
	return `sitegeist-session-owner:${sessionId}`;
}

/** BroadcastChannel shared by every panel document showing the session. */
export function sessionChannelName(sessionId: string): string {
	return `sitegeist-session:${sessionId}`;
}

/** Session whose persistent group assignment matches the group id. Pure. */
export function sessionForGroup(
	assignments: Record<string, { groupId: number } | undefined>,
	groupId: number | undefined,
): string | undefined {
	if (groupId === undefined || groupId === -1) return undefined;
	for (const [sessionId, assignment] of Object.entries(assignments)) {
		if (assignment?.groupId === groupId) return sessionId;
	}
	return undefined;
}

function panelKey(tabId: number): string {
	return `${GROUP_PANEL_KEY_PREFIX}${tabId}`;
}

/** Session the tab's panel is registered for, if any. */
export async function getAttachedSession(tabId: number): Promise<string | undefined> {
	try {
		const key = panelKey(tabId);
		const stored = await chrome.storage.session.get(key);
		const value = stored[key];
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Register the tab's side panel for the session. Idempotent: re-registering
 * the same session is skipped, because a path change reloads the tab's panel
 * document and would kill a run hosted there. Never throws.
 */
export async function attachPanelToTab(tabId: number, sessionId: string): Promise<void> {
	try {
		if ((await getAttachedSession(tabId)) === sessionId) return;
		await chrome.sidePanel.setOptions({ tabId, path: sessionPanelPath(sessionId, tabId), enabled: true });
		await chrome.storage.session.set({ [panelKey(tabId)]: sessionId });
	} catch (err) {
		console.warn("[SessionPanels] Failed to attach panel to tab", tabId, err);
	}
}

/** Forget the registration of a closed tab. Never throws. */
export async function forgetPanelForTab(tabId: number): Promise<void> {
	try {
		await chrome.storage.session.remove(panelKey(tabId));
	} catch {
		// Best effort.
	}
}

export async function isFocusSessionTabEnabled(): Promise<boolean> {
	try {
		if (typeof chrome === "undefined" || !chrome.storage?.local) return true;
		const stored = await chrome.storage.local.get(FOCUS_SESSION_TAB_KEY);
		return stored[FOCUS_SESSION_TAB_KEY] !== false;
	} catch {
		return true;
	}
}
