import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { FOCUS_SESSION_TAB_KEY } from "../browser/session-panels.js";
import { getProviders } from "../pi/models.js";
import { clampRetryPolicy, DEFAULT_RETRY_POLICY } from "../pi/retry-policy.js";
import { getAppStorage } from "../storage/app-storage.js";
import "../components/ProviderKeyInput.js";

export abstract class SettingsTab extends LitElement {
	protected createRenderRoot() {
		return this;
	}
	abstract getTabName(): string;
}

export class ApiKeysTab extends SettingsTab {
	getTabName() {
		return "API Keys";
	}
	render() {
		return html`<div class="flex flex-col gap-6">${getProviders().map((provider) => html`<sitegeist-provider-key-input .provider=${provider}></sitegeist-provider-key-input>`)}</div>`;
	}
}

export class ProxyTab extends SettingsTab {
	@state() private proxyEnabled = false;
	@state() private proxyUrl = "http://localhost:3001";

	getTabName() {
		return "Proxy";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const settings = getAppStorage().settings;
		this.proxyEnabled = (await settings.get<boolean>("proxy.enabled")) ?? false;
		this.proxyUrl = (await settings.get<string>("proxy.url")) ?? "http://localhost:3001";
	}

	private async saveProxySettings() {
		const settings = getAppStorage().settings;
		await settings.set("proxy.enabled", this.proxyEnabled);
		await settings.set("proxy.url", this.proxyUrl);
	}

	render() {
		return html`<div class="flex flex-col gap-4">
			<p class="text-sm text-muted-foreground">Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.</p>
			<div class="flex items-center justify-between">
				<span class="text-sm font-medium text-foreground">Use CORS Proxy</span>
				${Switch({
					checked: this.proxyEnabled,
					onChange: (checked) => {
						this.proxyEnabled = checked;
						void this.saveProxySettings();
					},
				})}
			</div>
			<div class="space-y-2">
				${Label("Proxy URL")}
				${Input({
					value: this.proxyUrl,
					disabled: !this.proxyEnabled,
					onChange: (event) => {
						this.proxyUrl = (event.target as HTMLInputElement).value;
						void this.saveProxySettings();
					},
				})}
				<p class="text-xs text-muted-foreground">Format: The proxy must accept requests as &lt;proxy-url&gt;/?url=&lt;target-url&gt;</p>
			</div>
		</div>`;
	}
}

export class TabsTab extends SettingsTab {
	@state() private tabScopeEnabled = false;
	@state() private focusSessionTab = true;

	getTabName() {
		return "Tabs";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const settings = getAppStorage().settings;
		this.tabScopeEnabled = (await settings.get<boolean>("tabScope.enabled")) ?? false;
		this.focusSessionTab = (await settings.get<boolean>(FOCUS_SESSION_TAB_KEY)) ?? true;
	}

	private async saveTabsSettings() {
		const settings = getAppStorage().settings;
		await settings.set("tabScope.enabled", this.tabScopeEnabled);
		await settings.set(FOCUS_SESSION_TAB_KEY, this.focusSessionTab);
		try {
			await chrome.storage.local.set({
				"tabScope.enabled": this.tabScopeEnabled,
				[FOCUS_SESSION_TAB_KEY]: this.focusSessionTab,
			});
		} catch {
			// Extension context required; settings record is the source of truth.
		}
	}

	render() {
		return html`<div class="flex flex-col gap-4">
			<p class="text-sm text-muted-foreground">Each chat owns its own tab group. Tabs open in the background, the agent works on its current tab, and the panel stays on the tab you opened it on.</p>
			<div class="flex items-center justify-between">
				<span class="text-sm font-medium text-foreground">Background tabs</span>
				${Switch({
					checked: this.tabScopeEnabled,
					onChange: (checked) => {
						this.tabScopeEnabled = checked;
						void this.saveTabsSettings();
					},
				})}
			</div>
			<p class="text-xs text-muted-foreground">Takes effect for new sessions. Existing sessions adopt a group when reopened. Switching to a tab in a chat's group shows that chat in the panel.</p>
			<div class="flex items-center justify-between">
				<span class="text-sm font-medium text-foreground">Switch to new chat's tab</span>
				${Switch({
					checked: this.focusSessionTab,
					disabled: !this.tabScopeEnabled,
					onChange: (checked) => {
						this.focusSessionTab = checked;
						void this.saveTabsSettings();
					},
				})}
			</div>
			<p class="text-xs text-muted-foreground">When a new chat starts, focus the tab it works in so you can watch it. Off keeps you on your current tab.</p>
		</div>`;
	}
}

export class RetryTab extends SettingsTab {
	@state() private maxRetries = DEFAULT_RETRY_POLICY.maxRetries;
	@state() private delayMs = DEFAULT_RETRY_POLICY.delayMs;

	getTabName() {
		return "Retry";
	}

	override async connectedCallback() {
		super.connectedCallback();
		const settings = getAppStorage().settings;
		const stored = clampRetryPolicy({
			maxRetries: (await settings.get<number>("retry.rateLimit.maxRetries")) ?? DEFAULT_RETRY_POLICY.maxRetries,
			delayMs: (await settings.get<number>("retry.rateLimit.delayMs")) ?? DEFAULT_RETRY_POLICY.delayMs,
		});
		this.maxRetries = stored.maxRetries;
		this.delayMs = stored.delayMs;
	}

	private async saveRetrySettings() {
		const settings = getAppStorage().settings;
		await settings.set("retry.rateLimit.maxRetries", this.maxRetries);
		await settings.set("retry.rateLimit.delayMs", this.delayMs);
		try {
			await chrome.storage.local.set({
				"retry.rateLimit.maxRetries": this.maxRetries,
				"retry.rateLimit.delayMs": this.delayMs,
			});
		} catch {
			// Extension context required; settings record is the source of truth.
		}
	}

	render() {
		return html`<div class="flex flex-col gap-4">
			<p class="text-sm text-muted-foreground">Retries rate-limited requests (HTTP 429) with a fixed delay. Quota and billing limits are never retried.</p>
			<div class="space-y-2">
				${Label("Max retries")}
				${Input({
					type: "number",
					min: 0,
					max: 10,
					step: 1,
					value: String(this.maxRetries),
					onChange: (event) => {
						this.maxRetries = clampRetryPolicy({
							maxRetries: Number((event.target as HTMLInputElement).value),
							delayMs: this.delayMs,
						}).maxRetries;
						void this.saveRetrySettings();
					},
				})}
				<p class="text-xs text-muted-foreground">Retries after the initial request. 0 disables retries.</p>
			</div>
			<div class="space-y-2">
				${Label("Retry delay (ms)")}
				${Input({
					type: "number",
					min: 0,
					max: 30000,
					step: 100,
					value: String(this.delayMs),
					onChange: (event) => {
						this.delayMs = clampRetryPolicy({
							maxRetries: this.maxRetries,
							delayMs: Number((event.target as HTMLInputElement).value),
						}).delayMs;
						void this.saveRetrySettings();
					},
				})}
				<p class="text-xs text-muted-foreground">Fixed wait between rate-limit retries. Server Retry-After hints are ignored.</p>
			</div>
		</div>`;
	}
}

export class SettingsDialog extends DialogBase {
	@property({ attribute: false }) tabs: SettingsTab[] = [];
	@state() private activeTabIndex = 0;
	private onCloseCallback?: () => void;
	protected modalWidth = "min(1000px, 90vw)";
	protected modalHeight = "min(800px, 90vh)";

	static async open(tabs: SettingsTab[], onClose?: () => void): Promise<void> {
		const dialog = new SettingsDialog();
		dialog.tabs = tabs;
		dialog.onCloseCallback = onClose;
		dialog.open();
	}

	override close() {
		if (!this.isConnected) return;
		super.close();
		const callback = this.onCloseCallback;
		this.onCloseCallback = undefined;
		callback?.();
	}

	protected renderContent() {
		return DialogContent({
			className: "h-full p-6",
			children: html`
			<div class="flex flex-col h-full overflow-hidden">
				<div class="pb-4 flex-shrink-0">${DialogHeader({ title: "Settings" })}</div>
				<div class="md:hidden flex flex-shrink-0 pb-4">
					${this.tabs.map(
						(tab, index) =>
							html`<button class="px-3 py-2 text-sm font-medium transition-colors ${index === this.activeTabIndex ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}" @click=${() => {
								this.activeTabIndex = index;
							}}>${tab.getTabName()}</button>`,
					)}
				</div>
				<div class="flex flex-1 overflow-hidden">
					<div class="hidden md:block w-64 flex-shrink-0 space-y-1">
						${this.tabs.map(
							(tab, index) =>
								html`<button class="w-full text-left px-4 py-3 rounded-md transition-colors ${index === this.activeTabIndex ? "bg-secondary text-foreground font-medium" : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"}" @click=${() => {
									this.activeTabIndex = index;
								}}>${tab.getTabName()}</button>`,
						)}
					</div>
					<div class="flex-1 overflow-y-auto md:pl-6">
						${this.tabs.map((tab, index) => html`<div style=${`display: ${index === this.activeTabIndex ? "block" : "none"}`}>${tab}</div>`)}
					</div>
				</div>
			</div>`,
		});
	}
}

customElements.define("sitegeist-proxy-tab", ProxyTab);
customElements.define("sitegeist-tabs-tab", TabsTab);
customElements.define("sitegeist-retry-tab", RetryTab);
customElements.define("sitegeist-api-keys-tab", ApiKeysTab);
customElements.define("sitegeist-settings-dialog", SettingsDialog);
