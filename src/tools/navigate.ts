import { i18n, icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { Loader2 } from "lucide";
import { type Static, Type } from "typebox";
import {
	assertTabInScope,
	createTabInScope,
	filterTabsToScope,
	getCurrentScope,
	getEffectiveScope,
	isTabScopeEnabled,
	resolveActingTab,
	setActingTab,
	setCurrentScope,
} from "../browser/session-tabs.js";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "../chat/renderers/index.js";
import { SkillPill } from "../components/SkillPill.js";
import { TabPill } from "../components/TabPill.js";
import type { AgentTool } from "../pi/agent.js";
import type { ToolResultMessage } from "../pi/models.js";
import { NAVIGATE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { getSitegeistStorage } from "../storage/app-storage.js";
import type { Skill } from "../storage/stores/skills-store.js";
import { formatSkills } from "../utils/format-skills.js";
import * as port from "../utils/port.js";
import "../utils/i18n-extension.js";

// Track tool-initiated navigations to filter out duplicate navigation messages
let isNavigating = false;

export function isToolNavigating(): boolean {
	return isNavigating;
}

function markNavigationStart() {
	isNavigating = true;
}

function markNavigationEnd() {
	isNavigating = false;
}

// ============================================================================
// TYPES
// ============================================================================

const navigateSchema = Type.Object({
	url: Type.Optional(Type.String({ description: "URL to navigate to (in current tab or new tab if newTab is true)" })),
	newTab: Type.Optional(Type.Boolean({ description: "Set to true to open URL in a new tab instead of current tab" })),
	listTabs: Type.Optional(Type.Boolean({ description: "Set to true to list all open tabs" })),
	switchToTab: Type.Optional(Type.Number({ description: "Tab ID to switch to (get IDs from listTabs)" })),
});

export type NavigateParams = Static<typeof navigateSchema>;

export interface TabInfo {
	id: number;
	url: string;
	title: string;
	active: boolean;
	favicon?: string;
}

export interface NavigateResult {
	finalUrl?: string;
	title?: string;
	favicon?: string;
	tabId?: number;
	skills?: Array<{ name: string; shortDescription: string; fullDetails?: Skill }>;
	tabs?: TabInfo[];
	switchedToTab?: number;
}

// ============================================================================
// TOOL
// ============================================================================

export class NavigateTool implements AgentTool<typeof navigateSchema, NavigateResult> {
	label = "Navigate";
	name = "navigate";
	description = NAVIGATE_TOOL_DESCRIPTION;
	parameters = navigateSchema;

	/**
	 * M1 tab scope. Undefined means legacy behavior (no filtering).
	 * Wired to the background-owned session-to-group map in M2; tests and
	 * future callers use setScope() to opt a tool instance into scoping.
	 * The flag gate stays off by default so unset scope changes nothing.
	 */
	scopedTabIds?: Set<number>;
	scopedGroupId?: number;

	setScope(tabIds: number[] | undefined, groupId?: number): void {
		this.scopedTabIds = tabIds === undefined ? undefined : new Set(tabIds);
		this.scopedGroupId = groupId;
	}

	async execute(
		_toolCallId: string,
		args: NavigateParams,
		signal?: AbortSignal,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		if (signal?.aborted) {
			throw new Error("Navigation aborted");
		}

		// Handle list tabs action
		if ("listTabs" in args) {
			return this.listTabs();
		}

		// Handle switch tab action
		if ("switchToTab" in args && args.switchToTab !== undefined) {
			markNavigationStart();
			try {
				return await this.switchToTab(args.switchToTab);
			} finally {
				markNavigationEnd();
			}
		}

		const scoped = await isTabScopeEnabled();
		const tab = scoped
			? await resolveActingTab()
			: (
					await chrome.tabs.query({
						active: true,
						currentWindow: true,
					})
				)[0];
		if (scoped && tab?.id !== undefined) {
			const allowed = getEffectiveScope(this.scopedTabIds, this.scopedGroupId).tabIds;
			if (allowed !== undefined) assertTabInScope(tab.id, allowed);
		}

		if (!tab || !tab.id) {
			throw new Error("No active tab found");
		}

		let finalUrl: string;
		let targetTabId = tab.id;

		markNavigationStart();
		try {
			if ("url" in args && args.url !== undefined) {
				// Check if opening in new tab
				if ("newTab" in args && args.newTab) {
					const opened = await this.openInNewTab(args.url, signal);
					finalUrl = opened.url;
					targetTabId = opened.tabId;
				} else {
					// Navigate to URL in current tab
					finalUrl = await this.navigateToUrl(tab.id, args.url, signal);
				}
			} else {
				throw new Error("Invalid navigation parameters");
			}
		} finally {
			markNavigationEnd();
		}

		// Get updated tab info using query (better cross-browser support)
		const updatedTabs = await chrome.tabs.query({});
		const updatedTab = updatedTabs.find((t: chrome.tabs.Tab) => t.id === targetTabId);
		const title = updatedTab?.title || "Untitled";
		const favicon = updatedTab?.favIconUrl;

		// Get skills for the final URL
		const skillsRepo = getSitegeistStorage().skills;
		const matchingSkills = await skillsRepo.getSkillsForUrl(finalUrl);
		const { newOrUpdated, unchanged, formattedText: skillsOutput } = formatSkills(matchingSkills);

		// Build skills array with full details for all skills (needed for UI rendering)
		const skills = [
			...newOrUpdated.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
			...unchanged.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
		];

		const details: NavigateResult = {
			finalUrl,
			title,
			favicon,
			tabId: targetTabId,
			skills,
		};
		setActingTab(targetTabId);

		// Build output message
		let output = "";
		if ("newTab" in args && args.newTab) {
			output = `Opened in new tab: ${finalUrl} (tab ${targetTabId})\n`;
		} else {
			output = `Navigated to: ${finalUrl} (tab ${targetTabId})\n`;
		}

		output += `\n${skillsOutput}`;

		return { content: [{ type: "text", text: output }], details };
	}

	private async navigateToUrl(tabId: number, url: string, signal?: AbortSignal): Promise<string> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			// Set up DOMContentLoaded listener (fires when DOM is ready, more reliable than onCompleted)
			const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (details.tabId === tabId && details.frameId === 0) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
					if (abortListener) signal?.removeEventListener("abort", abortListener);
					resolve(details.url);
				}
			};

			// Set up abort listener
			const abortListener = () => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
				}
				reject(new Error("Aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", abortListener);
			}

			chrome.webNavigation.onDOMContentLoaded.addListener(listener);

			// Trigger navigation
			chrome.tabs.update(tabId, { url }).catch((err: Error) => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
				}
				if (abortListener) signal?.removeEventListener("abort", abortListener);
				reject(err);
			});
		});
	}

	private async publishActingTab(tabId: number): Promise<void> {
		const sessionId = getCurrentScope()?.sessionId;
		if (!sessionId) return;
		await port.sendMessage({ type: "updateActingTab", sessionId, tabId }).catch((err: unknown) => {
			console.warn("[Navigate] Failed to publish acting tab:", err);
		});
	}

	private async openInNewTab(url: string, signal?: AbortSignal): Promise<{ url: string; tabId: number }> {
		if (signal?.aborted) {
			throw new Error("Aborted");
		}

		// M1 tab scope: open inactive and group when the flag is on. The
		// legacy path below keeps active:true so default behavior is unchanged.
		if (await isTabScopeEnabled()) {
			const effective = getEffectiveScope(this.scopedTabIds, this.scopedGroupId);
			const scopedTab = await createTabInScope(url, effective.groupId);
			const id = scopedTab.id;
			if (id === undefined) {
				throw new Error("Failed to create new tab");
			}
			const scope = getCurrentScope();
			if (scope) {
				setCurrentScope({
					...scope,
					tabIds: new Set([...scope.tabIds, id]),
					actingTabId: id,
				});
			}
			if (this.scopedTabIds) {
				this.scopedTabIds = new Set([...this.scopedTabIds, id]);
			}
			setActingTab(id);
			await this.publishActingTab(id);
			const resolvedUrl = await this.waitForTabLoad(id, signal);
			return { url: resolvedUrl, tabId: id };
		}

		const newTab = await chrome.tabs.create({ url, active: true });

		if (!newTab.id) {
			throw new Error("Failed to create new tab");
		}

		const resolvedUrl = await this.waitForTabLoad(newTab.id, signal);
		return { url: resolvedUrl, tabId: newTab.id };
	}

	private async waitForTabLoad(tabId: number, signal?: AbortSignal): Promise<string> {
		// Wait for the tab to load
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Aborted"));
				return;
			}

			const listener = (details: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
				if (details.tabId === tabId && details.frameId === 0) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
					if (abortListener) signal?.removeEventListener("abort", abortListener);
					resolve(details.url);
				}
			};

			const abortListener = () => {
				if (chrome.webNavigation?.onDOMContentLoaded) {
					chrome.webNavigation.onDOMContentLoaded.removeListener(listener);
				}
				reject(new Error("Aborted"));
			};

			if (signal) {
				signal.addEventListener("abort", abortListener);
			}

			chrome.webNavigation.onDOMContentLoaded.addListener(listener);
		});
	}

	private async listTabs(): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		const tabs = await chrome.tabs.query({});

		let tabInfos: TabInfo[] = tabs
			.filter(
				(t: chrome.tabs.Tab): t is chrome.tabs.Tab & { id: number; url: string } =>
					t.id !== undefined && t.url !== undefined,
			)
			.map((t: chrome.tabs.Tab & { id: number; url: string }) => ({
				id: t.id,
				url: t.url,
				title: t.title || "Untitled",
				active: t.active || false,
				favicon: t.favIconUrl,
			}));

		// M1 tab scope: never report tabs outside the session group when the
		// flag is on and a scope is set. Flag off or unset scope keeps legacy.
		if (await isTabScopeEnabled()) {
			const effective = getEffectiveScope(this.scopedTabIds, this.scopedGroupId);
			if (effective.tabIds === undefined) {
				tabInfos = [];
			} else {
				tabInfos = filterTabsToScope(tabInfos, effective.tabIds);
			}
		}

		const details: NavigateResult = {
			tabs: tabInfos,
		};

		let output = `Found ${tabInfos.length} open tabs:\n`;
		for (const tab of tabInfos) {
			const activeMarker = tab.active ? " [ACTIVE]" : "";
			output += `  - Tab ${tab.id}: ${tab.title}${activeMarker}\n`;
			output += `    URL: ${tab.url}\n`;
		}

		return { content: [{ type: "text", text: output }], details };
	}

	private async switchToTab(
		tabId: number,
	): Promise<{ content: Array<{ type: "text"; text: string }>; details: NavigateResult }> {
		// Ensure tabId is a number (in case it comes through as string)
		const numericTabId = typeof tabId === "string" ? parseInt(tabId, 10) : tabId;

		// Query for the tab to get its details
		const tabs = await chrome.tabs.query({});
		const tab = tabs.find((t: chrome.tabs.Tab) => t.id === numericTabId);

		if (!tab) {
			throw new Error(`Tab ${numericTabId} not found`);
		}

		// Reject foreign tabs before any focus change.
		const scoped = await isTabScopeEnabled();
		if (scoped) {
			const effective = getEffectiveScope(this.scopedTabIds, this.scopedGroupId);
			if (effective.tabIds === undefined) {
				throw new Error(`Tab ${numericTabId} is outside the session tab group`);
			}
			assertTabInScope(numericTabId, effective.tabIds);
		}

		// Activate the tab
		await chrome.tabs.update(numericTabId, { active: true });

		// Focus the window containing the tab
		if (tab.windowId) {
			await chrome.windows.update(tab.windowId, { focused: true });
		}
		setActingTab(numericTabId);
		if (scoped) await this.publishActingTab(numericTabId);

		const finalUrl = tab.url || "";
		const title = tab.title || "Untitled";
		const favicon = tab.favIconUrl;

		// Get skills for the tab's URL
		const skillsRepo = getSitegeistStorage().skills;
		const matchingSkills = finalUrl ? await skillsRepo.getSkillsForUrl(finalUrl) : [];
		const { newOrUpdated, unchanged, formattedText: skillsOutput } = formatSkills(matchingSkills);

		// Build skills array with full details for all skills (needed for UI rendering)
		const skills = [
			...newOrUpdated.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
			...unchanged.map((s) => ({
				name: s.name,
				shortDescription: s.shortDescription,
				fullDetails: s,
			})),
		];

		const details: NavigateResult = {
			finalUrl,
			title,
			favicon,
			tabId: numericTabId,
			skills,
			switchedToTab: numericTabId,
		};

		let output = `Switched to tab ${numericTabId}: ${title}\n`;
		output += `URL: ${finalUrl}\n`;
		output += `\n${skillsOutput}`;

		return { content: [{ type: "text", text: output }], details };
	}
}

// ============================================================================
// RENDERER
// ============================================================================

function getFallbackFavicon(url: string): string {
	try {
		const urlObj = new URL(url);
		return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
	} catch {
		return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23999' d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z'/%3E%3C/svg%3E";
	}
}

export const navigateRenderer: ToolRenderer<NavigateParams, NavigateResult> = {
	render(
		params: NavigateParams | undefined,
		result: ToolResultMessage<NavigateResult> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		// Loading state (params but no result)
		if (params && !result) {
			let displayText = "";
			if ("url" in params && params.url) {
				displayText = params.url;
			} else if ("listTabs" in params) {
				displayText = "Listing tabs...";
			} else if ("switchToTab" in params) {
				displayText = `Switching to tab ${params.switchToTab}`;
			}

			return {
				content: html`
					<div class="my-2">
						<div
							class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg max-w-full shadow-lg"
						>
							<div class="w-4 h-4 flex-shrink-0 flex items-center justify-center">
								${icon(Loader2, "sm", "animate-spin")}
							</div>
							<span class="truncate font-medium">${i18n("Navigating to")} ${displayText}</span>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Complete state (with result)
		if (result && !result.isError && result.details) {
			const { finalUrl, title, favicon, skills, tabs } = result.details;

			// Handle tab listing
			if (tabs) {
				return {
					content: html`
						<div class="flex items-center gap-2 flex-wrap">
							<span class="text-sm text-muted-foreground">${i18n("Open tabs")}</span>
							${tabs.map((tab) => TabPill(tab, true))}
						</div>
					`,
					isCustom: false,
				};
			}

			// Handle navigation/switch results
			if (finalUrl && title) {
				const faviconUrl = favicon || getFallbackFavicon(finalUrl);

				// Convert skills to Skill objects for SkillPill
				// Use fullDetails if available (for new/updated skills), otherwise create minimal skill
				const skillObjects: Skill[] = (skills || []).map((s) =>
					s.fullDetails
						? s.fullDetails
						: {
								name: s.name,
								shortDescription: s.shortDescription,
								description: "",
								examples: "",
								library: "",
								domainPatterns: [],
								createdAt: new Date().toISOString(),
								lastUpdated: new Date().toISOString(),
							},
				);

				return {
					content: html`
						<div class="my-2 space-y-2">
							<button
								class="inline-flex items-center gap-2 px-3 py-2 text-sm text-card-foreground bg-card border border-border rounded-lg hover:bg-accent/50 transition-colors max-w-full cursor-pointer shadow-lg"
								@click=${async () => {
									if (await isTabScopeEnabled()) {
										await createTabInScope(finalUrl, getCurrentScope()?.groupId).catch(() => {});
										return;
									}
									chrome.tabs.create({ url: finalUrl });
								}}
								title="${i18n("Click to open")}: ${finalUrl}"
							>
								<img src="${faviconUrl}" alt="" class="w-4 h-4 flex-shrink-0" />
								<span class="truncate font-medium">${title}</span>
							</button>
							${
								skillObjects.length > 0
									? html`
										<div class="flex flex-wrap gap-2">
											${skillObjects.map((s) => SkillPill(s, true))}
										</div>
								  `
									: ""
							}
						</div>
					`,
					isCustom: true,
				};
			}
		}

		// Error state
		if (result?.isError) {
			const errorText = result.content.find((c) => c.type === "text")?.text || "Unknown error";
			return {
				content: html`
					<div class="my-2">
						<div class="text-sm text-destructive">${errorText}</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Waiting state
		return {
			content: html`<div class="my-2 text-sm text-muted-foreground">${i18n("Waiting...")}</div>`,
			isCustom: true,
		};
	},
};

// Auto-register renderer
registerToolRenderer("navigate", navigateRenderer);
