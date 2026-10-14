import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { html, render } from "lit";
import { History, Plus, Settings, SquareArrowOutUpRight } from "lucide";
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
import { registerWelcomeRenderer } from "./messages/WelcomeMessage.js";
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
import { MirrorAgent } from "./pi/mirror-agent.js";
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
import { NavigateTool } from "./tools/navigate.js";
import { registerOverlayAbortHandler } from "./tools/repl/overlay-abort.js";
import { createReplTool } from "./tools/repl/repl.js";
import { BrowserJsRuntimeProvider, NavigateRuntimeProvider } from "./tools/repl/runtime-providers.js";
import * as port from "./utils/port.js";
import "./utils/i18n-extension.js";
import "./utils/live-reload.js";
import {
	adoptStartupSession,
	applyTitle,
	claimBackgroundLock,
	closeMirror,
	ensureOwnerRunScope,
	isMirror,
	openMirror,
} from "./sidepanel/session-mirror.js";
import {
	bindPanelTab,
	bindSessionPanel,
	installSessionTabListeners,
	loadSession,
	newSession,
	newSessionInNewTab,
	rememberSessionInUrl,
	resolveRunTab,
	scopeNewSession,
	updateGroupTitle,
} from "./sidepanel/session-scope.js";

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

/** Runs before every prompt in the owning panel, including prompts forwarded by mirrors. */
async function prepareRun(): Promise<void> {
	if (!agent || isMirror()) return;

	// Flag off: the active tab. Flag on: the acting group tab, never a foreign one.
	const tab = await resolveRunTab(() => ensureOwnerRunScope());
	if (!tab?.url || tab.url.startsWith("chrome-extension://") || tab.url.startsWith("moz-extension://")) return;

	// Find most recent navigation (either nav message or nav tool result)
	let lastUrl: string | undefined;
	for (let i = agent.state.messages.length - 1; i >= 0; i--) {
		const msg = agent.state.messages[i];
		if (msg.role === "navigation") {
			lastUrl = (msg as NavigationMessage).url;
			break;
		}
		if (msg.role === "toolResult" && msg.toolName === "navigate") {
			const details = msg.details;
			if (details && typeof details === "object" && "finalUrl" in details && typeof details.finalUrl === "string") {
				lastUrl = details.finalUrl;
			}
			break;
		}
	}

	// Only add if URL changed
	if (!lastUrl || lastUrl !== tab.url) {
		const navMessage = await createNavigationMessage(tab.url, tab.title || "Untitled", tab.favIconUrl, tab.id);
		agent.appendMessage(navMessage);
	}
}

const createAgent = async (initialState?: Partial<AgentState>, shouldSave = true, mirrorOf?: string) => {
	// A mirror's abort would be forwarded and stop the owner's run.
	if (!isMirror()) agent?.abort();
	if (agentUnsubscribe) {
		agentUnsubscribe();
		agentUnsubscribe = undefined;
	}
	closeMirror();

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
		agent = openMirror(mirrorOf, {
			model: defaultModel,
			thinkingLevel: initialState?.thinkingLevel ?? "medium",
			messages: initialState?.messages ?? [],
			title: currentTitle,
			onChange: (title) => {
				currentTitle = title;
				chatPanel.agentInterface?.requestUpdate();
				updateAuthLabel().catch(() => {});
				renderApp();
			},
		});
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
				rememberSessionInUrl(createdSessionId);
				void scopeNewSession(createdSessionId);
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
			const model = getModel(testProvider, testModel);
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
	currentTabId = await bindPanelTab();

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

	if (await adoptStartupSession()) {
		// If no API keys configured, show welcome dialog, open settings, then auto-select model
		if (!(await hasAnyApiKey())) {
			await WelcomeSetupDialog.show();
			await openApiKeysDialog();
			await selectDefaultModelForAvailableProvider();
			renderApp();
		}
	}
}

bindSessionPanel({
	isMirror,
	getWindowId: () => currentWindowId,
	getTitle: () => currentTitle,
	setTitle: (title) => {
		currentTitle = title;
	},
	getTabId: () => currentTabId,
	setTabId: (tabId) => {
		currentTabId = tabId;
	},
	getSessionId: () => currentSessionId,
	setSessionId: (sessionId) => {
		currentSessionId = sessionId;
	},
	setPendingSessionId: (sessionId) => {
		pendingSessionId = sessionId;
	},
	getAgent: () => agent,
	render: renderApp,
	updateAuthLabel,
	requestChatUpdate: () => {
		chatPanel.agentInterface?.requestUpdate();
	},
	prepareRun,
	createAgent,
});
installSessionTabListeners();

// Register custom user message renderer early, before any session loads
registerUserMessageRenderer();

initApp();
