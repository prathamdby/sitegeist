import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage as PiAssistantMessage,
	UserMessage as PiUserMessage,
	ToolCall,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import "@mariozechner/pi-web-ui/dist/components/AttachmentTile.js";
import { i18n } from "@mariozechner/mini-lit";
import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { formatUsage } from "../format.js";
import type { UserMessageWithAttachments } from "../types.js";
import { LightElement } from "./base.js";
import { renderTool } from "./tool-registry.js";
import "./ThinkingBlock.js";

@customElement("sitegeist-chat-user-message")
export class UserMessage extends LightElement {
	@property({ type: Object }) message!: PiUserMessage | UserMessageWithAttachments;

	override render() {
		const content =
			typeof this.message.content === "string"
				? this.message.content
				: (this.message.content.find((block) => block.type === "text")?.text ?? "");
		const attachments = "attachments" in this.message ? this.message.attachments : undefined;
		return html`<div class="flex justify-start mx-4"><div class="user-message-container py-2 px-4 rounded-xl"><markdown-block .content=${content}></markdown-block>${attachments?.length ? html`<div class="mt-3 flex flex-wrap gap-2">${attachments.map((attachment) => html`<attachment-tile .attachment=${attachment}></attachment-tile>`)}</div>` : nothing}</div></div>`;
	}
}

@customElement("sitegeist-tool-message-debug-view")
export class ToolMessageDebugView extends LightElement {
	@property({ type: Object }) callArgs: unknown;
	@property({ type: Object }) result?: ToolResultMessage;
	@property({ type: Boolean }) hasResult = false;

	override render() {
		return html`<div class="space-y-3"><div><div class="text-xs font-medium mb-1 text-muted-foreground">Input</div><code-block language="json" .code=${JSON.stringify(this.callArgs, null, 2) ?? ""}></code-block></div>${this.hasResult ? html`<div><div class="text-xs font-medium mb-1 text-muted-foreground">Output</div><code-block language="json" .code=${JSON.stringify(this.result, null, 2) ?? ""}></code-block></div>` : nothing}</div>`;
	}
}

@customElement("sitegeist-tool-message")
export class ToolMessage extends LightElement {
	@property({ type: Object }) toolCall!: ToolCall;
	@property({ type: Object }) tool?: AgentTool;
	@property({ type: Object }) result?: ToolResultMessage;
	@property({ type: Boolean }) pending = false;
	@property({ type: Boolean }) aborted = false;
	@property({ type: Boolean }) isStreaming = false;
	private jsonModeChanged = () => this.requestUpdate();

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("sitegeist-json-mode-change", this.jsonModeChanged);
	}

	override disconnectedCallback(): void {
		document.removeEventListener("sitegeist-json-mode-change", this.jsonModeChanged);
		super.disconnectedCallback();
	}

	override render() {
		const result =
			this.aborted && !this.result
				? {
						role: "toolResult" as const,
						toolCallId: this.toolCall.id,
						toolName: this.toolCall.name,
						content: [{ type: "text" as const, text: i18n("(no output)") }],
						isError: true,
						timestamp: 0,
					}
				: this.result;
		const rendered = renderTool(
			this.toolCall.name,
			this.toolCall.arguments,
			result,
			this.isStreaming || this.pending,
		);
		return html`<div class="p-2.5 border border-border rounded-md bg-card text-card-foreground shadow-xs">${rendered.content}</div>`;
	}
}

@customElement("sitegeist-assistant-message")
export class AssistantMessage extends LightElement {
	@property({ type: Object }) message!: PiAssistantMessage;
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Boolean }) hideToolCalls = false;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessage>;
	@property({ type: Boolean }) isStreaming = false;
	@property({ type: Boolean }) hidePendingToolCalls = false;
	@property({ attribute: false }) onCostClick?: () => void;

	override render() {
		const blocks = this.message.content.map((block) => {
			if (block.type === "thinking")
				return block.thinking
					? html`<sitegeist-thinking-block .content=${block.thinking} .isStreaming=${this.isStreaming}></sitegeist-thinking-block>`
					: nothing;
			if (block.type === "text")
				return block.text ? html`<markdown-block .content=${block.text}></markdown-block>` : nothing;
			if (this.hideToolCalls || (this.hidePendingToolCalls && this.pendingToolCalls?.has(block.id))) return nothing;
			return html`<sitegeist-tool-message .toolCall=${block} .tool=${this.tools.find((tool) => tool.name === block.name)} .result=${this.toolResultsById?.get(block.id)} .pending=${this.isStreaming && (this.pendingToolCalls?.has(block.id) ?? false)} .aborted=${this.message.stopReason === "aborted"} .isStreaming=${this.isStreaming}></sitegeist-tool-message>`;
		});
		const usage = this.message.usage;
		const cost = usage ? formatUsage(usage) : "";
		return html`<div>${blocks.length ? html`<div class="px-4 flex flex-col gap-3">${blocks}</div>` : nothing}${cost ? html`<div class="px-4 mt-2 text-xs text-muted-foreground ${this.onCostClick ? "cursor-pointer hover:text-foreground" : ""}" @click=${this.onCostClick}>${cost}</div>` : nothing}${this.message.stopReason === "error" && this.message.errorMessage ? html`<div class="mx-4 mt-3 p-3 bg-destructive/10 text-destructive rounded-lg text-sm overflow-hidden"><strong>${i18n("Error:")}</strong> ${this.message.errorMessage}</div>` : nothing}${this.message.stopReason === "aborted" ? html`<sitegeist-aborted-message></sitegeist-aborted-message>` : nothing}</div>`;
	}
}

@customElement("sitegeist-aborted-message")
export class AbortedMessage extends LightElement {
	override render() {
		return html`<div class="mx-4 mt-3 text-sm text-muted-foreground">${i18n("Request aborted")}</div>`;
	}
}
