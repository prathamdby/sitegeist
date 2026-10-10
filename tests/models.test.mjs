import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import {
	complete,
	createModelRegistry,
	getModel,
	getModels,
	getProviders,
	modelsAreEqual,
	rehydrateModel,
	streamSimple,
	StringEnum,
} from "../src/pi/models.js";

const custom = {
	id: "local-model",
	name: "Local model",
	provider: "configured-local-route",
	api: "openai-completions",
	baseUrl: "https://local.invalid/v1",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 8192,
	maxTokens: 512,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	headers: { "x-billing-route": "custom-account" },
	compat: { supportsDeveloperRole: false },
};

function completionsResponse() {
	const chunk = {
		id: "fixture-response",
		object: "chat.completion.chunk",
		created: 1,
		model: "local-model",
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "Content-Type": "text/event-stream" },
	});
}

test("the registry retains every legacy provider except the two removed Google routes", () => {
	assert.deepEqual(getProviders(), [
		"amazon-bedrock",
		"anthropic",
		"azure-openai-responses",
		"cerebras",
		"github-copilot",
		"google",
		"google-vertex",
		"groq",
		"huggingface",
		"kimi-coding",
		"minimax",
		"minimax-cn",
		"mistral",
		"openai",
		"openai-codex",
		"opencode",
		"opencode-go",
		"openrouter",
		"vercel-ai-gateway",
		"xai",
		"zai",
	]);
	for (const provider of getProviders()) {
		assert.ok(getModels(provider).length > 0, provider);
		assert.ok(
			getModels(provider).every((model) => model.provider === provider),
			provider,
		);
	}
	assert.deepEqual(getModels("google-gemini-cli"), []);
	assert.deepEqual(getModels("google-antigravity"), []);
	assert.deepEqual(getModels("unknown"), []);
});

test("catalog list mutation does not remove registry entries", () => {
	const models = getModels("anthropic");
	const model = models[0];
	assert.ok(model);
	models.length = 0;
	assert.equal(getModel("anthropic", model.id), model);
});

test("Azure reuses the released factory while preserving the stored legacy route", () => {
	const registry = createModelRegistry();
	assert.ok(registry.getProvider("azure-openai-responses"));
	assert.ok(
		registry.getAllModels("azure-openai-responses").every((model) => model.provider === "azure-openai-responses"),
	);
	assert.equal(registry.getProvider("azure"), undefined);
});

test("saved built-in models are rehydrated by provider and ID, not old embedded routing fields", () => {
	const model = getModels("anthropic")[0];
	assert.ok(model);
	assert.equal(rehydrateModel({ ...model, baseUrl: "https://stale.invalid", api: "openai-completions" }), model);
	assert.equal(rehydrateModel({ provider: model.provider, id: model.id }), model);
	assert.equal(rehydrateModel({ provider: model.provider, id: "removed-model-id" }), undefined);
	assert.equal(rehydrateModel({ provider: "missing-provider", id: model.id }), undefined);
});

test("removed selections never change billing route or use supplied custom definitions", () => {
	for (const provider of ["google-gemini-cli", "google-antigravity"]) {
		const removed = { ...custom, provider };
		assert.equal(rehydrateModel(removed, [removed], [provider]), undefined);
		assert.equal(getModel(provider, removed.id), undefined);
	}
	for (const saved of [undefined, null, "bad", {}, { provider: 1, id: "model" }]) {
		assert.equal(rehydrateModel(saved), undefined);
	}
});

test("custom rehydration preserves the configured provider, URL, headers, and compatibility fields", () => {
	assert.deepEqual(rehydrateModel(custom, [custom]), { ...custom, type: undefined });
	assert.deepEqual(rehydrateModel({ ...custom, baseUrl: "https://saved-route.invalid/v1" }, [custom]), {
		...custom,
		baseUrl: "https://saved-route.invalid/v1",
		type: undefined,
	});
	const restored = rehydrateModel(custom, [], [custom.provider]);
	assert.deepEqual(restored, { ...custom, type: undefined });
	assert.equal(restored?.provider, custom.provider);
	assert.equal(rehydrateModel(custom), undefined);
	assert.equal(rehydrateModel(custom, [{ ...custom, provider: "another-route" }]), undefined);
	assert.equal(rehydrateModel({ ...custom, api: "unknown-api" }, [], [custom.provider]), undefined);
	assert.equal(rehydrateModel({ ...custom, headers: { bad: 1 } }, [], [custom.provider]), undefined);
	assert.equal(rehydrateModel({ ...custom, maxTokens: -1 }, [], [custom.provider]), undefined);
});

test("model equality includes the billing provider and tolerates empty selections", () => {
	assert.equal(modelsAreEqual(custom, { ...custom }), true);
	assert.equal(modelsAreEqual(custom, { ...custom, provider: "other-billing-route" }), false);
	assert.equal(modelsAreEqual(custom, undefined), false);
	assert.equal(modelsAreEqual(null, null), false);
});

test("StringEnum creates a schema that composes with the current TypeBox package", () => {
	const schema = Type.Object({ operation: StringEnum(["read", "write"], { default: "read" }) });
	assert.deepEqual(schema.properties.operation, { type: "string", enum: ["read", "write"], default: "read" });
});

test("custom streaming normalizes legacy prompt/tools and retains route, overrides, and events", async () => {
	let requestCount = 0;
	const schema = Type.Object({ target: Type.String() });
	const stream = streamSimple(
		custom,
		{
			systemPrompt: "Keep this prompt",
			tools: [{ name: "navigate", description: "Navigate", parameters: schema }],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		},
		{
			apiKey: "fixture-custom-key",
			headers: { "x-request-route": "explicit-route" },
			fetch: async (input, init) => {
				requestCount++;
				assert.equal(String(input), `${custom.baseUrl}/chat/completions`);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), "Bearer fixture-custom-key");
				assert.equal(headers.get("x-billing-route"), "custom-account");
				assert.equal(headers.get("x-request-route"), "explicit-route");
				assert.equal(typeof init?.body, "string");
				const body = JSON.parse(String(init?.body));
				assert.equal(body.model, custom.id);
			assert.ok(body.messages.some((message) => message.content === "Keep this prompt"));
				assert.equal(body.tools[0].function.name, "navigate");
				assert.deepEqual(body.tools[0].function.parameters.properties.target, { type: "string" });
				return completionsResponse();
			},
		},
	);
	const events = [];
	for await (const event of stream) events.push(event.type);
	const result = await stream.result();
	assert.equal(requestCount, 1);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.provider, custom.provider);
	assert.equal(result.model, custom.id);
	assert.deepEqual(result.content, [{ type: "text", text: "ok" }]);
	assert.equal(events[0], "start");
	assert.equal(events.at(-1), "done");
});

test("legacy UI symbol-bearing JSON schemas remain accepted as serialized tool declarations", async () => {
	const result = await streamSimple(
		custom,
		{
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
			tools: [
				{
					name: "legacy-tool",
					description: "A temporary UI tool",
					parameters: {
						[Symbol.for("TypeBox.Kind")]: "Object",
						type: "object",
						properties: { action: { [Symbol.for("TypeBox.Kind")]: "String", type: "string" } },
						required: ["action"],
					},
				},
			],
		},
		{
			apiKey: "fixture-custom-key",
			fetch: async (_input, init) => {
				const body = JSON.parse(String(init?.body));
				assert.deepEqual(body.tools[0].function.parameters, {
					type: "object",
					properties: { action: { type: "string" } },
					required: ["action"],
				});
				return completionsResponse();
			},
		},
	).result();
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
});

test("keyless local custom routes accept an already normalized transcript", async () => {
	let requestCount = 0;
	const result = await streamSimple(
		custom,
		normalizeContext({
			systemPrompt: "local instruction",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		}),
		{
			fetch: async (_input, init) => {
				requestCount++;
				assert.equal(new Headers(init?.headers).get("authorization"), null);
				return completionsResponse();
			},
		},
	).result();
	assert.equal(requestCount, 1);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.provider, custom.provider);
});

test("complete uses the new API for legacy custom model validation requests", async () => {
	const result = await complete(
		custom,
		{
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		},
		{
			apiKey: "fixture-validation-key",
			maxTokens: 10,
			fetch: async () => completionsResponse(),
		},
	);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.provider, custom.provider);
});

test("Codex explicit token override stays on its subscription API and derives account headers", async () => {
	const model = getModels("openai-codex")[0];
	assert.ok(model);
	const token = `fixture.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }))}.fixture`;
	let requestCount = 0;
	const result = await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		},
		{
			apiKey: token,
			transport: "sse",
			fetch: async (input, init) => {
				requestCount++;
				assert.match(String(input), /^https:\/\/chatgpt\.com\/backend-api\//);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), `Bearer ${token}`);
				assert.equal(headers.get("chatgpt-account-id"), "fixture-account");
				const event = {
					type: "response.completed",
					response: {
						id: "fixture-codex",
						output: [],
						status: "completed",
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				};
				return new Response(`data: ${JSON.stringify(event)}\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		},
	).result();
	assert.equal(requestCount, 1);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.provider, "openai-codex");
	assert.equal(result.api, "openai-codex-responses");
});

test("Copilot explicit token overrides keep its dynamic subscription headers", async () => {
	const model = getModels("github-copilot").find((entry) => entry.api === "openai-completions");
	assert.ok(model);
	let requestCount = 0;
	const result = await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		},
		{
			apiKey: "fixture-copilot-token",
			fetch: async (input, init) => {
				requestCount++;
				assert.match(String(input), /^https:\/\/api\.individual\.githubcopilot\.com\//);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), "Bearer fixture-copilot-token");
				assert.equal(headers.get("x-initiator"), "user");
				assert.ok(headers.get("copilot-integration-id"));
				return completionsResponse();
			},
		},
	).result();
	assert.equal(requestCount, 1);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.provider, "github-copilot");
});

test("Anthropic explicit OAuth token overrides retain bearer subscription authentication", async () => {
	const model = getModels("anthropic")[0];
	assert.ok(model);
	let requestCount = 0;
	const result = await streamSimple(
		model,
		{
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		},
		{
			apiKey: "sk-ant-oat-fixture-not-a-credential",
			fetch: async (input, init) => {
				requestCount++;
				assert.match(String(input), /^https:\/\/api\.anthropic\.com\//);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), "Bearer sk-ant-oat-fixture-not-a-credential");
				assert.equal(headers.get("x-api-key"), null);
				const events = [
					{
						type: "message_start",
						message: {
							id: "fixture-anthropic",
							role: "assistant",
							content: [],
							model: model.id,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				return new Response(
					events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			},
		},
	).result();
	assert.equal(requestCount, 1);
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.equal(result.provider, "anthropic");
});

test("unknown APIs and removed providers finish with stream errors without network access", async () => {
	for (const model of [
		{ ...custom, api: "unknown-api" },
		{ ...custom, provider: "google-gemini-cli" },
	]) {
		const result = await streamSimple(
			model,
			{ messages: [] },
			{
				fetch: async () => assert.fail("Unsupported routes must not perform requests"),
			},
		).result();
		assert.equal(result.stopReason, "error");
		assert.equal(result.provider, model.provider);
	}
});
