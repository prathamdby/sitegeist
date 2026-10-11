import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { i18n, icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import "@mariozechner/pi-web-ui/dist/components/AttachmentTile.js";
import { type Attachment, loadAttachment } from "@mariozechner/pi-web-ui/dist/utils/attachment-utils.js";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Loader2, Paperclip, Send, Sparkles, Square } from "lucide";

@customElement("sitegeist-message-editor")
export class MessageEditor extends LitElement {
	@property() value = "";
	@property({ type: Boolean }) isStreaming = false;
	@property({ attribute: false }) currentModel?: Model<Api>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property({ type: Boolean }) showAttachmentButton = true;
	@property({ type: Boolean }) showModelSelector = true;
	@property({ type: Boolean }) showThinkingSelector = true;
	@property({ attribute: false }) attachments: Attachment[] = [];
	@property({ type: Boolean }) processingFiles = false;
	@property({ type: Boolean }) isDragging = false;
	maxFiles = 10;
	maxFileSize = 20 * 1024 * 1024;
	acceptedTypes =
		"image/*,application/pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";
	onInput?: (value: string) => void;
	onSend?: (input: string, attachments: Attachment[]) => void;
	onAbort?: () => void;
	onModelSelect?: () => void;
	onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	onFilesChange?: (files: Attachment[]) => void;
	private textarea = createRef<HTMLTextAreaElement>();
	private picker = createRef<HTMLInputElement>();

	protected override createRenderRoot() {
		return this;
	}

	protected override firstUpdated(): void {
		this.textarea.value?.focus();
	}

	protected override updated(): void {
		const textarea = this.textarea.value;
		if (!textarea) return;
		textarea.style.height = "auto";
	}

	private send(): void {
		if (this.isStreaming || this.processingFiles || (!this.value.trim() && !this.attachments.length)) return;
		this.onSend?.(this.value, [...this.attachments]);
	}

	private async addFiles(files: File[]): Promise<void> {
		if (this.processingFiles) return;
		if (this.attachments.length + files.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			return;
		}
		this.processingFiles = true;
		try {
			for (const file of files) {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${this.maxFileSize / 1024 / 1024}MB`);
					continue;
				}
				try {
					this.attachments = [...this.attachments, await loadAttachment(file)];
				} catch (error) {
					alert(`Failed to process ${file.name}: ${String(error)}`);
				}
			}
			this.onFilesChange?.(this.attachments);
		} finally {
			this.processingFiles = false;
			if (this.picker.value) this.picker.value.value = "";
		}
	}

	override render() {
		return html`
			<div class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}" @dragover=${(
				event: DragEvent,
			) => {
				if (!this.showAttachmentButton) return;
				event.preventDefault();
				this.isDragging = true;
			}} @dragleave=${() => {
				this.isDragging = false;
			}} @drop=${(event: DragEvent) => {
				if (!this.showAttachmentButton) return;
				event.preventDefault();
				this.isDragging = false;
				this.addFiles(Array.from(event.dataTransfer?.files ?? [])).catch(() => {});
			}}>
				${this.isDragging ? html`<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center"><div class="text-primary font-medium">${i18n("Drop files here")}</div></div>` : ""}
				${
					this.attachments.length
						? html`<div class="px-4 pt-3 pb-2 flex flex-wrap gap-2">${this.attachments.map(
								(attachment) =>
									html`<attachment-tile .attachment=${attachment} .showDelete=${true} .onDelete=${() => {
										this.attachments = this.attachments.filter((file) => file !== attachment);
										this.onFilesChange?.(this.attachments);
									}}></attachment-tile>`,
							)}</div>`
						: ""
				}
				<textarea ${ref(this.textarea)} class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto" rows="1" style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;" placeholder=${i18n("Type a message...")} .value=${this.value} @input=${(
					event: Event,
				) => {
					this.value = (event.target as HTMLTextAreaElement).value;
					this.onInput?.(this.value);
				}} @keydown=${(event: KeyboardEvent) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault();
						this.send();
					} else if (event.key === "Escape" && this.isStreaming) {
						event.preventDefault();
						this.onAbort?.();
					}
				}} @paste=${(event: ClipboardEvent) => {
					if (!this.showAttachmentButton) return;
					const files = Array.from(event.clipboardData?.items ?? [])
						.filter((item) => item.type.startsWith("image/"))
						.map((item) => item.getAsFile())
						.filter((file): file is File => file !== null);
					if (files.length) {
						event.preventDefault();
						this.addFiles(files).catch(() => {});
					}
				}}></textarea>
				<input ${ref(this.picker)} type="file" multiple style="display: none;" accept=${this.acceptedTypes} @change=${(
					event: Event,
				) => {
					this.addFiles(Array.from((event.target as HTMLInputElement).files ?? [])).catch(() => {});
				}} />
				<div class="px-2 pb-2 flex items-center justify-between">
					<div class="flex gap-2 items-center">
						${this.showAttachmentButton ? (this.processingFiles ? html`<div class="h-8 w-8 flex items-center justify-center">${icon(Loader2, "sm", "animate-spin text-muted-foreground")}</div>` : Button({ variant: "ghost", size: "icon", className: "h-8 w-8", onClick: () => this.picker.value?.click(), children: icon(Paperclip, "sm") })) : ""}
						${this.showThinkingSelector && this.currentModel?.reasoning ? Select({ value: this.thinkingLevel, options: (["Off", "Minimal", "Low", "Medium", "High"] as const).map((label) => ({ value: label.toLowerCase(), label: i18n(label), icon: icon(Brain, "sm") })), onChange: (value) => this.onThinkingChange?.(value as "off" | "minimal" | "low" | "medium" | "high"), variant: "ghost", size: "sm", width: "auto" }) : ""}
					</div>
					<div class="flex gap-2 items-center">
						${this.showModelSelector ? Button({ variant: "ghost", size: "sm", className: "h-8 text-xs truncate", onClick: () => this.onModelSelect?.(), children: html`${icon(Sparkles, "sm")}<span class="ml-1">${this.currentModel?.id ?? i18n("Select Model")}</span>` }) : ""}
						${Button({ variant: "ghost", size: "icon", className: "h-8 w-8", disabled: !this.isStreaming && (this.processingFiles || (!this.value.trim() && !this.attachments.length)), onClick: () => (this.isStreaming ? this.onAbort?.() : this.send()), children: this.isStreaming ? icon(Square, "sm") : html`<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>` })}
					</div>
				</div>
			</div>
		`;
	}
}
