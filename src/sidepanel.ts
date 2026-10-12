import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import type { ImageContent } from "@earendil-works/pi-ai";
import { html, render } from "lit";
import { History, Plus, Settings, SquareArrowOutUpRight } from "lucide";
import {
	attachPanelToTab,
	getAttachedSession,
	isFocusSessionTabEnabled,
	sessionChannelName,
	sessionOwnerLockName,
} from "./browser/session-panels.js";
import {
	clearCurrentScope,
	createTabInScope,
	ensureGroupForTabs,
	getCurrentScope,
	getGroupTabIds,
	isTabScopeEnabled,
	resolveActingTab,
	setActingTab,
	setCurrentScope,
	TAB_GROUPS_KEY,
} from "./browser/session-tabs.js";
import { ChatPanel } from "./chat/ChatPanel.js";
import { setShowJsonMode } from "./chat/renderers/index.js";
import { Toast } from "./components/Toast.js";
import { AboutTab } from "./dialogs/AboutTab.js";
import { ApiKeyOrOAuthDialog } from "./dialogs/ApiKeyOrOAuthDialog.js";
import { ApiKeysOAuthTab } from "./dialogs/ApiKeysOAuthTab.js";
import { CostsTab } from "./dialogs/CostsTab.js";
import { ModelSelector } from "./dialogs/ModelSelector.js";
import { SessionCostDialog } from "./dialogs/SessionCostDialog.js";
import { SitegeistSessionListDialog } from "./dialogs/SessionListDialog.js";
import { ProxyTab, RetryTab, SettingsDialog, TabsTab } from "./dialogs/SettingsDialog.js";
import { SkillsTab } from "./dialogs/SkillsTab.js";
import { UserScriptsPermissionDialog } from "./dialogs/UserScriptsPermissionDialog.js";
import { WelcomeSetupDialog } from "./dialogs/WelcomeSetupDialog.js";
import { browserMessageTransformer } from "./messages/message-transformer.js";
import {
	createNavigationMessage,
	type NavigationMessage,
	registerNavigationRenderer,
} from "./messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "./messages/UserMessageRenderer.js";
import { createWelcomeMessage, registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
import { isOAuthCredentials, resolveApiKey } from "./oauth/index.js";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	executableTool,
} from "./pi/agent.js";
import { CostRecorder } from "./pi/costs.js";
import { MirrorAgent, type PromptInput, SessionMirrorChannel, SessionOwnerChannel } from "./pi/mirror-agent.js";
import { getModel, getModels, getProviders, ModelConfiguration } from "./pi/models.js";
import { navigationSteeringGate } from "./pi/navigation-steering.js";
import { applyModelSelection, DEFAULT_MODELS, resolveInitialModel } from "./pi/selection.js";
import { createStreamFn } from "./pi/stream.js";
import { SYSTEM_PROMPT } from "./prompts/prompts.js";
import { SitegeistAppStorage, setAppStorage } from "./storage/app-storage.js";
import { DebuggerTool } from "./tools/debugger.js";
import { createExtractDocumentTool } from "./tools/extract-document.js";
import { ExtractImageTool, registerExtractImageRenderer } from "./tools/extract-image.js";
import { AskUserWhichElementTool, skillTool } from "./tools/index.js";
import { NativeInputEventsRuntimeProvider } from "./tools/NativeInputEventsRuntimeProvider.js";
import { isToolNavigating, NavigateTool } from "./tools/navigate.js";
import { registerOverlayAbortHandler } from "./tools/repl/overlay-abort.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import { tutorials } from "./tutorials.js";

// Register custom message renderers
registerNavigationRenderer();
registerExtractImageRenderer();

// Listen for abort messages from REPL overlay
registerOverlayAbortHandler(
	() => {
		// The owning panel receives the same relay and aborts its own run.
		if (isMirror() || !agent?.state.isStreaming) return false;
		agent.abort();
		return true;
	},
	() => currentWindowId,
);

// ============================================================================
// STORAGE SETUP
// ============================================================================
const storage = new SitegeistAppStorage();
setAppStorage(storage);
const modelConfiguration = new ModelConfiguration(() => storage.customProviders.getAll());

// ============================================================================
// APP STATE
// ============================================================================
let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let agent: Agent;
let chatPanel: ChatPanel;
let agentUnsubscribe: (() => void) | undefined;
let currentWindowId: number;
let currentTabId: number | undefined;
/** Session id to adopt for a not-yet-saved session (promoted mirror). */
let pendingSessionId: string | undefined;
/** Session this tab's panel is registered for as a group tab, if any. */
let groupPanelSessionId: string | undefined;
/** Set while this panel mirrors a session whose agent runs in another panel. */
let mirrorChannel: SessionMirrorChannel | undefined;
let ownerChannel: SessionOwnerChannel | undefined;
let ownedSessionId: string | undefined;

const isMirror = (): boolean => mirrorChannel !== undefined;

/**
 * Become the session's owner: the panel holding the Web Lock runs the agent.
 * The lock is held for the document's lifetime and released by Chrome when
 * the document goes away, which is what lets a mirror take over.
 */
let releaseOwnerLockFn: (() => void) | undefined;

function holdOwnerLock(sessionId: string): Promise<void> {
	ownedSessionId = sessionId;
	return new Promise<void>((release) => {
		releaseOwnerLockFn = release;
	});
}

function releaseOwnerLock(): void {
	releaseOwnerLockFn?.();
	releaseOwnerLockFn = undefined;
	ownedSessionId = undefined;
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
	if (!ownerChannel) {
		ownerChannel = new SessionOwnerChannel(sessionChannelName(sessionId), {
			title: () => currentTitle,
			prompt: (input, images) => promptFromMirror(input, images),
			setModel: (model) => {
				agent.setModel(model);
				updateAuthLabel().catch(() => {});
				chatPanel.agentInterface?.requestUpdate();
				renderApp();
			},
			setTitle: (title) => {
				void applyTitle(title);
			},
		});
	}
	ownerChannel.attach(agent);
}

/** Background session lock; a dead previous owner's stale scope is cleared once. */
async function claimBackgroundLock(sessionId: string): Promise<boolean> {
	const request = { type: "acquireLock", sessionId, windowId: currentWindowId } as const;
	const first = await port.sendMessage(request);
	if (first.success || ownedSessionId !== sessionId) return first.success;
	// Holding the owner lock proves no other panel runs this session; the
	// recorded bound tab is alive but its panel is gone.
	await port.sendMessage({ type: "releaseTabScope", sessionId }).catch(() => {});
	return (await port.sendMessage(request)).success;
}

async function applyTitle(title: string): Promise<void> {
	currentTitle = title;
	if (storage.sessions && currentSessionId) {
		await storage.sessions.updateTitle(currentSessionId, title).catch(() => {});
	}
	void updateGroupTitle();
	ownerChannel?.broadcastSnapshot();
	renderApp();
}

/** The group is the session's visible handle in the tab strip: name it after the chat. */
async function updateGroupTitle(): Promise<void> {
	const groupId = getCurrentScope()?.groupId;
	if (groupId === undefined || !currentTitle) return;
	try {
		await chrome.tabGroups.update(groupId, { title: currentTitle });
	} catch {
		// Title is cosmetic; the group may be gone.
	}
}

/**
 * Give the session its own background worker tab inside its own tab group
 * (M2/M4). The bound (panel) tab is never grouped and never acted on: the
 * agent works only on the worker tab and later tabs opened in the group.
 * Never throws: failures fall back to legacy window-scoped behavior.
 */
async function ensureSessionScope(
	sessionId: string,
	boundTabId: number,
	options: { focusNewWorker?: boolean } = {},
): Promise<void> {
	try {
		if (!(await isTabScopeEnabled())) return;
		// One tab group per session: reuse the persistently assigned group
		// when it is still alive. A new group is created only when the
		// recorded group is gone. The assignment survives session switches;
		// only the panel binding is released on switch.
		const readAssignment = async (): Promise<number | undefined> => {
			try {
				const stored = await chrome.storage.session.get(TAB_GROUPS_KEY);
				const assignments = (stored[TAB_GROUPS_KEY] as Record<string, { groupId: number }>) || {};
				return assignments[sessionId]?.groupId;
			} catch {
				return undefined;
			}
		};
		const clearAssignment = async (): Promise<void> => {
			try {
				const stored = await chrome.storage.session.get(TAB_GROUPS_KEY);
				const assignments = ((stored[TAB_GROUPS_KEY] as Record<string, { groupId: number }>) || {}) as Record<
					string,
					{ groupId: number }
				>;
				if (assignments[sessionId] !== undefined) {
					delete assignments[sessionId];
					await chrome.storage.session.set({ [TAB_GROUPS_KEY]: assignments });
				}
			} catch {
				// Best effort.
			}
		};
		const saveAssignment = async (groupId: number): Promise<void> => {
			try {
				const stored = await chrome.storage.session.get(TAB_GROUPS_KEY);
				const assignments = ((stored[TAB_GROUPS_KEY] as Record<string, { groupId: number }>) || {}) as Record<
					string,
					{ groupId: number }
				>;
				assignments[sessionId] = { groupId };
				await chrome.storage.session.set({ [TAB_GROUPS_KEY]: assignments });
			} catch (err) {
				console.warn("[Sidepanel] Failed to save tab group assignment:", err);
			}
		};
		const assignedGroupId = await readAssignment();
		if (assignedGroupId !== undefined) {
			try {
				await chrome.tabGroups.get(assignedGroupId);
				// Every member is a work tab. The panel's own tab is a member
				// only when it is a group tab hosting the session's panel.
				const live = await getGroupTabIds(assignedGroupId);
				if (live.length > 0) {
					let acting = live[0];
					try {
						const existing = await port.sendMessage({ type: "getTabScopes" });
						const recorded = existing.scopes[sessionId]?.actingTabId;
						if (recorded !== undefined && live.includes(recorded)) acting = recorded;
					} catch {
						// Fall through with the first live tab.
					}
					const request: port.AcquireTabScopeMessage = {
						type: "acquireTabScope",
						sessionId,
						tabId: boundTabId,
						windowId: currentWindowId,
						actingTabId: acting,
						groupId: assignedGroupId,
					};
					const acquired = await port.sendMessage(request);
					const tabIds = new Set<number>(live);
					for (const id of acquired.tabIds) {
						if (id !== boundTabId) tabIds.add(id);
					}
					setCurrentScope({
						sessionId,
						tabIds,
						groupId: acquired.groupId ?? assignedGroupId,
						boundTabId,
						actingTabId: acting,
					});
					for (const id of live) await attachPanelToTab(id, sessionId);
					void updateGroupTitle();
					return;
				}
			} catch {
				// Assigned group is gone; fall through and spawn a fresh one.
			}
			await clearAssignment();
		}
		// Spawn a dedicated inactive worker tab, never touching the user's tab.
		const worker = await createTabInScope();
		if (worker.id === undefined) {
			console.warn("[Sidepanel] Worker tab has no id; staying window-scoped");
			return;
		}
		let groupId: number | undefined;
		try {
			groupId = await ensureGroupForTabs([worker.id]);
			try {
				await chrome.tabGroups.update(groupId, { title: "Sitegeist" });
			} catch {
				// Title is cosmetic; ignore.
			}
		} catch (err) {
			console.warn("[Sidepanel] Failed to group worker tab:", err);
		}
		if (groupId !== undefined) {
			await saveAssignment(groupId);
		}
		// Register the worker's panel before anything can activate the tab.
		await attachPanelToTab(worker.id, sessionId);
		try {
			const request: port.AcquireTabScopeMessage = {
				type: "acquireTabScope",
				sessionId,
				tabId: boundTabId,
				windowId: currentWindowId,
				actingTabId: worker.id,
				...(groupId !== undefined ? { groupId } : {}),
			};
			const acquired = await port.sendMessage(request);
			const tabIds = new Set<number>([worker.id]);
			for (const id of acquired.tabIds) {
				if (id !== boundTabId) tabIds.add(id);
			}
			setCurrentScope({
				sessionId,
				tabIds,
				groupId: acquired.groupId ?? groupId,
				boundTabId,
				actingTabId: worker.id,
			});
			if (groupId !== undefined && acquired.groupId === undefined) {
				// Background reports the group dead; drop the assignment so
				// the next ensure spawns fresh instead of reusing a corpse.
				await clearAssignment();
			}
		} catch (err) {
			console.warn("[Sidepanel] Failed to acquire tab scope:", err);
			setCurrentScope({ sessionId, tabIds: new Set([worker.id]), groupId, boundTabId, actingTabId: worker.id });
		}
		void updateGroupTitle();
		if (options.focusNewWorker && (await isFocusSessionTabEnabled())) {
			try {
				await chrome.tabs.update(worker.id, { active: true });
			} catch (err) {
				console.warn("[Sidepanel] Failed to focus session tab:", err);
			}
		}
	} catch (err) {
		console.warn("[Sidepanel] ensureSessionScope failed:", err);
	}
}

/** Refresh the local mirror of the group membership (new tabs, user moves). */
async function refreshScopeTabIds(): Promise<void> {
	const scope = getCurrentScope();
	if (!scope) return;
	try {
		if (!(await isTabScopeEnabled())) return;
		if (scope.groupId === undefined) return;
		// Group members are the work tabs; the user's own tab is never grouped.
		const live = await getGroupTabIds(scope.groupId);
		if (live.length === 0) return;
		const acting = scope.actingTabId !== undefined && live.includes(scope.actingTabId) ? scope.actingTabId : live[0];
		setCurrentScope({ ...scope, tabIds: new Set(live), actingTabId: acting });
	} catch (err) {
		console.warn("[Sidepanel] refreshScopeTabIds failed:", err);
	}
}

// Track which skills we've shown in full (skillName -> lastUpdated timestamp)
// Reset when a new session/agent is created
const shownSkills = new Map<string, string>();

// Track which messages we've already recorded costs for (avoid duplicates)
const costRecorder = new CostRecorder();

// Cached auth type label for the current provider
let authLabel = "";

async function selectDefaultModelForAvailableProvider() {
	const providers = await getProvidersWithKeys();
	if (providers.length === 0 || !agent) return;

	// Try each provider with keys and find a default model
	for (const provider of providers) {
		const modelId = DEFAULT_MODELS[provider];
		if (modelId) {
			const model = getModel(provider, modelId);
			if (model) {
				agent.setModel(model);
				await storage.settings.set("lastUsedModel", model);
				await updateAuthLabel();
				renderApp();
				return;
			}
		}
	}

	// If no default found, try the first model for the first provider with a key
	for (const provider of providers) {
		const models = getModels(provider);
		if (models.length > 0) {
			agent.setModel(models[0]);
			await storage.settings.set("lastUsedModel", models[0]);
			await updateAuthLabel();
			renderApp();
			return;
		}
	}
}

async function getProvidersWithKeys(): Promise<string[]> {
	const providers = await storage.providerKeys.list();
	const result: string[] = [];
	for (const provider of providers) {
		const key = await storage.providerKeys.get(provider);
		if (key && getProviders().includes(provider)) result.push(provider);
	}
	for (const provider of await modelConfiguration.getProviders()) {
		for (const id of [provider.id, provider.name]) {
			if (!getProviders().includes(id) && !result.includes(id)) result.push(id);
		}
	}
	return result;
}

async function hasAnyApiKey(): Promise<boolean> {
	const providers = await storage.providerKeys.list();
	return providers.length > 0;
}

function openApiKeysDialog(): Promise<void> {
	return new Promise((resolve) => {
		SettingsDialog.open(
			[
				new ApiKeysOAuthTab(),
				new CostsTab(),
				new SkillsTab(),
				new ProxyTab(),
				new TabsTab(),
				new RetryTab(),
				new AboutTab(),
			],
			resolve,
		);
	});
}

async function updateAuthLabel() {
	if (!agent) {
		authLabel = "";
		return;
	}
	const provider = agent.state.model.provider;
	const stored = await storage.providerKeys.get(provider);
	if (!stored) {
		authLabel = "";
	} else if (isOAuthCredentials(stored)) {
		authLabel = "subscription";
	} else {
		authLabel = "api key";
	}
}

// Export getter for message transformer
export function getShownSkills(): Map<string, string> {
	return shownSkills;
}

// ============================================================================
// HELPERS
// ============================================================================
const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c) => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m: AgentMessage) => m.role === "user" || m.role === "user-with-attachments");
	const hasAssistantMsg = messages.some((m: AgentMessage) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const saveSession = async () => {
	if (!storage.sessions || !currentSessionId || !agent || !currentTitle) return;

	const state = agent.state;
	if (!shouldSaveSession(state.messages)) return;

	try {
		// Calculate cumulative usage from all assistant messages
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		for (const msg of state.messages) {
			if (msg.role === "assistant") {
				usage.input += msg.usage.input;
				usage.output += msg.usage.output;
				usage.cacheRead += msg.usage.cacheRead;
				usage.cacheWrite += msg.usage.cacheWrite;
				usage.totalTokens += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
				if (msg.usage.cost) {
					usage.cost.input += msg.usage.cost.input;
					usage.cost.output += msg.usage.cost.output;
					usage.cost.cacheRead += msg.usage.cost.cacheRead;
					usage.cost.cacheWrite += msg.usage.cost.cacheWrite;
					usage.cost.total += msg.usage.cost.total;
				}
			}
		}

		// Generate preview text (first 2KB of user + assistant text)
		let preview = "";
		for (const msg of state.messages) {
			if (preview.length >= 2048) break;
			if (msg.role === "user" || msg.role === "user-with-attachments") {
				const text =
					typeof msg.content === "string"
						? msg.content
						: msg.content
								.filter((c) => c.type === "text")
								.map((c) => c.text)
								.join("\n") || "";
				preview += `${text}\n`;
			} else if (msg.role === "assistant") {
				const text = msg.content
					.filter((c) => c.type === "text" || c.type === "thinking")
					.map((c) => (c.type === "text" ? c.text : c.thinking))
					.join("\n");
				preview += `${text}\n`;
			}
		}
		preview = preview.substring(0, 2048);

		// Preserve createdAt if session already exists
		const existingMetadata = await storage.sessions.getMetadata(currentSessionId);
		const createdAt = existingMetadata?.createdAt || new Date().toISOString();

		const metadata = {
			id: currentSessionId,
			title: currentTitle,
			createdAt,
			lastModified: new Date().toISOString(),
			messageCount: state.messages.filter((message) => message.role !== "system").length,
			usage,
			modelId: state.model.id,
			thinkingLevel: state.thinkingLevel,
			preview,
		};

		await storage.sessions.saveSession(currentSessionId, state, metadata, currentTitle);
	} catch (err) {
		console.error("Failed to save session:", err);
	}
};

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	if (currentTabId !== undefined) {
		url.searchParams.set("tabId", String(currentTabId));
	}
	window.history.replaceState({}, "", url);
};

/**
 * Give the session its owner lock, channel and tab group before the first
 * run starts, so the first tool call already acts inside the group.
 */
async function ensureRunScope(): Promise<void> {
	const sessionId = currentSessionId ?? agent.sessionId;
	if (!sessionId) return;
	if (getCurrentScope()?.sessionId === sessionId) return;
	let bound = currentTabId;
	if (bound === undefined) {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		bound = active?.id;
	}
	if (bound === undefined) return;
	currentTabId = bound;
	if (!(await acquireOwnerLock(sessionId))) return;
	startOwnerChannel(sessionId);
	await ensureSessionScope(sessionId, bound, { focusNewWorker: currentSessionId === undefined });
}

/** Runs before every prompt in the owning panel, including prompts forwarded by mirrors. */
async function prepareRun(): Promise<void> {
	if (!agent || isMirror()) return;

	// Get current tab info: the session's acting tab when tab scope is
	// on, otherwise the legacy active tab of the current window.
	let tab: chrome.tabs.Tab | undefined;
	if (await isTabScopeEnabled()) {
		await ensureRunScope();
		await refreshScopeTabIds();
		tab = await resolveActingTab().catch(() => undefined);
	}
	if (!tab) {
		[tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
	}
	if (!tab?.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;

	// Find most recent navigation (either nav message or nav tool result)
	let lastUrl: string | undefined;
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const msg = agent.state.messages[i];
		if (msg.role === "navigation") {
			lastUrl = (msg as NavigationMessage).url;
			break;
		}
		if (msg.role === "toolResult" && (msg as any).toolName === "navigate") {
			lastUrl = (msg as any).details?.finalUrl;
			break;
		}
	}

	// Only add if URL changed
	if (!lastUrl || lastUrl !== tab.url) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.appendMessage(navMessage);
	}
}

/**
 * Show a session whose agent runs in another panel. Starts from the stored
 * transcript (when saved) and follows the owner live. When the owner's
 * document goes away its Web Lock frees up and this panel takes over.
 */
async function startMirror(sessionId: string): Promise<void> {
	const sessionData = storage.sessions ? await storage.sessions.loadSession(sessionId).catch(() => null) : null;
	const metadata = sessionData ? await storage.sessions.getMetadata(sessionId).catch(() => null) : null;
	currentTitle = metadata?.title || "";
	await createAgent(
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
	renderApp();
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
	const mirrored = agent.state;
	const fallback = {
		model: mirrored.model,
		thinkingLevel: mirrored.thinkingLevel,
		messages: mirrored.messages.slice(),
	};
	const sessionData = storage.sessions ? await storage.sessions.loadSession(sessionId).catch(() => null) : null;
	if (sessionData) {
		currentSessionId = sessionId;
		const metadata = await storage.sessions.getMetadata(sessionId).catch(() => null);
		currentTitle = metadata?.title || currentTitle;
		await claimBackgroundLock(sessionId);
	} else {
		// Never saved: keep the id so the first save lands on the same session.
		pendingSessionId = sessionId;
	}
	if (currentTabId !== undefined && (await isTabScopeEnabled())) {
		await ensureSessionScope(sessionId, currentTabId);
	}
	const source = sessionData ?? fallback;
	await createAgent({
		systemPrompt: SYSTEM_PROMPT,
		model: source.model,
		thinkingLevel: source.thinkingLevel,
		messages: source.messages,
		tools: [],
	});
	startOwnerChannel(sessionId);
	updateUrl(sessionId);
	renderApp();
}

/** A mirror panel sent input; run it here, queueing behind an active run. */
async function promptFromMirror(input: PromptInput, images?: ImageContent[]): Promise<void> {
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
	await prepareRun();
	await agent.prompt(input, images);
}

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true, mirrorOf?: string) => {
	// A mirror's abort would be forwarded and stop the owner's run.
	if (!isMirror()) agent?.abort();
	if (agentUnsubscribe) {
		agentUnsubscribe();
		agentUnsubscribe = undefined;
	}
	mirrorChannel?.close();
	mirrorChannel = undefined;

	// Mark all loaded messages as already recorded (by object identity)
	costRecorder.seed(initialState?.messages ?? []);

	// Reset skill tracking for new session
	// When loading an old session, we intentionally don't reconstruct shownSkills
	// This ensures that new navigations in the continued session show the LATEST
	// version of skills, even if they were updated since the session was created
	shownSkills.clear();

	// Load debugger mode setting
	const stored = await chrome.storage.local.get("debuggerMode");
	const debuggerModeEnabled = stored.debuggerMode || false;

	// Load CORS proxy settings for extract_document tool
	const corsProxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
	const corsProxyUrl = await storage.settings.get<string>("proxy.url");

	const savedModel = initialState ? initialState.model : await storage.settings.get<unknown>("lastUsedModel");
	const hasSavedSelection = initialState !== undefined || (savedModel !== undefined && savedModel !== null);
	const defaultModel = await resolveInitialModel(
		modelConfiguration,
		savedModel,
		hasSavedSelection,
		await getProvidersWithKeys(),
	);

	if (mirrorOf !== undefined) {
		mirrorChannel = new SessionMirrorChannel(
			sessionChannelName(mirrorOf),
			(remote) =>
				new MirrorAgent(remote, {
					systemPrompt: SYSTEM_PROMPT,
					model: defaultModel,
					thinkingLevel: initialState?.thinkingLevel ?? "medium",
					messages: initialState?.messages ?? [],
				}),
		);
		const mirrorAgent = mirrorChannel.agent;
		mirrorAgent.title = currentTitle;
		mirrorAgent.onChange = () => {
			currentTitle = mirrorAgent.title;
			chatPanel.agentInterface?.requestUpdate();
			updateAuthLabel().catch(() => {});
			renderApp();
		};
		agent = mirrorAgent;
	} else {
		agent = new Agent({
			initialState: {
				systemPrompt: SYSTEM_PROMPT,
				thinkingLevel: "medium",
				messages: [],
				tools: [],
				...initialState,
				model: defaultModel,
			},
			convertToLlm: browserMessageTransformer,
			toolExecution: "sequential",
			// OpenCode Go requires a per-conversation routing id (x-opencode-session).
			// Use the persisted session id once minted, or an ephemeral one for the
			// first turn of a not-yet-saved session; it is synced below on save.
			sessionId: currentSessionId ?? pendingSessionId ?? crypto.randomUUID(),
			beforeToolCall: async () => navigationSteeringGate(agent),
			prepareRequest: async ({ model }) => {
				const resolved = await modelConfiguration.resolveModel(model);
				if (!resolved) throw new Error("The selected model is no longer configured. Select a model again.");
				return { model: resolved };
			},
			streamFn: createStreamFn(
				async () => {
					const enabled = await storage.settings.get<boolean>("proxy.enabled");
					if (!enabled) return undefined;
					return (await storage.settings.get<string>("proxy.url")) || undefined;
				},
				async () => ({
					maxRetries: (await storage.settings.get<number>("retry.rateLimit.maxRetries")) ?? 3,
					delayMs: (await storage.settings.get<number>("retry.rateLimit.delayMs")) ?? 2000,
				}),
			),
			getApiKey: async (provider: string) => {
				const customProvider = await modelConfiguration.getProvider(provider);
				const stored = (await storage.providerKeys.get(provider)) ?? customProvider?.apiKey;
				if (!stored) return undefined;
				const proxyEnabled = await storage.settings.get<boolean>("proxy.enabled");
				const proxyUrl = proxyEnabled ? (await storage.settings.get<string>("proxy.url")) || undefined : undefined;
				return resolveApiKey(stored, provider, storage.providerKeys, proxyUrl);
			},
		});
	}

	await updateAuthLabel();

	if (shouldSave) {
		agentUnsubscribe = agent.subscribe((event: AgentEvent) => {
			const messages = agent.state.messages;

			if (agent.state.model.provider) {
				storage.settings
					.set("lastUsedModel", agent.state.model)
					.catch((err) => console.error("Failed to save lastUsedModel:", err));
			}

			// Update auth label when model changes
			updateAuthLabel().catch(() => {});

			if (event.type === "message_end") {
				const cost = costRecorder.take(event.message);
				if (cost) {
					storage.costs
						.recordCost(cost.provider, cost.model, cost.cost)
						.catch((err) => console.error("Failed to record cost:", err));
				}
			}

			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				void updateGroupTitle();
			}

			if (!currentSessionId && shouldSaveSession(messages)) {
				// Reuse the agent's routing id as the persisted session id so the
				// first turn and later turns present one id to the provider.
				currentSessionId = agent.sessionId ?? crypto.randomUUID();
				agent.sessionId = currentSessionId;
				pendingSessionId = undefined;

				const createdSessionId = currentSessionId;
				claimBackgroundLock(createdSessionId)
					.then((success) => {
						if (!success) {
							console.warn("Failed to acquire lock for newly created session", createdSessionId);
						}
					})
					.catch(() => {});
				updateUrl(createdSessionId);
				// Own a tab group for the new session when tab scope is on.
				// Usually already created before the first run (prepareRun).
				// Falls back to the active tab when this panel has no bound tab.
				void (async () => {
					try {
						if (!(await isTabScopeEnabled())) return;
						if (getCurrentScope()?.sessionId === createdSessionId) return;
						let bound = currentTabId;
						if (bound === undefined) {
							const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
							bound = active?.id;
						}
						if (bound === undefined) return;
						currentTabId = bound;
						await ensureSessionScope(createdSessionId, bound);
					} catch (err) {
						console.warn("[Sidepanel] Failed to scope new session:", err);
					}
				})();
			}

			if (currentSessionId) {
				saveSession();
			}

			renderApp();
		});
	}

	await chatPanel.setAgent(agent, {
		sandboxUrlProvider: () => {
			return chrome.runtime.getURL("sandbox.html");
		},
		onApiKeyRequired: async (provider: string) => {
			if (!provider) {
				chatPanel.agentInterface?.onModelSelect?.();
				return false;
			}
			if (await modelConfiguration.getProvider(provider)) return true;
			return await ApiKeyOrOAuthDialog.prompt(provider);
		},
		onModelSelect: async () => {
			const providers = await getProvidersWithKeys();
			if (providers.length === 0) {
				openApiKeysDialog();
				return;
			}
			ModelSelector.open(
				agent.state.model,
				async (model) => {
					const resolved = await modelConfiguration.resolveModel(model);
					if (!resolved) {
						Toast.error("That model is no longer configured. Select another model.");
						return;
					}
					applyModelSelection(resolved, agent, storage.settings, () => {
						chatPanel.agentInterface?.requestUpdate();
						updateAuthLabel().catch(() => {});
						renderApp();
					}).catch(() => {});
				},
				providers,
			);
		},
		onBeforeSend: () => prepareRun(),
		onCostClick: () => {
			if (!agent) return;
			SessionCostDialog.open(agent.state.messages);
		},
		toolsFactory: (_agent, _agentInterface, _artifactsPanel, runtimeProvidersFactory) => {
			const navigateTool = new NavigateTool();
			const selectElementTool = new AskUserWhichElementTool();
			// Tab scope is resolved live from the current session scope
			// (see getEffectiveScope): no per-tool snapshot needed, so late
			// group changes are picked up without recreating the agent.

			// Create extract_document tool with CORS proxy from settings (loaded above)
			const extractDocumentTool = createExtractDocumentTool();
			if (corsProxyEnabled && corsProxyUrl) {
				extractDocumentTool.corsProxyUrl = `${corsProxyUrl}/?url=`;
			}

			const replTool = createReplTool();
			replTool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

			// Extend base providers with browser orchestration capabilities
			replTool.runtimeProvidersFactory = () => {
				// Providers that should be available in page context via browserjs()
				const pageProviders = [
					...runtimeProvidersFactory(), // attachments + artifacts from ChatPanel
					new NativeInputEventsRuntimeProvider(), // trusted browser events
				];

				return [
					...pageProviders, // Make them available in REPL context too
					new BrowserJsRuntimeProvider(pageProviders), // Pass to page context
					new NavigateRuntimeProvider(navigateTool),
				];
			};

			const extractImageTool = new ExtractImageTool();
			extractImageTool.windowId = currentWindowId;

			const tools: AgentTool[] = [
				executableTool(navigateTool),
				executableTool(selectElementTool),
				executableTool(replTool),
				executableTool(skillTool),
				executableTool(extractDocumentTool),
				executableTool(extractImageTool),
			];

			// Conditionally add debugger tool if enabled
			if (debuggerModeEnabled) {
				const debuggerTool = new DebuggerTool();
				tools.push(executableTool(debuggerTool));
			}

			return tools;
		},
	});
	agent.onModelRequired = () => chatPanel.agentInterface?.onModelSelect?.();
	if (hasSavedSelection && !defaultModel) chatPanel.agentInterface?.onModelSelect?.();

	// Register custom message renderers after agentInterface is available
	if (chatPanel.agentInterface) {
		registerWelcomeRenderer(agent, chatPanel.agentInterface);

		// Only disable auto-scroll for new sessions with welcome message
		// Check if this is a fresh session (only has welcome message, no user messages)
		const hasUserMessage = agent.state.messages.some((m) => m.role === "user" || m.role === "user-with-attachments");
		if (!hasUserMessage) {
			chatPanel.agentInterface.setAutoScroll(false);

			// Re-enable auto-scroll on first user message
			let unsubscribe: (() => void) | undefined;
			unsubscribe = agent.subscribe(() => {
				const hasUserMsg = agent.state.messages.some(
					(m) => m.role === "user" || m.role === "user-with-attachments",
				);
				if (hasUserMsg && unsubscribe) {
					chatPanel.agentInterface?.setAutoScroll(true);
					unsubscribe();
				}
			});
		}
	}
};

const releaseOwnScope = () => {
	// Navigation will disconnect port and auto-release locks. Tab scopes are
	// released explicitly so the old session is immediately adoptable. A
	// mirror never owned the scope.
	if (!isMirror() && currentSessionId) {
		void port.sendMessage({ type: "releaseTabScope", sessionId: currentSessionId }).catch(() => {});
		clearCurrentScope();
	}
};

/** Open a fresh panel on a new tab. Must run inside a user gesture. */
const openPanelInNewTab = async (query: string) => {
	// Explicit user gesture: focusing the new tab is intended.
	try {
		const tab = await chrome.tabs.create({ active: true });
		if (tab.id === undefined) return;
		try {
			await chrome.sidePanel.setOptions({
				tabId: tab.id,
				path: `sidepanel.html?${query}&tabId=${tab.id}`,
				enabled: true,
			});
		} catch {
			// Panel falls back to the default path without tab routing.
		}
		await chrome.sidePanel.open({ tabId: tab.id });
	} catch (err) {
		console.warn("[Sidepanel] Failed to open session in new tab:", err);
	}
};

const loadSession = (sessionId: string) => {
	// A group tab's panel belongs to its session; other sessions open beside it.
	if (groupPanelSessionId !== undefined && groupPanelSessionId !== sessionId) {
		void openPanelInNewTab(`session=${encodeURIComponent(sessionId)}`);
		return;
	}
	releaseOwnScope();
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.location.href = url.toString();
};

// Open a fresh panel on a new tab so two sessions run side by side.
const newSessionInNewTab = () => openPanelInNewTab("new=true");

const newSession = (inPlace = false) => {
	if (!inPlace && groupPanelSessionId !== undefined) {
		void newSessionInNewTab();
		return;
	}
	releaseOwnScope();
	const url = new URL(window.location.href);
	const tabId = url.searchParams.get("tabId");
	url.search = "?new=true";
	if (tabId !== null) {
		url.searchParams.set("tabId", tabId);
	}
	window.location.href = url.toString();
};

// ============================================================================
// RENDER
// ============================================================================
const renderApp = () => {
	const appHtml = html`
		<div class="w-full h-full flex flex-col bg-background text-foreground overflow-hidden">
			<!-- Header -->
			<div class="flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-2 px-3 py-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SitegeistSessionListDialog.open(
								(sessionId: string) => {
									loadSession(sessionId);
								},
								(deletedSessionId: string) => {
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Sessions",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: () => newSession(),
						title: "New Session",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(SquareArrowOutUpRight, "sm"),
						onClick: () => {
							void newSessionInNewTab();
						},
						title: "New session in new tab",
					})}

					${
						currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-48",
										/*
										TODO need to add this in Input in mini-lit
										onBlur: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											if (newTitle && newTitle !== currentTitle && storage.sessions && currentSessionId) {
												await storage.sessions.updateTitle(currentSessionId, newTitle);
												currentTitle = newTitle;
											}
											isEditingTitle = false;
											renderApp();
										},*/
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												if (newTitle && newTitle !== currentTitle) {
													if (agent instanceof MirrorAgent) {
														// The owner saves the session; a local write would be overwritten.
														currentTitle = newTitle;
														agent.setTitle(newTitle);
													} else if (storage.sessions && currentSessionId) {
														await applyTitle(newTitle);
													}
												}
												isEditingTitle = false;
												renderApp();
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderApp();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-xs text-foreground hover:bg-secondary rounded transition-colors truncate max-w-[150px]"
									@click=${() => {
										isEditingTitle = true;
										renderApp();
										requestAnimationFrame(() => {
											const input = document.body.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: html``
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${agent ? html`<span class="text-[10px] text-muted-foreground truncate max-w-[120px]" title="${agent.state.model.provider}/${agent.state.model.id}${authLabel ? ` (${authLabel})` : ""}">${agent.state.model.provider}${authLabel ? html` <span class="text-[9px] opacity-70">${authLabel}</span>` : ""}</span>` : ""}
					<theme-toggle></theme-toggle>
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: () =>
							SettingsDialog.open([
								new ApiKeysOAuthTab(),
								new CostsTab(),
								new SkillsTab(),
								new ProxyTab(),
								new TabsTab(),
								new RetryTab(),
								new AboutTab(),
							]),
						title: "Settings",
					})}
				</div>
			</div>

			<!-- Chat Panel -->
			${chatPanel}
		</div>
	`;

	render(appHtml, document.body);
};

// ============================================================================
// TAB NAVIGATION TRACKING
// ============================================================================

// Listen for tab updates and insert navigation messages only when agent is running
chrome.tabs.onUpdated.addListener(async (_tabId, changeInfo, tab) => {
	// Only the owning panel steers its agent; mirrors only display it.
	if (isMirror()) return;
	// Only care about URL changes on the active tab while agent is working
	// Ignore chrome-extension:// URLs (extension internal pages)
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	// Ignore tabs from other windows
	if (
		changeInfo.url &&
		tab.active &&
		tab.url &&
		tab.windowId === currentWindowId &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		// Tab scope: only tabs inside the session group may steer this agent.
		if (await isTabScopeEnabled()) {
			const scope = getCurrentScope();
			if (!scope || tab.id === undefined || !scope.tabIds.has(tab.id)) return;
		}
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// Listen for tab activation (user switches tabs) only when agent is running
chrome.tabs.onActivated.addListener(async (activeInfo) => {
	// Ignore tab activations from other windows
	if (activeInfo.windowId !== currentWindowId) return;

	// Only the owning panel steers its agent; mirrors only display it.
	// Showing a session on its group tabs needs no handling here: every
	// group tab carries its own registered panel for the session.
	if (isMirror()) return;

	// Tab scope: track the acting tab inside the group, ignore foreign tabs.
	if (await isTabScopeEnabled()) {
		const scope = getCurrentScope();
		if (!scope || !scope.tabIds.has(activeInfo.tabId)) return;
		setActingTab(activeInfo.tabId);
	}

	const tab = await chrome.tabs.get(activeInfo.tabId);
	// Ignore chrome-extension:// URLs (extension internal pages)
	// Ignore tool-initiated navigations (handled by the navigate tool itself)
	if (
		tab.url &&
		agent?.state.isStreaming &&
		!tab.url.startsWith("chrome-extension://") &&
		!tab.url.startsWith("moz-extension://") &&
		!isToolNavigating()
	) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.steer(navMessage);
		console.log("Queued navigation message for tab switch to", tab.url);
	}
});

// ============================================================================
// KEYBOARD SHORTCUTS
// ============================================================================
window.addEventListener(
	"keydown",
	(e) => {
		// Escape key to abort streaming - works globally in sidepanel
		// Use capturing phase to intercept before MessageEditor handles it
		if (e.key === "Escape" && agent?.state.isStreaming) {
			e.preventDefault();
			e.stopPropagation();
			agent.abort();
		}

		// Cmd+U (Mac) or Ctrl+U (Windows/Linux) to open debug page
		if ((e.metaKey || e.ctrlKey) && e.key === "u") {
			e.preventDefault();
			window.location.href = "./debug.html";
		}

		// Cmd+Shift+K (Mac) or Ctrl+Shift+K (Windows/Linux) to show session costs
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
			e.preventDefault();
			if (agent?.state.messages && agent.state.messages.length > 0) {
				SessionCostDialog.open(agent.state.messages);
			}
		}
	},
	true,
); // Use capture phase to intercept Escape before it reaches MessageEditor

// ============================================================================
// TEST STEPS FROM DEBUGGER.TS
// ============================================================================
async function testSteps(): Promise<boolean> {
	const urlParams = new URLSearchParams(window.location.search);
	const testStepsParam = urlParams.get("teststeps");
	const testProvider = urlParams.get("provider");
	const testModel = urlParams.get("model");

	if (!testStepsParam) return false;

	// Handle test prompts - create temporary session without saving
	try {
		const testSteps = JSON.parse(decodeURIComponent(testStepsParam)) as string[];

		// Set model if specified
		let initialState: Partial<AgentState> | undefined;
		if (testProvider && testModel) {
			const model = getModel(testProvider as any, testModel);
			if (model) {
				initialState = {
					systemPrompt: SYSTEM_PROMPT,
					model,
				};
			}
		}

		await createAgent(initialState, false);
		renderApp();

		// Wait for UI to render
		await new Promise((resolve) => requestAnimationFrame(resolve));

		// Submit prompts sequentially
		for (let i = 0; i < testSteps.length; i++) {
			const step = testSteps[i];
			if (!chatPanel?.agentInterface) break;

			// Send the prompt
			await chatPanel.agentInterface.sendMessage(step);

			// Wait for agent to finish (not streaming anymore)
			if (i < testSteps.length - 1) {
				// Wait for response to complete before sending next step
				await new Promise<void>((resolve) => {
					const checkComplete = () => {
						if (!chatPanel.agent?.state.isStreaming) {
							resolve();
						} else {
							setTimeout(checkComplete, 100);
						}
					};
					checkComplete();
				});
			}
		}
		return true;
	} catch (err) {
		console.error("Failed to run test steps:", err);
		return false;
	}
}

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	// Show loading
	render(
		html`
			<div class="w-full h-full flex items-center justify-center bg-background text-foreground">
				<div class="text-muted-foreground">Loading...</div>
			</div>
		`,
		document.body,
	);

	// Load showJsonMode setting
	const stored = await chrome.storage.local.get("showJsonMode");
	const showJsonModeEnabled = (stored.showJsonMode as boolean) || false;
	setShowJsonMode(showJsonModeEnabled);

	// Get current window ID for filtering tab events
	const currentWindow = await chrome.windows.getCurrent();
	if (!currentWindow.id) {
		throw new Error("Failed to get current window ID");
	}
	currentWindowId = currentWindow.id;

	// Per-tab panel binding (M2): the background opens the panel for a tab
	// with ?tabId=<id>. Without it this is a legacy window-bound panel.
	const earlyParams = new URLSearchParams(window.location.search);
	const tabIdParam = earlyParams.get("tabId");
	const parsedTabId = tabIdParam !== null ? Number(tabIdParam) : NaN;
	currentTabId = tabIdParam !== null && Number.isInteger(parsedTabId) ? parsedTabId : undefined;
	clearCurrentScope();

	// Panels opened without tab routing (e.g. extension icon) bind to the
	// active tab when tab scope is on, so every panel owns its tab.
	if (currentTabId === undefined && (await isTabScopeEnabled())) {
		const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
		if (active?.id !== undefined) {
			currentTabId = active.id;
			const url = new URL(window.location.href);
			url.searchParams.set("tabId", String(active.id));
			window.history.replaceState({}, "", url);
		}
	}

	// Initialize port communication system (tab-bound name when we have a tab)
	port.initializeWithTab(currentWindowId, currentTabId);

	// TODO reenable Request persistent storage
	// if (storage.sessions) {
	// 	await PersistentStorageDialog.request();
	// }

	// Request userScripts permission if not available
	if (!chrome.userScripts) {
		await UserScriptsPermissionDialog.request();
	}

	// Initialize default skills
	const { initializeDefaultSkills } = await import("./tools/skill.js");
	await initializeDefaultSkills();

	// Proxy disabled — CORS is handled locally via declarativeNetRequest rules
	await storage.settings.set("proxy.enabled", false);

	// Create ChatPanel
	chatPanel = new ChatPanel();

	// Handle test steps
	if (await testSteps()) {
		return;
	}

	// Check for session in URL
	const urlParams = new URLSearchParams(window.location.search);
	let sessionIdFromUrl = urlParams.get("session");
	const explicitSession = sessionIdFromUrl !== null;
	const isNewSession = urlParams.get("new") === "true";
	const scopeOn = await isTabScopeEnabled();
	if (scopeOn && currentTabId !== undefined) {
		groupPanelSessionId = await getAttachedSession(currentTabId);
	}

	// If no session in URL and not explicitly creating new, try to load the most recent session
	if (!sessionIdFromUrl && !isNewSession && storage.sessions) {
		const latestSessionId = await storage.sessions.getLatestSessionId();
		// With tab scope on, a session another panel runs is never taken over
		// implicitly: only an explicit ?session= link mirrors it.
		if (latestSessionId && (!scopeOn || (await acquireOwnerLock(latestSessionId)))) {
			if (await claimBackgroundLock(latestSessionId)) {
				sessionIdFromUrl = latestSessionId;
				// Update URL to include the latest session
				updateUrl(latestSessionId);
			} else {
				releaseOwnerLock();
			}
			// If lock fails, fall through to create new session
		}
	}

	if (sessionIdFromUrl && storage.sessions) {
		// Another panel runs this session (a group tab of a live session):
		// show it live instead of loading a competing copy.
		if (scopeOn && explicitSession && !(await acquireOwnerLock(sessionIdFromUrl))) {
			await startMirror(sessionIdFromUrl);
			return;
		}
		const sessionData = await storage.sessions.loadSession(sessionIdFromUrl);
		if (sessionData) {
			// Try to acquire lock if we don't already have it (in case user navigated directly via URL)
			const lockSuccess = await claimBackgroundLock(sessionIdFromUrl);

			if (!lockSuccess) {
				releaseOwnerLock();
				// This panel does not show the locked session; keep the URL honest.
				const url = new URL(window.location.href);
				url.searchParams.delete("session");
				window.history.replaceState({}, "", url);
				// Session is locked in another window - show landing page instead
				await createAgent();
				if (agent) {
					const welcomeMessage = createWelcomeMessage(tutorials);
					agent.appendMessage(welcomeMessage);
				}
				renderApp();
				return;
			}

			currentSessionId = sessionIdFromUrl;
			const metadata = await storage.sessions.getMetadata(sessionIdFromUrl);
			currentTitle = metadata?.title || "";

			// Adopt or create the session tab group for the bound tab (M2/M4).
			if (await isTabScopeEnabled()) {
				let bound = currentTabId;
				if (bound === undefined) {
					const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
					bound = active?.id;
				}
				if (bound !== undefined) {
					currentTabId = bound;
					updateUrl(sessionIdFromUrl);
					await ensureSessionScope(sessionIdFromUrl, bound);
				}
			}

			await createAgent({
				systemPrompt: SYSTEM_PROMPT,
				model: sessionData.model,
				thinkingLevel: sessionData.thinkingLevel,
				messages: sessionData.messages,
				tools: [],
			});
			if (ownedSessionId === sessionIdFromUrl) startOwnerChannel(sessionIdFromUrl);

			renderApp();
			return;
		} else {
			// Session doesn't exist, redirect to new session
			newSession(true);
			return;
		}
	}

	// No session - create new agent with welcome message
	await createAgent();

	// Add welcome message for new sessions
	if (agent) {
		const welcomeMessage = createWelcomeMessage(tutorials);
		agent.appendMessage(welcomeMessage);
	}

	renderApp();

	// If no API keys configured, show welcome dialog, open settings, then auto-select model
	if (!(await hasAnyApiKey())) {
		await WelcomeSetupDialog.show();
		await openApiKeysDialog();
		await selectDefaultModelForAvailableProvider();
		renderApp();
	}
}

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
