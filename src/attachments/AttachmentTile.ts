import { i18n, icon } from "@mariozechner/mini-lit";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { FileSpreadsheet, FileText, X } from "lucide";
import { AttachmentOverlay } from "./AttachmentOverlay.js";
import type { Attachment } from "./types.js";

@customElement("attachment-tile")
export class AttachmentTile extends LitElement {
	@property({ attribute: false }) attachment!: Attachment;
	@property({ type: Boolean }) showDelete = false;
	@property({ attribute: false }) onDelete?: () => void;

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.classList.add("max-h-16");
		this.style.display = "block";
	}

	override render() {
		const attachment = this.attachment;
		if (!attachment) return html``;
		return html`
			<div class="relative group inline-block">
				${
					attachment.preview
						? html`
					<div class="relative" @click=${() => AttachmentOverlay.open(attachment)}>
						<img class="w-16 h-16 object-cover rounded-lg border border-input cursor-pointer hover:opacity-80 transition-opacity" src=${`data:${attachment.type === "image" ? attachment.mimeType : "image/png"};base64,${attachment.preview}`} alt=${attachment.fileName} title=${attachment.fileName} />
						${attachment.mimeType === "application/pdf" ? html`<div class="absolute bottom-0 left-0 right-0 bg-background/90 px-1 py-0.5 rounded-b-lg"><div class="text-[10px] text-muted-foreground text-center font-medium">PDF</div></div>` : ""}
					</div>
				`
						: html`
					<div class="w-16 h-16 rounded-lg border border-input cursor-pointer hover:opacity-80 transition-opacity bg-muted text-muted-foreground flex flex-col items-center justify-center p-2" title=${attachment.fileName} @click=${() => AttachmentOverlay.open(attachment)}>
						${icon(attachment.mimeType.includes("spreadsheet") || attachment.mimeType.includes("excel") ? FileSpreadsheet : FileText, "md")}
						<div class="text-[10px] text-center truncate w-full">${attachment.fileName.length > 10 ? `${attachment.fileName.slice(0, 8)}...` : attachment.fileName}</div>
					</div>
				`
				}
				${
					this.showDelete
						? html`
					<button class="absolute -top-1 -right-1 w-5 h-5 bg-background hover:bg-muted text-muted-foreground hover:text-foreground rounded-full flex items-center justify-center opacity-100 hover:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-opacity border border-input shadow-sm" title=${i18n("Remove")} @click=${(
						event: MouseEvent,
					) => {
						event.stopPropagation();
						this.onDelete?.();
					}}>${icon(X, "xs")}</button>
				`
						: ""
				}
			</div>
		`;
	}
}
