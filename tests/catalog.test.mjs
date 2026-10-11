import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverModels } from "../src/pi/discovery.js";
import { getModels, ModelConfiguration, streamSimple } from "../src/pi/models.js";

const local = {
	id: "fixture-model",
	name: "Fixture model",
	provider: "Local fixture",
	api: "openai-completions",
	baseUrl: "https://obsolete.invalid/v1",
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 16384,
	maxTokens: 2048,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function provider(overrides = {}) {
	return {
		id: "fixture-provider",
		name: "Local fixture",
		type: "openai-completions",
		baseUrl: "https://current.invalid/v1",
		models: [{ ...local, baseUrl: "https://current.invalid/v1" }],
		...overrides,
	};
}

test("manual catalog combines builtins and current custom routes and filters by provider name", async () => {
	const providers = [
		provider(),
		provider({ id: "removed", name: "google-antigravity" }),
		provider({ id: "collision", name: "openai" }),
	];
	const before = structuredClone(providers);
	const configuration = new ModelConfiguration(async () => providers);
	const catalog = await configuration.getModels(["anthropic", "Local fixture", "google-antigravity"]);
	assert.equal(catalog.length, getModels("anthropic").length + 1);
	assert.equal(catalog.at(-1).baseUrl, "https://current.invalid/v1");
	assert.equal(catalog.at(-1).provider, "Local fixture");
	assert.deepEqual(await configuration.getModels([]), []);
	assert.ok((await configuration.getModels(["opencode"])).length > 0);
	assert.ok((await configuration.getModels()).length > catalog.length);
	assert.deepEqual(providers, before);
});

test("manual API, URL and headers are read from current configuration, never the saved selection", async () => {
	let providers = [
		provider({ models: [{ ...local, baseUrl: "https://current.invalid/v1", headers: { "x-route": "current" } }] }),
	];
	const configuration = new ModelConfiguration(async () => providers);
	const saved = { ...local, baseUrl: "https://saved.invalid", headers: { "x-route": "saved" } };
	assert.equal((await configuration.resolveModel(saved)).baseUrl, providers[0].baseUrl);
	providers = [
		provider({
			type: "anthropic-messages",
			baseUrl: "https://provider-level.invalid",
			models: [{ ...providers[0].models[0], api: "anthropic-messages", baseUrl: "https://edited.invalid" }],
		}),
	];
	const resolved = await configuration.resolveModel(saved);
	assert.equal(resolved.api, "anthropic-messages");
	assert.equal(resolved.baseUrl, "https://edited.invalid");
	assert.deepEqual(resolved.headers, { "x-route": "current" });
	providers = [];
	assert.equal(await configuration.resolveModel(saved), undefined);
});

test("discovery is refreshed on every catalog open, isolated on failure and not persisted", async () => {
	const providers = [
		provider({ type: "ollama", models: undefined }),
		provider({ id: "broken", name: "Broken", type: "vllm" }),
	];
	const before = structuredClone(providers);
	let count = 0;
	const configuration = new ModelConfiguration(
		async () => providers,
		async (type) => {
			count++;
			if (type === "vllm") throw new Error("fixture offline");
			return [{ ...local, provider: "", headers: { "x-stale": "discard" } }];
		},
	);
	for (let i = 0; i < 2; i++) {
		const catalog = await configuration.getModels(["Local fixture", "Broken", "opencode"]);
		assert.equal(catalog.length, getModels("opencode").length + 1);
		assert.equal(catalog.at(-1).baseUrl, "https://current.invalid/v1/v1");
		assert.equal(catalog.at(-1).headers, undefined);
	}
	assert.equal(count, 4);
	assert.ok(await configuration.resolveModel({ provider: local.provider, id: local.id }));
	assert.deepEqual(providers, before);
	const minimal = await configuration.resolveModel({ provider: "Local fixture", id: local.id });
	assert.equal(minimal.reasoning, true);
	assert.deepEqual(minimal.input, ["text", "image"]);
	const filtered = await configuration.getModels(["opencode"]);
	assert.equal(filtered.length, getModels("opencode").length);
	assert.equal(count, 4);
});

test("cached discovery cannot resurrect deleted providers or stale URL/credential generations", async () => {
	let providers = [provider({ type: "ollama", baseUrl: "http://localhost:11434", models: undefined })];
	const configuration = new ModelConfiguration(
		async () => providers,
		async () => [{ ...local, provider: "" }],
	);
	await configuration.getModels();
	const saved = { ...local, headers: { authorization: "stale-fixture" } };
	assert.ok(await configuration.resolveModel({ provider: local.provider, id: local.id }));
	providers = [{ ...providers[0], baseUrl: "http://localhost:22434", apiKey: "edited-fixture" }];
	assert.equal(await configuration.resolveModel({ provider: local.provider, id: local.id }), undefined);
	const current = await configuration.resolveModel(saved);
	assert.equal(current.baseUrl, "http://localhost:22434/v1");
	assert.equal(current.headers, undefined);
	await configuration.getModels();
	providers = [];
	assert.equal(await configuration.resolveModel(saved), undefined);
	assert.equal(await configuration.resolveModel({ provider: local.provider, id: local.id }), undefined);
});

test("preexisting configured discovery definitions resolve before selector refresh using the current server", async () => {
	const configuration = new ModelConfiguration(async () => [
		provider({ type: "ollama", baseUrl: "http://localhost:22434" }),
	]);
	const model = await configuration.resolveModel({ provider: local.provider, id: local.id });
	assert.equal(model.baseUrl, "http://localhost:22434/v1");
	assert.deepEqual(model.input, ["text", "image"]);
	assert.equal(model.reasoning, true);
});

test("providers removed or edited while discovery is pending do not publish stale models", async () => {
	const providers = [provider({ type: "ollama", models: undefined })];
	let release;
	let started;
	const ready = new Promise((resolve) => {
		started = resolve;
	});
	const configuration = new ModelConfiguration(
		async () => providers,
		async () => {
			started();
			return new Promise((resolve) => {
				release = resolve;
			});
		},
	);
	const pending = configuration.getModels([local.provider]);
	await ready;
	providers[0].baseUrl = "https://new.invalid";
	release([local]);
	assert.deepEqual(await pending, []);
	assert.equal(await configuration.resolveModel({ provider: local.provider, id: local.id }), undefined);
});

test("manual catalog rejects unsupported APIs, credential-bearing URLs and malformed headers", async () => {
	const configuration = new ModelConfiguration(async () => [
		provider({
			models: [
				{ ...local, api: "unknown" },
				{ ...local, baseUrl: "https://user:fixture-secret@host.invalid" },
				{ ...local, headers: { "bad\nheader": "fixture" } },
				{ ...local, contextWindow: -1 },
			],
		}),
	]);
	assert.deepEqual(await configuration.getModels([local.provider]), []);
	assert.equal(await configuration.resolveModel(local), undefined);
});

test("mutating a returned discovery model cannot override the current configured server", async () => {
	const configuration = new ModelConfiguration(
		async () => [provider({ type: "ollama", baseUrl: "http://localhost:11434" })],
		async () => [local],
	);
	const [model] = await configuration.getModels([local.provider]);
	model.baseUrl = "https://stale.invalid/v1";
	model.headers = { authorization: "stale-fixture" };
	const resolved = await configuration.resolveModel({ provider: local.provider, id: local.id });
	assert.equal(resolved.baseUrl, "http://localhost:11434/v1");
	assert.equal(resolved.headers, undefined);
});

test("Ollama list/show preserves tool filtering, thinking and context/token defaults", async () => {
	const calls = [];
	const models = await discoverModels("ollama", "http://localhost:11434/", "not-sent", {
		fetch: async (input, init) => {
			calls.push([String(input), init]);
			if (String(input).endsWith("/api/tags"))
				return Response.json({ models: ["basic", "thinker", "no-tools", "broken"].map((name) => ({ name })) });
			const { model } = JSON.parse(init.body);
			if (model === "broken") return new Response("offline", { status: 503 });
			return Response.json({
				capabilities:
					model === "no-tools" ? ["vision"] : model === "thinker" ? ["tools", "thinking", "vision"] : ["tools"],
				model_info: model === "thinker" ? { "general.architecture": "qwen", "qwen.context_length": 32768 } : {},
			});
		},
	});
	assert.equal(calls.length, 5);
	assert.ok(calls.every(([, init]) => !new Headers(init.headers).has("authorization")));
	assert.deepEqual(
		models.map((entry) => [entry.id, entry.reasoning, entry.contextWindow, entry.maxTokens, entry.input]),
		[
			["basic", false, 8192, 81920, ["text"]],
			["thinker", true, 32768, 327680, ["text"]],
		],
	);
	assert.ok(
		models.every((entry) => entry.baseUrl === "http://localhost:11434/v1" && entry.api === "openai-completions"),
	);
});

test("llama.cpp and vLLM use /v1/models and preserve their different context limits", async () => {
	for (const type of ["llama.cpp", "vllm"]) {
		const models = await discoverModels(type, "https://server.invalid/prefix/", "fixture-key", {
			fetch: async (input, init) => {
				assert.equal(input, "https://server.invalid/prefix/v1/models");
				assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-key");
				return Response.json({
					data: [
						{ id: "explicit", context_length: 16384, max_model_len: 2048, supports_vision: true },
						{ id: "default" },
						{ id: "invalid", context_length: -1, max_model_len: "bad" },
						{},
					],
				});
			},
		});
		assert.equal(models.length, 3);
		assert.deepEqual(
			models.map((entry) => [entry.contextWindow, entry.maxTokens]),
			type === "vllm"
				? [
						[2048, 2048],
						[8192, 4096],
						[8192, 4096],
					]
				: [
						[16384, 4096],
						[8192, 4096],
						[8192, 4096],
					],
		);
		assert.ok(models.every((entry) => !entry.reasoning && entry.input.length === 1));
	}
});

test("LM Studio discovers downloaded LLMs over secure WebSocket and keeps vision/context semantics", async () => {
	let disposed = 0;
	const models = await discoverModels("lmstudio", "https://server.invalid:1234/prefix/", "unused-key", {
		createLMStudioClient: (url) => {
			assert.equal(url, "wss://server.invalid:1234/prefix");
			return {
				system: {
					listDownloadedModels: async () => [
						{
							type: "llm",
							path: "folder/model.gguf",
							displayName: "Vision model",
							vision: true,
							trainedForToolUse: true,
							maxContextLength: 65536,
						},
						{ type: "embedding", path: "embed.gguf" },
					],
				},
				[Symbol.asyncDispose]: async () => {
					disposed++;
				},
			};
		},
	});
	assert.equal(disposed, 1);
	assert.equal(models.length, 1);
	assert.equal(models[0].id, "folder/model.gguf");
	assert.equal(models[0].name, "Vision model");
	assert.deepEqual(models[0].input, ["text", "image"]);
	assert.equal(models[0].reasoning, true);
	assert.equal(models[0].contextWindow, 65536);
	assert.equal(models[0].maxTokens, 65536);
	assert.equal(models[0].baseUrl, "https://server.invalid:1234/prefix/v1");
});

test("unsafe discovery URLs and invalid responses fail without exposing configured keys", async () => {
	let requests = 0;
	const fetch = async () => {
		requests++;
		return Response.json({ wrong: [] });
	};
	for (const url of [
		"javascript:bad",
		"https://user:secret-fixture@host.invalid",
		"https://host.invalid?key=fixture",
		"https://host.invalid#fragment",
	]) {
		await assert.rejects(discoverModels("vllm", url, "fixture", { fetch }));
	}
	assert.equal(requests, 0);
	await assert.rejects(discoverModels("vllm", "https://host.invalid", "fixture", { fetch }));
	assert.equal(requests, 1);
});

test("catalog custom models dispatch through Pi 1.1.0 using the current API key route", async () => {
	const configuration = new ModelConfiguration(async () => [provider({ apiKey: "fixture-custom-key" })]);
	const [model] = await configuration.getModels([local.provider]);
	const stream = streamSimple(
		model,
		{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
		{
			apiKey: (await configuration.getProvider(model.provider)).apiKey,
			fetch: async (input, init) => {
				assert.equal(String(input), "https://current.invalid/v1/chat/completions");
				assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-custom-key");
				return new Response(
					'data: {"id":"fixture","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		},
	);
	assert.equal((await stream.result()).stopReason, "stop");
});
