import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	lazyStream,
} from "@earendil-works/pi-ai";
import { streamSimple } from "./models.js";
import { clampRetryPolicy, DEFAULT_RETRY_POLICY, isThrottle429, type RetryPolicy } from "./retry-policy.js";

function createAbortError(): Error {
	const error = new Error("Request aborted");
	error.name = "AbortError";
	return error;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(createAbortError());
		};
		const timer = setTimeout(
			() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			Math.max(0, ms),
		);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function createSetupErrorMessage(
	model: { api: string; provider: string; id: string },
	error: unknown,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function createStreamFn(
	getProxyUrl: () => Promise<string | undefined>,
	getRetryPolicy?: () => Promise<RetryPolicy>,
): StreamFn {
	const invokeInner = (
		model: Parameters<StreamFn>[0],
		context: Parameters<StreamFn>[1],
		options: Parameters<StreamFn>[2],
	): AssistantMessageEventStream =>
		lazyStream(model, async () => {
			const proxyUrl = await getProxyUrl();
			const key = options?.apiKey ?? "";
			const needsProxy =
				model.provider === "zai" ||
				model.provider === "openai-codex" ||
				(model.provider === "anthropic" && (key.startsWith("sk-ant-oat") || key.startsWith("{")));
			const requestModel =
				proxyUrl && needsProxy && model.baseUrl
					? { ...model, baseUrl: `${proxyUrl}/?url=${encodeURIComponent(model.baseUrl)}` }
					: model;
			return streamSimple(requestModel, context, options);
		});

	return (model, context, options) => {
		const outer = createAssistantMessageEventStream();
		void (async () => {
			try {
				let retriesUsed = 0;
				for (;;) {
					let policy = DEFAULT_RETRY_POLICY;
					try {
						const resolved = await getRetryPolicy?.();
						if (resolved) {
							policy = clampRetryPolicy(resolved);
						}
					} catch {
						policy = DEFAULT_RETRY_POLICY;
					}
					const inner = invokeInner(model, context, options);
					const buffered: AssistantMessageEvent[] = [];
					let started = false;
					let failed: AssistantMessage | undefined;
					for await (const event of inner) {
						buffered.push(event);
						if (event.type === "start") {
							started = true;
							break;
						}
						if (event.type === "error") {
							failed = event.error;
							break;
						}
					}
					// Retry-After headers are deliberately ignored: the fixed delayMs alone is the policy.
					if (
						started ||
						failed === undefined ||
						!isThrottle429(failed.errorMessage ?? "") ||
						retriesUsed >= policy.maxRetries ||
						options?.signal?.aborted
					) {
						for (const event of buffered) {
							outer.push(event);
						}
						for await (const event of inner) {
							outer.push(event);
						}
						outer.end(await inner.result());
						return;
					}
					try {
						await abortableSleep(policy.delayMs, options?.signal);
					} catch {
						const aborted: AssistantMessage = {
							...failed,
							stopReason: "aborted",
							errorMessage: "Request aborted",
						};
						outer.push({ type: "error", reason: "aborted", error: aborted });
						outer.end(aborted);
						return;
					}
					retriesUsed += 1;
				}
			} catch (error) {
				const message = createSetupErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			}
		})();
		return outer;
	};
}
