import type { StreamFn } from "@earendil-works/pi-agent-core";
import { lazyStream } from "@earendil-works/pi-ai";
import { streamSimple } from "./models.js";

export function createStreamFn(getProxyUrl: () => Promise<string | undefined>): StreamFn {
	return (model, context, options) =>
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
}
