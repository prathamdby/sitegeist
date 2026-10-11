import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { html, LitElement } from "lit";
import { Check } from "lucide";
import { isOAuthCredentials } from "../oauth/types.js";
import { complete, getModel } from "../pi/models.js";
import { getAppStorage } from "../storage/app-storage.js";

const VALIDATION_MODELS: Readonly<Record<string, string>> = {
	anthropic: "claude-haiku-4-5",
	cerebras: "gpt-oss-120b",
	openai: "gpt-4o-mini",
	google: "gemini-2.5-flash",
	groq: "openai/gpt-oss-20b",
	openrouter: "z-ai/glm-4.6",
	"vercel-ai-gateway": "anthropic/claude-opus-4.5",
	opencode: "claude-haiku-4-5",
};

export async function validateProviderKey(provider: string, apiKey: string): Promise<boolean> {
	if (isOAuthCredentials(apiKey.trim())) return false;
	const model = VALIDATION_MODELS[provider] ? getModel(provider, VALIDATION_MODELS[provider]) : undefined;
	if (!model) return true;
	const storage = getAppStorage();
	const enabled = await storage.settings.get<boolean>("proxy.enabled");
	const proxyUrl = enabled ? await storage.settings.get<string>("proxy.url") : undefined;
	const needsProxy =
		provider === "zai" ||
		provider === "openai-codex" ||
		(provider === "anthropic" && apiKey.startsWith("sk-ant-oat"));
	const requestModel =
		proxyUrl && needsProxy ? { ...model, baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}` } : model;
	const result = await complete(
		requestModel,
		{ messages: [{ role: "user", content: "Reply with: ok", timestamp: Date.now() }] },
		{ apiKey, maxTokens: 200 },
	);
	return result.stopReason !== "error" && result.stopReason !== "aborted";
}

export class ProviderKeyInput extends LitElement {
	static properties = { provider: { type: String } };
	provider = "";
	private key = "";
	private saved = false;
	private status: "idle" | "testing" | "invalid" = "idle";
	private invalidTimer?: ReturnType<typeof setTimeout>;
	private revision = 0;

	protected createRenderRoot() {
		return this;
	}

	protected async updated(changed: Map<string, unknown>) {
		if (!changed.has("provider")) return;
		const revision = ++this.revision;
		const stored = await getAppStorage().providerKeys.get(this.provider);
		if (revision !== this.revision) return;
		this.key = stored && !isOAuthCredentials(stored) ? stored : "";
		this.saved = !!this.key;
		this.status = "idle";
		this.requestUpdate();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();
		if (this.invalidTimer) clearTimeout(this.invalidTimer);
		this.revision++;
	}

	async saveKey(): Promise<void> {
		if (this.status === "testing") return;
		const apiKey = this.key.trim();
		if (!apiKey && !this.saved) return;
		const provider = this.provider;
		const revision = ++this.revision;
		if (this.invalidTimer) clearTimeout(this.invalidTimer);
		this.status = "testing";
		this.requestUpdate();
		try {
			if (apiKey) {
				if (!(await validateProviderKey(provider, apiKey))) throw new Error("Invalid API key");
				if (revision !== this.revision) return;
				await getAppStorage().providerKeys.set(provider, apiKey);
			} else {
				await getAppStorage().providerKeys.delete(provider);
			}
			if (revision !== this.revision) return;
			this.key = apiKey;
			this.saved = !!apiKey;
			this.status = "idle";
			this.dispatchEvent(new CustomEvent("provider-key-changed", { bubbles: true, detail: { provider } }));
		} catch {
			if (revision !== this.revision) return;
			this.status = "invalid";
			this.invalidTimer = setTimeout(() => {
				this.status = "idle";
				this.requestUpdate();
			}, 5000);
		}
		this.requestUpdate();
	}

	render() {
		return html`
			<div class="flex flex-col gap-3">
				<div class="flex items-center gap-2">
					<label class="text-sm font-medium text-foreground" for=${`provider-key-${this.provider}`}>${this.provider.charAt(0).toUpperCase() + this.provider.slice(1)}</label>
					${this.saved ? html`<span class="text-green-600 dark:text-green-400" aria-label="Key saved">${icon(Check, "sm")}</span>` : ""}
					${this.status === "testing" ? Badge({ variant: "secondary", children: "Testing" }) : ""}
					${this.status === "invalid" ? Badge({ variant: "destructive", children: "Invalid" }) : ""}
				</div>
				<div class="flex items-center gap-2">
					${Input({
						id: `provider-key-${this.provider}`,
						type: "password",
						value: this.key,
						placeholder: "Enter API key",
						className: "flex-1",
						disabled: this.status === "testing",
						autocomplete: "off",
						onInput: (event) => {
							this.key = (event.target as HTMLInputElement).value;
							this.requestUpdate();
						},
						onKeyDown: (event) => {
							if (event.key === "Enter") void this.saveKey();
						},
					})}
					${Button({ size: "sm", disabled: this.status === "testing" || (!this.key.trim() && !this.saved), onClick: () => this.saveKey(), children: "Save" })}
				</div>
			</div>
		`;
	}
}

if (!customElements.get("sitegeist-provider-key-input")) {
	customElements.define("sitegeist-provider-key-input", ProviderKeyInput);
}
