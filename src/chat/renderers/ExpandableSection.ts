import { icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronDown, ChevronRight } from "lucide";
import { LightElement } from "./base.js";

@customElement("sitegeist-expandable-section")
export class ExpandableSection extends LightElement {
	@property() summary = "";
	@property({ type: Boolean }) defaultExpanded = false;
	@state() private expanded = false;
	private childrenContent: Node[] = [];
	private initialized = false;

	override connectedCallback(): void {
		if (!this.initialized) {
			this.childrenContent = [...this.childNodes];
			this.replaceChildren();
			this.expanded = this.defaultExpanded;
			this.initialized = true;
		}
		super.connectedCallback();
	}

	override render() {
		return html`<div><button class="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors w-full text-left" aria-expanded=${this.expanded} @click=${() => {
			this.expanded = !this.expanded;
		}}>${icon(this.expanded ? ChevronDown : ChevronRight, "sm")}<span>${this.summary}</span></button>${this.expanded ? html`<div class="mt-2">${this.childrenContent}</div>` : ""}</div>`;
	}
}
