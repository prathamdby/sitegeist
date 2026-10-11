import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { settingsBridge } from "../scripts/settings-bridge.mjs";
import { storageBridge } from "../scripts/storage-bridge.mjs";
import { filterModels, fuzzyScore } from "../src/pi/model-search.ts";
import { getModel, getModels, ModelConfiguration } from "../src/pi/models.ts";
import { applyModelSelection, resolveInitialModel, selectionRequiredModel } from "../src/pi/selection.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
let browser;
let server;
let origin;
let directory;
before(async () => {
	directory = mkdtempSync(join(tmpdir(), "sitegeist-ui-"));
	execFileSync(`${root}node_modules/.bin/tailwindcss`, ["-i", `${root}src/app.css`, "-o", join(directory, "app.css")]);
	const css = readFileSync(join(directory, "app.css"));
	const bundled = await build({
		entryPoints: ["tests/browser/model-settings.ts"],
		absWorkingDir: root,
		bundle: true,
		write: false,
		platform: "browser",
		format: "esm",
		plugins: [storageBridge(root), settingsBridge(root)],
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
		inject: [`${root}scripts/process-shim.js`],
		alias: {
			process: `${root}scripts/process-shim.js`,
			"@mariozechner/pi-ai": `${root}src/pi/models.ts`,
			"@mariozechner/pi-agent-core": `${root}src/pi/agent.ts`,
			"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
			lit: `${root}node_modules/lit`,
		},
	});
	server = createServer((request, response) => {
		if (request.url === "/app.css") {
			response.setHeader("Content-Type", "text/css");
			response.end(css);
			return;
		}
		response.setHeader("Content-Type", request.url === "/fixture.js" ? "text/javascript" : "text/html");
		response.end(
			request.url === "/fixture.js"
				? bundled.outputFiles[0].text
				: '<!doctype html><link rel="stylesheet" href="/app.css"><script type="module" src="/fixture.js"></script>',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const executablePath =
		process.env.CHROMIUM_PATH ||
		["/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
	browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});
after(async () => {
	await browser?.close();
	await new Promise((resolve) => server?.close(resolve) ?? resolve());
	if (directory) rmSync(directory, { recursive: true, force: true });
});

test("subsequence search removes whitespace, ranks contiguous matches and retains provider filtering", () => {
	assert.equal(fuzzyScore("g p t 5 4", "gpt-5.4"), 2);
	assert.equal(fuzzyScore("not-present", "gpt-5.4"), undefined);
	const models = [...getModels("anthropic"), ...getModels("openai")];
	const current = getModel("anthropic", "claude-sonnet-4-5");
	assert.equal(filterModels(models, current, "", false, false)[0], current);
	const matches = filterModels(models, current, "gpt54", false, false);
	assert.deepEqual(
		matches.map((model) => model.id),
		["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-4o-2024-05-13"],
	);
	assert.ok(
		filterModels(models, current, "op ai", false, false)
			.slice(0, getModels("openai").length)
			.every((model) => model.provider === "openai"),
	);
	assert.ok(
		filterModels(models, current, "", true, true).every((model) => model.reasoning && model.input.includes("image")),
	);
	const fixtures = [
		{ ...current, id: "plain", reasoning: false, input: ["text"] },
		{ ...current, id: "vision", reasoning: false, input: ["text", "image"] },
		{ ...current, id: "thinking", reasoning: true, input: ["text"] },
		{ ...current, id: "both", reasoning: true, input: ["text", "image"] },
	];
	assert.deepEqual(
		filterModels(fixtures, null, "", true, false).map((model) => model.id),
		["both", "thinking"],
	);
	assert.deepEqual(
		filterModels(fixtures, null, "", false, true).map((model) => model.id),
		["both", "vision"],
	);
	assert.deepEqual(
		filterModels(fixtures, null, "", true, true).map((model) => model.id),
		["both"],
	);
});

test("saved selections remain authoritative; absent selections use defaults without switching removed routes", async () => {
	const configuration = new ModelConfiguration(async () => []);
	const saved = { ...getModel("openai", "gpt-4o-mini"), baseUrl: "https://stale.invalid" };
	assert.equal(
		await resolveInitialModel(configuration, saved, true, ["anthropic"]),
		getModel("openai", "gpt-4o-mini"),
	);
	assert.equal(
		await resolveInitialModel(configuration, null, false, ["opencode"]),
		getModel("opencode", "claude-opus-4-6"),
	);
	assert.equal(
		await resolveInitialModel(configuration, { provider: "google-gemini-cli", id: "old" }, true, ["anthropic"]),
		selectionRequiredModel,
	);
	assert.equal(
		await resolveInitialModel(configuration, { provider: "openai", id: "missing" }, true, ["anthropic"]),
		selectionRequiredModel,
	);
	assert.equal(await resolveInitialModel(configuration, null, false, []), selectionRequiredModel);
});

test("model selection refreshes immediately while saved selection waits for persistence", async () => {
	const events = [];
	let finish;
	const model = getModel("openai", "gpt-4o-mini");
	const pending = applyModelSelection(
		model,
		{
			setModel: (value) => {
				assert.equal(value, model);
				events.push("agent");
			},
		},
		{
			set: (key, value) => {
				assert.equal(key, "lastUsedModel");
				assert.equal(value, model);
				events.push("save");
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		},
		() => events.push("composer"),
	);
	assert.deepEqual(events, ["agent", "composer", "save"]);
	finish();
	await pending;
});

test("selector focuses search, filters capabilities and clamps keyboard selection before refreshing the real composer", async () => {
	const page = await browser.newPage();
	try {
		await page.goto(origin);
		await page.locator("#models").click();
		const search = page.getByPlaceholder("Search models...");
		assert.equal(await search.evaluate((element) => document.activeElement === element), true);
		await search.fill("op ai");
		assert.ok((await page.locator("[data-model-item]").first().textContent()).includes("openai"));
		await search.fill("sonnet");
		await search.press("ArrowUp");
		assert.equal(await page.locator("sitegeist-model-selector").evaluate((element) => element.selectedIndex), 0);
		await search.press("ArrowDown");
		await search.press("ArrowDown");
		await search.press("Enter");
		await page.waitForFunction(() => window.fixture.selections === 1);
		assert.equal(await page.locator("sitegeist-model-selector").count(), 0);
		assert.equal(await page.locator("#summary").textContent(), "claude-sonnet-4-6");
		assert.equal(await page.evaluate(() => window.fixture.agent.state.model.id), "claude-sonnet-4-6");
		assert.equal(
			await page.evaluate(async () => (await window.fixture.storage.settings.get("lastUsedModel")).id),
			"claude-sonnet-4-6",
		);
		await page.locator("agent-interface").getByRole("button", { name: "claude-sonnet-4-6", exact: true }).waitFor();
		await page.locator("#models").click();
		assert.ok((await page.locator("[data-model-item]").first().textContent()).includes("claude-sonnet-4-6"));
		await page.getByRole("button", { name: "Thinking", exact: true }).click();
		await page.getByRole("button", { name: "Vision", exact: true }).click();
		const capable = await page.locator("[data-model-item] .truncate").allTextContents();
		assert.ok(capable.length > 0);
		assert.ok(
			capable.every((id) => {
				const model = getModel("anthropic", id) ?? getModel("openai", id);
				return model?.reasoning && model.input.includes("image");
			}),
		);
		await page.keyboard.press("ArrowDown");
		assert.equal(await page.locator("sitegeist-model-selector").evaluate((element) => element.selectedIndex), 1);
		assert.equal(
			await page
				.locator("sitegeist-model-selector")
				.evaluate((element) => element.filterThinking && element.filterVision),
			true,
		);
		await page.getByPlaceholder("Search models...").fill("no-such-model-ever");
		await page.keyboard.press("Enter");
		assert.equal(await page.evaluate(() => window.fixture.selections), 1);
		await page.keyboard.press("Escape");
		assert.equal(await page.locator("sitegeist-model-selector").count(), 0);
	} finally {
		await page.close();
	}
});

test("async custom models preserve the highlighted model identity instead of the old numeric index", async () => {
	const page = await browser.newPage();
	try {
		await page.goto(origin);
		await page.waitForFunction(() => !!window.fixture);
		await page.evaluate(() => window.fixture.deferCustomModels());
		await page.locator("#models").click();
		const search = page.getByPlaceholder("Search models...");
		await search.press("ArrowDown");
		const highlighted = page.locator("[data-model-item].bg-accent .truncate");
		assert.equal(await highlighted.textContent(), "claude-fable-5");
		await page.evaluate(() => window.fixture.releaseCustomModels());
		await page.waitForFunction(() => !document.querySelector("sitegeist-model-selector").customProvidersLoading);
		assert.equal(await highlighted.textContent(), "claude-fable-5");
		assert.equal(await page.locator("sitegeist-model-selector").evaluate((element) => element.selectedIndex), 2);
		await search.press("Enter");
		await page.waitForFunction(() => window.fixture.selections === 1);
		assert.equal(await page.evaluate(() => window.fixture.agent.state.model.id), "claude-fable-5");
	} finally {
		await page.close();
	}
});

test("settings keep tab order and mounted state, close once, and persist proxy toggles and URL", async () => {
	const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
	try {
		await page.goto(origin);
		await page.locator("#settings").click();
		const dialog = page.locator("sitegeist-settings-dialog");
		const names = await dialog.locator("button").allTextContents();
		assert.deepEqual(
			names.slice(0, 5).map((name) => name.trim()),
			["API Keys & OAuth", "Costs", "Skills", "Proxy", "About"],
		);
		assert.equal(await dialog.locator("sitegeist-api-keys-oauth-tab").count(), 1);
		await dialog.getByRole("button", { name: "Proxy", exact: true }).last().click();
		const input = dialog.locator("sitegeist-proxy-tab input");
		assert.equal(await input.inputValue(), "http://localhost:3001");
		assert.equal(await input.isDisabled(), true);
		await dialog.getByRole("switch").click();
		await input.fill("https://proxy.invalid");
		await input.dispatchEvent("change");
		await page.waitForFunction(
			async () => (await window.fixture.storage.settings.get("proxy.url")) === "https://proxy.invalid",
		);
		assert.equal(await page.evaluate(() => window.fixture.storage.settings.get("proxy.enabled")), true);
		await dialog.getByRole("switch").click();
		await page.waitForFunction(async () => (await window.fixture.storage.settings.get("proxy.enabled")) === false);
		await dialog.getByRole("button", { name: "About", exact: true }).last().click();
		await dialog.getByRole("button", { name: "Proxy", exact: true }).last().click();
		assert.equal(await input.inputValue(), "https://proxy.invalid");
		await page.keyboard.press("Escape");
		assert.equal(await page.evaluate(() => window.fixture.closes), 1);
		await page.keyboard.press("Escape");
		assert.equal(await page.evaluate(() => window.fixture.closes), 1);
		await page.locator("#settings").click();
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		assert.equal(await page.evaluate(() => window.fixture.closes), 2);
		await page.setViewportSize({ width: 420, height: 900 });
		await page.locator("#settings").click();
		await dialog.getByRole("button", { name: "Proxy", exact: true }).first().click();
		assert.equal(await input.isVisible(), true);
		assert.equal(await input.inputValue(), "https://proxy.invalid");
		await page.mouse.click(5, 5);
		assert.equal(await page.evaluate(() => window.fixture.closes), 3);
	} finally {
		await page.close();
	}
});
