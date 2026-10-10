import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createModels,
	createProvider,
	type JsonValue,
	lazyStream,
	type ModelsApiStreamOptions,
	type ModelsSimpleStreamOptions,
	type MutableModels,
	type Model as PiModel,
	type Provider as PiProvider,
	type ToolResultMessage as PiToolResultMessage,
	type ProviderId,
	type ProviderStreams,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { azureOpenAIResponsesApi } from "@earendil-works/pi-ai/api/azure-openai-responses.lazy";
import { bedrockConverseStreamApi } from "@earendil-works/pi-ai/api/bedrock-converse-stream.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { googleVertexApi } from "@earendil-works/pi-ai/api/google-vertex.lazy";
import { mistralConversationsApi } from "@earendil-works/pi-ai/api/mistral-conversations.lazy";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { piMessagesApi } from "@earendil-works/pi-ai/api/pi-messages.lazy";
import { amazonBedrockProvider } from "@earendil-works/pi-ai/providers/amazon-bedrock";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";

export type * from "@earendil-works/pi-ai";
export { modelsAreEqual, StringEnum } from "@earendil-works/pi-ai";

export type Model<TApi extends Api = Api> = PiModel<TApi>;
export type Provider = ProviderId;
export type ToolResultMessage<TDetails = JsonValue> = Omit<PiToolResultMessage, "details"> & {
	details?: TDetails;
};
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
	model: Model<TApi>,
	context: Context,
	options?: TOptions,
) => AssistantMessageEventStream;

const removedProviders = new Set(["google-gemini-cli", "google-antigravity"]);

export function isRemovedProvider(provider: string): boolean {
	return removedProviders.has(provider);
}
const customApis: ReadonlyMap<Api, ProviderStreams> = new Map([
	["anthropic-messages", anthropicMessagesApi()],
	["azure-openai-responses", azureOpenAIResponsesApi()],
	["bedrock-converse-stream", bedrockConverseStreamApi()],
	["google-generative-ai", googleGenerativeAIApi()],
	["google-vertex", googleVertexApi()],
	["mistral-conversations", mistralConversationsApi()],
	["openai-codex-responses", openAICodexResponsesApi()],
	["openai-completions", openAICompletionsApi()],
	["openai-responses", openAIResponsesApi()],
	["pi-messages", piMessagesApi()],
]);

export function createModelRegistry(): MutableModels {
	const registry = createModels();
	const azure = azureProvider();
	const azureModels = azure.getModels().map((model) => ({ ...model, provider: "azure-openai-responses" }));
	const azureAllModels = (azure.getAllModels?.() ?? azure.getModels()).map((model) => ({
		...model,
		provider: "azure-openai-responses",
	}));
	const codex = openaiCodexProvider();
	const providers: PiProvider[] = [
		amazonBedrockProvider(),
		anthropicProvider(),
		{
			...azure,
			id: "azure-openai-responses",
			getModels: () => azureModels,
			getAllModels: () => azureAllModels,
		},
		cerebrasProvider(),
		githubCopilotProvider(),
		googleProvider(),
		googleVertexProvider(),
		groqProvider(),
		huggingfaceProvider(),
		kimiCodingProvider(),
		minimaxProvider(),
		minimaxCnProvider(),
		mistralProvider(),
		openaiProvider(),
		{
			...codex,
			auth: {
				...codex.auth,
				apiKey: {
					name: "Application-resolved ChatGPT token",
					resolve: async ({ credential, signal }) => {
						signal.throwIfAborted();
						return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
					},
				},
			},
		},
		opencodeProvider(),
		opencodeGoProvider(),
		openrouterProvider(),
		vercelAIGatewayProvider(),
		xaiProvider(),
		zaiProvider(),
	];
	for (const provider of providers) registry.setProvider(provider);
	return registry;
}

export const modelRegistry = createModelRegistry();

export function getProviders(): string[] {
	return modelRegistry.getProviders().map((provider) => provider.id);
}

export function getModels(provider: string): Model[] {
	return [...modelRegistry.getModels(provider)];
}

export function getModel(provider: string, id: string): Model | undefined {
	return modelRegistry.getModel(provider, id);
}

export interface CustomModelProvider {
	id: string;
	name: string;
	type: string;
	baseUrl: string;
	apiKey?: string;
	models?: readonly Model[];
}

export class ModelConfiguration {
	constructor(private readonly readProviders: () => Promise<readonly CustomModelProvider[]>) {}

	async getProviders(): Promise<readonly CustomModelProvider[]> {
		return (await this.readProviders()).filter(
			(provider) => !isRemovedProvider(provider.id) && !isRemovedProvider(provider.name),
		);
	}

	async getProvider(id: string): Promise<CustomModelProvider | undefined> {
		return (await this.getProviders()).find((provider) => provider.id === id || provider.name === id);
	}

	async resolveModel(saved: unknown): Promise<Model | undefined> {
		const providers = await this.getProviders();
		return rehydrateModel(
			saved,
			providers.flatMap((provider) => provider.models ?? []),
			providers,
		);
	}
}

export function rehydrateModel(
	saved: unknown,
	customModels: readonly Model[] = [],
	configuredCustomProviders: readonly CustomModelProvider[] = [],
): Model | undefined {
	if (
		!saved ||
		typeof saved !== "object" ||
		!("provider" in saved) ||
		!("id" in saved) ||
		typeof saved.provider !== "string" ||
		typeof saved.id !== "string" ||
		removedProviders.has(saved.provider)
	) {
		return undefined;
	}
	const builtin = getModel(saved.provider, saved.id);
	if (builtin) return builtin;
	if (modelRegistry.getProvider(saved.provider)) return undefined;
	const custom = customModels.find((model) => model.provider === saved.provider && model.id === saved.id);
	if (custom && customApis.has(custom.api)) return savedCustomModel({ ...custom });
	const configured = configuredCustomProviders.find(
		(provider) => provider.id === saved.provider || provider.name === saved.provider,
	);
	if (
		!configured ||
		isRemovedProvider(configured.id) ||
		isRemovedProvider(configured.name) ||
		!["ollama", "llama.cpp", "vllm", "lmstudio"].includes(configured.type) ||
		!isRecord(saved)
	)
		return undefined;
	return savedCustomModel({
		...saved,
		api: "openai-completions",
		baseUrl: `${configured.baseUrl.replace(/\/+$/, "")}/v1`,
		headers: undefined,
		compat: undefined,
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function savedCustomModel(saved: Record<string, unknown>): Model | undefined {
	if (
		typeof saved.id !== "string" ||
		!saved.id ||
		typeof saved.provider !== "string" ||
		!saved.provider ||
		typeof saved.name !== "string" ||
		typeof saved.api !== "string" ||
		!customApis.has(saved.api) ||
		typeof saved.baseUrl !== "string" ||
		!saved.baseUrl ||
		typeof saved.reasoning !== "boolean" ||
		typeof saved.contextWindow !== "number" ||
		!Number.isFinite(saved.contextWindow) ||
		saved.contextWindow <= 0 ||
		typeof saved.maxTokens !== "number" ||
		!Number.isFinite(saved.maxTokens) ||
		saved.maxTokens <= 0 ||
		!Array.isArray(saved.input) ||
		!saved.input.every((input: unknown) => input === "text" || input === "image") ||
		!isRecord(saved.cost) ||
		typeof saved.cost.input !== "number" ||
		typeof saved.cost.output !== "number" ||
		typeof saved.cost.cacheRead !== "number" ||
		typeof saved.cost.cacheWrite !== "number" ||
		![saved.cost.input, saved.cost.output, saved.cost.cacheRead, saved.cost.cacheWrite].every(
			(rate) => Number.isFinite(rate) && rate >= 0,
		) ||
		(saved.type !== undefined && saved.type !== "chat")
	) {
		return undefined;
	}
	const input: ("text" | "image")[] = [];
	for (const modality of saved.input) {
		if (modality === "text" || modality === "image") input.push(modality);
	}
	const headers: Record<string, string> = {};
	if (saved.headers !== undefined) {
		if (!isRecord(saved.headers)) return undefined;
		for (const [name, value] of Object.entries(saved.headers)) {
			if (typeof value !== "string") return undefined;
			headers[name] = value;
		}
	}
	try {
		const url = new URL(saved.baseUrl);
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
		new Headers(headers);
	} catch {
		return undefined;
	}
	return {
		...saved,
		id: saved.id,
		provider: saved.provider,
		name: saved.name,
		api: saved.api,
		baseUrl: saved.baseUrl,
		reasoning: saved.reasoning,
		contextWindow: saved.contextWindow,
		maxTokens: saved.maxTokens,
		input,
		cost: {
			...saved.cost,
			input: saved.cost.input,
			output: saved.cost.output,
			cacheRead: saved.cost.cacheRead,
			cacheWrite: saved.cost.cacheWrite,
		},
		headers: saved.headers === undefined ? undefined : headers,
		type: saved.type,
	};
}

function requestRegistry(model: Model): MutableModels {
	if (removedProviders.has(model.provider)) throw new Error(`Provider has been removed: ${model.provider}`);
	if (modelRegistry.getProvider(model.provider)) return modelRegistry;
	const api = customApis.get(model.api);
	if (!api) throw new Error(`Unsupported model API: ${model.api}`);
	const keylessOpenAI = model.api === "openai-completions" || model.api === "openai-responses";
	const registry = createModels();
	registry.setProvider(
		createProvider({
			id: model.provider,
			name: model.provider,
			models: [model],
			auth: {
				apiKey: {
					name: "Application-resolved custom provider key",
					resolve: async ({ credential, signal }) => {
						signal.throwIfAborted();
						return {
							auth: {
								apiKey: credential?.key ?? (keylessOpenAI ? "unused" : undefined),
								headers: keylessOpenAI && !credential?.key ? { Authorization: null } : undefined,
							},
						};
					},
				},
			},
			api,
		}),
	);
	return registry;
}

export function streamSimple(
	model: Model,
	context: Context,
	options?: ModelsSimpleStreamOptions,
): AssistantMessageEventStream {
	return lazyStream(model, async () => requestRegistry(model).streamSimple(model, context, options));
}

export function complete<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: ModelsApiStreamOptions<TApi>,
): Promise<AssistantMessage> {
	return lazyStream(model, async () => requestRegistry(model).stream(model, context, options)).result();
}
