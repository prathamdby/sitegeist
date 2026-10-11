export interface OverlayAbortRequest {
	channel: "sitegeist-overlay";
	type: "abort-repl";
	requestId: string;
	capability: string;
}

const requests = new Map<number, { request: OverlayAbortRequest; windowId: number; used: boolean }>();

export function createOverlayAbortRequest(tabId: number, windowId: number): OverlayAbortRequest {
	const request: OverlayAbortRequest = {
		channel: "sitegeist-overlay",
		type: "abort-repl",
		requestId: crypto.randomUUID(),
		capability: crypto.randomUUID(),
	};
	requests.set(tabId, { request, windowId, used: false });
	return request;
}

export function removeOverlayAbortRequest(tabId: number, requestId?: string): boolean {
	if (requestId !== undefined && requests.get(tabId)?.request.requestId !== requestId) return false;
	requests.delete(tabId);
	return true;
}

export function relayOverlayAbortMessage(message: unknown, sender: chrome.runtime.MessageSender): object | undefined {
	if (!message || typeof message !== "object" || sender.id !== chrome.runtime.id || sender.frameId !== 0) return;
	const request = message as Record<string, unknown>;
	if (
		request.channel !== "sitegeist-overlay" ||
		request.type !== "abort-repl" ||
		typeof request.requestId !== "string" ||
		typeof request.capability !== "string" ||
		!sender.tab
	)
		return;
	return {
		channel: "sitegeist-overlay",
		type: "abort-repl",
		requestId: request.requestId,
		capability: request.capability,
		relayed: true,
		overlayTabId: sender.tab.id,
		overlayWindowId: sender.tab.windowId,
		overlayFrameId: sender.frameId,
	};
}

export function registerOverlayAbortHandler(abort: () => boolean, getWindowId: () => number | undefined): () => void {
	const handler = (message: unknown, sender: chrome.runtime.MessageSender, respond: (response: object) => void) => {
		if (!message || typeof message !== "object" || sender.id !== chrome.runtime.id) return false;
		const request = message as Record<string, unknown>;
		if (request.channel !== "sitegeist-overlay" || request.type !== "abort-repl") return false;
		const tabId = sender.tab?.id ?? (request.relayed === true ? request.overlayTabId : undefined);
		const senderWindowId = sender.tab?.windowId ?? (request.relayed === true ? request.overlayWindowId : undefined);
		const frameId = sender.frameId ?? (request.relayed === true ? request.overlayFrameId : undefined);
		if (typeof tabId !== "number" || frameId !== 0) return false;
		const owner = requests.get(tabId);
		if (
			!owner ||
			owner.used ||
			owner.windowId !== senderWindowId ||
			owner.request.requestId !== request.requestId ||
			owner.request.capability !== request.capability
		)
			return false;
		const windowId = getWindowId();
		if (windowId !== undefined && owner.windowId !== windowId) return false;
		owner.used = true;
		if (abort()) respond({ success: true });
		else respond({ success: false, reason: "not-streaming" });
		return false;
	};
	chrome.runtime.onMessage.addListener(handler);
	chrome.runtime.onUserScriptMessage?.addListener(handler);
	return () => {
		chrome.runtime.onMessage.removeListener(handler);
		chrome.runtime.onUserScriptMessage?.removeListener(handler);
	};
}
