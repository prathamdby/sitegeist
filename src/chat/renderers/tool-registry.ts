import type { JsonObject, JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import { type IconNode, i18n, icon } from "@mariozechner/mini-lit";
import { html, type TemplateResult } from "lit";
import { type Ref, ref } from "lit/directives/ref.js";
import { Calculator, ChevronsUpDown, ChevronUp, Clock, Code, Loader, Terminal } from "lucide";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "./ConsoleBlock.js";

export interface ToolRenderResult {
	content: TemplateResult;
	isCustom: boolean;
}

export interface ToolRenderer<TParams = JsonObject, TDetails = JsonValue> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult;
}

export const toolRenderers = new Map<string, ToolRenderer>();
let showJsonMode = false;

export function setShowJsonMode(show: boolean): void {
	showJsonMode = show;
	if (typeof document !== "undefined") document.dispatchEvent(new Event("sitegeist-json-mode-change"));
}

export function getShowJsonMode(): boolean {
	return showJsonMode;
}

export function registerToolRenderer<TParams, TDetails>(name: string, renderer: ToolRenderer<TParams, TDetails>): void {
	toolRenderers.set(name, renderer as unknown as ToolRenderer);
}

export function getToolRenderer(name: string): ToolRenderer | undefined {
	return toolRenderers.get(name);
}

export function renderHeader(
	state: "inprogress" | "complete" | "error",
	toolIcon: IconNode,
	text: string | TemplateResult,
): TemplateResult {
	const color =
		state === "error"
			? "text-destructive"
			: state === "complete"
				? "text-green-600 dark:text-green-500"
				: "text-foreground";
	return state === "inprogress"
		? html`<div class="flex items-center justify-between gap-2 text-sm text-muted-foreground"><div class="flex items-center gap-2"><span class="inline-block text-foreground">${icon(toolIcon, "sm")}</span>${text}</div><span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span></div>`
		: html`<div class="flex items-center gap-2 text-sm text-muted-foreground"><span class="inline-block ${color}">${icon(toolIcon, "sm")}</span>${text}</div>`;
}

export function renderCollapsibleHeader(
	state: "inprogress" | "complete" | "error",
	toolIcon: IconNode,
	text: string | TemplateResult,
	contentRef: Ref<HTMLElement>,
	chevronRef: Ref<HTMLElement>,
	defaultExpanded = false,
): TemplateResult {
	return html`<button class="flex items-center justify-between gap-2 text-sm text-muted-foreground w-full text-left hover:text-foreground transition-colors cursor-pointer" aria-expanded=${defaultExpanded} @click=${(
		event: Event,
	) => {
		const content = contentRef.value;
		if (!content) return;
		const expanded =
			content.classList.contains("hidden") ||
			content.classList.contains("max-h-0") ||
			content.style.display === "none";
		content.classList.toggle("max-h-0", !expanded);
		content.classList.toggle("max-h-[2000px]", expanded);
		content.classList.toggle("mt-3", expanded);
		chevronRef.value?.querySelector(".chevron-up")?.classList.toggle("hidden", !expanded);
		chevronRef.value?.querySelector(".chevrons-up-down")?.classList.toggle("hidden", expanded);
		(event.currentTarget as HTMLElement).setAttribute("aria-expanded", String(expanded));
	}}><div class="flex items-center gap-2">${state === "inprogress" ? html`<span class="inline-block text-foreground animate-spin">${icon(Loader, "sm")}</span>` : html`<span class="inline-block ${state === "error" ? "text-destructive" : "text-green-600 dark:text-green-500"}">${icon(toolIcon, "sm")}</span>`}${text}</div><span ${ref(chevronRef)} class="inline-block text-muted-foreground"><span class="chevron-up ${defaultExpanded ? "" : "hidden"}">${icon(ChevronUp, "sm")}</span><span class="chevrons-up-down ${defaultExpanded ? "hidden" : ""}">${icon(ChevronsUpDown, "sm")}</span></span></button>`;
}

export function toolResultText(result?: ToolResultMessage): string {
	return (
		result?.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("\n") ?? ""
	);
}

export function renderTool(
	name: string,
	params: JsonObject | undefined,
	result: ToolResultMessage | undefined,
	isStreaming = false,
): ToolRenderResult {
	return (showJsonMode ? defaultRenderer : (getToolRenderer(name) ?? defaultRenderer)).render(
		params,
		result,
		isStreaming,
	);
}

export class DefaultRenderer implements ToolRenderer {
	render(
		params: JsonObject | undefined,
		result: ToolResultMessage | undefined,
		isStreaming = false,
	): ToolRenderResult {
		const state = result?.isError ? "error" : isStreaming && !result ? "inprogress" : "complete";
		return {
			isCustom: false,
			content: html`<div class="space-y-3">${renderHeader(state, Code, "Tool Call")}${params ? html`<div><div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Input")}</div><code-block language="json" .code=${JSON.stringify(params, null, 2)}></code-block></div>` : ""}${result ? html`<div><div class="text-xs font-medium mb-1 text-muted-foreground">${i18n("Output")}</div><code-block language="text" .code=${toolResultText(result) || i18n("(no output)")}></code-block></div>` : ""}</div>`,
		};
	}
}

export class BashRenderer implements ToolRenderer<{ command: string }> {
	render(params: { command: string } | undefined, result: ToolResultMessage | undefined): ToolRenderResult {
		if (!params?.command)
			return { isCustom: false, content: renderHeader("inprogress", Terminal, i18n("Waiting for command...")) };
		return {
			isCustom: true,
			content: html`<div class="space-y-3">${renderHeader(result?.isError ? "error" : result ? "complete" : "inprogress", Terminal, i18n("Running command..."))}<sitegeist-console-block .content=${`> ${params.command}${result ? `\n\n${toolResultText(result)}` : ""}`} .variant=${result?.isError ? "error" : "default"}></sitegeist-console-block></div>`,
		};
	}
}

export class CalculateRenderer implements ToolRenderer<{ expression: string }> {
	render(params: { expression: string } | undefined, result: ToolResultMessage | undefined): ToolRenderResult {
		if (!params)
			return { isCustom: false, content: renderHeader("inprogress", Calculator, i18n("Waiting for expression...")) };
		if (!params.expression)
			return { isCustom: false, content: renderHeader("inprogress", Calculator, i18n("Writing expression...")) };
		return {
			isCustom: true,
			content: renderHeader(
				result?.isError ? "error" : result ? "complete" : "inprogress",
				Calculator,
				result ? `${params.expression} = ${toolResultText(result)}` : `${i18n("Calculating")} ${params.expression}`,
			),
		};
	}
}

export class GetCurrentTimeRenderer implements ToolRenderer<{ timezone?: string }> {
	render(params: { timezone?: string } | undefined, result: ToolResultMessage | undefined): ToolRenderResult {
		if (!params) return { isCustom: false, content: renderHeader("inprogress", Clock, "Getting time...") };
		return {
			isCustom: true,
			content: renderHeader(
				result?.isError ? "error" : result ? "complete" : "inprogress",
				Clock,
				`${params.timezone ? `${i18n("Getting current time in")} ${params.timezone}` : i18n("Getting current date and time")}${result ? `: ${toolResultText(result)}` : ""}`,
			),
		};
	}
}

const defaultRenderer = new DefaultRenderer();
