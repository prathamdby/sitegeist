import { i18n, icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import "@mariozechner/mini-lit/dist/ModeToggle.js";
import { renderAsync } from "docx-preview";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Download, X } from "lucide";
import * as XLSX from "xlsx";
import { loadPdfDocument } from "./processing.js";
import type { Attachment } from "./types.js";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages {
		Remove: string;
		PDF: string;
		Document: string;
		Spreadsheet: string;
		Text: string;
		"Error loading file": string;
		"No text content available": string;
		"No content available": string;
	}
}

@customElement("attachment-overlay")
export class AttachmentOverlay extends LitElement {
	@state() private attachment?: Attachment;
	@state() private showExtractedText = false;
	@state() private error = "";
	private generation = 0;
	private pdf?: Awaited<ReturnType<typeof loadPdfDocument>>;
	private pdfAbort?: AbortController;
	private onCloseCallback?: () => void;
	private readonly handleKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") this.close();
	};

	protected override createRenderRoot() {
		return this;
	}

	static open(attachment: Attachment, onClose?: () => void): void {
		const overlay = new AttachmentOverlay();
		overlay.attachment = attachment;
		overlay.onCloseCallback = onClose;
		document.body.append(overlay);
	}

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("keydown", this.handleKeyDown);
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener("keydown", this.handleKeyDown);
		this.cleanup();
	}

	private close(): void {
		if (!this.isConnected) return;
		this.remove();
		this.onCloseCallback?.();
	}

	private cleanup(): void {
		this.generation++;
		this.pdfAbort?.abort();
		this.pdfAbort = undefined;
		const pdf = this.pdf;
		this.pdf = undefined;
		if (pdf) void pdf.destroy().catch(() => {});
	}

	private getFileType(): "image" | "pdf" | "docx" | "excel" | "pptx" | "text" {
		const attachment = this.attachment;
		if (attachment?.type === "image") return "image";
		const mime = attachment?.mimeType;
		if (mime === "application/pdf") return "pdf";
		if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "docx";
		if (
			mime === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
			mime === "application/vnd.ms-excel"
		)
			return "excel";
		if (mime === "application/vnd.openxmlformats-officedocument.presentationml.presentation") return "pptx";
		return "text";
	}

	private download(): void {
		const attachment = this.attachment;
		if (!attachment) return;
		const url = URL.createObjectURL(new Blob([this.bytes()], { type: attachment.mimeType }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = attachment.fileName;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	private bytes(): Uint8Array<ArrayBuffer> {
		return Uint8Array.from(atob(this.attachment?.content ?? ""), (character) => character.charCodeAt(0));
	}

	override render() {
		const attachment = this.attachment;
		if (!attachment) return html``;
		const type = this.getFileType();
		const label = i18n(type === "pdf" ? "PDF" : type === "docx" ? "Document" : "Spreadsheet");
		return html`
			<div class="fixed inset-0 bg-black/90 z-50 flex flex-col">
				<div class="bg-background/95 backdrop-blur border-b border-border">
					<div class="px-4 py-2 flex items-center justify-between">
						<div class="flex items-center gap-3 min-w-0"><span class="text-sm font-medium text-foreground truncate">${attachment.fileName}</span></div>
						<div class="flex items-center gap-2">
							${
								["pdf", "docx", "excel"].includes(type) && attachment.extractedText
									? html`<mode-toggle .modes=${[label, i18n("Text")]} .selectedIndex=${this.showExtractedText ? 1 : 0} @mode-change=${(
											event: CustomEvent<{ index: number }>,
										) => {
											this.showExtractedText = event.detail.index === 1;
										}}></mode-toggle>`
									: ""
							}
							${Button({ variant: "ghost", size: "icon", className: "h-8 w-8", onClick: () => this.download(), children: icon(Download, "sm") })}
							${Button({ variant: "ghost", size: "icon", className: "h-8 w-8", onClick: () => this.close(), children: icon(X, "sm") })}
						</div>
					</div>
				</div>
				<div class="flex-1 flex items-center justify-center overflow-auto" @click=${(event: MouseEvent) => {
					if (event.target === event.currentTarget) this.close();
				}}>${this.renderContent()}</div>
			</div>
		`;
	}

	private renderContent() {
		if (this.error)
			return html`<div class="bg-destructive/10 border border-destructive text-destructive p-4 rounded-lg max-w-2xl"><div class="font-medium mb-1">${i18n("Error loading file")}</div><div class="text-sm opacity-90">${this.error}</div></div>`;
		const attachment = this.attachment;
		if (!attachment) return html``;
		if (this.showExtractedText)
			return html`<div class="bg-card border border-border text-foreground p-6 w-full h-full max-w-4xl overflow-auto"><pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed">${attachment.extractedText || i18n("No text content available")}</pre></div>`;
		switch (this.getFileType()) {
			case "image":
				return html`<img class="max-w-full max-h-full object-contain rounded-lg shadow-lg" src=${`data:${attachment.mimeType};base64,${attachment.content}`} alt=${attachment.fileName} />`;
			case "pdf":
				return html`<div id="pdf-container" class="bg-card text-foreground overflow-auto shadow-lg border border-border w-full h-full max-w-[1000px]"></div>`;
			case "docx":
				return html`<div id="docx-container" class="bg-card text-foreground overflow-auto shadow-lg border border-border w-full h-full max-w-[1000px]"></div>`;
			case "excel":
				return html`<div id="excel-container" class="bg-card text-foreground overflow-auto w-full h-full"></div>`;
			case "pptx":
				return html`<div id="pptx-container" class="bg-card text-foreground overflow-auto shadow-lg border border-border w-full h-full max-w-[1000px]"><div class="p-6 overflow-auto"><pre class="whitespace-pre-wrap text-sm text-foreground font-mono">${attachment.extractedText || i18n("No text content available")}</pre></div></div>`;
			default:
				return html`<div class="bg-card border border-border text-foreground p-6 w-full h-full max-w-4xl overflow-auto"><pre class="whitespace-pre-wrap font-mono text-sm">${attachment.extractedText || i18n("No content available")}</pre></div>`;
		}
	}

	protected override updated(changed: Map<string, unknown>): void {
		if (!changed.has("attachment") && !changed.has("showExtractedText")) return;
		this.cleanup();
		if (this.showExtractedText || !this.attachment) return;
		const generation = this.generation;
		const current = () => this.isConnected && this.generation === generation;
		void this.renderDocument(current).catch((error: unknown) => {
			if (current()) this.error = error instanceof Error ? error.message : String(error);
		});
	}

	private async renderDocument(current: () => boolean): Promise<void> {
		const type = this.getFileType();
		if (type === "pdf") {
			const container = this.querySelector("#pdf-container");
			if (!container) return;
			this.pdfAbort = new AbortController();
			const pdf = await loadPdfDocument(this.bytes(), this.pdfAbort.signal);
			if (!current()) {
				await pdf.destroy();
				return;
			}
			this.pdf = pdf;
			const pages = document.createElement("div");
			for (let pageNumber = 1; pageNumber <= pdf.document.numPages; pageNumber++) {
				const page = await pdf.document.getPage(pageNumber);
				if (!current()) return;
				const viewport = page.getViewport({ scale: 1.5 });
				const canvas = document.createElement("canvas");
				canvas.width = viewport.width;
				canvas.height = viewport.height;
				canvas.className = "w-full max-w-full h-auto block mx-auto bg-white rounded shadow-sm border border-border";
				await page.render({ canvas, viewport }).promise;
				if (!current()) return;
				const wrapper = document.createElement("div");
				wrapper.className = "mb-4 last:mb-0";
				wrapper.append(canvas);
				if (pageNumber < pdf.document.numPages) {
					const divider = document.createElement("div");
					divider.className = "h-px bg-border my-4";
					wrapper.append(divider);
				}
				pages.append(wrapper);
				container.replaceChildren(pages);
			}
			return;
		}
		if (type === "docx") {
			const container = this.querySelector("#docx-container");
			if (!container) return;
			const wrapper = document.createElement("div");
			wrapper.className = "docx-wrapper-custom";
			await renderAsync(this.bytes(), wrapper, undefined, { ignoreWidth: true });
			if (!current()) return;
			const styles = document.createElement("style");
			styles.textContent = `
				#docx-container { padding: 0; }
				#docx-container .docx-wrapper-custom { max-width: 100%; overflow-x: auto; }
				#docx-container .docx-wrapper { max-width: 100% !important; margin: 0 !important; background: transparent !important; padding: 0 !important; }
				#docx-container .docx-wrapper > section.docx { box-shadow: none !important; border: none !important; border-radius: 0 !important; margin: 0 !important; padding: 2em !important; background: white !important; color: black !important; max-width: 100% !important; width: 100% !important; min-width: 0 !important; overflow-x: auto !important; }
				#docx-container table { max-width: 100% !important; width: auto !important; overflow-x: auto !important; display: block !important; }
				#docx-container img { max-width: 100% !important; height: auto !important; }
				#docx-container p, #docx-container span, #docx-container div { max-width: 100% !important; word-wrap: break-word !important; overflow-wrap: break-word !important; }
				#docx-container .docx-page-break { display: none !important; }
			`;
			container.replaceChildren(wrapper, styles);
			return;
		}
		if (type !== "excel") return;
		const container = this.querySelector("#excel-container");
		if (!container) return;
		const workbook = XLSX.read(this.bytes(), { type: "array" });
		const wrapper = document.createElement("div");
		wrapper.className = "overflow-auto h-full flex flex-col";
		const tabs = document.createElement("div");
		tabs.className = "flex gap-2 mb-4 border-b border-border sticky top-0 bg-card z-10";
		wrapper.append(tabs);
		const panels: HTMLElement[] = [];
		const buttons: HTMLButtonElement[] = [];
		for (const [index, name] of workbook.SheetNames.entries()) {
			const panel = document.createElement("div");
			panel.className = "flex-1 overflow-auto";
			panel.style.display = index ? "none" : "flex";
			const content = document.createElement("div");
			content.innerHTML = XLSX.utils.sheet_to_html(workbook.Sheets[name], { id: `sheet-${index}` });
			const table = content.querySelector("table");
			if (table) {
				table.className = "w-full border-collapse text-foreground";
				for (const [rowIndex, row] of Array.from(table.rows).entries()) {
					if (rowIndex % 2) row.className = "bg-muted/30";
					for (const cell of Array.from(row.cells))
						cell.className =
							rowIndex === 0
								? "border border-border px-3 py-2 text-sm font-semibold bg-muted text-foreground sticky top-0"
								: "border border-border px-3 py-2 text-sm text-left";
				}
				content.replaceChildren(table);
			}
			panel.append(content);
			panels.push(panel);
			wrapper.append(panel);
			const button = document.createElement("button");
			button.textContent = name;
			const select = (selected: number) => {
				for (const [buttonIndex, tab] of buttons.entries()) {
					tab.className =
						buttonIndex === selected
							? "px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary"
							: "px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-b-2 hover:border-border transition-colors";
					panels[buttonIndex].style.display = buttonIndex === selected ? "flex" : "none";
				}
			};
			button.addEventListener("click", () => select(index));
			buttons.push(button);
			tabs.append(button);
			select(0);
		}
		container.replaceChildren(wrapper);
	}
}
