/**
 * Owner lock and live mirror between side panel documents of one session.
 *
 * The panel that holds the Web Lock runs the agent and broadcasts it. The
 * others replay that broadcast and forward prompts back. When the owner
 * document goes away, Chrome releases the lock and a mirror takes over.
 */

import type { ImageContent } from "@earendil-works/pi-ai";
import { getAttachedSession, sessionChannelName, sessionOwnerLockName } from "../browser/session-panels.js";
import { getCurrentScope, isTabScopeEnabled } from "../browser/session-tabs.js";
import { createWelcomeMessage } from "../messages/WelcomeMessage.js";
import type { AgentMessage, ThinkingLevel } from "../pi/agent.js";
import { MirrorAgent, type PromptInput, SessionMirrorChannel, SessionOwnerChannel } from "../pi/mirror-agent.js";
import type { Model } from "../pi/models.js";
import { SYSTEM_PROMPT } from "../prompts/prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import { tutorials } from "../tutorials.js";
import * as port from "../utils/port.js";
import {
	ensureSessionScope,
	newSession,
	noteGroupPanel,
	rememberSessionInUrl,
	resolveBoundTab,
	sessionPanel,
	updateGroupTitle,
} from "./session-scope.js";

let ownedSessionId: string | undefined;
let mirrorChannel: SessionMirrorChannel | undefined;
let ownerChannel: SessionOwnerChannel | undefined;

export function isMirror(): boolean {
	return mirrorChannel !== undefined;
}

export function closeMirror(): void {
	mirrorChannel?.close();
	mirrorChannel = undefined;
}

export function openMirror(
	sessionId: string,
	options: {
		model: Model;
		thinkingLevel: ThinkingLevel;
		messages: AgentMessage[];
		title: string;
		onChange: (title: string) => void;
	},
): MirrorAgent {
	mirrorChannel = new SessionMirrorChannel(
		sessionChannelName(sessionId),
		(remote) =>
			new MirrorAgent(remote, {
				systemPrompt: SYSTEM_PROMPT,
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				messages: options.messages,
			}),
	);
	void port
		.sendMessage({ type: "getMirrorProof", sessionId })
		.then((granted) => {
			if (granted.proof) mirrorChannel?.setProof(granted.proof);
		})
		.catch(() => {});
	const mirrorAgent = mirrorChannel.agent;
	mirrorAgent.title = options.title;
	mirrorAgent.onChange = () => {
		options.onChange(mirrorAgent.title);
	};
	return mirrorAgent;
}

/**
 * Become the session's owner: the panel holding the Web Lock runs the agent.
 * The lock is held for the document's lifetime and released by Chrome when
 * the document goes away, which is what lets a mirror take over.
 */
function holdOwnerLock(sessionId: string): Promise<void> {
	ownedSessionId = sessionId;
	return new Promise<void>(() => {
		// Held until this document is discarded. A failed background claim must not resolve it.
	});
}

function acquireOwnerLock(sessionId: string): Promise<boolean> {
	if (ownedSessionId === sessionId) return Promise.resolve(true);
	return new Promise((resolve) => {
		navigator.locks
			.request(sessionOwnerLockName(sessionId), { ifAvailable: true }, (lock) => {
				if (!lock) {
					resolve(false);
					return undefined;
				}
				resolve(true);
				return holdOwnerLock(sessionId);
			})
			.catch((err) => {
				console.warn("[Sidepanel] Owner lock request failed:", err);
				resolve(false);
			});
	});
}

function startOwnerChannel(sessionId: string): void {
	const host = sessionPanel();
	if (!ownerChannel) {
		ownerChannel = new SessionOwnerChannel(sessionChannelName(sessionId), {
			title: () => host.getTitle(),
			prompt: (input, images) => promptFromMirror(input, images),
			setModel: (model) => {
				const agent = host.getAgent();
				if (!agent) return;
				agent.setModel(model);
				host.updateAuthLabel().catch(() => {});
				host.requestChatUpdate();
				host.render();
			},
			setTitle: (title) => {
				void applyTitle(title);
			},
		});
	}
	const agent = host.getAgent();
	if (agent) ownerChannel.attach(agent);
	void port.sendMessage({ type: "registerMirrorProof", sessionId, proof: ownerChannel.proof }).catch(() => {});
}

/** Background session lock. Does not release another tab's scope. */
export async function claimBackgroundLock(sessionId: string): Promise<boolean> {
	const request = { type: "acquireLock", sessionId, windowId: sessionPanel().getWindowId() } as const;
	const first = await port.sendMessage(request);
	return first.success;
}

export async function applyTitle(title: string): Promise<void> {
	const host = sessionPanel();
	host.setTitle(title);
	const sessionId = host.getSessionId();
	if (sessionId) {
		await getSitegeistStorage()
			.sessions.updateTitle(sessionId, title)
			.catch(() => {});
	}
	void updateGroupTitle();
	ownerChannel?.broadcastSnapshot();
	host.render();
}

/**
 * Give the session its owner lock, channel and tab group before the first
 * run starts, so the first tool call already acts inside the group.
 */
export async function ensureOwnerRunScope(): Promise<void> {
	const host = sessionPanel();
	const agent = host.getAgent();
	if (!agent) return;
	const sessionId = host.getSessionId() ?? agent.sessionId;
	if (!sessionId) return;
	if (getCurrentScope()?.sessionId === sessionId) return;
	const bound = await resolveBoundTab();
	if (bound === undefined) return;
	if (!(await acquireOwnerLock(sessionId))) return;
	startOwnerChannel(sessionId);
	await ensureSessionScope(sessionId, bound, { focusNewWorker: host.getSessionId() === undefined });
	if (ownerChannel) {
		void port.sendMessage({ type: "registerMirrorProof", sessionId, proof: ownerChannel.proof }).catch(() => {});
	}
}

/**
 * Show a session whose agent runs in another panel. Starts from the stored
 * transcript (when saved) and follows the owner live. When the owner's
 * document goes away its Web Lock frees up and this panel takes over.
 */
async function startMirror(sessionId: string): Promise<void> {
	const sessions = getSitegeistStorage().sessions;
	const sessionData = await sessions.loadSession(sessionId).catch(() => null);
	const metadata = sessionData ? await sessions.getMetadata(sessionId).catch(() => null) : null;
	const host = sessionPanel();
	host.setTitle(metadata?.title || "");
	await host.createAgent(
		sessionData
			? {
					systemPrompt: SYSTEM_PROMPT,
					model: sessionData.model,
					thinkingLevel: sessionData.thinkingLevel,
					messages: sessionData.messages,
					tools: [],
				}
			: undefined,
		false,
		sessionId,
	);
	host.render();
	navigator.locks
		.request(sessionOwnerLockName(sessionId), async () => {
			const held = holdOwnerLock(sessionId);
			try {
				await promoteMirror(sessionId);
			} catch (err) {
				console.error("[Sidepanel] Failed to take over session:", err);
			}
			return held;
		})
		.catch((err) => console.warn("[Sidepanel] Owner lock wait failed:", err));
}

/** The owning panel is gone: run the session here, from storage when saved. */
async function promoteMirror(sessionId: string): Promise<void> {
	const host = sessionPanel();
	const agent = host.getAgent();
	if (!agent) return;
	const mirrored = agent.state;
	const fallback = {
		model: mirrored.model,
		thinkingLevel: mirrored.thinkingLevel,
		messages: mirrored.messages.slice(),
	};
	const sessions = getSitegeistStorage().sessions;
	const sessionData = await sessions.loadSession(sessionId).catch(() => null);
	if (sessionData) {
		host.setSessionId(sessionId);
		const metadata = await sessions.getMetadata(sessionId).catch(() => null);
		host.setTitle(metadata?.title || host.getTitle());
		await claimBackgroundLock(sessionId);
	} else {
		host.setPendingSessionId(sessionId);
	}
	const tabId = host.getTabId();
	if (tabId !== undefined && (await isTabScopeEnabled())) {
		await ensureSessionScope(sessionId, tabId);
	}
	const source = sessionData ?? fallback;
	await host.createAgent({
		systemPrompt: SYSTEM_PROMPT,
		model: source.model,
		thinkingLevel: source.thinkingLevel,
		messages: source.messages,
		tools: [],
	});
	startOwnerChannel(sessionId);
	rememberSessionInUrl(sessionId);
	host.render();
}

/** A mirror panel sent input; run it here, queueing behind an active run. */
async function promptFromMirror(input: PromptInput, images?: ImageContent[]): Promise<void> {
	const host = sessionPanel();
	const agent = host.getAgent();
	if (!agent || isMirror()) return;
	if (agent.state.isStreaming) {
		const messages: AgentMessage[] =
			typeof input === "string"
				? [{ role: "user", content: [{ type: "text", text: input }, ...(images ?? [])], timestamp: Date.now() }]
				: Array.isArray(input)
					? input
					: [input];
		for (const message of messages) agent.followUp(message);
		return;
	}
	await host.prepareRun();
	await agent.prompt(input, images);
}

async function showWelcome(): Promise<void> {
	const host = sessionPanel();
	await host.createAgent();
	const agent = host.getAgent();
	if (agent) agent.appendMessage(createWelcomeMessage(tutorials));
	host.render();
}

/**
 * Adopt the URL session, the latest session, or a welcome agent.
 * Returns true when init should continue to the first-run API key dialog.
 */
export async function adoptStartupSession(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	if (!sessionIdFromUrl) {
		const stashed = (await chrome.storage.session.get("tabGroup.pendingSession").catch(() => ({}))) as Record<
			string,
			unknown
		>;
		const pending = stashed["tabGroup.pendingSession"];
		if (typeof pending === "string" && pending.length > 0) {
			sessionIdFromUrl = pending;
			await chrome.storage.session.remove("tabGroup.pendingSession").catch(() => {});
		}
	}
	const explicitSession = sessionIdFromUrl !== null;
	const isNewSession = urlParams.get("new") === "true";
	const scopeOn = await isTabScopeEnabled();
	const host = sessionPanel();
	const tabId = host.getTabId();
	if (scopeOn && tabId !== undefined) {
		noteGroupPanel(await getAttachedSession(tabId));
	}

	const sessions = getSitegeistStorage().sessions;
	if (!sessionIdFromUrl && !isNewSession && sessions) {
		const latestSessionId = await sessions.getLatestSessionId();
		if (latestSessionId && (!scopeOn || (await acquireOwnerLock(latestSessionId)))) {
			if (await claimBackgroundLock(latestSessionId)) {
				sessionIdFromUrl = latestSessionId;
				rememberSessionInUrl(latestSessionId);
			}
		}
	}

	if (sessionIdFromUrl && sessions) {
		// Another panel runs this session (a group tab of a live session):
		// show it live instead of loading a competing copy.
		if (scopeOn && explicitSession && !(await acquireOwnerLock(sessionIdFromUrl))) {
			await startMirror(sessionIdFromUrl);
			return false;
		}
		const sessionData = await sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			const lockSuccess = await claimBackgroundLock(sessionIdFromUrl);
			if (!lockSuccess) {
				const url = new URL(window.location.href);
				url.searchParams.delete("session");
				window.history.replaceState({}, "", url);
				await showWelcome();
				return false;
			}

			host.setSessionId(sessionIdFromUrl);
			const metadata = await sessions.getMetadata(sessionIdFromUrl);
			host.setTitle(metadata?.title || "");

			if (await isTabScopeEnabled()) {
				const bound = await resolveBoundTab();
				if (bound !== undefined) {
					rememberSessionInUrl(sessionIdFromUrl);
					await ensureSessionScope(sessionIdFromUrl, bound);
				}
			}

			await host.createAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: sessionData.model,
				thinkingLevel: sessionData.thinkingLevel,
				messages: sessionData.messages,
				tools: [],
			});
			if (ownedSessionId === sessionIdFromUrl) startOwnerChannel(sessionIdFromUrl);
			host.render();
			return false;
		}
		newSession(true);
		return false;
	}

	await showWelcome();
	return true;
}
