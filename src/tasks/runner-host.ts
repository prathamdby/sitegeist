const runnerFrames = new Map<number, HTMLIFrameElement>();

chrome.runtime.onMessage.addListener(
	(message: { type?: string; ownerTabId?: number; sessionId?: string | null }, _sender, sendResponse) => {
		if (message?.type !== "ensureRunnerFrame" || typeof message.ownerTabId !== "number") return;
		const ownerTabId = message.ownerTabId;
		if (!runnerFrames.has(ownerTabId)) {
			const frame = document.createElement("iframe");
			const params = new URLSearchParams({ hostTab: String(ownerTabId), runner: "1" });
			if (typeof message.sessionId === "string" && message.sessionId) params.set("session", message.sessionId);
			frame.src = chrome.runtime.getURL(`sidepanel.html?${params.toString()}`);
			document.body.append(frame);
			runnerFrames.set(ownerTabId, frame);
		}
		sendResponse({ ok: true });
	},
);
