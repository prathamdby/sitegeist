import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export class ProviderKeysStore extends Store {
	getConfig(): StoreConfig {
		return { name: "provider-keys" };
	}
	get(provider: string): Promise<string | null> {
		return this.getBackend().get("provider-keys", provider);
	}
	set(provider: string, key: string): Promise<void> {
		return this.getBackend().set("provider-keys", provider, key);
	}
	delete(provider: string): Promise<void> {
		return this.getBackend().delete("provider-keys", provider);
	}
	list(): Promise<string[]> {
		return this.getBackend().keys("provider-keys");
	}
	has(provider: string): Promise<boolean> {
		return this.getBackend().has("provider-keys", provider);
	}
}
