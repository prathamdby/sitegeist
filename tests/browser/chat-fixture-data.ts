import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getModel } from "../../src/pi/models.js";

export const model = getModel("anthropic", "claude-sonnet-4-5");
export const usage = {
	input: 1234,
	output: 234,
	cacheRead: 500,
	cacheWrite: 0,
	totalTokens: 1968,
	cost: { input: 0.003702, output: 0.00351, cacheRead: 0.00015, cacheWrite: 0, total: 0.007362 },
};

export function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function initialMessages() {
	return [
		{ role: "user" as const, content: "Summarize this page and suggest the next step.", timestamp: 0 },
		assistant(
			"The page contains a concise project overview.\n\n**Next step:** review the settings before continuing.",
		),
	];
}
