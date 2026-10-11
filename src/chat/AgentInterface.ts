import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import type { Attachment } from "../attachments/types.js";
import type { Agent } from "../pi/agent.js";
import { getAppStorage } from "../storage/app-storage.js";
import { formatUsage } from "./format.js";
import { MessageEditor } from "./MessageEditor.js";
import "./renderers/index.js";

@customElement("sitegeist-agent-interface")
export class AgentInterface extends LitElement {
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	onApiKeyRequired?: (provider: string) => Promise<boolean>;
	onBeforeSend?: () => void | Promise<void>;
	onCostClick?: () => void;
	onModelSelect?: () => void;
	private editor = new MessageEditor();
	private scrollRef = createRef<HTMLElement>();
	private unsubscribe?: () => void;
	private subscribedAgent?: Agent;
	private observer?: ResizeObserver;
	private autoScroll = true;
	private lastClientHeight = 0;
	private lastScrollTop = 0;
	private streaming = false;
	private streamingMessage?: AssistantMessage;
	private messageKeys = new WeakMap<AgentMessage, object>();
	private streamingKey?: object;
	private frame?: number;
	private preparingSend = false;
	private results = new Map<string, ToolResultMessage>();

	protected override createRenderRoot() {
		return this;
	}

	setInput(text: string, attachments: Attachment[] = []): void {
		this.editor.value = text;
		this.editor.attachments = attachments;
	}

	setAutoScroll(enabled: boolean): void {
		this.autoScroll = enabled;
		if (enabled) this.scrollToBottom();
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";
		this.connectAgent();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.subscribedAgent = undefined;
		this.observer?.disconnect();
		this.observer = undefined;
		this.cancelFrame();
	}

	protected override willUpdate(): void {
		this.connectAgent();
	}

	private connectAgent(): void {
		if (this.session === this.subscribedAgent) return;
		this.unsubscribe?.();
		this.cancelFrame();
		this.subscribedAgent = this.session;
		this.streaming = this.session?.state.isStreaming ?? false;
		this.streamingMessage = undefined;
		this.messageKeys = new WeakMap();
		this.streamingKey = undefined;
		this.results.clear();
		this.unsubscribe = this.session?.subscribe((event) => this.handleEvent(event));
		const agent = this.session;
		if (agent && this.streaming) {
			agent.waitForIdle().then(() => {
				if (this.subscribedAgent !== agent) return;
				this.streaming = agent.state.isStreaming;
				this.requestUpdate();
			});
		}
	}

	private cancelFrame(): void {
		if (this.frame !== undefined) cancelAnimationFrame(this.frame);
		this.frame = undefined;
	}

	private handleEvent(event: AgentEvent): void {
		if (event.type === "agent_start") this.streaming = true;
		if (event.type === "message_start" && event.message.role === "assistant") this.streamingKey = {};
		if (event.type === "message_update" && event.message.role === "assistant") {
			this.streamingMessage = structuredClone(event.message);
			this.streamingKey ??= {};
			this.messageKeys.set(this.streamingMessage, this.streamingKey);
			if (this.frame === undefined)
				this.frame = requestAnimationFrame(() => {
					this.frame = undefined;
					this.requestUpdate();
				});
			return;
		}
		if (event.type === "message_end") {
			if (event.message.role === "assistant" && this.streamingKey) {
				this.messageKeys.set(event.message, this.streamingKey);
				this.streamingKey = undefined;
			}
			this.cancelFrame();
			this.streamingMessage = undefined;
		}
		if (event.type === "tool_execution_update") {
			this.results.set(event.toolCallId, {
				role: "toolResult",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				content: event.partialResult.content,
				details: event.partialResult.details,
				isError: false,
				timestamp: Date.now(),
			});
		}
		if (event.type === "tool_execution_end") this.results.delete(event.toolCallId);
		if (event.type === "agent_end") {
			this.streaming = false;
			this.streamingMessage = undefined;
			this.streamingKey = undefined;
			this.results.clear();
			this.cancelFrame();
		}
		this.requestUpdate();
	}

	private scrollToBottom(): void {
		const element = this.scrollRef.value;
		if (element && this.autoScroll) {
			element.scrollTop = element.scrollHeight;
			this.lastScrollTop = element.scrollTop;
		}
	}

	private handleScroll = (): void => {
		const element = this.scrollRef.value;
		if (!element) return;
		const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 50;
		if (nearBottom) this.autoScroll = true;
		else if (element.clientHeight === this.lastClientHeight && element.scrollTop < this.lastScrollTop)
			this.autoScroll = false;
		this.lastClientHeight = element.clientHeight;
		this.lastScrollTop = element.scrollTop;
	};

	protected override updated(): void {
		if (!this.observer && this.scrollRef.value) {
			this.lastClientHeight = this.scrollRef.value.clientHeight;
			this.observer = new ResizeObserver(() => {
				this.scrollToBottom();
				this.lastClientHeight = this.scrollRef.value?.clientHeight ?? 0;
			});
			this.observer.observe(this.scrollRef.value);
			const list = this.scrollRef.value.firstElementChild;
			if (list) this.observer.observe(list);
		}
		this.scrollToBottom();
	}

	async sendMessage(input: string, attachments: Attachment[] = []): Promise<void> {
		const agent = this.session;
		if (!agent || this.streaming || this.preparingSend || (!input.trim() && attachments.length === 0)) return;
		this.preparingSend = true;
		try {
			const provider = agent.state.model.provider;
			const key = provider ? await getAppStorage().providerKeys.get(provider) : undefined;
			if (!key && !(await this.onApiKeyRequired?.(provider))) return;
			await this.onBeforeSend?.();
			if (this.session !== agent) return;
			const draft = this.editor.value;
			const draftAttachments = this.editor.attachments;
			this.editor.value = "";
			this.editor.attachments = [];
			this.autoScroll = true;
			try {
				if (attachments.length) {
					await agent.prompt({
						role: "user-with-attachments",
						content: input,
						attachments,
						timestamp: Date.now(),
					});
				} else await agent.prompt(input);
			} catch (error) {
				if (!this.editor.value && this.editor.attachments.length === 0) {
					this.editor.value = draft;
					this.editor.attachments = draftAttachments;
				}
				throw error;
			}
		} finally {
			this.preparingSend = false;
			this.requestUpdate();
		}
	}

	private totalUsage(messages: AgentMessage[]): Usage {
		const usage: Usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
				usage[field] += message.usage?.[field] ?? 0;
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
				usage.cost[field] += message.usage?.cost?.[field] ?? 0;
		}
		return usage;
	}

	override render() {
		const state = this.session?.state;
		const messages = state?.messages.slice() ?? [];
		const toolResultsById = new Map(this.results);
		for (const message of messages)
			if (message.role === "toolResult") toolResultsById.set(message.toolCallId, message);
		this.editor.isStreaming = this.streaming;
		this.editor.currentModel = state?.model;
		this.editor.thinkingLevel = state?.thinkingLevel ?? "off";
		this.editor.showAttachmentButton = this.enableAttachments;
		this.editor.showModelSelector = this.enableModelSelector;
		this.editor.showThinkingSelector = this.enableThinkingSelector;
		this.editor.onSend = (input, attachments) => {
			this.sendMessage(input, attachments).catch(() => {});
		};
		this.editor.onAbort = () => this.session?.abort();
		this.editor.onModelSelect = this.onModelSelect;
		this.editor.onThinkingChange = (level) => {
			this.session?.setThinkingLevel(level);
			this.requestUpdate();
		};
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<div ${ref(this.scrollRef)} class="flex-1 overflow-y-auto" @scroll=${this.handleScroll}>
					<div class="max-w-3xl mx-auto p-4 pb-0"><div class="flex flex-col gap-3"><sitegeist-message-list .messages=${messages} .tools=${state?.tools} .pendingToolCalls=${state?.pendingToolCalls} .streamingMessage=${this.streamingMessage} .messageKeys=${this.messageKeys} .isStreaming=${this.streaming} .toolResultsById=${toolResultsById} .onCostClick=${this.onCostClick}></sitegeist-message-list>${this.streaming && !this.streamingMessage ? html`<div><span class="mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse"></span></div>` : ""}</div></div>
				</div>
				<div class="shrink-0"><div class="max-w-3xl mx-auto px-2">${this.editor}<div class="text-xs text-muted-foreground flex justify-between items-center h-5"><div class="flex items-center gap-1"></div><div class="flex ml-auto items-center gap-3"><span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${formatUsage(this.totalUsage(messages))}</span></div></div></div></div>
			</div>
		`;
	}
}
