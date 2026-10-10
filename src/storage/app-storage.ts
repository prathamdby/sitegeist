import { IndexedDBStorageBackend } from "./backends/indexeddb-storage-backend.js";
import { SessionsStore } from "./stores/base-sessions-store.js";
import { CostStore } from "./stores/cost-store.js";
import { CustomProvidersStore } from "./stores/custom-providers-store.js";
import { ProviderKeysStore } from "./stores/provider-keys-store.js";
import { SitegeistSessionsStore } from "./stores/sessions-store.js";
import { SettingsStore } from "./stores/settings-store.js";
import { SkillsStore } from "./stores/skills-store.js";
import type { StorageBackend } from "./types.js";

export class AppStorage {
	constructor(
		readonly settings: SettingsStore,
		readonly providerKeys: ProviderKeysStore,
		readonly sessions: SessionsStore,
		readonly customProviders: CustomProvidersStore,
		readonly backend: StorageBackend,
	) {}

	getQuotaInfo() {
		return this.backend.getQuotaInfo();
	}
	requestPersistence(): Promise<boolean> {
		return this.backend.requestPersistence();
	}
}

export class SitegeistAppStorage extends AppStorage {
	readonly skills: SkillsStore;
	readonly costs: CostStore;

	constructor() {
		const settings = new SettingsStore();
		const providerKeys = new ProviderKeysStore();
		const sessions = new SitegeistSessionsStore();
		const customProviders = new CustomProvidersStore();
		const skills = new SkillsStore();
		const costs = new CostStore();
		const stores = [settings, providerKeys, sessions, customProviders, skills, costs];
		const backend = new IndexedDBStorageBackend({
			dbName: "sitegeist-storage",
			version: 3,
			stores: [SessionsStore.getMetadataConfig(), ...stores.map((store) => store.getConfig())],
		});
		for (const store of stores) store.setBackend(backend);
		super(settings, providerKeys, sessions, customProviders, backend);
		this.skills = skills;
		this.costs = costs;
	}
}

let storage: AppStorage | undefined;

export function getAppStorage(): AppStorage {
	if (!storage) throw new Error("Application storage has not been initialized");
	return storage;
}

export function setAppStorage(value: AppStorage): void {
	storage = value;
}

export function getSitegeistStorage(): SitegeistAppStorage {
	const value = getAppStorage();
	if (!(value instanceof SitegeistAppStorage)) throw new Error("Sitegeist storage has not been initialized");
	return value;
}
