import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { ArtifactsRuntimeProvider as BaselineProvider } from "../node_modules/@mariozechner/pi-web-ui/dist/components/sandbox/ArtifactsRuntimeProvider.js";
import { ArtifactsRuntimeProvider } from "../src/artifacts/ArtifactsRuntimeProvider.ts";

function fixture(Provider = ArtifactsRuntimeProvider, readWrite = true) {
	const mutations = [];
	const messages = [];
	const artifacts = new Map([
		["data.json", { content: '{"value":7}' }],
		["plain.txt", { content: "héllo" }],
		["broken.json", { content: "bad JSON" }],
		["__proto__", { content: "safe filename" }],
	]);
	const panel = {
		artifacts,
		tool: {
			async execute(id, args) {
				mutations.push({ id, ...args });
				if (args.filename === "reject.txt") throw new Error("Rejected mutation");
				if (args.command === "delete") artifacts.delete(args.filename);
				else artifacts.set(args.filename, { content: args.content });
				return { content: [{ type: "text", text: "Done" }] };
			},
		},
	};
	const provider = new Provider(panel, { appendMessage: (message) => messages.push(message) }, readWrite);
	return { provider, panel, mutations, messages };
}

function runtime(provider, sendRuntimeMessage) {
	const window = { ...structuredClone(provider.getData()), ...(sendRuntimeMessage ? { sendRuntimeMessage } : {}) };
	runInNewContext(`(${provider.getRuntime().toString()})("artifact-fixture")`, { window });
	return window;
}

function operation(provider, message) {
	return new Promise((resolve, reject) => {
		provider.handleMessage({ type: "artifact-operation", ...message }, resolve).catch(reject);
	});
}

test("artifact snapshot helpers match retained public reads and standalone write rejection", async () => {
	for (const Provider of [BaselineProvider, ArtifactsRuntimeProvider]) {
		const { provider, panel } = fixture(Provider);
		panel.artifacts.delete("__proto__");
		const target = runtime(provider);
		assert.deepEqual(JSON.parse(JSON.stringify(await target.listArtifacts())), [
			"data.json",
			"plain.txt",
			"broken.json",
		]);
		assert.deepEqual(JSON.parse(JSON.stringify(await target.getArtifact("data.json"))), { value: 7 });
		assert.equal(await target.getArtifact("plain.txt"), "héllo");
		await assert.rejects(target.getArtifact("broken.json"), /Failed to parse JSON from broken.json:/);
		await assert.rejects(target.getArtifact("missing.txt"), /Artifact not found \(offline mode\): missing.txt/);
		await assert.rejects(target.createOrUpdateArtifact("new.txt", "data"), /offline mode \(read-only\)/);
		await assert.rejects(target.deleteArtifact("plain.txt"), /offline mode \(read-only\)/);
	}
});

test("standalone snapshots preserve prototype-like filenames as own data properties", async () => {
	const { provider } = fixture();
	const target = runtime(provider);
	assert.equal(await target.getArtifact("__proto__"), "safe filename");
	assert.equal(Object.hasOwn(target.artifacts, "__proto__"), true);
	await assert.rejects(target.getArtifact("constructor"), /Artifact not found/);
});

test("online artifact writes use create/rewrite/delete and preserve reconstructible messages", async () => {
	const { provider, mutations, messages, panel } = fixture();
	const target = runtime(provider, (message) => operation(provider, message));
	await target.createOrUpdateArtifact("generated.json", { total: 3 });
	await target.createOrUpdateArtifact("generated.json", '{"total":4}');
	assert.deepEqual(JSON.parse(JSON.stringify(await target.getArtifact("generated.json"))), { total: 4 });
	await target.deleteArtifact("generated.json");
	assert.equal(panel.artifacts.has("generated.json"), false);
	assert.deepEqual(
		mutations.map(({ command }) => command),
		["create", "rewrite", "delete"],
	);
	assert.equal(mutations[0].content, '{\n  "total": 3\n}');
	assert.deepEqual(
		messages.map(({ role, action, filename }) => ({ role, action, filename })),
		[
			{ role: "artifact", action: "create", filename: "generated.json" },
			{ role: "artifact", action: "update", filename: "generated.json" },
			{ role: "artifact", action: "delete", filename: "generated.json" },
		],
	);
	assert.equal(messages[0].title, "generated.json");
	assert.ok(messages.every(({ timestamp }) => Number.isFinite(Date.parse(timestamp))));
	await assert.rejects(target.createOrUpdateArtifact("reject.txt", "data"), /Rejected mutation/);
	assert.equal(messages.length, 3);
});

test("read-only host rejects forged write/delete even when callers bypass runtime helpers", async () => {
	const { provider, mutations, messages, panel } = fixture(ArtifactsRuntimeProvider, false);
	for (const action of ["createOrUpdate", "delete"]) {
		const response = await operation(provider, { action, filename: "plain.txt", content: "forged" });
		assert.equal(response.success, false);
		assert.match(response.error, /read-only/);
	}
	assert.equal(panel.artifacts.get("plain.txt").content, "héllo");
	assert.deepEqual(mutations, []);
	assert.deepEqual(messages, []);
	assert.equal((await operation(provider, { action: "get", filename: "plain.txt" })).result, "héllo");
	assert.equal((await operation(provider, { action: "list" })).success, true);
});

test("malformed artifact operations and failed tools cannot append persisted mutations", async () => {
	const { provider, mutations, messages, panel } = fixture();
	for (const message of [
		{ action: "unsupported" },
		{ action: "createOrUpdate", filename: 7, content: "data" },
		{ action: "createOrUpdate", filename: "bad.txt", content: { invalid: true } },
		{ action: "delete", filename: null },
	])
		assert.equal((await operation(provider, message)).success, false);
	assert.equal(
		(await operation(provider, { action: "get", filename: "missing" })).error,
		"Artifact not found: missing",
	);
	assert.equal(mutations.length, 0);
	panel.tool.execute = async () => ({ isError: true, content: [{ type: "text", text: "Failed tool" }] });
	assert.deepEqual(await operation(provider, { action: "createOrUpdate", filename: "bad.txt", content: "data" }), {
		success: false,
		error: "Failed tool",
	});
	assert.deepEqual(messages, []);
});
