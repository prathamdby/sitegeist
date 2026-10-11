import { i18n, icon } from "@mariozechner/mini-lit";
import { html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { Check, Copy } from "lucide";
import { LightElement } from "./base.js";

@customElement("sitegeist-console-block")
export class ConsoleBlock extends LightElement {
	@property() content = "";
	@property() variant: "default" | "error" = "default";
	@state() private copied = false;

	override updated(): void {
		const scroll = this.querySelector(".console-scroll");
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	}

	private async copy(): Promise<void> {
		await navigator.clipboard.writeText(this.content);
		this.copied = true;
		setTimeout(() => {
			this.copied = false;
		}, 2000);
	}

	override render() {
		return html`<div class="border border-border rounded-lg overflow-hidden"><div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border"><span class="text-xs text-muted-foreground font-mono">${i18n("console")}</span><button class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors" title=${i18n("Copy output")} @click=${this.copy}>${icon(this.copied ? Check : Copy, "sm")}${this.copied ? i18n("Copied!") : ""}</button></div><div class="console-scroll overflow-auto max-h-64"><pre class="!bg-background !border-0 !rounded-none m-0 p-3 text-xs ${this.variant === "error" ? "text-destructive" : "text-foreground"} font-mono whitespace-pre-wrap">${this.content}</pre></div></div>`;
	}
}
