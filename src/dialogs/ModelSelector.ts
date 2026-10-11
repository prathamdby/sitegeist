import { icon } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { html } from "lit";
import { state } from "lit/decorators.js";
import { Brain, Image } from "lucide";
import { filterModels } from "../pi/model-search.js";
import { getModels, getProviders, type Model, ModelConfiguration } from "../pi/models.js";
import { getAppStorage } from "../storage/app-storage.js";

export class ModelSelector extends DialogBase {
	currentModel: Model | null = null;
	@state() searchQuery = "";
	@state() filterThinking = false;
	@state() filterVision = false;
	@state() customProvidersLoading = false;
	@state() selectedIndex = 0;
	@state() private models: Model[] = [];
	private onSelectCallback?: (model: Model) => void;
	private allowedProviders?: readonly string[];
	private navigationMode: "keyboard" | "mouse" = "keyboard";
	private lastMousePosition?: { x: number; y: number };
	protected modalWidth = "min(400px, 90vw)";

	override connectedCallback() {
		super.connectedCallback();
		this.addEventListener("keydown", this.handleKeyDown);
	}

	override disconnectedCallback() {
		this.removeEventListener("keydown", this.handleKeyDown);
		super.disconnectedCallback();
	}

	static async open(
		currentModel: Model | null,
		onSelect: (model: Model) => void,
		allowedProviders?: string[],
	): Promise<void> {
		const dialog = new ModelSelector();
		dialog.currentModel = currentModel;
		dialog.onSelectCallback = onSelect;
		dialog.allowedProviders = allowedProviders;
		dialog.models = getProviders()
			.filter((provider) => !allowedProviders || allowedProviders.includes(provider))
			.flatMap(getModels);
		dialog.open();
	}

	protected async firstUpdated() {
		this.querySelector<HTMLInputElement>("input")?.focus();
		this.customProvidersLoading = true;
		try {
			const configuration = new ModelConfiguration(() => getAppStorage().customProviders.getAll());
			this.models = await configuration.getModels(this.allowedProviders);
		} finally {
			this.customProvidersLoading = false;
		}
	}

	private getFilteredModels() {
		return filterModels(this.models, this.currentModel, this.searchQuery, this.filterThinking, this.filterVision);
	}

	private handleSelect(model: Model) {
		this.onSelectCallback?.(model);
		this.close();
	}

	private handleKeyDown(event: KeyboardEvent) {
		const models = this.getFilteredModels();
		if (event.key === "Enter" && models[this.selectedIndex]) {
			event.preventDefault();
			this.handleSelect(models[this.selectedIndex]);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		this.navigationMode = "keyboard";
		this.selectedIndex = Math.max(
			0,
			Math.min(models.length - 1, this.selectedIndex + (event.key === "ArrowDown" ? 1 : -1)),
		);
		void this.updateComplete.then(() =>
			this.querySelectorAll<HTMLElement>("[data-model-item]")[this.selectedIndex]?.scrollIntoView({
				block: "nearest",
			}),
		);
	}

	protected renderContent() {
		const models = this.getFilteredModels();
		const tokens = (count: number) =>
			count >= 1_000_000 ? `${Math.round(count / 1_000_000)}M` : `${Math.round(count / 1000)}`;
		return html`
			<div class="p-6 pb-4 flex flex-col gap-4 border-b border-border flex-shrink-0">
				${DialogHeader({ title: "Select Model" })}
				${Input({
					placeholder: "Search models...",
					value: this.searchQuery,
					onInput: (event) => {
						this.searchQuery = (event.target as HTMLInputElement).value;
						this.selectedIndex = 0;
					},
				})}
				<div class="flex gap-2">
					${Button({
						size: "sm",
						variant: this.filterThinking ? "default" : "secondary",
						className: "rounded-full",
						onClick: () => {
							this.filterThinking = !this.filterThinking;
							this.selectedIndex = 0;
						},
						children: html`<span class="inline-flex items-center gap-1">${icon(Brain, "sm")} Thinking</span>`,
					})}
					${Button({
						size: "sm",
						variant: this.filterVision ? "default" : "secondary",
						className: "rounded-full",
						onClick: () => {
							this.filterVision = !this.filterVision;
							this.selectedIndex = 0;
						},
						children: html`<span class="inline-flex items-center gap-1">${icon(Image, "sm")} Vision</span>`,
					})}
				</div>
			</div>
			<div class="flex-1 overflow-y-auto">
				${models.map(
					(model, index) => html`
					<div data-model-item class="px-4 py-3 hover:bg-muted cursor-pointer border-b border-border ${index === this.selectedIndex ? "bg-accent" : ""}" @click=${() => this.handleSelect(model)} @mousemove=${(
						event: MouseEvent,
					) => {
						if (this.lastMousePosition?.x === event.clientX && this.lastMousePosition?.y === event.clientY)
							return;
						this.lastMousePosition = { x: event.clientX, y: event.clientY };
						this.navigationMode = "mouse";
						this.selectedIndex = index;
					}} @mouseleave=${() => {
						if (this.navigationMode === "mouse") this.selectedIndex = -1;
					}}>
						<div class="flex items-center justify-between gap-2 mb-1">
							<div class="flex items-center gap-2 flex-1 min-w-0"><span class="text-sm font-medium text-foreground truncate">${model.id}</span>${model.id === this.currentModel?.id && model.provider === this.currentModel?.provider ? html`<span class="text-green-500">✓</span>` : ""}</div>
							${Badge(model.provider, "outline")}
						</div>
						<div class="flex items-center justify-between text-xs text-muted-foreground">
							<div class="flex items-center gap-2">${model.reasoning ? icon(Brain, "sm") : ""}${model.input.includes("image") ? icon(Image, "sm") : ""}<span>${tokens(model.contextWindow)}K/${tokens(model.maxTokens)}K</span></div><span>${`$${model.cost.input}/$${model.cost.output}`}</span>
						</div>
					</div>`,
				)}
				${models.length === 0 ? html`<div class="p-6 text-sm text-muted-foreground text-center">No models found</div>` : ""}
				${this.customProvidersLoading ? html`<div class="p-4 text-sm text-muted-foreground text-center">Loading custom providers...</div>` : ""}
			</div>`;
	}
}

customElements.define("sitegeist-model-selector", ModelSelector);
