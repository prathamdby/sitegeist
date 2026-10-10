import type { Model } from "../../pi/models.js";
import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export type AutoDiscoveryProviderType = "ollama" | "llama.cpp" | "vllm" | "lmstudio";
export type CustomProviderType =
	| AutoDiscoveryProviderType
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages";

export interface CustomProvider {
	id: string;
	name: string;
	type: CustomProviderType;
	baseUrl: string;
	apiKey?: string;
	models?: Model[];
}

export class CustomProvidersStore extends Store {
	getConfig(): StoreConfig {
		return { name: "custom-providers" };
	}
	get(id: string): Promise<CustomProvider | null> {
		return this.getBackend().get("custom-providers", id);
	}
	set(provider: CustomProvider): Promise<void> {
		return this.getBackend().set("custom-providers", provider.id, provider);
	}
	delete(id: string): Promise<void> {
		return this.getBackend().delete("custom-providers", id);
	}
	has(id: string): Promise<boolean> {
		return this.getBackend().has("custom-providers", id);
	}
	async getAll(): Promise<CustomProvider[]> {
		const keys = await this.getBackend().keys("custom-providers");
		const values = await Promise.all(keys.map((key) => this.get(key)));
		return values.filter((value): value is CustomProvider => value !== null);
	}
}
