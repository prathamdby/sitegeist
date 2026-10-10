import {
	type AgentMessage,
	type AgentOptions,
	type AgentState,
	type AgentTool,
	Agent as PiAgent,
	type StreamFn,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	createInitialSystemMessage,
	type ImageContent,
	type Model,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { ArtifactMessage, UserMessageWithAttachments } from "@mariozechner/pi-web-ui";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";

export type * from "@earendil-works/pi-agent-core";

export function executableTool<T extends TSchema, D>(tool: AgentTool<T, D>): AgentTool<TSchema, D> {
	const validator = Compile(tool.parameters);
	return {
		...tool,
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (id, args, signal, onUpdate) => tool.execute(id, validator.Parse(args), signal, onUpdate),
	};
}

declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"user-with-attachments": UserMessageWithAttachments;
		artifact: ArtifactMessage;
	}
}

export class Agent extends PiAgent {
	private readonly legacyState: AgentState;
	private turnEnded = false;
	onModelRequired?: () => void;

	constructor(options: AgentOptions) {
		super(options);
		this.legacyState = new Proxy(super.state, {
			get: (state, property, receiver) =>
				property === "isStreaming" ? state.isStreaming && !this.turnEnded : Reflect.get(state, property, receiver),
		});
		super.subscribe((event) => {
			if (event.type === "message_end") super.state.messages = super.state.messages;
			if (event.type === "agent_start") this.turnEnded = false;
			if (event.type === "agent_end") this.turnEnded = true;
		});
	}

	override get state(): AgentState {
		return this.legacyState;
	}

	override async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
		if (!this.state.model.provider) {
			this.onModelRequired?.();
			return;
		}
		if (typeof input === "string") return super.prompt(input, images);
		return super.prompt(input);
	}

	override async continue(): Promise<void> {
		if (!this.state.model.provider) {
			this.onModelRequired?.();
			return;
		}
		return super.continue();
	}

	get streamFn(): StreamFn {
		return this.streamFunction;
	}

	set streamFn(stream: StreamFn) {
		this.streamFunction = stream;
	}

	setModel(model: Model<Api>): void {
		this.state.model = model;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.state.thinkingLevel = level;
	}

	setTools(tools: AgentTool[]): void {
		this.state.tools = tools;
	}

	appendMessage(message: AgentMessage): void {
		this.state.messages = [...this.state.messages, message];
	}

	replaceMessages(messages: AgentMessage[]): void {
		const baseline = createInitialSystemMessage(this.state.systemPrompt, this.state.tools.map(toToolDeclaration));
		this.state.messages = messages[0]?.role === "system" || !baseline ? messages : [baseline, ...messages];
	}
}
