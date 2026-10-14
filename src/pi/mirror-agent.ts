import type { AgentEvent, AgentMessage, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { Agent } from "./agent.js";

/**
 * Live session mirroring between side panel documents.
 *
 * Chrome gives every tab its own panel document, so a session viewed from
 * several tabs of its group has several documents. Exactly one (the owner)
 * runs the agent; the others hold a MirrorAgent that replays the owner's
 * events and forwards user actions back to it.
 */

export interface SessionSnapshot {
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: string[];
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	title: string;
	/** Absent when the owner has no error. Applying a snapshot replaces or clears the mirror's error. */
	errorMessage?: string;
}

export type PromptInput = string | AgentMessage | AgentMessage[];

export type MirrorToOwnerMessage =
	| { kind: "hello" }
	| { kind: "prompt"; input: PromptInput; images?: ImageContent[]; proof?: string }
	| { kind: "abort"; proof?: string }
	| { kind: "steer"; message: AgentMessage; proof?: string }
	| { kind: "model"; model: Model<Api>; proof?: string }
	| { kind: "thinking"; level: ThinkingLevel; proof?: string }
	| { kind: "title"; title: string; proof?: string };

/** hello is public. Every other owner command needs the proof the background gave this mirror. */
export function hasMirrorProof(message: { kind: string; proof?: string }, proof: string): boolean {
	if (message.kind === "hello") return true;
	return message.proof === proof && proof.length > 0;
}

export type OwnerToMirrorMessage =
	| { kind: "snapshot"; snapshot: SessionSnapshot }
	| { kind: "event"; event: AgentEvent };

export interface MirrorState {
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: ReadonlySet<string>;
	errorMessage?: string;
}

/**
 * Apply one owner event to mirrored state, matching the owner's reducer.
 * Returns false when a duplicate agent_start arrives during an open run: that
 * resend is not a new run, so callers must not emit it or start another idle wait.
 */
export function reduceMirrorEvent(state: MirrorState, event: AgentEvent): boolean {
	switch (event.type) {
		case "agent_start":
			if (state.isStreaming) return false;
			state.isStreaming = true;
			state.streamingMessage = undefined;
			state.errorMessage = undefined;
			break;
		case "message_start":
		case "message_update":
			state.streamingMessage = event.message;
			break;
		case "message_end":
			state.streamingMessage = undefined;
			state.messages = [...state.messages, event.message];
			break;
		case "tool_execution_start": {
			const pending = new Set(state.pendingToolCalls);
			pending.add(event.toolCallId);
			state.pendingToolCalls = pending;
			break;
		}
		case "tool_execution_end": {
			const pending = new Set(state.pendingToolCalls);
			pending.delete(event.toolCallId);
			state.pendingToolCalls = pending;
			break;
		}
		case "turn_end":
			if (event.message.role === "assistant" && event.message.errorMessage) {
				state.errorMessage = event.message.errorMessage;
			}
			break;
		case "agent_end":
			state.isStreaming = false;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set();
			break;
	}
	return true;
}

/**
 * Structured clone fails on functions or DOM values a tool may leave in
 * `details`. Fall back to a JSON copy, which drops them, before giving up.
 */
export function postToChannel(channel: Pick<BroadcastChannel, "postMessage">, message: unknown): boolean {
	try {
		channel.postMessage(message);
		return true;
	} catch {
		try {
			channel.postMessage(JSON.parse(JSON.stringify(message)));
			return true;
		} catch {
			return false;
		}
	}
}

export interface MirrorRemote {
	send(message: MirrorToOwnerMessage): void;
}

const neverStream: StreamFn = () => {
	throw new Error("Mirror panels never stream; the owning panel runs the agent");
};

type Listener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export class MirrorAgent extends Agent {
	private readonly remote: MirrorRemote;
	private readonly mirrorListeners = new Set<Listener>();
	private readonly signalSource = new AbortController();
	private idle?: { promise: Promise<void>; resolve: () => void };
	title = "";
	/** Called after any state change that does not arrive as an event (snapshots). */
	onChange?: () => void;

	constructor(
		remote: MirrorRemote,
		initialState: { model: Model<Api>; thinkingLevel: ThinkingLevel; messages: AgentMessage[]; systemPrompt: string },
	) {
		super({ initialState: { ...initialState, tools: [] }, streamFn: neverStream });
		this.remote = remote;
	}

	private get mutableState(): MirrorState {
		return this.state as unknown as MirrorState;
	}

	override subscribe(listener: Listener): () => void {
		this.mirrorListeners.add(listener);
		return () => {
			this.mirrorListeners.delete(listener);
		};
	}

	override waitForIdle(): Promise<void> {
		return this.idle?.promise ?? Promise.resolve();
	}

	override async prompt(input: PromptInput, images?: ImageContent[]): Promise<void> {
		if (!this.state.model.provider) {
			this.onModelRequired?.();
			return;
		}
		this.remote.send(images?.length ? { kind: "prompt", input, images } : { kind: "prompt", input });
	}

	override async continue(): Promise<void> {
		// Continuation is driven by the owner; mirrors never start runs.
	}

	override abort(): void {
		this.remote.send({ kind: "abort" });
	}

	override steer(message: AgentMessage): void {
		this.remote.send({ kind: "steer", message });
	}

	override followUp(message: AgentMessage): void {
		this.remote.send({ kind: "prompt", input: message });
	}

	override setModel(model: Model<Api>): void {
		super.setModel(model);
		this.remote.send({ kind: "model", model });
	}

	override setThinkingLevel(level: ThinkingLevel): void {
		super.setThinkingLevel(level);
		this.remote.send({ kind: "thinking", level });
	}

	setTitle(title: string): void {
		this.title = title;
		this.remote.send({ kind: "title", title });
	}

	private beginRun(): void {
		if (this.idle) return;
		let resolve = () => {};
		const promise = new Promise<void>((done) => {
			resolve = done;
		});
		this.idle = { promise, resolve };
	}

	private endRun(): void {
		const idle = this.idle;
		this.idle = undefined;
		idle?.resolve();
	}

	private async emit(event: AgentEvent): Promise<void> {
		for (const listener of this.mirrorListeners) {
			try {
				await listener(event, this.signalSource.signal);
			} catch (err) {
				console.warn("[MirrorAgent] Listener failed:", err);
			}
		}
	}

	async applyEvent(event: AgentEvent): Promise<void> {
		if (!reduceMirrorEvent(this.mutableState, event)) return;
		if (event.type === "agent_start") this.beginRun();
		await this.emit(event);
		if (event.type === "agent_end") this.endRun();
	}

	/** Streaming transitions go through the reducer; the snapshot then resyncs fields that transition clobbers. */
	async applySnapshot(snapshot: SessionSnapshot): Promise<void> {
		const wasStreaming = this.state.isStreaming;
		this.state.model = snapshot.model;
		this.state.thinkingLevel = snapshot.thinkingLevel;
		this.title = snapshot.title;
		if (snapshot.isStreaming !== wasStreaming) {
			await this.applyEvent(
				snapshot.isStreaming ? { type: "agent_start" } : { type: "agent_end", messages: snapshot.messages },
			);
		}
		const state = this.mutableState;
		state.messages = snapshot.messages;
		state.isStreaming = snapshot.isStreaming;
		state.streamingMessage = snapshot.streamingMessage;
		state.pendingToolCalls = new Set(snapshot.pendingToolCalls);
		state.errorMessage = snapshot.errorMessage;
		this.onChange?.();
	}
}

/** Mirror end of the session channel: replays owner messages in order. */
export class SessionMirrorChannel {
	private readonly channel: BroadcastChannel;
	private queue: Promise<void> = Promise.resolve();
	private proof = "";
	readonly agent: MirrorAgent;

	constructor(
		channelName: string,
		createAgent: (remote: MirrorRemote) => MirrorAgent,
		private readonly onFirstSnapshot?: () => void,
	) {
		this.channel = new BroadcastChannel(channelName);
		this.agent = createAgent({
			send: (message) => {
				const stamped = this.proof ? { ...message, proof: this.proof } : message;
				postToChannel(this.channel, stamped);
			},
		});
		let sawSnapshot = false;
		this.channel.onmessage = (event: MessageEvent<OwnerToMirrorMessage>) => {
			const message = event.data;
			this.queue = this.queue
				.then(async () => {
					if (message.kind === "snapshot") {
						await this.agent.applySnapshot(message.snapshot);
						if (!sawSnapshot) {
							sawSnapshot = true;
							this.onFirstSnapshot?.();
						}
					} else if (message.kind === "event") {
						await this.agent.applyEvent(message.event);
					}
				})
				.catch((err) => console.warn("[SessionMirror] Failed to apply owner message:", err));
		};
		this.channel.postMessage({ kind: "hello" } satisfies MirrorToOwnerMessage);
	}

	setProof(proof: string): void {
		this.proof = proof;
	}

	close(): void {
		this.channel.onmessage = null;
		this.channel.close();
	}
}

export interface SessionOwnerHandlers {
	title(): string;
	prompt(input: PromptInput, images?: ImageContent[]): Promise<void>;
	setModel(model: Model<Api>): void;
	setTitle(title: string): void;
}

/** Owner end of the session channel: broadcasts agent activity, serves mirror requests. */
export class SessionOwnerChannel {
	private readonly channel: BroadcastChannel;
	private agent?: Agent;
	private unsubscribe?: () => void;
	readonly proof = crypto.randomUUID();

	constructor(
		channelName: string,
		private readonly handlers: SessionOwnerHandlers,
	) {
		this.channel = new BroadcastChannel(channelName);
		this.channel.onmessage = (event: MessageEvent<MirrorToOwnerMessage>) => {
			this.handle(event.data);
		};
	}

	attach(agent: Agent): void {
		this.unsubscribe?.();
		this.agent = agent;
		this.unsubscribe = agent.subscribe((event) => {
			if (event.type === "agent_start") {
				this.broadcastSnapshot();
				return;
			}
			if (!this.post({ kind: "event", event })) this.broadcastSnapshot();
			if (event.type === "agent_end") {
				// The run is idle only after agent_end listeners settle; resync then.
				void agent.waitForIdle().then(() => this.broadcastSnapshot());
			}
		});
		this.broadcastSnapshot();
	}

	broadcastSnapshot(): void {
		const agent = this.agent;
		if (!agent) return;
		const state = agent.state;
		this.post({
			kind: "snapshot",
			snapshot: {
				messages: state.messages.slice(),
				isStreaming: state.isStreaming,
				...(state.streamingMessage !== undefined ? { streamingMessage: state.streamingMessage } : {}),
				pendingToolCalls: Array.from(state.pendingToolCalls),
				model: state.model,
				thinkingLevel: state.thinkingLevel,
				title: this.handlers.title(),
				errorMessage: state.errorMessage,
			},
		});
	}

	private post(message: OwnerToMirrorMessage): boolean {
		return postToChannel(this.channel, message);
	}

	private handle(message: MirrorToOwnerMessage): void {
		const agent = this.agent;
		if (!agent || !hasMirrorProof(message, this.proof)) return;
		switch (message.kind) {
			case "hello":
				this.broadcastSnapshot();
				break;
			case "prompt":
				void this.handlers.prompt(message.input, message.images).catch((err) => {
					console.warn("[SessionOwner] Forwarded prompt failed:", err);
				});
				break;
			case "abort":
				agent.abort();
				break;
			case "steer":
				agent.steer(message.message);
				break;
			case "model":
				this.handlers.setModel(message.model);
				this.broadcastSnapshot();
				break;
			case "thinking":
				agent.setThinkingLevel(message.level);
				this.broadcastSnapshot();
				break;
			case "title":
				this.handlers.setTitle(message.title);
				this.broadcastSnapshot();
				break;
		}
	}

	close(): void {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.channel.onmessage = null;
		this.channel.close();
	}
}
