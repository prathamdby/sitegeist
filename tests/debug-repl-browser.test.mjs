import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { getModel } from "../src/pi/models.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const models = [
	getModel("anthropic", "claude-sonnet-4-5-20250929"),
	getModel("openai", "gpt-5-codex"),
	getModel("google", "gemini-2.5-pro"),
	getModel("openrouter", "z-ai/glm-4.6"),
].filter(Boolean);
const prompts = [
	[
		"Calculate the sum of numbers from 1 to 100",
		"Now multiply that result by 3",
		"Create a bar chart showing the original sum and the multiplied value",
	],
	[
		"Create an HTML artifact with a red background and 'Hello World' text",
		"Change the background to blue",
		"Add a button that shows an alert when clicked",
	],
	[
		"Generate an array of 20000 random numbers between 1 and 100. Calculate the mean, median, and standard deviation. Create a Chart.js visualization showing the distribution. Use a separate tool call for each step.",
	],
	[
		"Generate an array of 20000 random numbers between 1 and 100. Calculate the mean, median, and standard deviation. Create a Chart.js visualization showing the distribution.",
	],
	[
		"Search Google for 'JavaScript tutorials'",
		"Extract the first 3 result titles",
		"Write them to a tutorials.md artifact with proper markdown formatting",
	],
];
let context;
let directory;
let origin;
let server;
const renders = process.env.SITEGEIST_DEBUG_RENDERS;

before(async () => {
	directory = mkdtempSync(join(tmpdir(), "sitegeist-debug-"));
	const extension = join(directory, "extension");
	mkdirSync(extension);
	const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
	writeFileSync(
		join(extension, "manifest.json"),
		JSON.stringify({
			manifest_version: 3,
			minimum_chrome_version: manifest.minimum_chrome_version,
			name: "Debug REPL migration fixture",
			version: "1.0.0",
			background: { service_worker: "background.js" },
			permissions: ["storage", "tabs", "userScripts"],
			host_permissions: manifest.host_permissions,
			sandbox: manifest.sandbox,
			content_security_policy: manifest.content_security_policy,
		}),
	);
	writeFileSync(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});");
	copyFileSync(join(root, "static/debug.html"), join(extension, "debug.html"));
	for (const file of ["sandbox.html", "sandbox.js", "theme-loader.js"])
		copyFileSync(join(root, "static", file), join(extension, file));
	writeFileSync(
		join(extension, "tool.html"),
		'<!doctype html><link rel="stylesheet" href="app.css"><script type="module" src="tool.js"></script>',
	);
	for (const file of ["sidepanel.html", "icons.html"])
		writeFileSync(join(extension, file), `<!doctype html><title>Navigation destination</title><p>${file}</p>`);
	execFileSync(join(root, "node_modules/.bin/tailwindcss"), [
		"-i",
		join(root, "src/app.css"),
		"-o",
		join(extension, "app.css"),
	]);
	await build({
		absWorkingDir: root,
		entryPoints: { debug: "src/debug.ts", tool: "tests/browser/debug-repl.ts" },
		outdir: extension,
		bundle: true,
		platform: "browser",
		format: "esm",
		plugins: [
			{
				name: "debug-fixture-shown-skills",
				setup(builder) {
					builder.onResolve({ filter: /sidepanel\.js$/ }, (args) =>
						args.importer === join(root, "src/utils/format-skills.ts")
							? { path: join(root, "tests/browser/debug-sidepanel.ts") }
							: undefined,
					);
				},
			},
		],
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
		inject: [join(root, "scripts/process-shim.js")],
		alias: {
			process: join(root, "scripts/process-shim.js"),
			"@mariozechner/mini-lit": join(root, "node_modules/@mariozechner/mini-lit"),
			lit: join(root, "node_modules/lit"),
		},
	});
	context = await chromium.launchPersistentContext(join(directory, "profile"), {
		channel: "chromium",
		headless: true,
		viewport: { width: 1440, height: 1100 },
		args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
	});
	context.on("page", (page) => page.on("pageerror", (error) => console.error(error.message)));
	const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
	origin = `chrome-extension://${new URL(worker.url()).hostname}`;
	server = createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(
			'<!doctype html><title>Debug picker target</title><button id="pick-me">Choose this element</button>',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
	await context?.close();
	await new Promise((resolve) => server?.close(resolve) ?? resolve());
	if (directory) rmSync(directory, { recursive: true, force: true });
});

async function debugPage(language) {
	const page = await context.newPage();
	if (language)
		await page.addInitScript((code) => {
			if (window === window.top) localStorage.setItem("language", code);
		}, language);
	await page.goto(`${origin}/debug.html`);
	await page.locator("repl-panel textarea").waitFor();
	return page;
}

async function screenshot(page, name) {
	if (!renders) return;
	mkdirSync(renders, { recursive: true });
	await page.screenshot({ path: join(renders, name), fullPage: true });
}

test(
	"real Chromium debug REPL preserves Run, keyboard execution, console/return, artifacts and Abort",
	{ timeout: 60000 },
	async (t) => {
		const page = await debugPage();
		t.diagnostic(await page.evaluate(() => navigator.userAgent));
		const panel = page.locator("repl-panel");
		const run = panel.getByRole("button", { name: "Run", exact: true });
		assert.equal(await run.isDisabled(), true);
		assert.equal(await panel.locator("pre").first().innerText(), "No output yet");
		await panel.locator("textarea").fill("   ");
		assert.equal(await run.isDisabled(), true);
		await panel
			.locator("textarea")
			.fill("console.log('debug console', 42); console.warn('warning'); return {total: 42};");
		await run.click();
		await page.waitForFunction(() => document.querySelector("repl-panel pre")?.textContent?.includes('"total": 42'));
		assert.equal(
			await panel.locator("pre").first().innerText(),
			'debug console 42\nwarning\n\n=> {\n  "total": 42\n}',
		);
		assert.equal(await page.locator("sitegeist-sandbox").count(), 0);
		await panel
			.locator("textarea")
			.fill(
				"await createOrUpdateArtifact('debug.md', '# Debug artifact\\n\\nCreated by the local sandbox.'); return await getArtifact('debug.md');",
			);
		await panel.locator("textarea").press("Control+Enter");
		await page.waitForFunction(() =>
			document.querySelector("repl-panel pre")?.textContent?.includes("=> # Debug artifact"),
		);
		await panel.getByRole("heading", { name: "Debug artifact" }).waitFor();
		await screenshot(page, "debug-repl-artifact.png");
		await panel.locator("textarea").fill("console.info('before error'); throw new Error('debug failure');");
		await panel.locator("textarea").press("Meta+Enter");
		await page.waitForFunction(() =>
			document.querySelector("repl-panel pre")?.textContent?.includes("debug failure"),
		);
		assert.match(await panel.locator("pre").first().innerText(), /^Error: before error\n\nError: debug failure\n/);
		await screenshot(page, "debug-repl-error.png");
		await panel.locator("textarea").fill("await new Promise(() => {});");
		await run.click();
		const abort = panel.getByRole("button", { name: "Abort", exact: true });
		await abort.waitFor();
		assert.equal(await panel.locator("pre").first().innerText(), "Executing...");
		await panel.locator("textarea").press("Control+Enter");
		assert.equal(await page.locator("sitegeist-sandbox").count(), 1);
		await abort.click();
		await run.waitFor();
		assert.equal(await panel.locator("pre").first().innerText(), "Error: Error: Execution aborted");
		assert.equal(await page.locator("sitegeist-sandbox").count(), 0);
		await panel.locator("textarea").fill("return 7;");
		await run.click();
		await page.waitForFunction(() => document.querySelector("repl-panel pre")?.textContent === "=> 7");
		await page.close();
		const german = await debugPage("de");
		try {
			const germanPanel = german.locator("repl-panel");
			await germanPanel.locator("textarea").fill("await createOrUpdateArtifact('de.md', '# Deutsch'); return 42;");
			await germanPanel.getByRole("button", { name: "Run", exact: true }).click();
			await german.waitForFunction(() => document.querySelector("repl-panel pre")?.textContent === "=> 42");
			assert.equal(await germanPanel.getByRole("heading", { name: "Deutsch", exact: true }).count(), 1);
			assert.deepEqual(
				await germanPanel
					.locator("artifacts-panel > div > div button[title]")
					.evaluateAll((buttons) => buttons.map((button) => button.title)),
				["Vorschau", "Code", "Markdown kopieren", "Markdown herunterladen", "Artefakte schließen"],
			);
			await screenshot(german, "debug-repl-german-artifact.png");
		} finally {
			await german.evaluate(() => localStorage.setItem("language", "en"));
			await german.close();
		}
	},
);

test(
	"real Chromium generic tool registers locally and renders original downloadable output with JSON override",
	{ timeout: 60000 },
	async () => {
		const page = await context.newPage();
		await page.goto(`${origin}/tool.html`);
		await page.waitForFunction(() => window.debugReplFixture);
		assert.equal(await page.evaluate(() => window.debugReplFixture.registered), true);
		assert.match(await page.evaluate(() => window.debugReplFixture.description), /returnDownloadableFile/);
		await page.evaluate(() => window.debugReplFixture.preparing());
		assert.equal(await page.getByText("Preparing JavaScript...", { exact: true }).count(), 1);
		assert.equal(await page.locator(".animate-spin").count(), 1);
		const result = await page.evaluate(() =>
			window.debugReplFixture.run(
				"console.log('file output'); await returnDownloadableFile('hé.txt', 'hé 文', 'text/plain'); await returnDownloadableFile('bytes.bin', new Uint8Array([0, 255]), 'application/octet-stream'); return 42;",
			),
		);
		assert.match(result.content[0].text, /file output\n\n=> 42\n\[Files returned: 2\]/);
		assert.equal(Buffer.from(result.details.files[0].contentBase64, "base64").toString("utf8"), "hé 文");
		assert.deepEqual([...Buffer.from(result.details.files[1].contentBase64, "base64")], [0, 255]);
		await page.getByRole("button", { name: "Generic debug output" }).click();
		assert.match(await page.locator("sitegeist-console-block").innerText(), /file output/);
		assert.equal(await page.locator("attachment-tile").count(), 2);
		await screenshot(page, "debug-generic-files.png");
		await page.locator('[title="hé.txt"]').click();
		await page.getByText("hé 文", { exact: true }).waitFor();
		const download = page.waitForEvent("download");
		await page.locator("attachment-overlay button").first().click();
		const file = await download;
		assert.equal(file.suggestedFilename(), "hé.txt");
		assert.equal(readFileSync(await file.path(), "utf8"), "hé 文");
		await page.locator("attachment-overlay button").last().click();
		await page.evaluate(() => window.debugReplFixture.run("throw new Error('generic failure');"));
		await page.getByRole("button", { name: "Generic debug output" }).click();
		assert.match(await page.locator("sitegeist-console-block").innerText(), /Error: generic failure/);
		assert.equal(await page.locator("sitegeist-console-block").evaluate((element) => element.variant), "error");
		await page.evaluate(() => window.debugReplFixture.json(true));
		await page.evaluate(() => window.debugReplFixture.run("return 5;"));
		assert.equal(await page.getByText("Tool Call", { exact: true }).count(), 1);
		assert.equal(await page.locator("code-block[language=json]").count(), 1);
		await page.close();
	},
);

test(
	"real Chromium preserves both persisted debug toggles and every debug navigation/test-prompt control",
	{ timeout: 60000 },
	async () => {
		const page = await debugPage();
		const switches = page.getByRole("switch");
		assert.equal(await switches.count(), 2);
		for (let index = 0; index < 2; index++) {
			await switches.nth(index).click();
			await page.waitForFunction(
				(key) => chrome.storage.local.get(key).then((stored) => stored[key] === true),
				index === 0 ? "debuggerMode" : "showJsonMode",
			);
			await page.waitForFunction(
				(index) => document.querySelectorAll('[role="switch"]')[index]?.getAttribute("aria-checked") === "true",
				index,
			);
		}
		await page.reload();
		await page.locator("repl-panel textarea").waitFor();
		assert.deepEqual(await switches.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-checked"))), [
			"true",
			"true",
		]);
		await screenshot(page, "debug-controls.png");
		for (let index = 0; index < 2; index++) {
			await switches.nth(index).click();
			await page.waitForFunction(
				(key) => chrome.storage.local.get(key).then((stored) => stored[key] === false),
				index === 0 ? "debuggerMode" : "showJsonMode",
			);
		}
		for (const [control, destination] of [
			["Back to chat", "sidepanel.html"],
			["Generate extension icons", "icons.html"],
		]) {
			await page.goto(`${origin}/debug.html`);
			await page.getByTitle(control).click();
			await page.waitForURL(`${origin}/${destination}`);
		}
		for (const chord of ["Control+u", "Meta+u"]) {
			await page.goto(`${origin}/debug.html`);
			await page.locator("repl-panel textarea").waitFor();
			await page.locator("body").press(chord);
			await page.waitForURL(`${origin}/sidepanel.html`);
		}
		for (let prompt = 0; prompt < prompts.length; prompt++) {
			for (const model of models) {
				await page.goto(`${origin}/debug.html`);
				const buttons = page.getByTitle(`Run with ${model.name}`, { exact: true });
				assert.equal(await buttons.count(), prompts.length);
				await buttons.nth(prompt).click();
				await page.waitForURL((url) => url.pathname === "/sidepanel.html");
				const url = new URL(page.url());
				assert.deepEqual(JSON.parse(url.searchParams.get("teststeps")), prompts[prompt]);
				assert.equal(url.searchParams.get("provider"), model.provider);
				assert.equal(url.searchParams.get("model"), model.id);
			}
		}
		await page.close();
	},
);

test(
	"real Chromium debug element-picker control launches the production overlay and shows its selection",
	{ timeout: 60000 },
	async () => {
		const page = await debugPage();
		const settings = await context.newPage();
		await settings.goto(`chrome://extensions/?id=${new URL(origin).hostname}`);
		await settings.locator("extensions-detail-view").waitFor();
		await settings.locator("#allow-user-scripts cr-toggle").click();
		await settings.close();
		const target = await context.newPage();
		await target.goto(`http://127.0.0.1:${server.address().port}`);
		await target.bringToFront();
		const selected = new Promise((resolve) =>
			page.once("dialog", async (dialog) => {
				const message = dialog.message();
				await dialog.accept();
				resolve(message);
			}),
		);
		await page.getByRole("button", { name: "Launch Element Picker", exact: true }).click();
		await target.locator("#sitegeist-element-picker").waitFor();
		await target.locator("#pick-me").click();
		assert.match(await selected, /Selected element:/);
		assert.equal(await target.locator("#sitegeist-element-picker").count(), 0);
		await page.close();
		await target.close();
	},
);

test(
	"packaged Chromium HTML artifacts enforce isolation/read-only access and export matching offline snapshots",
	{ timeout: 60000 },
	async () => {
		const page = await debugPage();
		const upload = "Uploaded fixture text hé 文";
		const uploadBytes = [...new TextEncoder().encode(upload)];
		await page.evaluate(
			({ upload, content, size }) => {
				const panel = document.querySelector("artifacts-panel");
				panel.agent = {
					state: {
						messages: [
							{
								role: "user-with-attachments",
								attachments: [
									{
										id: "debug-upload",
										type: "document",
										fileName: "upload.txt",
										mimeType: "text/plain",
										size,
										content,
										extractedText: upload,
									},
								],
							},
						],
					},
				};
				document.body.dataset.debugHtmlMarker = "protected";
				localStorage.setItem("debugHtmlMarker", "protected");
				return chrome.storage.local.set({ debugHtmlMarker: "protected" });
			},
			{ upload, content: Buffer.from(upload).toString("base64"), size: uploadBytes.length },
		);

		const html = (version) => `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 24px; color: #172033; background: #f4f7fb; font: 16px system-ui; }
pre { background: white; padding: 16px; border: 1px solid #d8e1ed; border-radius: 8px; white-space: pre-wrap; }
</style></head><body><h1>Sandboxed artifact v${version}</h1><p>Artifact and uploaded-file helpers</p>
<pre id="artifact"></pre><pre id="upload"></pre><script>
(async () => {
 const data = await getArtifact('data.json');
 document.querySelector('#artifact').textContent = JSON.stringify(data, null, 2);
 document.querySelector('#upload').textContent = readTextAttachment('debug-upload');
 const probe = { data, attachments: listAttachments(), uploadBytes: [...readBinaryAttachment('debug-upload')], online: typeof window.sendRuntimeMessage === 'function' };
 const denied = async run => { try { await run(); return 'allowed'; } catch (error) { return error.name; } };
 probe.parentDOM = await denied(() => { parent.document.body.dataset.debugHtmlMarker = 'forged'; });
 probe.parentStorage = await denied(() => { parent.localStorage.setItem('debugHtmlMarker', 'forged'); });
 probe.localStorage = await denied(() => { localStorage.setItem('debugHtmlMarker', 'forged'); });
 probe.sessionStorage = await denied(() => { sessionStorage.setItem('debugHtmlMarker', 'forged'); });
 probe.parentChrome = await denied(() => parent.chrome.storage.local.set({ debugHtmlMarker: 'forged' }));
 probe.extensionAPI = typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined';
 if (probe.online) {
  const rejection = async run => { try { await run(); return 'allowed'; } catch (error) { return error.message; } };
  probe.helperWrite = await rejection(() => createOrUpdateArtifact('data.json', { value: 'forged' }));
  probe.helperDelete = await rejection(() => deleteArtifact('data.json'));
  probe.forgedWrite = await rejection(() => sendRuntimeMessage({ type: 'artifact-operation', action: 'createOrUpdate', filename: 'forged.json', content: '{}' }));
  probe.forgedDelete = await rejection(() => sendRuntimeMessage({ type: 'artifact-operation', action: 'delete', filename: 'data.json' }));
 }
 window.debugHtmlProbe = probe;
 document.body.dataset.ready = 'true';
})().catch(error => { document.querySelector('#artifact').textContent = String(error); });
</script></body></html>`;
		const panel = page.locator("repl-panel");
		const preview = page.frameLocator("artifacts-panel sitegeist-html-preview iframe");
		const execute = async (data, version) => {
			await panel
				.locator("textarea")
				.fill(
					`await createOrUpdateArtifact('data.json', ${JSON.stringify(data)}); await createOrUpdateArtifact('isolation.html', ${JSON.stringify(html(version))}); return 'Artifact v${version} ready';`,
				);
			await panel.getByRole("button", { name: "Run", exact: true }).click();
			await page.waitForFunction(
				(version) => document.querySelector("repl-panel pre")?.textContent === `=> Artifact v${version} ready`,
				version,
			);
			await preview.locator('body[data-ready="true"] h1').waitFor();
			assert.equal(await preview.locator("h1").innerText(), `Sandboxed artifact v${version}`);
			return preview.locator("body").evaluate(() => window.debugHtmlProbe);
		};
		const first = await execute({ label: "Initial snapshot", count: 1 }, 1);
		const iframe = page.locator("artifacts-panel sitegeist-html-preview iframe");
		assert.equal(await iframe.getAttribute("src"), `${origin}/sandbox.html`);
		assert.equal(await iframe.getAttribute("srcdoc"), null);
		assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts allow-modals");
		assert.equal(first.online, true);
		for (const key of ["parentDOM", "parentStorage", "localStorage", "sessionStorage", "parentChrome"])
			assert.equal(first[key], "SecurityError", key);
		assert.equal(first.extensionAPI, true);
		for (const key of ["helperWrite", "helperDelete", "forgedWrite", "forgedDelete"])
			assert.equal(first[key], "Artifacts are read-only in HTML previews", key);
		assert.deepEqual(first.uploadBytes, uploadBytes);
		assert.deepEqual(
			first.attachments.map(({ id, fileName }) => ({ id, fileName })),
			[{ id: "debug-upload", fileName: "upload.txt" }],
		);
		assert.deepEqual(
			await page.evaluate(async () => ({
				dom: document.body.dataset.debugHtmlMarker,
				storage: localStorage.getItem("debugHtmlMarker"),
				chrome: (await chrome.storage.local.get("debugHtmlMarker")).debugHtmlMarker,
				data: JSON.parse(document.querySelector("artifacts-panel").artifacts.get("data.json").content),
				forged: document.querySelector("artifacts-panel").artifacts.has("forged.json"),
			})),
			{
				dom: "protected",
				storage: "protected",
				chrome: "protected",
				data: { label: "Initial snapshot", count: 1 },
				forged: false,
			},
		);

		const updated = { label: "Updated snapshot hé 文", count: 2 };
		assert.deepEqual((await execute(updated, 2)).data, updated);
		assert.equal(await preview.locator("#artifact").innerText(), JSON.stringify(updated, null, 2));
		assert.equal(await preview.locator("#upload").innerText(), upload);
		await screenshot(page, "debug-html-isolation.png");
		const visible = await preview.locator("body").innerText();
		const downloaded = page.waitForEvent("download");
		await page.getByTitle("Download HTML", { exact: true }).click();
		const file = await downloaded;
		assert.equal(file.suggestedFilename(), "isolation.html");
		const standalone = readFileSync(await file.path(), "utf8");
		assert.ok(standalone.includes("Sandboxed artifact v2"));
		assert.equal(standalone.includes("sitegeist-artifact-navigation"), false);
		const offlinePath = join(directory, "standalone.html");
		writeFileSync(offlinePath, standalone);
		const offline = await context.newPage();
		const networkRequests = [];
		offline.on("request", (request) => {
			if (/^https?:/.test(request.url())) networkRequests.push(request.url());
		});
		await offline.goto(pathToFileURL(offlinePath).href);
		await offline.locator('body[data-ready="true"]').waitFor();
		assert.equal(await offline.locator("body").innerText(), visible);
		const offlineProbe = await offline.evaluate(() => window.debugHtmlProbe);
		assert.equal(offlineProbe.online, false);
		assert.deepEqual(offlineProbe.data, updated);
		assert.deepEqual(offlineProbe.uploadBytes, uploadBytes);
		assert.deepEqual(networkRequests, []);
		await offline.close();
		await page.close();
	},
);

test(
	"packaged Chromium CSP blocks SVG handlers while preserving foreignObject content",
	{ timeout: 60000 },
	async () => {
		const page = await debugPage();
		await page.evaluate(async () => {
			window.svgHandlerExecuted = false;
			window.svgScriptExecuted = false;
			window.svgLinkExecuted = false;
			window.svgPolicyViolations = [];
			document.addEventListener("securitypolicyviolation", (event) =>
				window.svgPolicyViolations.push(event.effectiveDirective),
			);
			await chrome.storage.local.set({ svgProbe: "protected" });
		});
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="100" onload="window.svgHandlerExecuted=true;chrome.storage.local.set({svgProbe:'changed'})">
<rect width="240" height="100" fill="#4169e1"/><script>window.svgScriptExecuted=true</script>
<a href="javascript:window.svgLinkExecuted=true"><text x="10" y="20">Script link</text></a>
<foreignObject x="10" y="40" width="220" height="50"><div xmlns="http://www.w3.org/1999/xhtml">Foreign content preserved</div></foreignObject></svg>`;
		await page
			.locator("repl-panel textarea")
			.fill(`await createOrUpdateArtifact('policy.svg', ${JSON.stringify(svg)}); return 'SVG ready';`);
		await page.getByRole("button", { name: "Run", exact: true }).click();
		await page.waitForFunction(() => document.querySelector("repl-panel pre")?.textContent.includes("=> SVG ready"));
		assert.equal(await page.locator("artifacts-panel foreignObject div").innerText(), "Foreign content preserved");
		await page.waitForFunction(() =>
			window.svgPolicyViolations.some((directive) => directive.startsWith("script-src")),
		);
		await page.locator("artifacts-panel svg a").click();
		assert.deepEqual(
			await page.evaluate(async () => ({
				handler: window.svgHandlerExecuted,
				script: window.svgScriptExecuted,
				link: window.svgLinkExecuted,
				storage: (await chrome.storage.local.get("svgProbe")).svgProbe,
			})),
			{ handler: false, script: false, link: false, storage: "protected" },
		);
		await page.close();
	},
);
