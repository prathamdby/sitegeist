import type { RuntimeMessage, RuntimeResponse } from "./types.js";

export type MessageType = "request-response" | "fire-and-forget";

export interface RuntimeMessageBridgeOptions {
	context: "sandbox-iframe" | "user-script";
	sandboxId: string;
	worldId?: string;
	capability?: string;
}

export interface SendRuntimeMessageOptions {
	rejectOnError?: boolean;
	type?: MessageType;
	messageType?: MessageType;
	timeout?: number;
	timeoutMs?: number;
}

function installRuntimeBridge(options: RuntimeMessageBridgeOptions): void {
	const target = window as Window & {
		sendRuntimeMessage?: (
			message: RuntimeMessage,
			options?: SendRuntimeMessageOptions | MessageType,
		) => Promise<RuntimeResponse | undefined>;
		__completionCallbacks?: Array<(success: boolean) => Promise<void> | void>;
		__runtimeBridgeCleanup?: () => void;
		onCompleted?: (callback: (success: boolean) => Promise<void> | void) => void;
	};
	target.__runtimeBridgeCleanup?.();
	const pending = new Map<
		string,
		{
			resolve: (response: RuntimeResponse) => void;
			reject: (error: Error) => void;
			timer: ReturnType<typeof setTimeout>;
			rejectOnError: boolean;
		}
	>();
	let completed = false;
	let sequence = 0;
	const prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const [settle] = [
		(id: string, response?: RuntimeResponse, error?: Error) => {
			const request = pending.get(id);
			if (!request) return;
			pending.delete(id);
			clearTimeout(request.timer);
			if (error) request.reject(error);
			else if (response?.success === false && request.rejectOnError)
				request.reject(new Error(response.error || "Operation failed"));
			else request.resolve(response ?? {});
		},
	];
	const [receive] = [
		(event: MessageEvent<unknown>) => {
			if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
			const response = event.data as RuntimeResponse;
			if (
				response.channel !== "sitegeist-runtime" ||
				response.sandboxId !== options.sandboxId ||
				response.type !== "runtime-response" ||
				typeof response.messageId !== "string"
			)
				return;
			settle(response.messageId, response);
		},
	];
	if (options.context === "sandbox-iframe") window.addEventListener("message", receive);
	const [cleanup] = [
		() => {
			completed = true;
			window.removeEventListener("message", receive);
			for (const id of pending.keys()) settle(id, undefined, new Error("Sandbox execution completed"));
		},
	];
	target.__runtimeBridgeCleanup = cleanup;
	target.__completionCallbacks = [];
	target.onCompleted = (callback) => target.__completionCallbacks!.push(callback);
	target.sendRuntimeMessage = async (message, requestOptions = {}) => {
		const settings = typeof requestOptions === "string" ? { type: requestOptions } : requestOptions;
		const mode = settings.messageType ?? settings.type ?? "request-response";
		if (mode !== "request-response" && mode !== "fire-and-forget") throw new Error("Invalid runtime message mode");
		if (completed && mode === "request-response") throw new Error("Sandbox execution completed");
		if (!message || typeof message.type !== "string" || !message.type)
			throw new Error("A runtime message type is required");
		const id = `${prefix}-${++sequence}`;
		const envelope = {
			...message,
			channel: "sitegeist-runtime",
			sandboxId: options.sandboxId,
			messageId: id,
			messageType: mode,
			...(options.worldId !== undefined ? { worldId: options.worldId } : {}),
			...(options.capability !== undefined ? { capability: options.capability } : {}),
		};
		if (mode === "fire-and-forget") {
			if (options.context === "sandbox-iframe") window.parent.postMessage(envelope, "*");
			else Promise.resolve(chrome.runtime.sendMessage(envelope)).catch(() => {});
			return;
		}
		const timeout = settings.timeoutMs ?? settings.timeout ?? 30000;
		if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Runtime message timeout must be positive");
		return new Promise<RuntimeResponse>((resolve, reject) => {
			const timer = setTimeout(() => settle(id, undefined, new Error("Runtime message timed out")), timeout);
			pending.set(id, { resolve, reject, timer, rejectOnError: settings.rejectOnError !== false });
			try {
				if (options.context === "sandbox-iframe") window.parent.postMessage(envelope, "*");
				else {
					Promise.resolve(chrome.runtime.sendMessage(envelope)).then(
						(response: unknown) => {
							if (
								!response ||
								typeof response !== "object" ||
								(response as RuntimeResponse).channel !== "sitegeist-runtime" ||
								(response as RuntimeResponse).sandboxId !== options.sandboxId ||
								(response as RuntimeResponse).type !== "runtime-response" ||
								(response as RuntimeResponse).messageId !== id
							)
								return;
							settle(id, response as RuntimeResponse);
						},
						(error: unknown) =>
							settle(id, undefined, new Error(error instanceof Error ? error.message : String(error))),
					);
				}
			} catch (error) {
				settle(id, undefined, new Error(error instanceof Error ? error.message : String(error)));
			}
		});
	};
}

export const RuntimeMessageBridge = {
	generateBridgeCode(options: RuntimeMessageBridgeOptions): string {
		if (!options.sandboxId || !["sandbox-iframe", "user-script"].includes(options.context)) {
			throw new Error("Invalid runtime bridge options");
		}
		return `(${installRuntimeBridge.toString()})(${JSON.stringify(options).replace(/</g, "\\u003c")});`;
	},
};
