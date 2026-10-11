import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronRight } from "lucide";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import { LightElement } from "./base.js";

@customElement("sitegeist-thinking-block")
export class ThinkingBlock extends LightElement {
	@property() content = "";
	@property({ type: Boolean }) isStreaming = false;
	@state() private isExpanded = false;

	override render() {
		return html`<div class="thinking-block"><div class="thinking-header cursor-pointer select-none flex items-center gap-2 py-1 text-sm text-muted-foreground hover:text-foreground transition-colors" @click=${this.toggle}><span class="transition-transform inline-block ${this.isExpanded ? "rotate-90" : ""}">${icon(ChevronRight, "sm")}</span><span class=${this.isStreaming ? "animate-shimmer bg-gradient-to-r from-muted-foreground via-foreground to-muted-foreground bg-[length:200%_100%] bg-clip-text text-transparent" : ""}>Thinking...</span></div>${this.isExpanded ? html`<markdown-block .content=${this.content} .isThinking=${true}></markdown-block>` : ""}</div>`;
	}

	private toggle = () => {
		this.isExpanded = !this.isExpanded;
	};
}
