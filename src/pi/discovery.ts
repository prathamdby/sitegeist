import { LMStudioClient, type ModelInfo } from "@lmstudio/sdk";
import { Ollama } from "ollama/browser";
import type { Model } from "./models.js";

export type DiscoveryProviderType = "ollama" | "llama.cpp" | "vllm" | "lmstudio";

export interface DiscoveryOptions {
	fetch?: typeof fetch;
	createLMStudioClient?: (baseUrl: string) => {
		system: { listDownloadedModels(): Promise<readonly ModelInfo[]> };
		[Symbol.asyncDispose]?: () => Promise<void>;
	};
}

export function discoveryBaseUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Discovery requires an HTTP(S) server URL without embedded credentials");
	}
	if (url.search || url.hash) throw new Error("Discovery server URLs cannot contain a query or fragment");
	return baseUrl.replace(/\/+$/, "");
}

function positive(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function model(id: string, baseUrl: string, contextWindow: number, maxTokens: number): Model {
	return {
		id,
		name: id,
		provider: "",
		api: "openai-completions",
		baseUrl: `${baseUrl}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

export async function discoverModels(
	type: DiscoveryProviderType,
	baseUrl: string,
	apiKey?: string,
	options: DiscoveryOptions = {},
): Promise<Model[]> {
	const base = discoveryBaseUrl(baseUrl);
	if (type === "ollama") {
		const client = new Ollama({ host: base, fetch: options.fetch ?? globalThis.fetch });
		const listed = await client.list();
		const results = await Promise.all(
			listed.models.map(async (entry): Promise<Model | undefined> => {
				if (!entry.name) return undefined;
				try {
					const info = await client.show({ model: entry.name });
					if (!info.capabilities?.includes("tools")) return undefined;
					const metadata: unknown = info.model_info;
					const fields = metadata && typeof metadata === "object" ? metadata : {};
					const architecture = "general.architecture" in fields ? fields["general.architecture"] : undefined;
					const contextKey = typeof architecture === "string" ? `${architecture}.context_length` : "";
					const contextWindow = positive(contextKey in fields ? Reflect.get(fields, contextKey) : undefined, 8192);
					return {
						...model(entry.name, base, contextWindow, contextWindow * 10),
						reasoning: info.capabilities.includes("thinking"),
					};
				} catch {
					return undefined;
				}
			}),
		);
		return results.filter((entry): entry is Model => entry !== undefined);
	}
	if (type === "lmstudio") {
		const websocket = new URL(base);
		websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
		const client =
			options.createLMStudioClient?.(websocket.href.replace(/\/+$/, "")) ??
			new LMStudioClient({ baseUrl: websocket.href.replace(/\/+$/, "") });
		try {
			const listed = await client.system.listDownloadedModels();
			return listed.flatMap((entry): Model[] => {
				if (entry.type !== "llm" || !entry.path) return [];
				const contextWindow = positive(entry.maxContextLength, 8192);
				return [
					{
						...model(entry.path, base, contextWindow, contextWindow),
						name: entry.displayName,
						reasoning: entry.trainedForToolUse,
						input: entry.vision ? ["text", "image"] : ["text"],
					},
				];
			});
		} finally {
			await client[Symbol.asyncDispose]?.();
		}
	}
	const headers = new Headers({ "Content-Type": "application/json" });
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	const response = await (options.fetch ?? globalThis.fetch)(`${base}/v1/models`, { headers });
	if (!response.ok) throw new Error(`Model discovery failed (${response.status})`);
	const payload: unknown = await response.json();
	if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) {
		throw new Error("Invalid model discovery response");
	}
	return payload.data.flatMap((entry: unknown): Model[] => {
		if (!entry || typeof entry !== "object" || !("id" in entry) || typeof entry.id !== "string" || !entry.id) {
			return [];
		}
		const contextWindow = positive(Reflect.get(entry, type === "vllm" ? "max_model_len" : "context_length"), 8192);
		return [model(entry.id, base, contextWindow, type === "vllm" ? Math.min(contextWindow, 4096) : 4096)];
	});
}
