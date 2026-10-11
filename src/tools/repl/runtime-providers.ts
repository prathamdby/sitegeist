import {
	BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION,
	NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION,
} from "../../prompts/prompts.js";
import { ConsoleRuntimeProvider } from "../../sandbox/ConsoleRuntimeProvider.js";
import { RUNTIME_MESSAGE_ROUTER } from "../../sandbox/RuntimeMessageRouter.js";
import type { RuntimeMessage, RuntimeResponse, SandboxRuntimeProvider } from "../../sandbox/types.js";
import { getSitegeistStorage } from "../../storage/app-storage.js";
import type { NavigateParams, NavigateTool } from "../navigate.js";
import { buildWrapperCode, checkUserScriptsAvailability } from "./userscripts-helpers.js";

/**
 * BrowserJsRuntimeProvider
 *
 * Provides the browserjs() helper to REPL scripts, which executes code
 * in the active browser tab's page context via userScripts API.
 *
 * Usage in REPL:
 *   const title = await browserjs(() => document.title);
 *   const count = await browserjs((sel) => document.querySelectorAll(sel).length, '.product');
 */
export class BrowserJsRuntimeProvider implements SandboxRuntimeProvider {
	private activeSandboxIds: Set<string> = new Set();
	private activeExecutions = new Map<
		string,
		{
			ownerSandboxId?: string;
			cancel: () => void;
		}
	>();
	private sandboxAbortSignals = new Map<string, AbortSignal>();

	constructor(private sharedProviders: SandboxRuntimeProvider[]) {}

	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			// Inject browserjs() helper
			(window as any).browserjs = async (func: () => any, ...args: any[]): Promise<any> => {
				if (typeof func !== "function") {
					throw new Error("First argument to browserjs() must be a function");
				}

				const response = await sendRuntimeMessage(
					{
						type: "browser-js",
						code: func.toString(),
						args: JSON.stringify(args),
					},
					{ rejectOnError: false },
				);

				// Log console output from browserjs() execution to REPL's console
				// BEFORE throwing errors, so console logs are visible even on failure
				if (response.console && Array.isArray(response.console)) {
					for (const log of response.console) {
						const method = log.type || "log";
						const message = `[browserjs] ${log.text}`;
						if (method === "error") {
							console.error(message);
						} else if (method === "warn") {
							console.warn(message);
						} else if (method === "info") {
							console.info(message);
						} else {
							console.log(message);
						}
					}
				}

				if (!response.success) {
					throw new Error(response.error || "browserjs() execution failed");
				}

				return response.result;
			};
		};
	}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		if (signal) {
			this.sandboxAbortSignals.set(sandboxId, signal);
		}
	}

	onExecutionEnd(sandboxId: string): void {
		for (const execution of this.activeExecutions.values()) {
			if (execution.ownerSandboxId === sandboxId) execution.cancel();
		}
		this.sandboxAbortSignals.delete(sandboxId);
	}

	async handleMessage(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void> {
		if (message.type !== "browser-js") {
			return;
		}
		const sandboxId = `browserjs_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
		const abortSignal = message.sandboxId ? this.sandboxAbortSignals.get(message.sandboxId) : undefined;
		let cancelled = false;
		let tabId: number | undefined;
		let windowId: number | undefined;
		let executionId: string | undefined;
		let injectionStarted = false;
		const executionController = new AbortController();
		const startedProviders: SandboxRuntimeProvider[] = [];
		let rejectCancellation: (error: Error) => void = () => {};
		const cancellation = new Promise<never>((_, reject) => {
			rejectCancellation = reject;
		});
		const userScripts = chrome.userScripts as
			| (typeof chrome.userScripts & { terminate?: (tabId: number, executionId: string) => Promise<void> })
			| undefined;
		const cancel = () => {
			if (cancelled) return;
			cancelled = true;
			rejectCancellation(new Error("Script execution was cancelled"));
			executionController.abort();
			this.cleanup(sandboxId);
			if (injectionStarted && tabId !== undefined && executionId && userScripts?.terminate) {
				void userScripts.terminate(tabId, executionId).catch((error: unknown) => {
					console.error("[BrowserJsRuntimeProvider] Failed to terminate execution:", error);
				});
			}
		};
		this.activeExecutions.set(sandboxId, { ownerSandboxId: message.sandboxId, cancel });
		abortSignal?.addEventListener("abort", cancel, { once: true });
		const tabActivated = (info: chrome.tabs.OnActivatedInfo) => {
			if (tabId !== undefined && info.tabId !== tabId && info.windowId === windowId) cancel();
		};
		const tabRemoved = (removedTabId: number) => {
			if (removedTabId === tabId) cancel();
		};
		try {
			if (abortSignal?.aborted) {
				cancel();
				await cancellation;
			}
			const apiCheck = await Promise.race([checkUserScriptsAvailability(), cancellation]);
			if (!apiCheck.available) {
				respond({ success: false, error: apiCheck.message || "userScripts API not available" });
				return;
			}
			const [tab] = await Promise.race([chrome.tabs.query({ active: true, currentWindow: true }), cancellation]);
			if (tab?.id === undefined) {
				respond({ success: false, error: "No active tab found" });
				return;
			}
			tabId = tab.id;
			windowId = tab.windowId;
			chrome.tabs.onActivated.addListener(tabActivated);
			chrome.tabs.onRemoved.addListener(tabRemoved);
			if (
				tab.url?.startsWith("chrome://") ||
				tab.url?.startsWith("chrome-extension://") ||
				tab.url?.startsWith("moz-extension://") ||
				tab.url?.startsWith("about:")
			) {
				respond({
					success: false,
					error: `Cannot execute scripts on ${tab.url}. Extension pages and internal URLs are protected.`,
				});
				return;
			}
			let skillLibrary = "";
			if (tab.url) {
				const matchingSkills = await Promise.race([
					getSitegeistStorage().skills.getSkillsForUrl(tab.url),
					cancellation,
				]);
				if (matchingSkills.length > 0) {
					skillLibrary = `${matchingSkills.map((skill) => skill.library).join("\n\n")}\n\n`;
				}
			}
			let parsedArgs: unknown[] = [];
			if (message.args) {
				try {
					parsedArgs = JSON.parse(String(message.args));
				} catch (error) {
					respond({ success: false, error: `Failed to parse arguments: ${error}` });
					return;
				}
			}
			if (cancelled) await cancellation;
			const worldId = "sitegeist-browser-script";
			const pageConsoleProvider = new ConsoleRuntimeProvider();
			const providers = [pageConsoleProvider, ...this.sharedProviders];
			this.activeSandboxIds.add(sandboxId);
			const wrapperCode = buildWrapperCode(
				String(message.code),
				skillLibrary,
				false,
				providers,
				sandboxId,
				parsedArgs,
				{
					transport: "user-script",
					tabId,
					frameId: 0,
					worldId,
					capability: crypto.randomUUID(),
					signal: executionController.signal,
				},
			);
			for (const provider of providers) {
				startedProviders.push(provider);
				provider.onExecutionStart?.(sandboxId, executionController.signal);
			}
			executionId = typeof userScripts?.terminate === "function" ? crypto.randomUUID() : undefined;
			if (chrome.userScripts && typeof chrome.userScripts.execute === "function") {
				try {
					await Promise.race([
						chrome.userScripts.configureWorld({
							worldId,
							messaging: true,
							csp: "script-src 'unsafe-eval' 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; frame-src 'none'; font-src 'none'; object-src 'none'; default-src 'none';",
						}),
						cancellation,
					]);
				} catch (error) {
					if (cancelled) throw error;
					console.warn("[BrowserJsRuntimeProvider] Failed to configure userScripts world:", error);
				}
				if (cancelled) await cancellation;
				const injectionConfig: chrome.userScripts.UserScriptInjection & { executionId?: string } = {
					js: [{ code: wrapperCode }],
					target: { tabId, allFrames: false },
					world: "USER_SCRIPT",
					worldId,
					injectImmediately: true,
				};
				if (executionId) {
					injectionConfig.executionId = executionId;
				}
				injectionStarted = true;
				const results = await Promise.race([chrome.userScripts.execute(injectionConfig), cancellation]);
				const result = results[0]?.result as
					| {
							success: boolean;
							lastValue?: unknown;
							error?: string;
							stack?: string;
					  }
					| undefined;

				// Get console output from the dedicated ConsoleRuntimeProvider for this execution
				const consoleLogs = pageConsoleProvider.getLogs();

				if (!result) {
					respond({
						success: true,
						error: "No result returned from script execution",
						console: consoleLogs,
					});
					return;
				}

				if (!result.success) {
					respond({
						success: false,
						error: result.error,
						stack: result.stack,
						console: consoleLogs,
					});
					return;
				}

				respond({
					success: true,
					result: result.lastValue,
					console: consoleLogs,
				});
			} else {
				// Firefox fallback
				respond({
					success: false,
					error: 'Firefox is currently not supported for browserjs(). Use Chrome 138+ with "Allow User Scripts" enabled.',
				});
			}
		} catch (error: unknown) {
			respond({
				success: false,
				error: cancelled
					? "Script execution was cancelled"
					: error instanceof Error
						? error.message
						: String(error),
				cancelled,
			});
		} finally {
			abortSignal?.removeEventListener("abort", cancel);
			chrome.tabs.onActivated.removeListener(tabActivated);
			chrome.tabs.onRemoved.removeListener(tabRemoved);
			this.activeExecutions.delete(sandboxId);
			this.cleanup(sandboxId);
			executionController.abort();
			for (const provider of startedProviders) {
				try {
					provider.onExecutionEnd?.(sandboxId);
				} catch (error) {
					console.error("Browser runtime provider cleanup failed", error);
				}
			}
		}
	}

	getDescription(): string {
		return BROWSERJS_RUNTIME_PROVIDER_DESCRIPTION;
	}

	/**
	 * Cleanup a specific sandbox registration
	 */
	private cleanup(sandboxId: string) {
		if (this.activeSandboxIds.has(sandboxId)) {
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
			this.activeSandboxIds.delete(sandboxId);
		}
	}

	/**
	 * Cleanup all active sandboxes (call when provider is destroyed)
	 */
	public cleanupAll() {
		for (const execution of this.activeExecutions.values()) execution.cancel();
		for (const sandboxId of this.activeSandboxIds) {
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
		}
		this.activeSandboxIds.clear();
		this.sandboxAbortSignals.clear();
	}
}

/**
 * NavigateRuntimeProvider
 *
 * Provides the navigate() helper to REPL scripts, which wraps the NavigateTool.
 *
 * Usage in REPL:
 *   await navigate({ url: 'https://example.com' });
 *   await navigate({ history: 'back' });
 */
export class NavigateRuntimeProvider implements SandboxRuntimeProvider {
	private sandboxAbortSignals = new Map<string, AbortSignal>();

	constructor(private navigateTool: NavigateTool) {}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		if (signal) this.sandboxAbortSignals.set(sandboxId, signal);
	}

	onExecutionEnd(sandboxId: string): void {
		this.sandboxAbortSignals.delete(sandboxId);
	}

	getData(): Record<string, any> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		// This function will be stringified and injected into the REPL iframe
		return (_sandboxId: string) => {
			const sendRuntimeMessage = (window as any).sendRuntimeMessage;
			if (typeof sendRuntimeMessage !== "function") {
				throw new Error("sendRuntimeMessage is not available in this context");
			}

			// Inject navigate() helper
			(window as any).navigate = async (args: any): Promise<any> => {
				const response = await sendRuntimeMessage({
					type: "navigate",
					args,
				});

				if (!response.success) {
					throw new Error(response.error || "navigate() execution failed");
				}

				return response.result;
			};
		};
	}

	async handleMessage(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void> {
		if (message.type !== "navigate") {
			return;
		}

		console.log("[NavigateRuntimeProvider] Received message:", message);

		try {
			// Call the navigate tool
			const signal = message.sandboxId ? this.sandboxAbortSignals.get(message.sandboxId) : undefined;
			const result = await this.navigateTool.execute(
				`navigate_${Date.now()}`,
				message.args as NavigateParams,
				signal,
			);

			respond({
				success: true,
				result: {
					finalUrl: result.details.finalUrl,
					title: result.details.title,
					skills: result.details.skills,
				},
			});
		} catch (error: any) {
			console.error("[NavigateRuntimeProvider] Error:", error);
			respond({
				success: false,
				error: error.message || String(error),
			});
		}
	}

	getDescription(): string {
		return NAVIGATE_RUNTIME_PROVIDER_DESCRIPTION;
	}
}
