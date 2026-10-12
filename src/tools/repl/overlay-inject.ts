import { getPageTab } from "../../tasks/client.js";
import { createOverlayAbortRequest, removeOverlayAbortRequest } from "./overlay-abort.js";
import { createOverlayScript, removeOverlayScript } from "./overlay-content.js";

const OVERLAY_WORLD_ID = "sitegeist-repl-overlay";

/**
 * Get the currently active tab ID.
 * @returns Tab ID of the active tab in the current window
 * @throws Error if no active tab is found
 */
async function getActiveTabId(): Promise<number> {
	const tab = await getPageTab();
	if (!tab) throw new Error("No active tab found");
	return tab.id;
}

/**
 * Inject the REPL overlay into the active tab.
 * @param tabId - ID of the tab to inject into
 * @param taskName - Name of the task being executed (shown in overlay)
 */
export async function injectOverlay(tabId: number, taskName: string): Promise<string | undefined> {
	let requestId: string | undefined;
	try {
		// Check if tab is a restricted URL
		const tab = await chrome.tabs.get(tabId);
		if (
			tab.url?.startsWith("chrome://") ||
			tab.url?.startsWith("chrome-extension://") ||
			tab.url?.startsWith("moz-extension://") ||
			tab.url?.startsWith("about:")
		) {
			// Can't inject into system pages - skip overlay
			console.warn("[Overlay] Cannot inject overlay into system page:", tab.url);
			return;
		}

		// Use userScripts API with messaging enabled
		if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
			// Configure world with messaging enabled
			try {
				await chrome.userScripts.configureWorld({
					worldId: OVERLAY_WORLD_ID,
					messaging: true,
					csp: "script-src 'unsafe-eval' 'unsafe-inline'; style-src 'unsafe-inline'; default-src 'none';",
				});
			} catch (e) {
				console.warn("[Overlay] Failed to configure userScripts world:", e);
			}

			// Inject overlay script
			const abortRequest = createOverlayAbortRequest(tabId, tab.windowId);
			requestId = abortRequest.requestId;
			await chrome.userScripts.execute({
				js: [{ code: createOverlayScript(taskName, abortRequest) }],
				target: { tabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId: OVERLAY_WORLD_ID,
				injectImmediately: true,
			});

			console.log("[Overlay] Injected overlay into tab", tabId);
			return requestId;
		} else {
			console.warn("[Overlay] userScripts API not available");
		}
	} catch (error) {
		if (requestId !== undefined) await removeOverlay(tabId, requestId);
		// Don't fail the REPL if overlay injection fails
		console.warn("[Overlay] Failed to inject overlay:", error);
	}
}

/**
 * Remove the REPL overlay from the active tab.
 * @param tabId - ID of the tab to remove overlay from
 */
export async function removeOverlay(tabId: number, requestId?: string): Promise<void> {
	if (!removeOverlayAbortRequest(tabId, requestId)) return;
	try {
		if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
			await chrome.userScripts.execute({
				js: [{ code: removeOverlayScript(requestId) }],
				target: { tabId, allFrames: false },
				world: "USER_SCRIPT",
				worldId: OVERLAY_WORLD_ID,
				injectImmediately: true,
			});

			console.log("[Overlay] Removed overlay from tab", tabId);
		}
	} catch (error) {
		// Don't fail the REPL if overlay removal fails (tab might be closed)
		console.warn("[Overlay] Failed to remove overlay:", error);
	}
}

/**
 * Inject overlay for the currently active tab.
 * Automatically determines the active tab.
 * @param taskName - Name of the task being executed
 * @returns Tab ID where overlay was injected
 */
export async function injectOverlayForActiveTab(taskName: string): Promise<{ tabId: number; requestId?: string }> {
	const tabId = await getActiveTabId();
	const requestId = await injectOverlay(tabId, taskName);
	return { tabId, requestId };
}

/**
 * Remove overlay from the currently active tab.
 * Automatically determines the active tab.
 */
export async function removeOverlayForActiveTab(): Promise<void> {
	try {
		const tabId = await getActiveTabId();
		await removeOverlay(tabId);
	} catch (error) {
		// Tab might have been closed
		console.warn("[Overlay] Failed to remove overlay from active tab:", error);
	}
}
