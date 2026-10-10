import type { Api, Model } from "@earendil-works/pi-ai";

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
