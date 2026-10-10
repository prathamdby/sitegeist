import type { IndexedDBConfig, StorageBackend, StorageTransaction } from "../types.js";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export class IndexedDBStorageBackend implements StorageBackend {
	private database?: Promise<IDBDatabase>;

	constructor(private readonly config: IndexedDBConfig) {}

	private open(): Promise<IDBDatabase> {
		if (!this.database) {
			this.database = new Promise((resolve, reject) => {
				const request = indexedDB.open(this.config.dbName, this.config.version);
				request.onupgradeneeded = () => {
					for (const config of this.config.stores) {
						if (request.result.objectStoreNames.contains(config.name)) continue;
						const store = request.result.createObjectStore(config.name, {
							keyPath: config.keyPath,
							autoIncrement: config.autoIncrement,
						});
						for (const index of config.indices ?? []) {
							store.createIndex(index.name, index.keyPath, { unique: index.unique });
						}
					}
				};
				request.onerror = () => {
					this.database = undefined;
					reject(request.error);
				};
				request.onsuccess = () => {
					const db = request.result;
					db.onversionchange = () => {
						db.close();
						this.database = undefined;
					};
					resolve(db);
				};
			});
		}
		return this.database;
	}

	private async run<T>(
		names: string[],
		mode: IDBTransactionMode,
		operation: (transaction: IDBTransaction) => Promise<T>,
	): Promise<T> {
		const db = await this.open();
		const transaction = db.transaction(names, mode);
		const completion = new Promise<void>((resolve, reject) => {
			transaction.oncomplete = () => resolve();
			transaction.onabort = () => reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError"));
			transaction.onerror = () => reject(transaction.error ?? new Error("Storage transaction failed"));
		});
		try {
			const [value] = await Promise.all([operation(transaction), completion]);
			return value;
		} catch (error) {
			try {
				transaction.abort();
			} catch {}
			await completion.catch(() => {});
			throw error;
		}
	}

	transaction<T>(
		names: string[],
		mode: "readonly" | "readwrite",
		operation: (tx: StorageTransaction) => Promise<T>,
	): Promise<T> {
		return this.run(names, mode, (transaction) =>
			operation({
				get: async <V>(name: string, key: string) =>
					(await requestResult<V | undefined>(transaction.objectStore(name).get(key))) ?? null,
				set: async <V>(name: string, key: string, value: V) => {
					const store = transaction.objectStore(name);
					await requestResult(store.keyPath === null ? store.put(value, key) : store.put(value));
				},
				delete: async (name: string, key: string) => {
					await requestResult(transaction.objectStore(name).delete(key));
				},
			}),
		);
	}

	get<T = unknown>(name: string, key: string): Promise<T | null> {
		return this.transaction([name], "readonly", (tx) => tx.get<T>(name, key));
	}

	set<T = unknown>(name: string, key: string, value: T): Promise<void> {
		return this.transaction([name], "readwrite", (tx) => tx.set(name, key, value));
	}

	delete(name: string, key: string): Promise<void> {
		return this.transaction([name], "readwrite", (tx) => tx.delete(name, key));
	}

	keys(name: string, prefix?: string): Promise<string[]> {
		return this.run([name], "readonly", async (tx) => {
			const range = prefix === undefined ? undefined : IDBKeyRange.bound(prefix, `${prefix}\uffff`);
			return (await requestResult(tx.objectStore(name).getAllKeys(range))).map(String);
		});
	}

	getAllFromIndex<T = unknown>(name: string, index: string, direction: "asc" | "desc" = "asc"): Promise<T[]> {
		return this.run(
			[name],
			"readonly",
			(tx) =>
				new Promise((resolve, reject) => {
					const values: T[] = [];
					const request = tx
						.objectStore(name)
						.index(index)
						.openCursor(null, direction === "desc" ? "prev" : "next");
					request.onerror = () => reject(request.error);
					request.onsuccess = () => {
						if (!request.result) return resolve(values);
						values.push(request.result.value as T);
						request.result.continue();
					};
				}),
		);
	}

	clear(name: string): Promise<void> {
		return this.run([name], "readwrite", async (tx) => {
			await requestResult(tx.objectStore(name).clear());
		});
	}

	has(name: string, key: string): Promise<boolean> {
		return this.run([name], "readonly", async (tx) => (await requestResult(tx.objectStore(name).count(key))) > 0);
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		const estimate = await globalThis.navigator?.storage?.estimate?.();
		const usage = estimate?.usage ?? 0;
		const quota = estimate?.quota ?? 0;
		return { usage, quota, percent: quota > 0 ? (usage / quota) * 100 : 0 };
	}

	async requestPersistence(): Promise<boolean> {
		return (await globalThis.navigator?.storage?.persist?.()) ?? false;
	}
}
