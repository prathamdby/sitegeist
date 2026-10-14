/**
 * Centralized port communication module for sidepanel <-> background messaging.
 *
 * Handles automatic reconnection when port disconnects (Chrome disconnects after ~5min inactivity).
 * Background script listeners (runtime.onConnect) stay alive forever and handle new connections.
 */

// ============================================================================
// MESSAGE INTERFACES
// ============================================================================

/**
 * Request to acquire a session lock.
 * Sent from sidepanel to background.
 */
export interface AcquireLockMessage {
	type: "acquireLock";
	sessionId: string;
	windowId: number;
}

/**
 * Response to acquireLock request.
 * Sent from background to sidepanel.
 */
export interface LockResultMessage {
	type: "lockResult";
	sessionId: string;
	success: boolean;
	ownerWindowId?: number; // Set if lock failed (session owned by another window)
}

/**
 * Session tab-scope record owned by the background. Survives service worker
 * sleep via chrome.storage.session (M2/M4).
 */
export interface TabScopeRecord {
	sessionId: string;
	boundTabId: number;
	actingTabId: number;
	windowId: number;
	groupId?: number;
}

/**
 * Request to acquire (or adopt) a session tab scope for a bound tab.
 * The background verifies the tab still exists before granting.
 */
export interface AcquireTabScopeMessage {
	type: "acquireTabScope";
	sessionId: string;
	tabId: number;
	windowId: number;
	groupId?: number;
	actingTabId?: number;
}

export interface TabScopeAcquiredMessage {
	type: "tabScopeAcquired";
	sessionId: string;
	success: boolean;
	groupId?: number;
	tabIds: number[];
}

/** Move the session's acting tab inside its scope. */
export interface UpdateActingTabMessage {
	type: "updateActingTab";
	sessionId: string;
	tabId: number;
}

export interface ActingTabUpdatedMessage {
	type: "actingTabUpdated";
	sessionId: string;
	success: boolean;
}

export interface ReleaseTabScopeMessage {
	type: "releaseTabScope";
	sessionId: string;
}

export interface TabScopeReleasedMessage {
	type: "tabScopeReleased";
	sessionId: string;
}

export interface GetTabScopesMessage {
	type: "getTabScopes";
}

export interface RegisterMirrorProofMessage {
	type: "registerMirrorProof";
	sessionId: string;
	proof: string;
}

export interface MirrorProofRegisteredMessage {
	type: "mirrorProofRegistered";
	sessionId: string;
	success: boolean;
}

export interface GetMirrorProofMessage {
	type: "getMirrorProof";
	sessionId: string;
}

export interface UpdateTabGroupMessage {
	type: "updateTabGroup";
	sessionId: string;
	groupId?: number;
}

export interface TabGroupUpdatedMessage {
	type: "tabGroupUpdated";
	sessionId: string;
	success: boolean;
}

export interface MirrorProofMessage {
	type: "mirrorProof";
	sessionId: string;
	proof?: string;
}

export interface TabScopesMessage {
	type: "tabScopes";
	scopes: Record<string, TabScopeRecord>;
}

/**
 * Request to get all currently locked sessions.
 * Sent from sidepanel to background.
 */
export interface GetLockedSessionsMessage {
	type: "getLockedSessions";
}

/**
 * Response to getLockedSessions request.
 * Sent from background to sidepanel.
 */
export interface LockedSessionsMessage {
	type: "lockedSessions";
	locks: Record<string, number>; // sessionId -> windowId
}

// ============================================================================
// DERIVED TYPES
// ============================================================================

/**
 * Defines all request/response message pairs.
 * This is the single source of truth for all port communication.
 */
export type MessagePair =
	| { request: AcquireLockMessage; response: LockResultMessage }
	| { request: GetLockedSessionsMessage; response: LockedSessionsMessage }
	| { request: AcquireTabScopeMessage; response: TabScopeAcquiredMessage }
	| { request: UpdateActingTabMessage; response: ActingTabUpdatedMessage }
	| { request: ReleaseTabScopeMessage; response: TabScopeReleasedMessage }
	| { request: GetTabScopesMessage; response: TabScopesMessage }
	| { request: RegisterMirrorProofMessage; response: MirrorProofRegisteredMessage }
	| { request: GetMirrorProofMessage; response: MirrorProofMessage }
	| { request: UpdateTabGroupMessage; response: TabGroupUpdatedMessage };

/**
 * All messages that can be sent from sidepanel to background.
 */
export type SidepanelToBackgroundMessage = MessagePair["request"];

/**
 * All messages that can be sent from background to sidepanel.
 */
export type BackgroundToSidepanelMessage = MessagePair["response"];

/**
 * Maps request message type to corresponding response message type.
 */
export type ResponseForRequest<TRequest extends SidepanelToBackgroundMessage> = Extract<
	MessagePair,
	{ request: TRequest }
>["response"];

/**
 * Runtime mapping from request type to response type.
 * Used to determine which response message to wait for.
 */
export const REQUEST_TO_RESPONSE_TYPE: Record<
	SidepanelToBackgroundMessage["type"],
	BackgroundToSidepanelMessage["type"]
> = {
	acquireLock: "lockResult",
	getLockedSessions: "lockedSessions",
	acquireTabScope: "tabScopeAcquired",
	updateActingTab: "actingTabUpdated",
	releaseTabScope: "tabScopeReleased",
	getTabScopes: "tabScopes",
	registerMirrorProof: "mirrorProofRegistered",
	getMirrorProof: "mirrorProof",
	updateTabGroup: "tabGroupUpdated",
};

// ============================================================================
// PORT COMMUNICATION
// ============================================================================

let port: chrome.runtime.Port | null = null;
let currentWindowId: number | undefined;
let currentTabId: number | undefined;
let currentSessionId: string | undefined;
const responseHandlers = new Map<string, (msg: BackgroundToSidepanelMessage) => void>();

/**
 * Initialize port system with window ID.
 * Must be called before sending any messages.
 */
export function initialize(windowId: number): void {
	currentWindowId = windowId;
	currentTabId = undefined;
	currentSessionId = undefined;
	connect();
}

/**
 * Initialize port system with window ID plus tab binding. The background
 * accepts both legacy (`sidepanel:<windowId>`) and tab-bound
 * (`sidepanel:tab:<tabId>:<sessionId|->`) names through the cutover.
 */
export function initializeWithTab(windowId: number, tabId?: number, sessionId?: string): void {
	currentWindowId = windowId;
	currentTabId = tabId;
	currentSessionId = sessionId;
	connect();
}

function portName(): string {
	if (currentWindowId === undefined) {
		throw new Error("[Port] Cannot connect: windowId not initialized");
	}
	if (currentTabId !== undefined) {
		return `sidepanel:tab:${currentTabId}:${currentSessionId ?? "-"}`;
	}
	return `sidepanel:${currentWindowId}`;
}

/**
 * Create new port connection and set up listeners.
 * Background script will receive this connection via runtime.onConnect.
 */
function connect(): chrome.runtime.Port {
	console.log(`[Port] Connecting... (${new Date().toISOString()})`);
	const tmpPort = chrome.runtime.connect({ name: portName() });

	// Set up message listener to dispatch responses
	tmpPort.onMessage.addListener((msg: BackgroundToSidepanelMessage) => {
		// Dispatch to registered response handlers
		const handler = responseHandlers.get(msg.type);
		if (handler) {
			handler(msg);
		}
	});

	// Set up disconnect listener
	tmpPort.onDisconnect.addListener(() => {
		console.log(`[Port] Disconnected (likely due to inactivity timeout) (${new Date().toISOString()})`);
		port = null;
	});

	console.log(`[Port] Connected (${new Date().toISOString()})`);
	return tmpPort;
}

/**
 * Mark port as disconnected.
 * Next send attempt will create a new connection.
 */
function disconnect(): void {
	port = null;
}

/**
 * Send a message through the port and wait for a response.
 * The response type is automatically inferred from the request message type.
 *
 * @param message - Request message to send to background script
 * @param timeoutMs - Response timeout in milliseconds (default: 5000)
 * @returns Promise resolving to the corresponding response message
 */
export async function sendMessage<TRequest extends SidepanelToBackgroundMessage>(
	message: TRequest,
	timeoutMs = 5000,
): Promise<ResponseForRequest<TRequest>> {
	for (let attempt = 1; attempt <= 2; attempt++) {
		// Ensure we have a port connection
		if (!port) {
			port = connect();
		}

		try {
			// Determine expected response type from request type
			const responseType = REQUEST_TO_RESPONSE_TYPE[message.type];
			if (!responseType) {
				throw new Error(`[Port] No response type mapping for message type: ${message.type}`);
			}

			// Set up response handler (all messages expect a response)
			const responsePromise = new Promise<BackgroundToSidepanelMessage>((resolve, reject) => {
				const timeoutId = setTimeout(() => {
					responseHandlers.delete(responseType);
					reject(new Error(`[Port] Timeout waiting for response: ${responseType}`));
				}, timeoutMs);

				responseHandlers.set(responseType, (msg: BackgroundToSidepanelMessage) => {
					clearTimeout(timeoutId);
					responseHandlers.delete(responseType);
					resolve(msg);
				});
			});

			// Try to send the message
			// This can throw if port disconnected between our check and this call
			port.postMessage(message);

			// Wait for response
			return (await responsePromise) as ResponseForRequest<TRequest>;
		} catch (err) {
			// Determine expected response type from request type for cleanup
			const responseType = REQUEST_TO_RESPONSE_TYPE[message.type];

			// Clean up response handler if we set one up
			if (responseType) {
				responseHandlers.delete(responseType);
			}

			// If this was our last attempt, give up
			if (attempt === 2) {
				throw new Error(`[Port] Failed to send message after ${attempt} attempts: ${err}`);
			}

			// Retry: disconnect and loop will reconnect
			console.warn(`[Port] Send attempt ${attempt} failed, will retry...`, err);
			disconnect();
		}
	}

	// TypeScript: This should never be reached (we throw on attempt 2 in catch block)
	throw new Error("[Port] Failed to send message: max attempts exceeded");
}

/**
 * Check if port is currently connected.
 * Note: This is best-effort - port can disconnect immediately after this check.
 */
export function isConnected(): boolean {
	return port !== null;
}
