export type PanelRole = "host" | "work";

export interface PanelBinding {
	ownerTabId: number;
	sessionId: string | null;
	role: PanelRole;
}

export interface LockDecision {
	granted: boolean;
	ownerTabId?: number;
}

export function sidePanelPath(ownerTabId: number, sessionId?: string | null): string {
	const params = new URLSearchParams();
	params.set("hostTab", String(ownerTabId));
	if (sessionId) params.set("session", sessionId);
	return `sidepanel.html?${params.toString()}`;
}

export function parseHostTab(search: string): number | undefined {
	const raw = new URLSearchParams(search).get("hostTab");
	if (!raw) return undefined;
	const id = Number(raw);
	if (!Number.isInteger(id) || id <= 0) return undefined;
	return id;
}

/**
 * A session stays with one owner tab. The requester gets it when nobody holds
 * it, when they already hold it, or when the recorded owner has no open panel.
 */
export function decideLock(
	locks: Record<string, number>,
	openOwnerTabIds: ReadonlySet<number>,
	sessionId: string,
	requesterTabId: number,
): LockDecision {
	const owner = locks[sessionId];
	if (owner === undefined || owner === requesterTabId || !openOwnerTabIds.has(owner)) {
		return { granted: true };
	}
	return { granted: false, ownerTabId: owner };
}

export function releaseLocksForOwner(locks: Record<string, number>, ownerTabId: number): Record<string, number> {
	const next: Record<string, number> = {};
	for (const [sessionId, owner] of Object.entries(locks)) {
		if (owner !== ownerTabId) next[sessionId] = owner;
	}
	return next;
}

export function rewriteLockOwner(
	locks: Record<string, number>,
	removedTabId: number,
	addedTabId: number,
): Record<string, number> {
	const next: Record<string, number> = {};
	for (const [sessionId, owner] of Object.entries(locks)) {
		next[sessionId] = owner === removedTabId ? addedTabId : owner;
	}
	return next;
}

export function retargetBindings(
	bindings: Record<string, PanelBinding>,
	removedTabId: number,
	addedTabId: number,
): Record<string, PanelBinding> {
	const next: Record<string, PanelBinding> = {};
	for (const [key, binding] of Object.entries(bindings)) {
		const tabId = Number(key) === removedTabId ? addedTabId : Number(key);
		next[String(tabId)] = {
			...binding,
			ownerTabId: binding.ownerTabId === removedTabId ? addedTabId : binding.ownerTabId,
		};
	}
	return next;
}

export function clearHostBinding(bindings: Record<string, PanelBinding>, tabId: number): Record<string, PanelBinding> {
	const current = bindings[String(tabId)];
	if (!current || current.role !== "host" || current.ownerTabId !== tabId) return bindings;
	const next = { ...bindings };
	delete next[String(tabId)];
	return next;
}
