import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import { getProviders } from "../pi/models.js";
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
customElements.define("sitegeist-api-keys-tab", ApiKeysTab);
customElements.define("sitegeist-settings-dialog", SettingsDialog);
