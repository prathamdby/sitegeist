import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Agent } from "./agent.js";

type PromptInput = string | AgentMessage | AgentMessage[];

export class ViewAgent extends Agent {
	onPrompt?: (input: PromptInput) => void;
	onAbort?: () => void;
	onThinking?: (level: ThinkingLevel) => void;
	private viewListeners = new Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>();

	override subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>): () => void {
		this.viewListeners.add(listener);
		return () => {
			this.viewListeners.delete(listener);
		};
	}

	play(event: AgentEvent): void {
		const signal = new AbortController().signal;
		for (const listener of this.viewListeners) void listener(event, signal);
	}

	override async prompt(input: PromptInput, _images?: ImageContent[]): Promise<void> {
		this.onPrompt?.(input);
	}

	override abort(): void {
		this.onAbort?.();
	}

	override setThinkingLevel(level: ThinkingLevel): void {
		super.setThinkingLevel(level);
		this.onThinking?.(level);
	}
}
