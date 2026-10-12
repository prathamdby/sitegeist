import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { build } from "esbuild";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import Fuse from "fuse.js";
import { browserMessageTransformer } from "../src/messages/message-transformer.ts";
import { Agent } from "../src/pi/agent.ts";
import { getModel } from "../src/pi/models.ts";
import { getAppStorage, getSitegeistStorage, SitegeistAppStorage, setAppStorage } from "../src/storage/app-storage.ts";
import { IndexedDBStorageBackend } from "../src/storage/backends/indexeddb-storage-backend.ts";
import { SessionsStore } from "../src/storage/stores/base-sessions-store.ts";
import { SettingsStore } from "../src/storage/stores/settings-store.ts";

const schema = [
	{ name: "settings" },
	{ name: "provider-keys" },
	{ name: "custom-providers" },
	{ name: "sessions", keyPath: "id", indices: [{ name: "lastModified", keyPath: "lastModified" }] },
	{ name: "sessions-metadata", keyPath: "id", indices: [{ name: "lastModified", keyPath: "lastModified" }] },
	{ name: "skills" },
	{ name: "daily_costs", keyPath: "date", indices: [{ name: "date", keyPath: "date", unique: true }] },
];
const usage = {
	input: 2,
	output: 3,
	cacheRead: 4,
	cacheWrite: 5,
	totalTokens: 14,
	cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
};
const model = {
	id: "historic-custom",
	name: "Saved custom model",
	provider: "custom-fixture",
	api: "openai-completions",
	baseUrl: "https://fixture.invalid/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
	unknownModelField: { keep: true },
};
const attachment = {
	id: "binary",
	type: "image",
	fileName: "fixture.png",
	mimeType: "image/png",
	size: 4,
	content: "AAH+/w==",
	preview: "AAH+/w==",
};
const messages = [
	{ role: "user-with-attachments", content: "", attachments: [attachment], timestamp: 1 },
	{ role: "navigation", url: "https://fixture.invalid", timestamp: 2, unknown: true },
	{ role: "welcome", timestamp: 3 },
	{ role: "toolResult", toolCallId: "legacy-tool", toolName: "browserjs", output: "legacy output", timestamp: 4 },
	{ role: "artifact", action: "create", filename: "saved.html", content: "<b>Fixture</b>", timestamp: "2026-01-01" },
	{ role: "future-role", payload: { preserve: [1, 2] } },
];
const data = {
	id: "older",
	title: "Historic research",
	model,
	thinkingLevel: "medium",
	messages,
	createdAt: "2026-01-01T00:00:00.000Z",
	lastModified: "2026-01-02T00:00:00.000Z",
	extra: "preserved",
};
const metadata = {
	id: data.id,
	title: data.title,
	createdAt: data.createdAt,
	lastModified: data.lastModified,
	messageCount: messages.length,
	usage,
	thinkingLevel: "medium",
	preview: "Needle in persisted preview",
	modelId: model.id,
};
const skill = {
	name: "fixture-skill",
	domainPatterns: ["fixture.invalid/*"],
	shortDescription: "Fixture",
	description: "Sanitized skill",
	createdAt: data.createdAt,
	lastUpdated: data.lastModified,
	examples: "example",
	library: "const fixture = true;",
};
const provider = {
	id: "custom-fixture",
	name: "Fixture",
	type: "openai-completions",
	baseUrl: model.baseUrl,
	apiKey: "sanitized-not-a-secret",
	models: [model],
};
const oauth = JSON.stringify({ type: "oauth", access: "sanitized-access", refresh: "sanitized-refresh", expires: 0 });

function requestResult(request) {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

async function fixture() {
	globalThis.indexedDB = new IDBFactory();
	globalThis.IDBKeyRange = IDBKeyRange;
	const request = indexedDB.open("sitegeist-storage", 3);
	request.onupgradeneeded = () => {
		for (const config of schema) {
			const store = request.result.createObjectStore(config.name, { keyPath: config.keyPath });
			for (const index of config.indices ?? [])
				store.createIndex(index.name, index.keyPath, { unique: !!index.unique });
		}
	};
	const db = await requestResult(request);
	const tx = db.transaction(
		schema.map((store) => store.name),
		"readwrite",
	);
	const complete = new Promise((resolve, reject) => {
		tx.oncomplete = resolve;
		tx.onabort = () => reject(tx.error);
	});
	tx.objectStore("sessions").put(data);
	tx.objectStore("sessions").put({ ...data, id: "newer", lastModified: "2026-02-01T00:00:00.000Z" });
	tx.objectStore("sessions-metadata").put(metadata);
	tx.objectStore("sessions-metadata").put({ ...metadata, id: "newer", lastModified: "2026-02-01T00:00:00.000Z" });
	tx.objectStore("settings").put(true, "proxy.enabled");
	tx.objectStore("settings").put("http://localhost:3001", "proxy.url");
	tx.objectStore("settings").put(model, "lastUsedModel");
	tx.objectStore("provider-keys").put("sanitized-api-key", "openai");
	tx.objectStore("provider-keys").put(oauth, "anthropic");
	tx.objectStore("provider-keys").put("sanitized-removed-provider", "google-gemini-cli");
	tx.objectStore("custom-providers").put(provider, provider.id);
	tx.objectStore("skills").put(skill, skill.name);
	tx.objectStore("daily_costs").put({
		date: "2026-01-01",
		total: 1.5,
		byProvider: { openai: { "gpt-4o-mini": 1.5 } },
	});
	await complete;
	db.close();
	return new SitegeistAppStorage();
}

test("version-3 fixtures retain schema, unknown records, search, rename, export/import, and resume", async () => {
	const storage = await fixture();
	const request = indexedDB.open("sitegeist-storage", 3);
	let upgrades = 0;
	request.onupgradeneeded = () => upgrades++;
	const db = await requestResult(request);
	assert.equal(db.version, 3);
	assert.equal(upgrades, 0);
	assert.deepEqual([...db.objectStoreNames].sort(), schema.map((s) => s.name).sort());
	for (const config of schema) {
		const store = db.transaction(config.name).objectStore(config.name);
		assert.equal(store.keyPath, config.keyPath ?? null);
		assert.equal(store.autoIncrement, false);
		assert.deepEqual(
			[...store.indexNames],
			(config.indices ?? []).map((i) => i.name),
		);
		for (const index of config.indices ?? []) {
			assert.equal(store.index(index.name).keyPath, index.keyPath);
			assert.equal(store.index(index.name).unique, !!index.unique);
		}
	}
	db.close();
	const restored = await storage.sessions.loadSession("older");
	assert.deepEqual(await storage.sessions.get("older"), restored);
	assert.deepEqual(restored.model, model);
	assert.equal(restored.extra, "preserved");
	assert.deepEqual(restored.messages[3].content, [{ type: "text", text: "legacy output" }]);
	assert.equal("output" in restored.messages[3], false);
	assert.deepEqual(
		restored.messages.filter((_, i) => i !== 3),
		messages.filter((_, i) => i !== 3),
	);
	assert.deepEqual(Buffer.from(restored.messages[0].attachments[0].content, "base64"), Buffer.from([0, 1, 254, 255]));
	assert.deepEqual(
		await storage.backend.get("sessions", "older"),
		data,
		"read migration never rewrites stored messages",
	);
	const list = await storage.sessions.getAllMetadata();
	assert.deepEqual(
		list.map((s) => s.id),
		["newer", "older"],
	);
	assert.equal(await storage.sessions.getLatestSessionId(), "newer");
	const search = new Fuse(list, {
		keys: ["title", "preview"],
		threshold: 0.4,
		ignoreLocation: true,
		minMatchCharLength: 2,
	});
	assert.equal(search.search("Needle").length, 2);
	await storage.sessions.updateTitle("older", "Renamed");
	assert.deepEqual(await storage.sessions.getMetadata("older"), { ...metadata, title: "Renamed" });
	assert.deepEqual(await storage.backend.get("sessions", "older"), { ...data, title: "Renamed" });
	assert.deepEqual(
		(await storage.sessions.getAllMetadata()).map((s) => s.id),
		["newer", "older"],
	);
	await storage.sessions.updateTitle("missing", "No new records");
	assert.equal(await storage.sessions.get("missing"), null);
	assert.equal(await storage.sessions.getMetadata("missing"), null);
	const exported = JSON.parse(JSON.stringify({ session: restored, metadata }));
	await storage.sessions.save({ ...exported.session, id: "imported" }, { ...exported.metadata, id: "imported" });
	assert.deepEqual((await storage.sessions.loadSession("imported")).messages, restored.messages);
	const agent = new Agent({
		initialState: { model: getModel("openai", "gpt-4o-mini"), systemPrompt: "Fixture prompt" },
		convertToLlm: browserMessageTransformer,
		streamFn: () => {
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "Resumed" }],
				api: "openai-completions",
				provider: "openai",
				model: "gpt-4o-mini",
				stopReason: "stop",
				timestamp: 10,
				usage,
			};
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	agent.replaceMessages(restored.messages);
	assert.deepEqual(agent.state.messages.slice(1), restored.messages);
	assert.equal(agent.state.messages[0].role, "system");
	await agent.prompt("Continue fixture");
	assert.equal(agent.state.messages.at(-1).content[0].text, "Resumed");
	assert.deepEqual(await storage.backend.get("sessions", "older"), { ...data, title: "Renamed" });
	await storage.sessions.deleteSession("newer");
	assert.equal(await storage.sessions.get("newer"), null);
	assert.equal(await storage.sessions.getMetadata("newer"), null);
});

test("settings, opaque credentials, providers, skills and daily costs keep old records and operations", async () => {
	const storage = await fixture();
	assert.equal(await storage.settings.get("proxy.enabled"), true);
	assert.equal(await storage.settings.get("proxy.url"), "http://localhost:3001");
	assert.deepEqual(await storage.settings.get("lastUsedModel"), model);
	assert.equal(await storage.providerKeys.get("anthropic"), oauth);
	assert.equal(await storage.providerKeys.get("openai"), "sanitized-api-key");
	assert.equal(await storage.providerKeys.get("google-gemini-cli"), "sanitized-removed-provider");
	assert.deepEqual(await storage.customProviders.getAll(), [provider]);
	assert.deepEqual(await storage.skills.getSkillsForUrl("https://fixture.invalid/path"), [skill]);
	assert.deepEqual(await storage.skills.list("https://other.invalid"), []);
	assert.equal(await storage.costs.getTotalCost(), 1.5);
	assert.deepEqual(await storage.costs.getCostsByModel(), { "openai:gpt-4o-mini": 1.5 });
	await Promise.all(Array.from({ length: 10 }, () => storage.costs.recordCost("openai", "gpt-4o-mini", 0.5)));
	assert.equal(await storage.costs.getTotalCost(), 6.5);
	assert.deepEqual(await storage.costs.getCostsByProvider(), { openai: 6.5 });
	assert.equal(
		(await storage.costs.getCostsByDateRange(new Date("2026-01-01"), new Date("2026-01-01")))[0].total,
		1.5,
	);
	await storage.settings.set("proxy.enabled", false);
	await storage.settings.delete("proxy.url");
	assert.equal(await storage.settings.get("proxy.url"), null);
	assert.deepEqual(await storage.backend.keys("settings", "proxy."), ["proxy.enabled"]);
	await storage.providerKeys.set("fixture", oauth);
	assert.equal(await storage.providerKeys.has("fixture"), true);
	await storage.providerKeys.delete("fixture");
	assert.equal(await storage.providerKeys.has("fixture"), false);
	await storage.customProviders.set({ ...provider, name: "Edited" });
	assert.equal((await storage.customProviders.get(provider.id)).name, "Edited");
	await storage.customProviders.delete(provider.id);
	assert.equal(await storage.customProviders.has(provider.id), false);
	await storage.skills.saveSkill({ ...skill, description: "Edited" });
	assert.equal((await storage.skills.getSkill(skill.name)).description, "Edited");
	await storage.skills.deleteSkill(skill.name);
	assert.deepEqual(await storage.skills.listSkills(), []);
	await storage.settings.clear();
	assert.deepEqual(await storage.settings.list(), []);
	assert.ok((await storage.providerKeys.list()).includes("anthropic"));
});

test("writes, renames and deletes abort together and resolve only after transaction completion", async () => {
	const storage = await fixture();
	const original = indexedDB.open.bind(indexedDB);
	const request = original("sitegeist-storage", 3);
	const db = await requestResult(request);
	const transaction = db.transaction.bind(db);
	const abortedBackend = new IndexedDBStorageBackend({ dbName: "sitegeist-storage", version: 3, stores: schema });
	indexedDB.open = (...args) => {
		const open = original(...args);
		open.addEventListener("success", () => {
			const nativeTransaction = open.result.transaction.bind(open.result);
			open.result.transaction = (...txArgs) => {
				const tx = nativeTransaction(...txArgs);
				const objectStore = tx.objectStore.bind(tx);
				tx.objectStore = (name) => {
					const store = objectStore(name);
					for (const method of ["put", "delete"]) {
						const native = store[method].bind(store);
						store[method] = (...values) => {
							const result = native(...values);
							if (name === "sessions-metadata") result.addEventListener("success", () => tx.abort());
							return result;
						};
					}
					return store;
				};
				return tx;
			};
		});
		return open;
	};
	const sessions = new SessionsStore();
	sessions.setBackend(abortedBackend);
	await assert.rejects(sessions.save({ ...data, title: "Uncommitted" }, { ...metadata, title: "Uncommitted" }), {
		name: "AbortError",
	});
	await assert.rejects(sessions.updateTitle("older", "Uncommitted"), { name: "AbortError" });
	await assert.rejects(sessions.delete("older"), { name: "AbortError" });
	assert.deepEqual(await storage.backend.get("sessions", "older"), data);
	assert.deepEqual(await storage.sessions.getMetadata("older"), metadata);
	indexedDB.open = original;
	db.transaction = transaction;
	db.close();
	await assert.rejects(
		storage.backend.transaction(["settings"], "readwrite", async (tx) => {
			await tx.set("settings", "rollback", 1);
			throw new Error("operation failed");
		}),
		/operation failed/,
	);
	assert.equal(await storage.settings.get("rollback"), null);
	await assert.rejects(storage.sessions.save(data, { ...metadata, id: "wrong-id" }), /IDs must match/);
	await assert.rejects(
		storage.sessions.save({ ...data, id: "invalid" }, { ...metadata, id: "invalid", uncloneable: () => {} }),
	);
	assert.equal(await storage.sessions.get("invalid"), null);
});

test("independent version-3 reader can reopen every new record without a schema upgrade", async () => {
	const storage = await fixture();
	const passedMetadata = {
		...metadata,
		id: "saved",
		messageCount: 1,
		preview: "Caller preview",
		lastModified: data.createdAt,
	};
	await storage.sessions.saveSession(
		"saved",
		{ model, messages, thinkingLevel: "high" },
		passedMetadata,
		"Saved title",
	);
	await storage.sessions.saveSession("no-metadata", { model, messages, thinkingLevel: "off" }, undefined);
	const stub = await storage.sessions.getMetadata("no-metadata");
	assert.deepEqual(stub, {
		id: "no-metadata",
		title: "",
		createdAt: stub.createdAt,
		lastModified: stub.createdAt,
		messageCount: messages.length,
		thinkingLevel: "off",
		preview: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	});
	assert.equal(new Date(stub.createdAt).toISOString(), stub.createdAt);
	assert.equal((await storage.sessions.get("no-metadata")).createdAt, stub.createdAt);
	assert.deepEqual(await storage.sessions.getMetadata("saved"), passedMetadata);
	assert.equal((await storage.sessions.getAllMetadata()).at(-1).id, "saved");
	await storage.settings.set("new-setting", { arbitrary: [true, 3] });
	await storage.providerKeys.set("new-provider", oauth);
	await storage.customProviders.set({ ...provider, id: "new-custom" });
	await storage.skills.saveSkill({ ...skill, name: "new-skill" });
	await storage.costs.recordCost("fixture", "historic-custom", 2);
	const db = await requestResult(indexedDB.open("sitegeist-storage", 3));
	const readRecord = (store, key) => requestResult(db.transaction(store, "readonly").objectStore(store).get(key));
	const saved = await readRecord("sessions", "saved");
	assert.equal(saved.title, "Saved title");
	assert.deepEqual(saved.model, model);
	assert.deepEqual(saved.messages, messages);
	assert.equal(saved.createdAt, data.createdAt);
	assert.deepEqual(await readRecord("sessions-metadata", "saved"), passedMetadata);
	assert.equal((await readRecord("sessions", "no-metadata")).title, "");
	assert.deepEqual(await readRecord("sessions-metadata", "no-metadata"), stub);
	assert.deepEqual(await readRecord("settings", "new-setting"), { arbitrary: [true, 3] });
	assert.equal(await readRecord("provider-keys", "new-provider"), oauth);
	assert.deepEqual(await readRecord("custom-providers", "new-custom"), { ...provider, id: "new-custom" });
	assert.deepEqual(await readRecord("skills", "new-skill"), { ...skill, name: "new-skill" });
	assert.equal(
		(await readRecord("daily_costs", new Date().toISOString().slice(0, 10))).byProvider.fixture["historic-custom"],
		2,
	);
	db.close();
	const reopened = new SitegeistAppStorage();
	assert.equal((await reopened.sessions.get("saved")).title, "Saved title");
});

test("inline keys come from the record while out-of-line keys come from the supplied key", async () => {
	const storage = await fixture();
	const value = { ...data, id: "keypath-id" };
	await storage.backend.transaction(["sessions", "settings"], "readwrite", async (tx) => {
		await tx.set("sessions", "explicit-key", value);
		await tx.set("settings", "explicit-key", value);
	});
	assert.deepEqual(await storage.backend.get("sessions", "keypath-id"), value);
	assert.equal(await storage.backend.get("sessions", "explicit-key"), null);
	assert.deepEqual(await storage.settings.get("explicit-key"), value);
	assert.equal(await storage.settings.get("keypath-id"), null);
});

test("unwired stores fail explicitly; quota and persistence forward browser capabilities", async () => {
	assert.throws(() => new SettingsStore().get("key"), /not been initialized/);
	assert.throws(() => getAppStorage(), /not been initialized/);
	const storage = await fixture();
	setAppStorage(storage);
	assert.equal(getAppStorage(), storage);
	assert.equal(getSitegeistStorage(), storage);
	assert.deepEqual(await storage.getQuotaInfo(), { usage: 0, quota: 0, percent: 0 });
	assert.equal(await storage.requestPersistence(), false);
	Object.defineProperty(globalThis.navigator, "storage", {
		configurable: true,
		value: {
			estimate: async () => ({ usage: 20, quota: 100 }),
			persist: async () => true,
		},
	});
	assert.deepEqual(await storage.sessions.getQuotaInfo(), { usage: 20, quota: 100, percent: 20 });
	assert.equal(await storage.sessions.requestPersistence(), true);
	delete globalThis.navigator.storage;
});

test("browser bundle uses one application-owned storage singleton and the local sessions class", async () => {
	const outdir = mkdtempSync(join(tmpdir(), "sitegeist-storage-tests-"));
	if (lstatSync(outdir).isSymbolicLink()) throw new Error(`scratch directory is a symlink: ${outdir}`);
	chmodSync(outdir, 0o700);
	await mkdir(join(outdir, "unrelated/storage"), { recursive: true });
	const unrelated = join(outdir, "unrelated/storage/fixture.js");
	await writeFile(unrelated, "export const unrelated = 'unchanged';\n");
	const outfile = join(outdir, "bridge.mjs");
	const result = await build({
		stdin: {
			contents: `import { getSitegeistStorage as sharedGet } from './src/storage/app-storage.ts';
			import { SessionsStore as LocalSessions } from './src/storage/stores/base-sessions-store.ts';
			import { unrelated } from ${JSON.stringify(unrelated)};
			import { SitegeistAppStorage, getAppStorage, setAppStorage } from './src/storage/app-storage.ts';
			export { sharedGet, getAppStorage, setAppStorage, SitegeistAppStorage, LocalSessions, unrelated };`,
			resolveDir: process.cwd(),
		},
		outfile,
		bundle: true,
		platform: "browser",
		format: "esm",
		metafile: true,
	});
	assert.equal(
		Object.keys(result.metafile.inputs).some((path) => /node_modules\/.*storage\//.test(path)),
		false,
	);
	assert.ok((await readFile(outfile, "utf8")).includes("sitegeist-storage"));
	assert.ok(Object.keys(result.metafile.inputs).includes("src/storage/stores/base-sessions-store.ts"));
	assert.ok(Object.keys(result.metafile.inputs).some((path) => path.endsWith("unrelated/storage/fixture.js")));
	await promisify(execFile)(process.execPath, [
		"--input-type=module",
		"-e",
		`
		import assert from 'node:assert/strict';
		import { indexedDB, IDBKeyRange } from '${pathToFileURL(join(process.cwd(), "node_modules/fake-indexeddb/build/esm/index.js")).href}';
		import * as bundle from '${pathToFileURL(outfile).href}';
		globalThis.indexedDB = indexedDB;
		globalThis.IDBKeyRange = IDBKeyRange;
		const shared = new bundle.SitegeistAppStorage();
		assert.ok(shared.sessions instanceof bundle.LocalSessions);
		assert.equal(bundle.unrelated, 'unchanged');
		bundle.setAppStorage(shared);
		assert.equal(bundle.sharedGet(), bundle.getAppStorage());
		assert.equal(bundle.sharedGet().backend, shared.backend);
		await bundle.sharedGet().settings.set('via-local-ui', true);
		assert.equal(await shared.settings.get('via-local-ui'), true);
		assert.equal(await new bundle.SitegeistAppStorage().settings.get('via-local-ui'), true);
	`,
	]);
});
