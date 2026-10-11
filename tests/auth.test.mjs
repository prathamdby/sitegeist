import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { build } from "esbuild";
import { oauthLogin, resolveApiKey, serializeOAuthCredentials } from "../src/oauth/index.ts";

function eventMock() {
	const listeners = new Set();
	return {
		listeners,
		addListener: (listener) => listeners.add(listener),
		removeListener: (listener) => listeners.delete(listener),
		emit: (...args) => {
			for (const listener of [...listeners]) listener(...args);
		},
	};
}

function mockChrome(outcome = "success") {
	const onUpdated = eventMock();
	const onRemoved = eventMock();
	const created = [];
	const removed = [];
	globalThis.chrome = {
		identity: { launchWebAuthFlow: () => assert.fail("Existing flows use tabs, not chrome.identity") },
		tabs: {
			onUpdated,
			onRemoved,
			create: async ({ url, active }) => {
				assert.equal(active, true);
				created.push(new URL(url));
				const id = created.length;
				const auth = new URL(url);
				if (auth.searchParams.has("redirect_uri")) {
					setTimeout(() => {
						if (outcome === "cancel") return onRemoved.emit(id);
						const redirect = new URL(auth.searchParams.get("redirect_uri"));
						redirect.searchParams.set("code", "fixture-authorization-code");
						redirect.searchParams.set(
							"state",
							outcome === "mismatch" ? "wrong-state" : auth.searchParams.get("state"),
						);
						onUpdated.emit(id, { url: redirect.href });
					}, 0);
				}
				return { id };
			},
			remove: async (id) => removed.push(id),
		},
	};
	return { created, removed, onUpdated, onRemoved };
}

const codexToken = `fixture.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } }))}.fixture`;
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

for (const provider of ["anthropic", "openai-codex"]) {
	test(`${provider} browser login exchanges PKCE/state and cleans up tab listeners`, async (t) => {
		const original = globalThis.chrome;
		t.after(() => {
			globalThis.chrome = original;
		});
		const chrome = mockChrome();
		const requests = [];
		t.mock.method(globalThis, "fetch", async (url, init) => {
			requests.push({ url: String(url), body: JSON.parse(init.body) });
			return json({
				access_token: provider === "openai-codex" ? codexToken : "fixture-access",
				refresh_token: "fixture-refresh",
				expires_in: 3600,
			});
		});
		const before = Date.now();
		const credentials = await oauthLogin(provider);
		assert.equal(credentials.providerId, provider);
		assert.equal(credentials.refresh, "fixture-refresh");
		assert.ok(credentials.expires > before + 3000_000);
		assert.equal(requests.length, 1);
		const auth = chrome.created[0];
		assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
		assert.ok(auth.searchParams.get("code_challenge"));
		assert.equal(requests[0].body.grant_type, "authorization_code");
		assert.equal(requests[0].body.code, "fixture-authorization-code");
		assert.ok(requests[0].body.code_verifier);
		assert.equal(requests[0].body.redirect_uri, auth.searchParams.get("redirect_uri"));
		if (provider === "anthropic") {
			assert.equal(requests[0].body.state, auth.searchParams.get("state"));
			assert.equal(requests[0].body.code_verifier, auth.searchParams.get("state"));
		} else assert.equal(credentials.accountId, "fixture-account");
		assert.deepEqual(chrome.removed, [1]);
		assert.equal(chrome.onUpdated.listeners.size, 0);
		assert.equal(chrome.onRemoved.listeners.size, 0);
	});

	for (const outcome of ["cancel", "mismatch"]) {
		test(`${provider} ${outcome} rejects without exchanging tokens`, async (t) => {
			const original = globalThis.chrome;
			t.after(() => {
				globalThis.chrome = original;
			});
			const chrome = mockChrome(outcome);
			t.mock.method(globalThis, "fetch", async () => assert.fail("Rejected authorization must not exchange tokens"));
			await assert.rejects(oauthLogin(provider), outcome === "cancel" ? /tab was closed/ : /state mismatch/);
			assert.equal(chrome.onUpdated.listeners.size, 0);
			assert.equal(chrome.onRemoved.listeners.size, 0);
		});
	}
}

for (const denied of [false, true]) {
	test(`Copilot device login ${denied ? "reports user denial" : "opens verification, polls, and exchanges token"}`, async (t) => {
		const original = globalThis.chrome;
		t.after(() => {
			globalThis.chrome = original;
		});
		const chrome = mockChrome();
		const urls = [];
		t.mock.method(globalThis, "fetch", async (url, init) => {
			urls.push(String(url));
			if (String(url).endsWith("/device/code")) {
				assert.equal(new URLSearchParams(init.body).get("scope"), "read:user");
				return json({
					device_code: "fixture-device",
					user_code: "FIXTURE-CODE",
					verification_uri: "https://github.com/login/device",
					interval: 1,
					expires_in: 30,
				});
			}
			if (String(url).endsWith("/access_token")) {
				assert.equal(new URLSearchParams(init.body).get("device_code"), "fixture-device");
				return json(denied ? { error: "access_denied" } : { access_token: "fixture-github-token" });
			}
			assert.equal(init.headers.Authorization, "Bearer fixture-github-token");
			return json({ token: "fixture-copilot-token", expires_at: Math.floor(Date.now() / 1000) + 3600 });
		});
		let device;
		const login = oauthLogin("github-copilot", undefined, (info) => {
			device = info;
		});
		if (denied) await assert.rejects(login, /access_denied/);
		else {
			const credentials = await login;
			assert.equal(credentials.access, "fixture-copilot-token");
			assert.equal(credentials.refresh, "fixture-github-token");
			assert.equal(urls.length, 3);
		}
		assert.deepEqual(device, { userCode: "FIXTURE-CODE", verificationUri: "https://github.com/login/device" });
		assert.equal(chrome.created[0].href, device.verificationUri);
	});
}

for (const provider of ["anthropic", "openai-codex", "github-copilot"]) {
	test(`${provider} expired credentials refresh and persist under the same provider key`, async (t) => {
		const stored = { providerId: provider, access: "fixture-old-token", refresh: "fixture-refresh", expires: 0 };
		const writes = [];
		let requests = 0;
		t.mock.method(globalThis, "fetch", async (url, init) => {
			requests++;
			if (provider === "github-copilot") {
				assert.equal(String(url), "https://api.github.com/copilot_internal/v2/token");
				assert.equal(init.headers.Authorization, "Bearer fixture-refresh");
				return json({ token: "fixture-renewed", expires_at: Math.floor(Date.now() / 1000) + 3600 });
			}
			const body = JSON.parse(init.body);
			assert.equal(body.grant_type, "refresh_token");
			assert.equal(body.refresh_token, "fixture-refresh");
			return json({
				access_token: provider === "openai-codex" ? codexToken : "fixture-renewed",
				refresh_token: "fixture-rotated",
				expires_in: 3600,
			});
		});
		const storage = { set: async (...args) => writes.push(args) };
		const token = await resolveApiKey(serializeOAuthCredentials(stored), provider, storage);
		assert.equal(requests, 1);
		assert.equal(writes[0][0], provider);
		const renewed = JSON.parse(writes[0][1]);
		assert.equal(renewed.providerId, provider);
		assert.equal(renewed.access, token);
		assert.ok(renewed.expires > Date.now());
		assert.equal(await resolveApiKey(writes[0][1], provider, storage), token);
		assert.equal(requests, 1);
	});
}

test("plain API keys bypass OAuth and expired-token failure never overwrites credentials", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("fixture denial", { status: 401 }));
	t.mock.method(console, "error", () => {});
	const storage = { set: async () => assert.fail("A failed refresh must leave stored credentials untouched") };
	assert.equal(await resolveApiKey("fixture-api-key", "opencode", storage), "fixture-api-key");
	await assert.rejects(
		resolveApiKey(
			serializeOAuthCredentials({
				providerId: "anthropic",
				access: "fixture-old",
				refresh: "fixture-refresh",
				expires: 0,
			}),
			"anthropic",
			storage,
		),
		/refresh failed/,
	);
});

function validationResponse(api) {
	if (api === "anthropic") {
		return [
			{
				type: "message_start",
				message: {
					id: "fixture-message",
					role: "assistant",
					content: [],
					model: "claude-haiku-4-5",
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			},
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		]
			.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
			.join("");
	}
	return `data: ${JSON.stringify({ type: "response.completed", response: { id: "fixture-response", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
}

test("masked API key UI adds, validates, replaces, reloads, and removes without live calls", async (t) => {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const bundle = await build({
		entryPoints: [resolve(root, "tests/browser/auth.ts")],
		bundle: true,
		write: false,
		format: "esm",
		platform: "browser",
		target: "chrome120",
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
		inject: [resolve(root, "scripts/process-shim.js")],
		alias: { process: resolve(root, "scripts/process-shim.js") },
	});
	const server = createServer((request, response) => {
		response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
		response.end(
			request.url === "/fixture.js"
				? bundle.outputFiles[0].text
				: '<!doctype html><html><body><script type="module" src="/fixture.js"></script></body></html>',
		);
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	t.after(() => new Promise((done) => server.close(done)));
	const address = server.address();
	const origin = `http://127.0.0.1:${address.port}`;
	const browser = await chromium.launch({
		headless: true,
		executablePath:
			process.env.CHROMIUM_EXECUTABLE_PATH ||
			(existsSync("/usr/local/bin/chromium") ? "/usr/local/bin/chromium" : undefined),
		args: ["--no-sandbox"],
	});
	t.after(() => browser.close());
	const page = await browser.newPage();
	const requests = [];
	let rejectKey = false;
	let release;
	let pending;
	await page.route("**/*", async (route) => {
		if (route.request().url().startsWith(origin)) return route.continue();
		const request = route.request();
		requests.push({ url: request.url(), headers: request.headers(), body: request.postDataJSON() });
		if (pending) await pending;
		if (rejectKey)
			return route.fulfill({
				status: 401,
				contentType: "application/json",
				body: JSON.stringify({ error: { message: "fixture invalid key" } }),
			});
		return route.fulfill({
			status: 200,
			contentType: "text/event-stream",
			body: validationResponse(
				request.url().includes("anthropic") || request.url().includes("opencode") ? "anthropic" : "openai",
			),
		});
	});
	await page.goto(origin);
	await page.waitForFunction(() => !!window.authFixture);
	await page.evaluate(() => window.authFixture.mount("openai"));
	const field = page.locator("input");
	const save = page.getByRole("button", { name: "Save", exact: true });
	assert.equal(await field.getAttribute("type"), "password");
	assert.equal(await save.isDisabled(), true);
	await field.fill("fixture-first-key");
	pending = new Promise((done) => {
		release = done;
	});
	await save.click();
	await page.getByText("Testing", { exact: true }).waitFor();
	assert.equal(await save.isDisabled(), true);
	assert.equal(await field.isDisabled(), true);
	release();
	pending = undefined;
	await page.locator('[aria-label="Key saved"]').waitFor();
	assert.equal(await page.evaluate(() => window.authFixture.readKey("openai")), "fixture-first-key");
	assert.equal(requests.length, 1);
	assert.equal(requests[0].headers.authorization, "Bearer fixture-first-key");
	assert.ok(JSON.stringify(requests[0].body).includes("Reply with: ok"));

	rejectKey = true;
	await page.clock.install();
	await field.fill("fixture-invalid-key");
	await save.click();
	await page.getByText("Invalid", { exact: true }).waitFor();
	assert.equal(await page.evaluate(() => window.authFixture.readKey("openai")), "fixture-first-key");
	await page.clock.fastForward(5001);
	assert.equal(await page.getByText("Invalid", { exact: true }).count(), 0);
	await page.clock.resume();
	rejectKey = false;
	await field.fill("fixture-replacement-key");
	await field.press("Enter");
	await expect.poll(() => page.evaluate(() => window.authFixture.readKey("openai"))).toBe("fixture-replacement-key");
	await page.reload();
	await page.waitForFunction(() => !!window.authFixture);
	await page.evaluate(() => window.authFixture.mount("openai"));
	await page.locator('[aria-label="Key saved"]').waitFor();
	assert.equal(await field.inputValue(), "fixture-replacement-key");
	const beforeRemoval = requests.length;
	await field.fill("");
	await save.click();
	await expect.poll(() => page.evaluate(() => window.authFixture.readKey("openai"))).toBeNull();
	assert.equal(requests.length, beforeRemoval);
	assert.equal(await page.locator('[aria-label="Key saved"]').count(), 0);

	await page.evaluate(() => window.authFixture.mount("opencode"));
	await field.fill("fixture-opencode-key");
	await save.click();
	await expect.poll(() => page.evaluate(() => window.authFixture.readKey("opencode"))).toBe("fixture-opencode-key");
	assert.match(requests.at(-1).url, /^https:\/\/opencode.ai\/zen/);
	assert.equal(requests.at(-1).body.max_tokens, 200);
	assert.ok(await page.evaluate(() => window.authFixture.model("anthropic", "claude-haiku-4-5")));

	await page.evaluate(async () => {
		await window.authFixture.setProxy(true, "https://proxy.fixture");
		await window.authFixture.mount("anthropic");
	});
	await field.fill("sk-ant-oat-fixture-browser-token");
	await save.click();
	await expect
		.poll(() => page.evaluate(() => window.authFixture.readKey("anthropic")))
		.toBe("sk-ant-oat-fixture-browser-token");
	assert.match(requests.at(-1).url, /^https:\/\/proxy.fixture\//);
	assert.ok(decodeURIComponent(requests.at(-1).url).includes("https://api.anthropic.com"));
	await page.evaluate(() => window.authFixture.setProxy(false, "https://proxy.fixture"));
	await field.fill("sk-ant-oat-fixture-direct-token");
	await save.click();
	await expect
		.poll(() => page.evaluate(() => window.authFixture.readKey("anthropic")))
		.toBe("sk-ant-oat-fixture-direct-token");
	assert.match(requests.at(-1).url, /^https:\/\/api.anthropic.com\//);

	const beforeUnknown = requests.length;
	await page.evaluate(() => window.authFixture.mount("fixture-unknown-provider"));
	await field.fill("fixture-unknown-key");
	await save.click();
	await expect
		.poll(() => page.evaluate(() => window.authFixture.readKey("fixture-unknown-provider")))
		.toBe("fixture-unknown-key");
	assert.equal(requests.length, beforeUnknown);
	for (const provider of ["huggingface", "minimax", "minimax-cn", "mistral", "xai", "zai"]) {
		await page.evaluate((name) => window.authFixture.mount(name), provider);
		await field.fill("fixture-untested-provider-key");
		await save.click();
		await expect
			.poll(() => page.evaluate((name) => window.authFixture.readKey(name), provider))
			.toBe("fixture-untested-provider-key");
		assert.equal(requests.length, beforeUnknown, `${provider} keeps its baseline no-validation-network contract`);
	}
	const oauthRecord = serializeOAuthCredentials({
		providerId: "anthropic",
		access: "fixture-access-token",
		refresh: "fixture-refresh-token",
		expires: Date.now() + 60_000,
	});
	await page.evaluate(async (record) => {
		await window.authFixture.setKey("anthropic", record);
		await window.authFixture.mount("anthropic");
	}, oauthRecord);
	assert.equal(await page.evaluate(() => window.authFixture.readKey("anthropic")), oauthRecord);
	assert.equal(await field.inputValue(), "");
	assert.equal(await save.isDisabled(), true);
	await page.locator("sitegeist-provider-key-input").evaluate((element) => element.saveKey());
	assert.equal(await page.evaluate(() => window.authFixture.readKey("anthropic")), oauthRecord);
	await field.fill(oauthRecord);
	await save.click();
	await page.getByText("Invalid", { exact: true }).waitFor();
	assert.equal(requests.length, beforeUnknown, "OAuth JSON never enters provider or proxy validation requests");
	assert.equal(await page.evaluate(() => window.authFixture.readKey("anthropic")), oauthRecord);
	await field.fill("fixture-intentional-api-key-replacement");
	await save.click();
	await expect
		.poll(() => page.evaluate(() => window.authFixture.readKey("anthropic")))
		.toBe("fixture-intentional-api-key-replacement");
});
