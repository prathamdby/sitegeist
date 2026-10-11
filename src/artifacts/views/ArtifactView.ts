import { i18n, icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "@mariozechner/mini-lit/dist/CopyButton.js";
import { DownloadButton } from "@mariozechner/mini-lit/dist/DownloadButton.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/PreviewCodeToggle.js";
import { renderAsync } from "docx-preview";
import hljs from "highlight.js";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { ChevronDown, ChevronRight, ChevronsDown, Download, File, RotateCw } from "lucide";
import * as XLSX from "xlsx";
import { loadPdfDocument } from "../../attachments/processing.js";
import type { SandboxRuntimeProvider } from "../../sandbox/types.js";
import { HtmlArtifactPreview } from "../HtmlArtifactPreview.js";

export type ArtifactKind = "html" | "svg" | "markdown" | "image" | "pdf" | "excel" | "docx" | "text" | "generic";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages {
		"Reload HTML": string;
		"Copy HTML": string;
		"Copy SVG": string;
		"Copy Markdown": string;
		"Download HTML": string;
		"Download SVG": string;
		"Download Markdown": string;
		"Preview not available for this file type.": string;
		"Click the download button above to view it on your computer.": string;
		"Autoscroll enabled": string;
		"Autoscroll disabled": string;
		"Copy logs": string;
	}
}

const languages: Record<string, string> = {
	js: "javascript",
	ts: "typescript",
	jsx: "javascript",
	tsx: "typescript",
	py: "python",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	rb: "ruby",
	go: "go",
	rs: "rust",
	php: "php",
	swift: "swift",
	kt: "kotlin",
	scala: "scala",
	sh: "bash",
	bash: "bash",
	sql: "sql",
	json: "json",
	xml: "xml",
	css: "css",
	yaml: "yaml",
	yml: "yaml",
};

export function artifactKind(filename: string): ArtifactKind {
	const extension = filename.split(".").pop()?.toLowerCase() ?? "";
	if (extension === "html") return "html";
	if (extension === "svg") return "svg";
	if (["md", "markdown"].includes(extension)) return "markdown";
	if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"].includes(extension)) return "image";
	if (extension === "pdf") return "pdf";
	if (["xlsx", "xls"].includes(extension)) return "excel";
	if (extension === "docx") return "docx";
	if (extension === "txt" || extension === "csv" || Object.hasOwn(languages, extension)) return "text";
	return "generic";
}

@customElement("sitegeist-artifact-view")
export class ArtifactView extends LitElement {
	@property() filename = "";
	@property() content = "";
	@property() kind: ArtifactKind = "text";
	runtimeProvidersFactory: () => SandboxRuntimeProvider[] = () => [];
	sandboxUrlProvider?: () => string;
	@state() private viewMode: "preview" | "code" = "preview";
	@state() private error = "";
	@state() private logs: Array<{ type: string; text: string }> = [];
	@state() private consoleExpanded = false;
	@state() private autoscroll = true;
	private readonly preview = new HtmlArtifactPreview();
	private readonly documentRef = createRef<HTMLElement>();
	private readonly consoleRef = createRef<HTMLElement>();
	private generation = 0;
	private pdf?: Awaited<ReturnType<typeof loadPdfDocument>>;
	private pdfAbort?: AbortController;
	ready: Promise<void> = Promise.resolve();

	protected override createRenderRoot() {
		return this;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.cleanupDocument();
	}

	private cleanupDocument(): void {
		this.generation++;
		this.pdfAbort?.abort();
		this.pdfAbort = undefined;
		if (this.pdf) void this.pdf.destroy().catch(() => {});
		this.pdf = undefined;
	}

	private mimeType(): string {
		const extension = this.filename.split(".").pop()?.toLowerCase() ?? "";
		const types: Record<string, string> = {
			html: "text/html",
			svg: "image/svg+xml",
			md: "text/markdown",
			markdown: "text/markdown",
			txt: "text/plain",
			csv: "text/csv",
			json: "application/json",
			js: "text/javascript",
			css: "text/css",
			xml: "application/xml",
			png: "image/png",
			jpg: "image/jpeg",
			jpeg: "image/jpeg",
			gif: "image/gif",
			webp: "image/webp",
			bmp: "image/bmp",
			ico: "image/x-icon",
			pdf: "application/pdf",
			xls: "application/vnd.ms-excel",
			xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		};
		return types[extension] ?? (this.kind === "text" ? "text/plain" : "application/octet-stream");
	}

	private bytes(): Uint8Array<ArrayBuffer> {
		return Uint8Array.from(atob(this.content.replace(/^data:[^,]*,/, "")), (character) => character.charCodeAt(0));
	}

	getHeaderButtons(): TemplateResult {
		const source = ["html", "svg", "markdown"].includes(this.kind);
		const copyTitle =
			this.kind === "html"
				? i18n("Copy HTML")
				: this.kind === "svg"
					? i18n("Copy SVG")
					: this.kind === "markdown"
						? i18n("Copy Markdown")
						: i18n("Copy");
		const downloadTitle =
			this.kind === "html"
				? i18n("Download HTML")
				: this.kind === "svg"
					? i18n("Download SVG")
					: this.kind === "markdown"
						? i18n("Download Markdown")
						: i18n("Download");
		return html`<div class="flex items-center ${source ? "gap-2" : "gap-1"}">
			${
				source
					? html`<preview-code-toggle .mode=${this.viewMode} @mode-change=${(
							event: CustomEvent<"preview" | "code">,
						) => {
							this.viewMode = event.detail;
							this.dispatchEvent(new Event("artifact-view-change", { bubbles: true }));
						}}></preview-code-toggle>`
					: ""
			}
			${
				this.kind === "html"
					? Button({
							variant: "ghost",
							size: "sm",
							title: i18n("Reload HTML"),
							children: icon(RotateCw, "sm"),
							onClick: () => {
								void this.reload();
							},
						})
					: ""
			}
			${source || this.kind === "text" ? html`<copy-button .text=${this.content} .title=${copyTitle}></copy-button>` : ""}
			${
				this.kind === "html"
					? Button({
							variant: "ghost",
							size: "sm",
							title: downloadTitle,
							children: icon(Download, "sm"),
							onClick: () => {
								void this.downloadHtml();
							},
						})
					: DownloadButton({
							content: !source && this.kind !== "text" ? this.content.replace(/^data:[^,]*,/, "") : this.content,
							filename: this.filename,
							mimeType: this.mimeType(),
							title: downloadTitle,
							isBase64: !source && this.kind !== "text",
						})
			}
		</div>`;
	}

	private async downloadHtml(): Promise<void> {
		const content = this.preview.prepareHtmlDocument(
			`artifact-${this.filename}`,
			this.content,
			this.runtimeProvidersFactory(),
			{ isStandalone: true },
		);
		const url = URL.createObjectURL(new Blob([content], { type: "text/html" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = this.filename;
		anchor.click();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	getLogs(): string {
		return this.preview
			.getLogs()
			.map(({ type, text }) => `[${type}] ${text}`)
			.join("\n");
	}

	async reload(): Promise<void> {
		if (this.kind !== "html") return;
		await this.updateComplete;
		this.preview.sandboxUrlProvider = this.sandboxUrlProvider;
		this.preview.loadContent(`artifact-${crypto.randomUUID()}`, this.content, this.runtimeProvidersFactory());
		this.ready = this.preview.ready;
		await this.ready;
		this.logs = this.preview.getLogs();
	}

	protected override updated(changed: Map<string, unknown>): void {
		if (this.autoscroll && this.consoleRef.value)
			this.consoleRef.value.scrollTop = this.consoleRef.value.scrollHeight;
		if (!changed.has("content") && !changed.has("kind")) return;
		this.error = "";
		this.cleanupDocument();
		if (this.kind === "html") {
			this.preview.addEventListener("console-update", this.onConsoleUpdate);
			this.ready = this.reload();
			return;
		}
		const generation = this.generation;
		this.ready = this.renderDocument(() => this.isConnected && this.generation === generation).catch(
			(error: unknown) => {
				if (this.generation === generation) this.error = error instanceof Error ? error.message : String(error);
			},
		);
	}

	private readonly onConsoleUpdate = () => {
		this.logs = this.preview.getLogs();
	};

	private async renderDocument(current: () => boolean): Promise<void> {
		const container = this.documentRef.value;
		if (!container || !["pdf", "excel", "docx"].includes(this.kind)) return;
		if (this.kind === "pdf") {
			this.pdfAbort = new AbortController();
			const pdf = await loadPdfDocument(this.bytes(), this.pdfAbort.signal);
			if (!current()) {
				await pdf.destroy();
				return;
			}
			this.pdf = pdf;
			container.replaceChildren();
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
					const separator = document.createElement("div");
					separator.className = "h-px bg-border my-4";
					wrapper.append(separator);
				}
				container.append(wrapper);
			}
			return;
		}
		if (this.kind === "docx") {
			const wrapper = document.createElement("div");
			await renderAsync(this.bytes(), wrapper, undefined, { inWrapper: true, ignoreWidth: true, breakPages: false });
			if (!current()) return;
			const styles = document.createElement("style");
			styles.textContent = `sitegeist-artifact-view .docx-wrapper { max-width: 100% !important; margin: 0 !important; background: transparent !important; padding: 0 !important; } sitegeist-artifact-view section.docx { box-shadow: none !important; border: none !important; border-radius: 0 !important; margin: 0 !important; width: 100% !important; max-width: 100% !important; min-width: 0 !important; overflow-x: auto !important; padding: 2em !important; } sitegeist-artifact-view .docx-wrapper table { max-width: 100% !important; width: auto !important; overflow-x: auto !important; display: block !important; } sitegeist-artifact-view .docx-wrapper img { max-width: 100% !important; height: auto !important; } sitegeist-artifact-view .docx-wrapper p, sitegeist-artifact-view .docx-wrapper span, sitegeist-artifact-view .docx-wrapper div { max-width: 100% !important; word-wrap: break-word !important; overflow-wrap: break-word !important; } sitegeist-artifact-view .docx-page-break { display: none !important; }`;
			container.replaceChildren(wrapper, styles);
			return;
		}
		const workbook = XLSX.read(this.bytes(), { type: "array" });
		const tabs = document.createElement("div");
		tabs.className = "flex gap-2 mb-4 border-b border-border sticky top-0 bg-card z-10";
		const wrapper = document.createElement("div");
		wrapper.className = "overflow-auto h-full flex flex-col";
		wrapper.append(tabs);
		const sheets: HTMLElement[] = [];
		const buttons: HTMLButtonElement[] = [];
		for (const [index, name] of workbook.SheetNames.entries()) {
			const sheet = document.createElement("div");
			sheet.className = "flex-1 overflow-auto";
			const content = document.createElement("div");
			content.innerHTML = XLSX.utils.sheet_to_html(workbook.Sheets[name], { id: `sheet-${index}` });
			const table = content.querySelector("table");
			if (table) {
				table.className = "w-full border-collapse text-foreground";
				for (const [rowIndex, row] of [...table.rows].entries()) {
					if (rowIndex % 2) row.className = "bg-muted/30";
					for (const cell of [...row.cells])
						cell.className =
							rowIndex === 0
								? "border border-border px-3 py-2 text-sm font-semibold bg-muted text-foreground sticky top-0"
								: "border border-border px-3 py-2 text-sm text-left";
				}
				content.replaceChildren(table);
			}
			sheet.append(content);
			wrapper.append(sheet);
			sheets.push(sheet);
			const button = document.createElement("button");
			button.textContent = name;
			button.addEventListener("click", () => select(index));
			buttons.push(button);
			tabs.append(button);
		}
		const select = (selected: number) => {
			for (const [index, button] of buttons.entries()) {
				button.className =
					index === selected
						? "px-4 py-2 text-sm font-medium border-b-2 border-primary text-primary"
						: "px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:border-b-2 hover:border-border transition-colors";
				sheets[index].style.display = index === selected ? "flex" : "none";
			}
		};
		select(0);
		container.replaceChildren(wrapper);
	}

	private svg(): string {
		const document = new DOMParser().parseFromString(this.content, "image/svg+xml");
		document.documentElement.classList.add("w-full", "h-full");
		return new XMLSerializer().serializeToString(document.documentElement);
	}

	private source(language: string, wrap = false): TemplateResult {
		return html`<pre class="m-0 p-4 text-xs ${wrap ? "whitespace-pre-wrap break-words" : ""}"><code class=${`hljs language-${language}`}>${unsafeHTML(hljs.highlight(this.content, { language }).value)}</code></pre>`;
	}

	private console(): TemplateResult | string {
		if (!this.logs.length) return "";
		const errors = this.logs.filter((log) => log.type === "error").length;
		const summary = errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : String(this.logs.length);
		return html`<div class="border-t border-border p-2"><div class="flex items-center gap-2 w-full"><button class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors flex-1 text-left" @click=${() => {
			this.consoleExpanded = !this.consoleExpanded;
		}}>${icon(this.consoleExpanded ? ChevronDown : ChevronRight, "sm")}<span>${i18n("console")} (${summary})</span></button>${
			this.consoleExpanded
				? html`<button class="p-1 rounded transition-colors ${this.autoscroll ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent"}" title=${i18n(this.autoscroll ? "Autoscroll enabled" : "Autoscroll disabled")} @click=${() => {
						this.autoscroll = !this.autoscroll;
					}}>${icon(ChevronsDown, "sm")}</button><copy-button class="!bg-transparent hover:!bg-accent" .title=${i18n("Copy logs")} .text=${this.getLogs()}></copy-button>`
				: ""
		}</div>${this.consoleExpanded ? html`<div ${ref(this.consoleRef)} class="max-h-48 overflow-y-auto space-y-1 mt-2">${this.logs.map((log) => html`<div class="text-xs font-mono ${log.type === "error" ? "text-destructive" : "text-muted-foreground"}">[${log.type}] ${log.text}</div>`)}</div>` : ""}</div>`;
	}

	override render() {
		if (this.kind === "html")
			return html`<div class="h-full flex flex-col"><div class="flex-1 overflow-hidden relative"><div class="absolute inset-0 flex flex-col" style=${`display: ${this.viewMode === "preview" ? "flex" : "none"};`}>${this.preview}${this.console()}</div><div class="absolute inset-0 overflow-auto bg-background" style=${`display: ${this.viewMode === "code" ? "block" : "none"};`}>${this.source("html")}</div></div></div>`;
		if (this.error) return html`<div class="p-4 text-destructive text-sm">${this.error}</div>`;
		if (["pdf", "excel", "docx"].includes(this.kind))
			return html`<div ${ref(this.documentRef)} class="h-full overflow-auto bg-background ${this.kind === "pdf" ? "p-4" : ""}"></div>`;
		if (this.kind === "image")
			return html`<div class="h-full flex items-center justify-center bg-background overflow-auto"><img class="max-w-full max-h-full object-contain" src=${this.content.startsWith("data:") ? this.content : `data:${this.mimeType()};base64,${this.content}`} alt=${this.filename} /></div>`;
		if (this.kind === "generic")
			return html`<div class="h-full flex items-center justify-center bg-background p-8"><div class="text-center max-w-md"><div class="text-muted-foreground text-lg mb-4">${icon(File, "xl", "h-16 w-16 mx-auto mb-4 text-muted-foreground/50")}<div class="font-medium text-foreground mb-2">${this.filename}</div><p class="text-sm">${i18n("Preview not available for this file type.")} ${i18n("Click the download button above to view it on your computer.")}</p></div></div></div>`;
		let content: TemplateResult;
		if (this.viewMode === "code" && ["markdown", "svg"].includes(this.kind))
			content = this.source(this.kind === "markdown" ? "markdown" : "xml", this.kind === "markdown");
		else if (this.kind === "markdown")
			content = html`<div class="p-4"><markdown-block .content=${this.content}></markdown-block></div>`;
		else if (this.kind === "svg")
			content = html`<div class="h-full flex items-center justify-center">${unsafeHTML(this.svg())}</div>`;
		else {
			const language = languages[this.filename.split(".").pop()?.toLowerCase() ?? ""];
			content =
				language && hljs.getLanguage(language)
					? html`<pre class="m-0 p-4 text-xs"><code class=${`hljs language-${language}`}>${unsafeHTML(hljs.highlight(this.content, { language }).value)}</code></pre>`
					: html`<pre class="m-0 p-4 text-xs font-mono">${this.content}</pre>`;
		}
		return html`<div class="h-full flex flex-col"><div class="flex-1 overflow-auto">${content}</div></div>`;
	}
}
