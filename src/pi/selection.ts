import { type Api, getModel, type Model, type ModelConfiguration } from "./models.js";

export const selectionRequiredModel: Model<Api> = {
	id: "",
	name: "Select a model",
	provider: "",
	api: "unknown",
	baseUrl: "",
	input: [],
	reasoning: false,
	contextWindow: 0,
	maxTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export const DEFAULT_MODELS: Record<string, string> = {
	"amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
	anthropic: "claude-sonnet-4-6",
	"azure-openai-responses": "gpt-5.2",
	cerebras: "zai-glm-4.6",
	"github-copilot": "gpt-4o",
	google: "gemini-2.5-flash",
	"google-vertex": "gemini-3-pro-preview",
	groq: "openai/gpt-oss-20b",
	huggingface: "moonshotai/Kimi-K2.5",
	"kimi-coding": "kimi-k2-thinking",
	minimax: "MiniMax-M2.1",
	"minimax-cn": "MiniMax-M2.1",
	mistral: "devstral-medium-latest",
	openai: "gpt-4o-mini",
	"openai-codex": "gpt-5.1-codex-mini",
	opencode: "claude-opus-4-6",
	"opencode-go": "kimi-k2.5",
	openrouter: "openai/gpt-5.1-codex",
	"vercel-ai-gateway": "anthropic/claude-opus-4-6",
	xai: "grok-4-fast-non-reasoning",
	zai: "glm-4.6",
};

export async function resolveInitialModel(
	configuration: ModelConfiguration,
	saved: unknown,
	hasSavedSelection: boolean,
	providers: readonly string[],
): Promise<Model> {
	const resolved = await configuration.resolveModel(saved);
	if (resolved) return resolved;
	if (hasSavedSelection) return selectionRequiredModel;
	for (const provider of providers) {
		const model = getModel(provider, DEFAULT_MODELS[provider]);
		if (model) return model;
	}
	return selectionRequiredModel;
}

export async function applyModelSelection(
	model: Model,
	agent: { setModel(model: Model): void },
	settings: { set(key: string, value: Model): Promise<void> },
	refresh: () => void,
): Promise<void> {
	agent.setModel(model);
	refresh();
	await settings.set("lastUsedModel", model);
}
