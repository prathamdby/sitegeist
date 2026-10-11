import type { MessageConsumer, RuntimeMessage, RuntimeResponse, SandboxRuntimeProvider } from "./types.js";

export type { MessageConsumer } from "./types.js";

export interface SandboxMessageBinding {
	transport?: "sandbox-iframe" | "user-script";
	tabId?: number;
	frameId?: number;
	worldId?: string;
	capability?: string;
	signal?: AbortSignal;
}

interface Registration {
	providers: SandboxRuntimeProvider[];
	consumers: Set<MessageConsumer>;
	binding: SandboxMessageBinding;
	iframe?: HTMLIFrameElement;
	requestIds: Set<string>;
	abort?: () => void;
}

export class RuntimeMessageRouter {
	private sandboxes = new Map<string, Registration>();
	private messageTarget?: Window;
	private userScriptTarget?: typeof chrome.runtime.onUserScriptMessage;

	private messageListener = (event: MessageEvent<unknown>): void => {
		const message = this.validateMessage(event.data);
		if (!message) return;
		const registration = this.sandboxes.get(message.sandboxId!);
		const source = registration?.iframe?.contentWindow;
		if (!registration || !source || event.source !== source || registration.binding.transport === "user-script")
			return;
		this.dispatch(message, registration, (response) => {
			if (registration.iframe?.contentWindow === source) source.postMessage(response, "*");
		});
	};

	private userScriptMessageListener = (
		data: unknown,
		sender: chrome.runtime.MessageSender & { userScriptWorldId?: string },
		sendResponse: (response: RuntimeResponse) => void,
	): boolean => {
		const message = this.validateMessage(data);
		if (!message) return false;
		const registration = this.sandboxes.get(message.sandboxId!);
		if (!registration || registration.iframe || registration.binding.transport === "sandbox-iframe") return false;
		if (chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
		const { tabId, frameId, worldId, capability } = registration.binding;
		if (
			(tabId !== undefined && sender.tab?.id !== tabId) ||
			(frameId !== undefined && sender.frameId !== frameId) ||
			(worldId !== undefined && message.worldId !== worldId) ||
			(worldId !== undefined && sender.userScriptWorldId !== undefined && sender.userScriptWorldId !== worldId) ||
			(capability !== undefined && message.capability !== capability)
		)
			return false;
		return this.dispatch(message, registration, sendResponse);
	};

	registerSandbox(
		sandboxId: string,
		providers: SandboxRuntimeProvider[],
		consumers: MessageConsumer[],
		binding: SandboxMessageBinding = {},
	): void {
		if (!sandboxId) throw new Error("A sandbox ID is required");
		this.unregisterSandbox(sandboxId);
		if (binding.signal?.aborted) return;
		const registration: Registration = {
			providers: [...providers],
			consumers: new Set(consumers),
			binding: { ...binding, transport: binding.transport ?? "sandbox-iframe" },
			requestIds: new Set(),
		};
		if (binding.signal) {
			registration.abort = () => {
				if (this.sandboxes.get(sandboxId) === registration) this.unregisterSandbox(sandboxId);
			};
			binding.signal.addEventListener("abort", registration.abort, { once: true });
		}
		this.sandboxes.set(sandboxId, registration);
		this.setupListeners();
	}

	setSandboxIframe(sandboxId: string, iframe: HTMLIFrameElement): void {
		const registration = this.sandboxes.get(sandboxId);
		if (registration && registration.binding.transport !== "user-script") registration.iframe = iframe;
	}

	addConsumer(sandboxId: string, consumer: MessageConsumer): void {
		this.sandboxes.get(sandboxId)?.consumers.add(consumer);
	}

	removeConsumer(sandboxId: string, consumer: MessageConsumer): void {
		this.sandboxes.get(sandboxId)?.consumers.delete(consumer);
	}

	unregisterSandbox(sandboxId: string): void {
		const registration = this.sandboxes.get(sandboxId);
		if (registration?.abort) registration.binding.signal?.removeEventListener("abort", registration.abort);
		this.sandboxes.delete(sandboxId);
		if (this.sandboxes.size) return;
		this.messageTarget?.removeEventListener("message", this.messageListener);
		this.userScriptTarget?.removeListener(this.userScriptMessageListener);
		this.messageTarget = undefined;
		this.userScriptTarget = undefined;
	}

	private validateMessage(data: unknown): RuntimeMessage | undefined {
		if (!data || typeof data !== "object" || Array.isArray(data)) return;
		const message = data as RuntimeMessage;
		if (
			message.channel !== "sitegeist-runtime" ||
			typeof message.sandboxId !== "string" ||
			!message.sandboxId ||
			typeof message.type !== "string" ||
			!message.type ||
			message.type === "runtime-response" ||
			(message.messageType !== undefined &&
				message.messageType !== "request-response" &&
				message.messageType !== "fire-and-forget") ||
			(message.messageId !== undefined && (typeof message.messageId !== "string" || !message.messageId)) ||
			(message.messageType === "request-response" && message.messageId === undefined)
		)
			return;
		return message;
	}

	private dispatch(
		message: RuntimeMessage,
		registration: Registration,
		sendResponse: (response: RuntimeResponse) => void,
	): boolean {
		if (registration.binding.signal?.aborted) return false;
		if (message.messageId) {
			if (registration.requestIds.has(message.messageId)) return false;
			registration.requestIds.add(message.messageId);
		}
		let responded = false;
		const { capability: _capability, ...routedMessage } = message;
		routedMessage.runtimeTabId = registration.binding.tabId;
		const active = () =>
			this.sandboxes.get(message.sandboxId!) === registration && !registration.binding.signal?.aborted;
		const respond = (response: RuntimeResponse) => {
			if (responded || !message.messageId || message.messageType === "fire-and-forget" || !active()) return;
			responded = true;
			sendResponse({
				...response,
				channel: "sitegeist-runtime",
				type: "runtime-response",
				sandboxId: message.sandboxId,
				messageId: message.messageId,
			});
		};
		for (const provider of registration.providers) {
			if (!active()) break;
			try {
				Promise.resolve(provider.handleMessage?.(routedMessage, respond)).catch((error: unknown) => {
					respond({ success: false, error: error instanceof Error ? error.message : String(error) });
				});
			} catch (error) {
				respond({ success: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
		for (const consumer of [...registration.consumers]) {
			if (!active()) break;
			try {
				Promise.resolve(consumer.handleMessage(routedMessage)).catch(() => {});
			} catch {}
		}
		return !!message.messageId && message.messageType !== "fire-and-forget";
	}

	private setupListeners(): void {
		if (!this.messageTarget && typeof window !== "undefined") {
			this.messageTarget = window;
			window.addEventListener("message", this.messageListener);
		}
		if (!this.userScriptTarget && typeof chrome !== "undefined" && chrome.runtime?.onUserScriptMessage) {
			this.userScriptTarget = chrome.runtime.onUserScriptMessage;
			this.userScriptTarget.addListener(this.userScriptMessageListener);
		}
	}
}

export const RUNTIME_MESSAGE_ROUTER = new RuntimeMessageRouter();
