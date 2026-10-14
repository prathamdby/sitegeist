export type GroupClick =
	| { action: "ignore" }
	| { action: "reveal"; boundTabId: number }
	| { action: "adopt"; sessionId: string };

/**
 * What a click on a grouped tab should do.
 * Same-session and tool-driven clicks are ignored. A streaming panel ignores
 * the click. A live owner is revealed. A dead owner is adopted.
 */
export function resolveGroupClick(input: {
	toolNavigating: boolean;
	clickedSessionId?: string;
	currentSessionId?: string;
	ownerAlive: boolean;
	boundTabId?: number;
	streaming: boolean;
}): GroupClick {
	if (input.toolNavigating) return { action: "ignore" };
	if (!input.clickedSessionId || input.clickedSessionId === input.currentSessionId) return { action: "ignore" };
	if (input.streaming) return { action: "ignore" };
	if (input.ownerAlive && input.boundTabId !== undefined) return { action: "reveal", boundTabId: input.boundTabId };
	return { action: "adopt", sessionId: input.clickedSessionId };
}
