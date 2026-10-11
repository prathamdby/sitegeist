import { i18n, icon } from "@mariozechner/mini-lit";
import { Diff } from "@mariozechner/mini-lit/dist/Diff.js";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode } from "lucide";
import {
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
	toolResultText,
} from "../chat/renderers/tool-registry.js";
import type { ToolResultMessage } from "../pi/models.js";
import type { ArtifactsPanel, ArtifactsParams } from "./ArtifactsPanel.js";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages {
		"Preparing artifact...": string;
		"Processing artifact": string;
		"Creating artifact": string;
		"Created artifact": string;
		"Updating artifact": string;
		"Updated artifact": string;
		"Rewriting artifact": string;
		"Rewrote artifact": string;
		"Getting artifact": string;
		"Got artifact": string;
		"Deleting artifact": string;
		"Deleted artifact": string;
		"Getting logs": string;
		"Got logs": string;
	}
}

export class ArtifactsToolRenderer implements ToolRenderer<Partial<ArtifactsParams>> {
	constructor(readonly artifactsPanel?: ArtifactsPanel) {}

	render(
		params: Partial<ArtifactsParams> | undefined,
		result: ToolResultMessage | undefined,
		isStreaming = false,
	): ToolRenderResult {
		const error = result?.isError ?? false;
		const state = error ? "error" : !result && isStreaming ? "inprogress" : "complete";
		if (!params?.command)
			return {
				isCustom: false,
				content: error
					? html`<div class="space-y-3">${renderHeader("error", FileCode, i18n("Processing artifact"))}<div class="text-destructive text-sm">${toolResultText(result)}</div></div>`
					: renderHeader("inprogress", FileCode, i18n("Preparing artifact...")),
			};
		const labels: Record<string, [string, string]> = {
			create: [i18n("Creating artifact"), i18n("Created artifact")],
			update: [i18n("Updating artifact"), i18n("Updated artifact")],
			rewrite: [i18n("Rewriting artifact"), i18n("Rewrote artifact")],
			get: [i18n("Getting artifact"), i18n("Got artifact")],
			delete: [i18n("Deleting artifact"), i18n("Deleted artifact")],
			logs: [i18n("Getting logs"), i18n("Got logs")],
		};
		const label = labels[params.command]?.[result && !error ? 1 : 0] ?? i18n("Processing artifact");
		const pill =
			params.filename && !(error && ["get", "delete", "logs"].includes(params.command))
				? this.pill(params.filename)
				: "";
		const title = html`<span>${label} ${pill}</span>`;
		if (params.command === "delete" || (error && ["get", "logs"].includes(params.command)))
			return {
				isCustom: false,
				content: html`<div class="space-y-3">${renderHeader(state, FileCode, title)}${error ? html`<div class="text-destructive text-sm">${toolResultText(result)}</div>` : ""}</div>`,
			};
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();
		const extension = params.filename?.split(".").pop()?.toLowerCase() ?? "";
		const language =
			(
				{
					md: "markdown",
					markdown: "markdown",
					js: "javascript",
					ts: "typescript",
					svg: "xml",
					html: "html",
					css: "css",
					json: "json",
					xml: "xml",
					py: "python",
					sh: "bash",
				} as Record<string, string>
			)[extension] ?? "text";
		let content: TemplateResult | string = "";
		if (params.command === "update") content = Diff({ oldText: params.old_str ?? "", newText: params.new_str ?? "" });
		else if (["create", "rewrite"].includes(params.command) && params.content !== undefined)
			content = html`<code-block .language=${language} .code=${params.content}></code-block>`;
		else if (result && !error)
			content =
				params.command === "logs"
					? html`<sitegeist-console-block .content=${toolResultText(result)}></sitegeist-console-block>`
					: html`<code-block .language=${language} .code=${toolResultText(result)}></code-block>`;
		return {
			isCustom: false,
			content: html`<div>${renderCollapsibleHeader(state, FileCode, title, contentRef, chevronRef)}<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">${content}${error ? html`<div class="text-destructive text-sm">${toolResultText(result)}</div>` : ""}</div></div>`,
		};
	}

	private pill(filename: string): TemplateResult {
		return html`<span class="inline-flex items-center gap-1 px-2 py-0.5 text-xs bg-muted/50 border border-border rounded ${this.artifactsPanel ? "cursor-pointer hover:bg-muted" : ""}" @click=${(
			event: Event,
		) => {
			if (this.artifactsPanel) {
				event.stopPropagation();
				this.artifactsPanel.openArtifact(filename);
			}
		}}>${icon(FileCode, "sm")}<span class="text-foreground">${filename}</span></span>`;
	}
}
