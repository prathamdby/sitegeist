export function registerOverlayAbortHandler(abort: () => boolean, getWindowId: () => number | undefined): () => void {
	const handler = (
		message: { type?: unknown } | null,
		sender: chrome.runtime.MessageSender,
		respond: (response: object) => void,
	) => {
		if (message?.type !== "abort-repl") return false;
		if (sender.id && sender.id !== chrome.runtime.id) return false;
		const windowId = getWindowId();
		if (windowId !== undefined && sender.tab?.windowId !== undefined && sender.tab.windowId !== windowId)
			return false;
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
