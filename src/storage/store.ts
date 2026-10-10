import type { StorageBackend, StoreConfig } from "./types.js";

export abstract class Store {
	private backend?: StorageBackend;
	abstract getConfig(): StoreConfig;

	setBackend(backend: StorageBackend): void {
		this.backend = backend;
	}

	protected getBackend(): StorageBackend {
		if (!this.backend) throw new Error("Storage backend has not been initialized");
		return this.backend;
	}
}
