import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { LightElement } from "./base.js";
import { renderMessage } from "./message-registry.js";
import "./Messages.js";

@customElement("sitegeist-message-list")
export class MessageList extends LightElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) pendingToolCalls?: Set<string>;
	@property({ type: Object }) toolResultsById?: Map<string, ToolResultMessage>;
	@property({ type: Object }) streamingMessage?: AssistantMessage;
	@property({ type: Boolean }) isStreaming = false;
	@property({ attribute: false }) onCostClick?: () => void;

	override render() {
		const results = new Map<string, ToolResultMessage>();
		for (const message of this.messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
		for (const [id, result] of this.toolResultsById ?? []) results.set(id, result);
		const messages = this.messages.filter((message) => message.role !== "toolResult");
		if (this.streamingMessage && !messages.includes(this.streamingMessage)) messages.push(this.streamingMessage);
		return html`<div class="flex flex-col gap-3">${repeat(
			messages,
			(_message, index) => index,
			(message) => {
				const custom = renderMessage(message);
				if (custom) return custom;
				if (message.role === "user" || message.role === "user-with-attachments")
					return html`<sitegeist-chat-user-message .message=${message}></sitegeist-chat-user-message>`;
				if (message.role === "assistant")
					return html`<sitegeist-assistant-message .message=${message} .tools=${this.tools} .pendingToolCalls=${this.pendingToolCalls} .toolResultsById=${results} .isStreaming=${message === this.streamingMessage} .onCostClick=${this.onCostClick}></sitegeist-assistant-message>`;
				return nothing;
			},
		)}</div>`;
	}
}
