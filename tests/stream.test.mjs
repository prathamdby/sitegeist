import assert from "node:assert/strict";
import test from "node:test";
import { getModels } from "../src/pi/models.ts";
import { createStreamFn } from "../src/pi/stream.ts";

test("the application proxy wrapper preserves eligible routes and reads settings on each request", async () => {
	const model = getModels("zai")[0];
	assert.ok(model);
	let proxy = "https://proxy.invalid/proxy";
	let settingsReads = 0;
	const stream = createStreamFn(async () => {
		settingsReads++;
		return proxy;
	});
	const urls = [];
	const options = {
		apiKey: "synthetic-fixture-key",
		maxRetries: 0,
		fetch: async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ error: { message: "synthetic validation response" } }), { status: 400 });
		},
	};
	await (await stream(model, { messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }, options)).result();
	proxy = undefined;
	await (await stream(model, { messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }, options)).result();
	assert.equal(settingsReads, 2);
	assert.equal(urls.length, 2);
	assert.match(urls[0], /^https:\/\/proxy\.invalid\/proxy\//);
	assert.ok(decodeURIComponent(urls[0]).includes(model.baseUrl));
	assert.ok(urls[1].startsWith(model.baseUrl));
	assert.equal(model.provider, "zai");
});

test("proxy settings failures are returned as stream errors instead of rejected stream factories", async () => {
	const stream = createStreamFn(async () => {
		throw new Error("Synthetic storage failure");
	});
	const result = await (await stream(getModels("openai")[0], { messages: [] })).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage, /Synthetic storage failure/);
});

const codexToken = `fixture.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }))}.fixture`;
for (const [provider, shape, apiKey, proxied] of [
	["openai-codex", "subscription token", codexToken, true],
	["anthropic", "OAuth token", "sk-ant-oat-synthetic-fixture", true],
	["anthropic", "serialized credentials", '{"synthetic":"fixture"}', true],
	["anthropic", "API key", "sk-ant-api-synthetic-fixture", false],
	["openai", "API key", "synthetic-fixture-key", false],
]) {
	test(`proxy routing for ${provider} with ${shape}`, async () => {
		const model = getModels(provider)[0];
		const urls = [];
		const stream = createStreamFn(async () => "https://proxy.invalid/proxy");
		await (
			await stream(
				model,
				{ messages: [{ role: "user", content: "Fixture", timestamp: 1 }] },
				{
					apiKey,
					transport: "sse",
					maxRetries: 0,
					fetch: async (input) => {
						urls.push(String(input));
						return new Response(JSON.stringify({ error: { message: "synthetic rejection" } }), { status: 400 });
					},
				},
			)
		).result();
		assert.equal(urls.length, 1);
		if (proxied) {
			assert.match(urls[0], /^https:\/\/proxy\.invalid\/proxy\//);
			assert.ok(decodeURIComponent(urls[0]).includes(model.baseUrl));
		} else {
			assert.ok(urls[0].startsWith(model.baseUrl));
		}
	});
}

test("an undefined key stays direct for keyless custom servers and cannot dispatch unconfigured OpenAI", async () => {
	const stream = createStreamFn(async () => "https://proxy.invalid/proxy");
	const model = {
		...getModels("openai")[0],
		provider: "keyless-local",
		api: "openai-completions",
		baseUrl: "http://localhost:1234/v1",
	};
	const urls = [];
	const options = {
		apiKey: undefined,
		env: { OPENAI_API_KEY: "" },
		maxRetries: 0,
		fetch: async (input) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ error: { message: "synthetic rejection" } }), { status: 400 });
		},
	};
	await (await stream(model, { messages: [{ role: "user", content: "Fixture", timestamp: 1 }] }, options)).result();
	assert.equal(urls.length, 1);
	assert.ok(urls[0].startsWith(model.baseUrl));
	urls.length = 0;
	const unconfigured = await (await stream(getModels("openai")[0], { messages: [] }, options)).result();
	assert.equal(unconfigured.stopReason, "error");
	assert.equal(urls.length, 0);
});
