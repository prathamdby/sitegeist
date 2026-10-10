import { Store } from "../store.js";
import type { StoreConfig } from "../types.js";

export class SettingsStore extends Store {
	getConfig(): StoreConfig {
		return { name: "settings" };
	}
	get<T>(key: string): Promise<T | null> {
		return this.getBackend().get("settings", key);
	}
	set<T>(key: string, value: T): Promise<void> {
		return this.getBackend().set("settings", key, value);
	}
	delete(key: string): Promise<void> {
		return this.getBackend().delete("settings", key);
	}
	list(): Promise<string[]> {
		return this.getBackend().keys("settings");
	}
	clear(): Promise<void> {
		return this.getBackend().clear("settings");
	}
}
