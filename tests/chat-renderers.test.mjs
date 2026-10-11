import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
let browser;
let server;
let origin;
let directory;

before(async () => {
	directory = mkdtempSync(join(tmpdir(), "sitegeist-renderers-"));
	execFileSync(`${root}node_modules/.bin/tailwindcss`, ["-i", `${root}src/app.css`, "-o", join(directory, "app.css")]);
	const css = readFileSync(join(directory, "app.css"));
	const bundled = await build({
		entryPoints: ["tests/browser/chat-renderers.ts"],
		absWorkingDir: root,
		bundle: true,
		write: false,
		platform: "browser",
		format: "esm",
		plugins: [
			{
				name: "renderer-fixture-sidepanel",
				setup(build) {
					build.onResolve({ filter: /^@mariozechner\/pi-ai$/ }, (args) => ({
						path: /\/pi-mono\/packages\/(agent|ai)\//.test(args.importer)
							? `${root}../pi-mono/packages/ai/dist/index.js`
							: `${root}src/pi/models.ts`,
					}));
					build.onResolve({ filter: /sidepanel\.js$/ }, (args) =>
						args.importer.endsWith("/src/utils/format-skills.ts")
							? { path: `${root}tests/browser/chat-renderers-sidepanel.ts` }
							: undefined,
					);
				},
			},
		],
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
		inject: [`${root}scripts/process-shim.js`],
		alias: {
			process: `${root}scripts/process-shim.js`,
			"@mariozechner/pi-agent-core": `${root}src/pi/agent.ts`,
			"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
			lit: `${root}node_modules/lit`,
			"@mariozechner/pi-web-ui/dist/components/MessageList.js": `${root}node_modules/@mariozechner/pi-web-ui/dist/components/MessageList.js`,
			"@mariozechner/pi-web-ui/dist/components/Messages.js": `${root}node_modules/@mariozechner/pi-web-ui/dist/components/Messages.js`,
			"@mariozechner/pi-web-ui/dist/components/AttachmentTile.js": `${root}node_modules/@mariozechner/pi-web-ui/dist/components/AttachmentTile.js`,
		},
	});
	server = createServer((request, response) => {
		response.setHeader(
			"Content-Type",
			request.url === "/app.css" ? "text/css" : request.url === "/fixture.js" ? "text/javascript" : "text/html",
		);
		response.end(
			request.url === "/app.css"
				? css
				: request.url === "/fixture.js"
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

async function page() {
	const page = await browser.newPage();
	page.on("pageerror", (error) => console.error(error));
	await page.goto(origin);
	await page.waitForFunction(() => window.fixture);
	return page;
}

test("baseline and local preserve assistant block ordering, paired tools, Markdown and usage", async () => {
	const p = await page();
	for (const local of [false, true]) {
		await p.evaluate((local) => window.fixture[local ? "local" : "baseline"](), local);
		const tag = local ? "sitegeist-assistant-message" : "assistant-message";
		assert.deepEqual(
			await p
				.locator(`${tag} > div > .px-4.flex > *`)
				.evaluateAll((nodes) => nodes.map((node) => node.tagName.replace("SITEGEIST-", "").toLowerCase())),
			["thinking-block", "markdown-block", "tool-message", "markdown-block"],
		);
		assert.equal(await p.locator("markdown-block strong").innerText(), "tool");
		assert.equal(await p.locator(local ? "sitegeist-tool-message" : "tool-message").count(), 1);
		assert.match(await p.locator(`${tag}`).innerText(), /↑120 ↓35 R10 W5 \$0\.0330/);
		assert.equal(await p.locator("code-block code").last().innerText(), "Result body");
	}
	await p.close();
});

test("incomplete default renderers and streaming reasoning match measured baseline states", async () => {
	const p = await page();
	for (const name of ["bash", "calculate", "get_current_time"]) {
		for (const args of [
			undefined,
			{},
			name === "bash" ? { command: "ls" } : name === "calculate" ? { expression: "1+1" } : { timezone: "UTC" },
		]) {
			const texts = [];
			for (const local of [false, true]) {
				await p.evaluate(
					({ name, args, local }) =>
						window.fixture[local ? "localTool" : "tool"]({
							toolCall: { type: "toolCall", id: "one", name, arguments: args },
							result: undefined,
							isStreaming: true,
						}),
					{ name, args, local },
				);
				texts.push((await p.locator("body").innerText()).replace(/\s+/g, " ").trim());
			}
			assert.equal(texts[1], texts[0]);
		}
	}
	for (const local of [false, true]) {
		await p.evaluate((local) => window.fixture.thinking(local, true), local);
		assert.equal(await p.locator(".animate-shimmer").count(), 1);
		assert.equal(await p.locator(".thinking-header").getAttribute("tabindex"), null);
		assert.equal(await p.locator("markdown-block").count(), 0);
		await p.locator(".thinking-header").click();
		assert.equal(await p.locator(".thinking-block > markdown-block").count(), 1);
		assert.equal(await p.locator("markdown-block .italic.text-sm").count(), 1);
	}
	await p.close();
});

test("tools expose running, success, error and aborted states like baseline", async () => {
	const p = await page();
	for (const state of ["pending", "running", "success", "error", "aborted"]) {
		for (const local of [false, true]) {
			await p.evaluate(
				({ state, local }) =>
					window.fixture[local ? "localTool" : "tool"]({
						result:
							state === "success" || state === "error"
								? { ...window.fixture.result, isError: state === "error" }
								: undefined,
						isStreaming: state === "running" || state === "pending",
						pending: state === "pending",
						aborted: state === "aborted",
					}),
				{ state, local },
			);
			assert.equal(await p.locator(".animate-spin").count(), state === "pending" || state === "running" ? 1 : 0);
			assert.equal(await p.locator(".text-destructive").count(), state === "error" || state === "aborted" ? 1 : 0);
		}
	}
	await p.close();
});

test("reasoning expands, copy writes the tool payload, cost clicks and custom role overrides work", async () => {
	const p = await page();
	await p.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	await p.evaluate(() => window.fixture.local());
	await p.locator(".thinking-header").click();
	assert.match(await p.locator("sitegeist-thinking-block markdown-block").innerText(), /Reasoning detail/);
	await p.locator("code-block copy-button button").first().click();
	assert.equal(await p.evaluate(() => navigator.clipboard.readText()), '{\n  "query": "fixture"\n}');
	await p.locator("sitegeist-assistant-message .mt-2.text-xs").click();
	assert.equal(await p.evaluate(() => window.fixture.costs), 1);
	await p.evaluate(async () => {
		window.fixture.custom("user");
		await window.fixture.local();
	});
	assert.equal(await p.locator('[data-custom="user"]').innerText(), "Custom user");
	assert.equal(await p.locator("sitegeist-chat-user-message").count(), 0);
	await p.close();
});

test("stream updates preserve one assistant, reasoning state and partial tool results", async () => {
	const p = await page();
	await p.evaluate(() => window.fixture.local({ messages: [], streamingMessage: window.fixture.assistant }));
	await p.locator(".thinking-header").click();
	await p.evaluate(async () => {
		const list = document.querySelector("sitegeist-message-list");
		list.streamingMessage = {
			...window.fixture.assistant,
			content: [...window.fixture.assistant.content, { type: "text", text: "Streaming tail" }],
		};
		list.toolResultsById = new Map([["one", window.fixture.result]]);
		await list.updateComplete;
	});
	assert.equal(await p.locator("sitegeist-assistant-message").count(), 1);
	assert.equal(await p.locator("sitegeist-thinking-block markdown-block").count(), 1);
	assert.match(await p.locator("sitegeist-assistant-message").innerText(), /Streaming tail/);
	await p.evaluate(async () => {
		const list = document.querySelector("sitegeist-message-list");
		list.messages = [list.streamingMessage, window.fixture.result];
		await list.updateComplete;
	});
	assert.equal(await p.locator("sitegeist-assistant-message").count(), 1);
	assert.equal(await p.locator("sitegeist-tool-message").count(), 1);
	await p.close();
});

test("message identity keeps expansion on its row after removal and does not leak state into a replacement", async () => {
	const p = await page();
	try {
		await p.evaluate(() =>
			window.fixture.local({
				messages: [
					window.fixture.assistant,
					{ ...structuredClone(window.fixture.assistant), timestamp: window.fixture.assistant.timestamp },
				],
			}),
		);
		await p.locator(".thinking-header").last().click();
		await p.evaluate(async () => {
			const list = document.querySelector("sitegeist-message-list");
			list.messages = [list.messages[1]];
			await list.updateComplete;
		});
		assert.equal(await p.locator("sitegeist-thinking-block markdown-block").count(), 1);
		await p.evaluate(async () => {
			const list = document.querySelector("sitegeist-message-list");
			list.messages = [
				{ ...structuredClone(window.fixture.assistant), timestamp: window.fixture.assistant.timestamp },
			];
			await list.updateComplete;
		});
		assert.equal(await p.locator("sitegeist-thinking-block markdown-block").count(), 0);
	} finally {
		await p.close();
	}
});

test("console copy denial is handled and its reset timer is cancelled when the row disconnects", async () => {
	const p = await page();
	const errors = [];
	p.on("pageerror", (error) => errors.push(error.message));
	try {
		await p.evaluate(() => {
			window.fixture.localTool({
				toolCall: { type: "toolCall", id: "copy", name: "bash", arguments: { command: "fixture" } },
			});
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async () => {
						throw new DOMException("Denied", "NotAllowedError");
					},
				},
			});
		});
		await p.getByTitle("Copy output").click();
		assert.deepEqual(errors, []);
		assert.equal(await p.getByTitle("Copy output").innerText(), "");
		await p.evaluate(() => {
			Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
			const timers = new Set();
			const schedule = window.setTimeout.bind(window);
			const cancel = window.clearTimeout.bind(window);
			window.setTimeout = (callback, delay, ...args) => {
				const id = schedule(callback, delay, ...args);
				if (delay === 2000) timers.add(id);
				return id;
			};
			window.clearTimeout = (id) => {
				timers.delete(id);
				cancel(id);
			};
			window.copyTimers = timers;
		});
		await p.getByTitle("Copy output").click();
		await p.getByText("Copied!", { exact: true }).waitFor();
		assert.equal(await p.evaluate(() => window.copyTimers.size), 1);
		await p.evaluate(() => document.querySelector("sitegeist-console-block").remove());
		assert.equal(await p.evaluate(() => window.copyTimers.size), 0);
	} finally {
		await p.close();
	}
});

test("built-in tools and JSON mode match baseline rendered text", async () => {
	const p = await page();
	for (const [name, args] of [
		["bash", { command: "ls" }],
		["calculate", { expression: "1+1" }],
		["get_current_time", { timezone: "UTC" }],
	]) {
		const texts = [];
		for (const local of [false, true]) {
			await p.evaluate(
				({ name, args, local }) =>
					window.fixture[local ? "localTool" : "tool"]({
						toolCall: { type: "toolCall", id: "one", name, arguments: args },
					}),
				{ name, args, local },
			);
			texts.push((await p.locator("body").innerText()).replace(/\s+/g, " ").trim());
		}
		assert.equal(texts[1], texts[0]);
	}
	await p.evaluate(() => window.fixture.json(true, true));
	assert.match(await p.locator("body").innerText(), /Tool Call.*Input.*Output/s);
	assert.equal(await p.locator("sitegeist-console-block").count(), 0);
	await p.evaluate(() => window.fixture.json(true, false));
	await p.close();
});

test("header helper expands existing custom renderer max-height content and expandable captures children", async () => {
	const p = await page();
	await p.evaluate(() => window.fixture.header(true));
	await p.locator("button").click();
	assert.equal(await p.locator(".max-h-0").count(), 0);
	assert.equal(await p.locator("button").getAttribute("aria-expanded"), "true");
	await p.locator("button").click();
	assert.equal(await p.locator(".max-h-0").count(), 1);
	await p.evaluate(() => window.fixture.expandable(true));
	assert.equal(await p.locator("sitegeist-expandable-section .mt-2").count(), 0);
	await p.locator("button").click();
	assert.equal(await p.locator("sitegeist-expandable-section .mt-2").innerText(), "Expanded content");
	await p.close();
});

test("attachments stay legacy tiles and system/artifact/toolResult messages stay invisible", async () => {
	const p = await page();
	await p.evaluate(() =>
		window.fixture.local({
			messages: [
				{ role: "system", content: "Private system prompt", timestamp: 0 },
				{ role: "artifact", action: "create", filename: "hidden.md", timestamp: "now" },
				window.fixture.result,
				{
					role: "user-with-attachments",
					content: "Attached",
					timestamp: 0,
					attachments: [
						{
							id: "file",
							type: "document",
							fileName: "example.txt",
							mimeType: "text/plain",
							size: 10,
							content: "ZXhhbXBsZQ==",
							extractedText: "example",
						},
					],
				},
			],
		}),
	);
	assert.equal(await p.locator("attachment-tile").count(), 1);
	assert.equal(await p.locator("attachment-tile").evaluate((tile) => tile.attachment.fileName), "example.txt");
	assert.doesNotMatch(await p.locator("body").innerText(), /Private system prompt|hidden.md|Result body/);
	await p.close();
});

test("actual user-pill/navigation/welcome renderers consume local registry and preserve their actions", async () => {
	const p = await page();
	await p.evaluate(() => window.fixture.actualCustom());
	assert.equal(await p.locator("sitegeist-user-message").count(), 1);
	assert.equal(await p.locator("sitegeist-user-message .user-message-container").innerText(), "Styled question");
	await p.getByRole("button", { name: "Fixture page" }).click();
	assert.equal(await p.evaluate(() => window.fixture.openedUrl), "https://example.test/");
	await p.getByRole("button", { name: "Try tutorial" }).click();
	assert.equal(await p.evaluate(() => window.fixture.tutorialPrompt), "Tutorial request");
	await p.close();
});

test("native baseline controller keeps tool cards visible while sequential execution is held", async () => {
	const p = await page();
	await p.evaluate(() => window.fixture.baselineHold());
	assert.deepEqual(
		await p.locator("agent-interface").evaluate((controller) => ({
			streaming: controller.session.state.isStreaming,
			pending: [...controller.session.state.pendingToolCalls],
		})),
		{ streaming: true, pending: ["first"] },
	);
	assert.equal(await p.locator("tool-message").count(), 2);
	assert.equal(await p.locator("tool-message .animate-spin").count(), 0);
	await p.evaluate(() => window.fixture.releaseHeld());
	assert.equal(await p.locator("tool-message").count(), 2);
	assert.equal(await p.locator("tool-message .animate-spin").count(), 0);
	await p.evaluate(() => window.fixture.releaseHeld());
	assert.equal(await p.locator("tool-message .animate-spin").count(), 0);
	await p.evaluate(() =>
		window.fixture.local({
			messages: [window.fixture.assistant],
			pendingToolCalls: new Set(["one"]),
			isStreaming: true,
		}),
	);
	assert.equal(await p.locator("sitegeist-tool-message").count(), 1);
	assert.equal(await p.locator("sitegeist-tool-message .animate-spin").count(), 0);
	await p.close();
});

test("German renderer labels preserve baseline translations and literal thinking/fallback headers", async () => {
	const p = await page();
	await Promise.all([p.waitForEvent("load"), p.evaluate(() => window.fixture.language("de"))]);
	await p.waitForFunction(() => window.fixture);
	const bodies = [];
	for (const local of [false, true]) {
		await p.evaluate((local) => window.fixture[local ? "local" : "baseline"](), local);
		bodies.push((await p.locator("body").innerText()).replace(/\s+/g, " ").trim());
	}
	assert.equal(bodies[1], bodies[0]);
	assert.match(bodies[1], /Thinking\.\.\..*Tool Call.*Eingabe.*Ausgabe/);
	for (const [name, args] of [
		["bash", { command: "ls" }],
		["calculate", { expression: "1+1" }],
		["get_current_time", { timezone: "UTC" }],
	]) {
		const texts = [];
		for (const local of [false, true]) {
			await p.evaluate(
				({ name, args, local }) =>
					window.fixture[local ? "localTool" : "tool"]({
						toolCall: { type: "toolCall", id: "one", name, arguments: args },
					}),
				{ name, args, local },
			);
			texts.push((await p.locator("body").innerText()).replace(/\s+/g, " ").trim());
		}
		assert.equal(texts[1], texts[0]);
	}
	await p.close();
});

test("mixed reasoning/tool layout matches baseline at narrow/wide light/dark viewports", async () => {
	const output = process.env.RENDERER_SCREENSHOT_DIR;
	if (output) mkdirSync(output, { recursive: true });
	const p = await page();
	for (const width of [360, 900]) {
		await p.setViewportSize({ width, height: 600 });
		for (const theme of ["light", "dark"]) {
			await p.evaluate((theme) => {
				document.documentElement.classList.toggle("dark", theme === "dark");
				document.body.style.cssText = "margin:0;background:var(--color-background);color:var(--color-foreground)";
			}, theme);
			const layouts = [];
			for (const local of [false, true]) {
				await p.evaluate((local) => window.fixture[local ? "local" : "baseline"](), local);
				await p.locator(".thinking-header").click();
				await p.waitForTimeout(350);
				layouts.push(await p.locator(local ? "sitegeist-tool-message" : "tool-message").boundingBox());
				if (output)
					await p.screenshot({
						path: join(output, `renderers-${local ? "after" : "before"}-${theme}-${width}.png`),
					});
			}
			assert.deepEqual(layouts[1], layouts[0]);
		}
	}
	await p.close();
});
