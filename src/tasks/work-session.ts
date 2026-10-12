export const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"] as const;

export type GroupColor = (typeof GROUP_COLORS)[number];

export interface WorkTab {
	id: number;
	windowId: number;
	url: string;
	title: string;
	favIconUrl?: string;
	active: boolean;
	groupId?: number;
}

export interface WorkSession {
	sessionId: string;
	ownerTabId: number;
	windowId: number;
	groupId: number | null;
	currentTabId: number | null;
	tabIds: number[];
	title: string;
	color: GroupColor;
	debuggerBlockedTabIds: number[];
}

export interface WorkBackend {
	get(tabId: number): Promise<WorkTab>;
	createInactive(windowId: number, url: string): Promise<WorkTab>;
	setUrl(tabId: number, url: string): Promise<void>;
	activate(tabId: number): Promise<void>;
	focusWindow(windowId: number): Promise<void>;
	group(tabId: number, windowId: number, groupId: number | null): Promise<number>;
	retitle(groupId: number, title: string, color: GroupColor): Promise<void>;
	ungroup(tabIds: number[]): Promise<void>;
	own(session: WorkSession, tabId: number): Promise<void>;
	activeInWindow(windowId: number): Promise<WorkTab | undefined>;
}

export function colorForSession(sessionId: string): GroupColor {
	let hash = 0;
	for (const char of sessionId) hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
	return GROUP_COLORS[hash % GROUP_COLORS.length];
}

export function isRestrictedPage(url: string | undefined): boolean {
	if (!url) return true;
	return (
		url.startsWith("chrome://") ||
		url.startsWith("chrome-extension://") ||
		url.startsWith("moz-extension://") ||
		url.startsWith("about:") ||
		url.startsWith("edge://") ||
		url.startsWith("devtools://") ||
		url.startsWith("view-source:") ||
		url.startsWith("file:")
	);
}

export class WorkSessionBook {
	private sessions = new Map<string, WorkSession>();
	private lastActive = new Map<number, number>();
	private previousActive = new Map<number, number>();

	constructor(private readonly backend: WorkBackend) {}

	snapshot(): WorkSession[] {
		return [...this.sessions.values()].map((session) => ({
			...session,
			tabIds: [...session.tabIds],
			debuggerBlockedTabIds: [...session.debuggerBlockedTabIds],
		}));
	}

	restore(sessions: WorkSession[]): void {
		this.sessions.clear();
		for (const session of sessions) {
			this.sessions.set(session.sessionId, {
				...session,
				tabIds: [...session.tabIds],
				debuggerBlockedTabIds: [...(session.debuggerBlockedTabIds ?? [])],
			});
		}
	}

	findByTab(tabId: number): WorkSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.ownerTabId === tabId || session.tabIds.includes(tabId)) return session;
		}
		return undefined;
	}

	get(sessionId: string): WorkSession | undefined {
		return this.sessions.get(sessionId);
	}

	noteActivation(windowId: number, tabId: number): void {
		const current = this.lastActive.get(windowId);
		if (current !== undefined && current !== tabId) this.previousActive.set(windowId, current);
		this.lastActive.set(windowId, tabId);
	}

	private async ensure(sessionId: string, ownerTabId: number): Promise<WorkSession> {
		const existing = this.sessions.get(sessionId);
		if (existing) return existing;
		const owner = await this.backend.get(ownerTabId);
		const session: WorkSession = {
			sessionId,
			ownerTabId,
			windowId: owner.windowId,
			groupId: null,
			currentTabId: null,
			tabIds: [],
			title: "Sitegeist",
			color: colorForSession(sessionId),
			debuggerBlockedTabIds: [],
		};
		this.sessions.set(sessionId, session);
		return session;
	}

	async open(sessionId: string, ownerTabId: number, url: string, newTab: boolean): Promise<WorkTab> {
		const session = await this.ensure(sessionId, ownerTabId);
		if (!newTab && session.currentTabId !== null) {
			return this.backend.get(session.currentTabId);
		}
		if (isRestrictedPage(url)) throw new Error("That page cannot be used by a task");
		const created = await this.backend.createInactive(session.windowId, url);
		const groupId = await this.backend.group(created.id, session.windowId, session.groupId);
		session.groupId = groupId;
		if (!session.tabIds.includes(created.id)) session.tabIds.push(created.id);
		session.currentTabId = created.id;
		await this.backend.retitle(groupId, session.title, session.color);
		await this.backend.own(session, created.id);
		return this.backend.get(created.id);
	}

	async list(sessionId: string): Promise<WorkTab[]> {
		const session = this.sessions.get(sessionId);
		if (!session) return [];
		const tabs: WorkTab[] = [];
		const live: number[] = [];
		for (const tabId of [...session.tabIds]) {
			const tab = await this.readLiveTab(session, tabId);
			if (!tab) continue;
			live.push(tabId);
			tabs.push({ ...tab, active: tab.id === session.currentTabId });
		}
		session.tabIds = live;
		if (session.currentTabId !== null && !live.includes(session.currentTabId)) {
			session.currentTabId = live[0] ?? null;
		}
		return tabs;
	}

	async select(sessionId: string, tabId: number, reveal: boolean): Promise<WorkTab> {
		const session = this.sessions.get(sessionId);
		if (!session || !session.tabIds.includes(tabId)) {
			throw new Error(`Tab ${tabId} is not in this task`);
		}
		if (reveal) {
			await this.backend.activate(tabId);
			await this.backend.focusWindow(session.windowId);
		}
		const tab = await this.backend.get(tabId);
		session.currentTabId = tabId;
		return tab;
	}

	async current(sessionId: string): Promise<WorkTab | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session?.currentTabId) return undefined;
		const tab = await this.readLiveTab(session, session.currentTabId);
		if (!tab) return undefined;
		return { ...tab, active: true };
	}

	async rename(sessionId: string, title: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.title = title.slice(0, 100) || "Sitegeist";
		if (session.groupId !== null) await this.backend.retitle(session.groupId, session.title, session.color);
	}

	async share(sessionId: string, ownerTabId: number, tab: WorkTab): Promise<void> {
		if (isRestrictedPage(tab.url)) throw new Error("That page cannot be used by a task");
		const other = this.findByTab(tab.id);
		if (other && other.sessionId !== sessionId) throw new Error("That tab belongs to another task");
		const session = await this.ensure(sessionId, ownerTabId);
		const groupId = await this.backend.group(tab.id, session.windowId, session.groupId);
		session.groupId = groupId;
		if (!session.tabIds.includes(tab.id)) session.tabIds.push(tab.id);
		session.currentTabId = tab.id;
		await this.backend.retitle(groupId, session.title, session.color);
		await this.backend.own(session, tab.id);
	}

	async shareActive(sessionId: string, ownerTabId: number): Promise<WorkTab> {
		const session = await this.ensure(sessionId, ownerTabId);
		const active = await this.backend.activeInWindow(session.windowId);
		if (!active) throw new Error("No tab is active in this window");
		await this.share(sessionId, ownerTabId, active);
		return this.backend.get(active.id);
	}

	async adoptPopup(sourceTabId: number, newTabId: number): Promise<boolean> {
		const session = this.findByTab(sourceTabId);
		if (!session) return false;
		const groupId = await this.backend.group(newTabId, session.windowId, session.groupId);
		session.groupId = groupId;
		if (!session.tabIds.includes(newTabId)) session.tabIds.push(newTabId);
		await this.backend.own(session, newTabId);
		const last = this.lastActive.get(session.windowId);
		const previous = this.previousActive.get(session.windowId);
		const userTab = last !== undefined && last !== newTabId ? last : previous;
		if (userTab !== undefined && userTab !== sourceTabId && userTab !== newTabId) {
			await this.backend.activate(userTab);
		}
		return true;
	}

	removeTab(tabId: number): { promoted?: { session: WorkSession; previousOwnerTabId: number } } {
		let promoted: { session: WorkSession; previousOwnerTabId: number } | undefined;
		for (const [sessionId, session] of this.sessions) {
			session.tabIds = session.tabIds.filter((id) => id !== tabId);
			session.debuggerBlockedTabIds = session.debuggerBlockedTabIds.filter((id) => id !== tabId);
			if (session.currentTabId === tabId) session.currentTabId = session.tabIds[0] ?? null;
			if (session.ownerTabId !== tabId) continue;
			if (session.tabIds.length > 0) {
				session.ownerTabId = session.currentTabId ?? session.tabIds[0];
				promoted = { session, previousOwnerTabId: tabId };
				continue;
			}
			this.sessions.delete(sessionId);
		}
		return { promoted };
	}

	async replaceTab(removedTabId: number, addedTabId: number): Promise<void> {
		for (const session of this.sessions.values()) {
			if (session.ownerTabId === removedTabId) session.ownerTabId = addedTabId;
			session.tabIds = session.tabIds.map((id) => (id === removedTabId ? addedTabId : id));
			if (session.currentTabId === removedTabId) session.currentTabId = addedTabId;
			session.debuggerBlockedTabIds = session.debuggerBlockedTabIds.map((id) =>
				id === removedTabId ? addedTabId : id,
			);
		}
	}

	blockDebugger(tabId: number): void {
		const session = this.findByTab(tabId);
		if (!session || session.debuggerBlockedTabIds.includes(tabId)) return;
		session.debuggerBlockedTabIds.push(tabId);
	}

	clearDebuggerBlock(tabId: number): void {
		const session = this.findByTab(tabId);
		if (!session) return;
		session.debuggerBlockedTabIds = session.debuggerBlockedTabIds.filter((id) => id !== tabId);
	}

	async discardMissing(
		liveTabIds: ReadonlySet<number>,
	): Promise<Array<{ session: WorkSession; previousOwnerTabId: number }>> {
		const promoted: Array<{ session: WorkSession; previousOwnerTabId: number }> = [];
		for (const [sessionId, session] of this.sessions) {
			const live = session.tabIds.filter((id) => liveTabIds.has(id));
			if (live.length === 0 && !liveTabIds.has(session.ownerTabId)) {
				this.sessions.delete(sessionId);
				continue;
			}
			session.tabIds = live;
			session.debuggerBlockedTabIds = session.debuggerBlockedTabIds.filter((id) => liveTabIds.has(id));
			if (session.currentTabId !== null && !live.includes(session.currentTabId)) {
				session.currentTabId = live[0] ?? null;
			}
			if (!liveTabIds.has(session.ownerTabId) && live.length > 0) {
				const previousOwnerTabId = session.ownerTabId;
				session.ownerTabId = session.currentTabId ?? live[0];
				promoted.push({ session, previousOwnerTabId });
			}
		}
		return promoted;
	}

	private async readLiveTab(session: WorkSession, tabId: number): Promise<WorkTab | undefined> {
		try {
			return await this.backend.get(tabId);
		} catch {
			session.tabIds = session.tabIds.filter((id) => id !== tabId);
			session.debuggerBlockedTabIds = session.debuggerBlockedTabIds.filter((id) => id !== tabId);
			if (session.currentTabId === tabId) session.currentTabId = session.tabIds[0] ?? null;
			return undefined;
		}
	}
}
