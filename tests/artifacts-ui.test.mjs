import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { chatBridge } from "../scripts/chat-bridge.mjs";
import { storageBridge } from "../scripts/storage-bridge.mjs";
import { documentFixtures } from "./attachments-ui-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = join(process.env.HOME, ".capy/work/artifacts-ui");
const renders = process.env.ARTIFACT_RENDER_DIRECTORY;
const measurementsPath = process.env.ARTIFACT_MEASUREMENTS_PATH || join(work, "artifact-measurements.json");
let browser;
let server;
let origin;
const measurements = [];

before(async () => {
	mkdirSync(work, { recursive: true });
	if (renders) mkdirSync(renders, { recursive: true });
	mkdirSync(dirname(measurementsPath), { recursive: true });
	execFileSync(`${root}node_modules/.bin/tailwindcss`, ["-i", `${root}src/app.css`, "-o", join(work, "app.css")]);
	const bundle = async (entry) => {
		const result = await build({
			absWorkingDir: root,
			entryPoints: [entry],
			bundle: true,
			write: false,
			platform: "browser",
			format: "esm",
			plugins: [chatBridge(root), storageBridge(root)],
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
		return result.outputFiles[0].text;
	};
	const [baseline, local] = await Promise.all([
		bundle("tests/browser/artifacts-baseline.ts"),
		bundle("tests/browser/artifacts-local.ts"),
	]);
	server = createServer((request, response) => {
		if (request.url === "/baseline.js" || request.url === "/local.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(request.url === "/baseline.js" ? baseline : local);
		} else if (request.url === "/app.css") {
			response.setHeader("Content-Type", "text/css");
			response.end(readFileSync(join(work, "app.css")));
		} else if (request.url.endsWith("pdf.worker.min.mjs")) {
			response.setHeader("Content-Type", "text/javascript");
			response.end(readFileSync(`${root}node_modules/pdfjs-dist/build/pdf.worker.min.mjs`));
		} else {
			response.setHeader("Content-Type", "text/html");
			response.end(
				`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><script type="module" src="/${request.url === "/baseline" ? "baseline" : "local"}.js"></script>`,
			);
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const executablePath =
		process.env.CHROMIUM_PATH ||
		[chromium.executablePath(), "/usr/local/bin/chromium", "/usr/bin/chromium"].find(existsSync);
	browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
	writeFileSync(measurementsPath, JSON.stringify(measurements, null, 2));
	await browser?.close();
	await new Promise((resolve) => server?.close(resolve));
});

async function pageFor(local = true, width = 600) {
	const page = await browser.newPage({ viewport: { width, height: 800 } });
	await page.goto(`${origin}/${local ? "local" : "baseline"}`);
	await page.waitForSelector('[data-artifacts-ready="true"]');
	return page;
}
async function command(page, params) {
	return page.evaluate((params) => window.artifactsFixture.command(params), params);
}
async function settle(page) {
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function capture(page, name) {
	if (renders) await page.screenshot({ path: join(renders, `${name}.png`) });
}

test("tool results, callbacks and first-match/dollar replacement match the measured public baseline", async () => {
	const pages = await Promise.all([pageFor(false), pageFor()]);
	const commands = [
		{ command: "get", filename: "missing.txt" },
		{ command: "delete", filename: "missing.txt" },
		{ command: "create", filename: "notes.txt", content: "before one one after" },
		{ command: "create", filename: "notes.txt", content: "replace" },
		{ command: "update", filename: "notes.txt", old_str: "absent", new_str: "x" },
		{ command: "update", filename: "notes.txt", old_str: "one", new_str: "$&/$`/$'/$$" },
		{ command: "get", filename: "notes.txt" },
		{ command: "rewrite", filename: "notes.txt", content: "new" },
		{ command: "logs", filename: "notes.txt" },
		{ command: "delete", filename: "notes.txt" },
	];
	for (const params of commands) {
		const [baseline, local] = await Promise.all(pages.map((page) => command(page, params)));
		assert.deepEqual(local.content, baseline.content, JSON.stringify(params));
		assert.deepEqual(
			await pages[1].evaluate(() => window.artifactsFixture.state()),
			await pages[0].evaluate(() => window.artifactsFixture.state()),
		);
		if (local.content[0].text.startsWith("Error:")) assert.equal(local.isError, true);
	}
	for (const page of pages) {
		await command(page, { command: "create", filename: "open.md", content: "# Note" });
		await page.evaluate(() => window.artifactsFixture.panel.openArtifact("open.md"));
		await page.getByTitle("Close artifacts", { exact: true }).click();
	}
	assert.deepEqual(
		await pages[1].evaluate(() => window.artifactsFixture.state()),
		await pages[0].evaluate(() => window.artifactsFixture.state()),
	);
	await Promise.all(pages.map((page) => page.close()));
});

test("all nine preview kinds retain measured header geometry, source/copy/download and document content", async () => {
	const documents = await documentFixtures();
	const word = documents.find((document) => document.id === "docx");
	const zip = await JSZip.loadAsync(word.content, { base64: true });
	zip.file(
		"[Content_Types].xml",
		(await zip.file("[Content_Types].xml").async("string")).replace(
			"</Types>",
			'<Override PartName="/word/afchunk.html" ContentType="text/html"/></Types>',
		),
	);
	zip.file(
		"word/document.xml",
		(await zip.file("word/document.xml").async("string"))
			.replace(
				"<w:document ",
				'<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
			)
			.replace("<w:sectPr>", '<w:altChunk r:id="htmlChunk"/><w:sectPr>'),
	);
	zip.file(
		"word/_rels/document.xml.rels",
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="htmlChunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/afChunk" Target="afchunk.html"/></Relationships>',
	);
	zip.file("word/afchunk.html", "<!doctype html><html><body><p>Embedded DOCX content</p></body></html>");
	word.content = await zip.generateAsync({ type: "base64" });
	const excel = documents.find((document) => document.id === "xlsx");
	const workbook = XLSX.read(excel.content, { type: "base64" });
	const sheet = workbook.Sheets.Data;
	Object.assign(sheet, {
		A4: { t: "s", v: "Formatted number" },
		B4: { t: "n", v: 1234.5, z: "#,##0.00" },
		A5: { t: "s", v: "Formatted date" },
		B5: { t: "n", v: 46010, z: "yyyy-mm-dd" },
		A6: { t: "s", v: "Cached formula" },
		B6: { t: "n", v: 84, f: "B2*2", z: "0.00" },
		"!ref": "A1:B6",
	});
	excel.content = XLSX.write(workbook, { type: "base64", bookType: "xlsx" });
	const samples = [
		{
			filename: "notes.md",
			content: "# Artifact report\n\nA **bold** note.\n\n- One\n- Two",
			selector: "markdown-block h1",
			source: "Markdown",
		},
		{
			filename: "shape.svg",
			content:
				'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#4169e1"/><text x="20" y="50" fill="white">SVG preview</text><foreignObject x="20" y="80" width="200" height="80"><div xmlns="http://www.w3.org/1999/xhtml">Foreign object label</div></foreignObject></svg>',
			selector: "svg foreignObject",
			source: "SVG",
		},
		{ filename: "script.js", content: "const answer = 42;\nconsole.log(answer);", selector: "code.hljs", copy: true },
		{ filename: "notes.txt", content: "Artifact text fixture\nSecond line", selector: "pre", copy: true },
		{
			filename: "sample.png",
			content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
			selector: "img",
		},
		{ filename: "opaque.bin", content: Buffer.from("opaque binary payload").toString("base64"), selector: "p" },
		...documents.map((document) => ({
			filename: document.fileName,
			content: document.content,
			selector: document.id === "pdf" ? "canvas" : document.id === "docx" ? "section.docx" : "table",
		})),
	];
	for (const sample of samples) {
		const pages = await Promise.all([pageFor(false), pageFor()]);
		const metrics = [];
		for (const [index, page] of pages.entries()) {
			await command(page, { command: "create", filename: sample.filename, content: sample.content });
			await page.locator(`artifacts-panel ${sample.selector}`).first().waitFor({ state: "visible" });
			if (sample.filename.endsWith("pdf"))
				await page.waitForFunction(() => document.querySelectorAll("artifacts-panel canvas").length === 2);
			if (sample.filename.endsWith("xlsx")) {
				assert.match(await page.locator("table:visible").innerText(), /Alpha/);
				assert.match(await page.locator("table:visible").innerText(), /1,234\.50/);
				assert.ok((await page.locator("table:visible").innerText()).includes(XLSX.SSF.format("yyyy-mm-dd", 46010)));
				assert.match(await page.locator("table:visible").innerText(), /84\.00/);
				await page.getByRole("button", { name: "Notes", exact: true }).click();
				assert.match(await page.locator("table:visible").innerText(), /Beta/);
				await page.getByRole("button", { name: "Data", exact: true }).click();
			}
			if (sample.filename.endsWith("docx")) {
				assert.match(await page.locator("section.docx").innerText(), /DOCX fixture heading/);
				await page
					.frameLocator("section.docx iframe")
					.getByText("Embedded DOCX content", { exact: true })
					.waitFor();
			}
			if (sample.filename.endsWith("svg"))
				assert.match(await page.locator("foreignObject").textContent(), /Foreign object label/);
			await settle(page);
			metrics.push(
				await page.evaluate((selector) => {
					const panel = document.querySelector("artifacts-panel");
					const header = panel.firstElementChild.firstElementChild;
					const bounds = (node) => {
						const rect = node.getBoundingClientRect();
						return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
					};
					return {
						header: bounds(header),
						tabs: [...panel.querySelectorAll("button[data-filename]")].map(bounds),
						controls: [...header.querySelectorAll("button[title]")].map((button) => ({
							title: button.title,
							bounds: bounds(button),
						})),
						text: header.innerText,
						content: [...panel.querySelectorAll(selector)]
							.filter((element) => element.getBoundingClientRect().width > 0)
							.map((element) => ({
								bounds: bounds(element),
								color: getComputedStyle(element).color,
								fontSize: getComputedStyle(element).fontSize,
								...(element instanceof HTMLCanvasElement
									? { width: element.width, height: element.height }
									: {}),
							})),
					};
				}, sample.selector),
			);
			await capture(page, `${index ? "local" : "baseline"}-${sample.filename.replace(/\./g, "-")}`);
			if (sample.source) {
				await page.getByTitle("Code", { exact: true }).click();
				await page.locator("artifacts-panel pre:visible").first().waitFor();
				assert.match(
					await page.locator("artifacts-panel pre:visible").first().innerText(),
					sample.filename.endsWith("md") ? /Artifact report/ : /foreignObject/,
				);
				await page.getByTitle("Preview", { exact: true }).click();
			}
			if (sample.source || sample.copy) {
				await page.evaluate(() => {
					Object.defineProperty(navigator, "clipboard", {
						configurable: true,
						value: {
							writeText: async (text) => {
								window.copiedArtifact = text;
							},
						},
					});
				});
				await page
					.getByTitle(sample.source ? `Copy ${sample.source}` : "Copy", { exact: true })
					.first()
					.click();
				assert.equal(await page.evaluate(() => window.copiedArtifact), sample.content);
			}
			const download = page.waitForEvent("download");
			await page.getByTitle(sample.source ? `Download ${sample.source}` : "Download", { exact: true }).click();
			const file = await download;
			assert.equal(file.suggestedFilename(), sample.filename);
			assert.deepEqual(
				readFileSync(await file.path()),
				Buffer.from(sample.content, sample.source || sample.copy ? "utf8" : "base64"),
			);
		}
		assert.deepEqual(metrics[1], metrics[0], `${sample.filename} geometry/header parity`);
		measurements.push({ filename: sample.filename, baseline: metrics[0], local: metrics[1] });
		await Promise.all(pages.map((page) => page.close()));
	}
});

test("full-screen narrow overlay, collapsed panel and stable HTML tabs/source mode preserve flows", async () => {
	const page = await pageFor(true, 480);
	await command(page, {
		command: "create",
		filename: "app.html",
		content:
			'<body style="background:#fafafa"><h1>Interactive artifact</h1><button onclick="this.textContent=String(++window.count)">0</button><script>window.count=0; console.log("ready")</script>',
	});
	const frame = page.frameLocator("sitegeist-html-preview iframe");
	await frame.getByRole("button", { name: "0", exact: true }).click();
	await page.getByTitle("Code", { exact: true }).click();
	await page.getByTitle("Preview", { exact: true }).click();
	assert.equal(await frame.locator("button").textContent(), "1");
	await command(page, { command: "create", filename: "other.txt", content: "Other tab" });
	await page.locator('[data-filename="app.html"]').click();
	assert.equal(await frame.getByRole("button", { name: "0", exact: true }).textContent(), "0");
	await frame.getByRole("button", { name: "0", exact: true }).click();
	await page.locator('[data-filename="other.txt"]').click();
	await page.locator('[data-filename="app.html"]').click();
	assert.equal(await frame.locator("button").textContent(), "1");
	await page.evaluate(async () => {
		const panel = window.artifactsFixture.panel;
		panel.overlay = true;
		await panel.updateComplete;
	});
	assert.deepEqual(await page.locator("artifacts-panel > div").boundingBox(), { x: 0, y: 0, width: 480, height: 800 });
	await capture(page, "local-html-overlay");
	await page.evaluate(async () => {
		const panel = window.artifactsFixture.panel;
		panel.collapsed = true;
		await panel.updateComplete;
	});
	assert.equal(await page.locator("artifacts-panel > div").isVisible(), false);
	await page.evaluate(async () => {
		const panel = window.artifactsFixture.panel;
		panel.collapsed = false;
		await panel.updateComplete;
	});
	await page.getByTitle("Reload HTML", { exact: true }).click();
	await frame.getByRole("button", { name: "0", exact: true }).waitFor();
	await page.close();
});

test("real HTML isolation rejects writes and exports offline artifact/attachment snapshots", async () => {
	const page = await pageFor();
	await page.evaluate(() => {
		window.parentMarker = "private";
		window.openCalls = [];
		window.open = (...args) => {
			window.openCalls.push(args);
			return null;
		};
		window.artifactsFixture.panel.agent = {
			state: {
				messages: [
					{
						role: "user-with-attachments",
						attachments: [
							{
								id: "uploaded",
								fileName: "uploaded.txt",
								type: "document",
								mimeType: "text/plain",
								size: 5,
								content: btoa("hello"),
								extractedText: "hello",
							},
						],
					},
				],
			},
		};
	});
	await command(page, { command: "create", filename: "data.json", content: '{"value":42}' });
	const html =
		'<!doctype html><html><head><title>Snapshot report</title></head><body style="background:white"><h1>Snapshot report</h1><output id="values"></output><a id="external" href="https://example.com/report">Open report</a><script type="module">const data = await getArtifact("data.json"); document.querySelector("#values").textContent = data.value + ":" + readTextAttachment("uploaded"); console.log("snapshot", data.value);</script></body></html>';
	const result = await command(page, { command: "create", filename: "report.html", content: html });
	assert.match(result.content[0].text, /Created file report.html/);
	const frame = page.frames().find((frame) => frame.parentFrame());
	await page
		.frameLocator("sitegeist-html-preview iframe")
		.locator("#values")
		.filter({ hasText: "42:hello" })
		.waitFor();
	const isolation = await frame.evaluate(async () => {
		const denied = (operation) => {
			try {
				operation();
				return false;
			} catch {
				return true;
			}
		};
		const errors = [];
		for (const action of ["createOrUpdate", "delete"]) {
			try {
				await window.sendRuntimeMessage({
					type: "artifact-operation",
					action,
					filename: "data.json",
					content: "corrupted",
				});
				errors.push(false);
			} catch {
				errors.push(true);
			}
		}
		return {
			parent: denied(() => window.parent.document.body),
			storage: denied(() => localStorage.getItem("x")),
			chrome: typeof window.chrome?.runtime === "undefined",
			errors,
		};
	});
	assert.deepEqual(isolation, { parent: true, storage: true, chrome: true, errors: [true, true] });
	assert.equal((await command(page, { command: "get", filename: "data.json" })).content[0].text, '{"value":42}');
	await page.frameLocator("sitegeist-html-preview iframe").locator("#external").click();
	assert.deepEqual(await page.evaluate(() => window.openCalls), [
		["https://example.com/report", "_blank", "noopener,noreferrer"],
	]);
	await page.evaluate(() =>
		window.artifactsFixture.panel.agent.state.messages.push({
			role: "user-with-attachments",
			attachments: [
				{
					id: "late",
					fileName: "late.txt",
					type: "document",
					mimeType: "text/plain",
					size: 5,
					content: btoa("fresh"),
					extractedText: "fresh",
				},
			],
		}),
	);
	await page.getByTitle("Reload HTML", { exact: true }).click();
	await page
		.frameLocator("sitegeist-html-preview iframe")
		.locator("#values")
		.filter({ hasText: "42:hello" })
		.waitFor();
	assert.equal(
		await page
			.frameLocator("sitegeist-html-preview iframe")
			.locator("body")
			.evaluate(() => readTextAttachment("late")),
		"fresh",
	);
	const download = page.waitForEvent("download");
	await page.getByTitle("Download HTML", { exact: true }).click();
	const file = await download;
	assert.equal(file.suggestedFilename(), "report.html");
	const standalone = readFileSync(await file.path(), "utf8");
	assert.equal(standalone.includes("sitegeist-artifact-navigation"), false);
	assert.equal(standalone.includes("sendRuntimeMessage ="), false);
	const offline = await pageFor();
	await offline.setContent(standalone);
	await offline.locator("#values").filter({ hasText: "42:hello" }).waitFor();
	assert.deepEqual(
		await offline.evaluate(async () => ({
			files: await listArtifacts(),
			attachments: listAttachments().map((file) => file.fileName),
			bridge: typeof window.sendRuntimeMessage,
			bytes: [...readBinaryAttachment("uploaded")],
		})),
		{
			files: ["data.json", "report.html"],
			attachments: ["uploaded.txt", "late.txt"],
			bridge: "undefined",
			bytes: [...Buffer.from("hello")],
		},
	);
	await capture(page, "local-html-isolation");
	const markedFilename = "report-<!--<script>.html";
	await command(page, {
		command: "create",
		filename: markedFilename,
		content: "<html><body><h1>Safe script-data name</h1></body></html>",
	});
	const markedDownload = page.waitForEvent("download");
	await page.getByTitle("Download HTML", { exact: true }).click();
	const markedContent = readFileSync(await (await markedDownload).path(), "utf8");
	await offline.setContent(markedContent);
	assert.equal(
		await offline.getByRole("heading", { name: "Safe script-data name" }).textContent(),
		"Safe script-data name",
	);
	assert.equal(await offline.locator("script").count(), 1);
	assert.ok(await offline.evaluate(async (filename) => (await listArtifacts()).includes(filename), markedFilename));
	await offline.close();
	await page.close();
});

test("real Pi Agent creates/updates/reads HTML and restoration never opens the panel", async () => {
	const page = await pageFor();
	const result = await page.evaluate(() => window.runArtifactAgentRoundtrip());
	assert.equal(result.requests, 2);
	assert.equal(result.restored, result.before);
	assert.match(result.restored, /Updated report/);
	assert.doesNotMatch(result.restored, /must not appear/);
	assert.match(result.results.find((result) => result.id === "artifact-rejected").text, /^Error:/);
	assert.equal(result.results.find((result) => result.id === "artifact-rejected").isError, true);
	assert.equal(await page.evaluate(() => window.artifactsFixture.opened), 0);
	await page.frameLocator("sitegeist-html-preview iframe").getByRole("heading", { name: "Updated report" }).waitFor();
	const download = page.waitForEvent("download");
	await page.getByTitle("Download HTML", { exact: true }).click();
	assert.match(readFileSync(await (await download).path(), "utf8"), /Updated report/);
	await capture(page, "local-agent-report");
	await page.close();
});

test("German headers and partial streaming renderer states retain the public baseline", async () => {
	const pages = await Promise.all([pageFor(false), pageFor()]);
	const results = [];
	for (const page of pages) {
		await page.evaluate(() => localStorage.setItem("language", "de"));
		await page.reload();
		await page.waitForSelector('[data-artifacts-ready="true"]');
		const titles = [];
		for (const [filename, content] of [
			["note.md", "# Hallo"],
			["shape.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
			["app.html", '<body><h1>Hallo</h1><script>console.log("hello")</script>'],
			["text.txt", "Hallo"],
		]) {
			await command(page, { command: "create", filename, content });
			await settle(page);
			titles.push(
				await page
					.locator("artifacts-panel > div > div")
					.first()
					.locator("button[title]")
					.evaluateAll((buttons) => buttons.map((button) => button.title)),
			);
		}
		const renderers = [];
		for (const params of [
			undefined,
			{},
			{ command: "create" },
			{ command: "update" },
			{ command: "get" },
			{ command: "create", filename: "text.txt", content: "Hallo" },
		]) {
			await page.evaluate((params) => window.artifactsFixture.renderTool(params, undefined, true), params);
			await settle(page);
			renderers.push((await page.locator("#tool-renderer").innerText()).replace(/\s+/g, " ").trim());
		}
		results.push({ titles, renderers });
	}
	assert.deepEqual(results[1], results[0]);
	measurements.push({ german: results[0] });
	await Promise.all(pages.map((page) => page.close()));
});

test("HTML tool settle captures delayed logs while complete/onCompleted remain the measured baseline", async () => {
	const pages = await Promise.all([pageFor(false), pageFor()]);
	const results = [];
	const content =
		'<body><h1>Async HTML</h1><script>onCompleted(()=>console.log("callback must not run"));setTimeout(()=>{console.log("delayed");complete()},100)</script>';
	for (const page of pages) {
		const outputs = [];
		for (const params of [
			{ command: "create", filename: "async.html", content },
			{ command: "logs", filename: "async.html" },
			{ command: "update", filename: "async.html", old_str: "Async HTML", new_str: "Updated HTML" },
			{ command: "rewrite", filename: "async.html", content },
		]) {
			const started = performance.now();
			const result = await command(page, params);
			outputs.push({ command: params.command, text: result.content[0].text });
			if (params.command !== "logs")
				assert.ok(performance.now() - started >= 1400, "HTML mutation preserves 1.5s console settle");
			else assert.ok(performance.now() - started < 1000, "logs is immediate");
		}
		results.push(outputs);
	}
	assert.deepEqual(results[1], results[0]);
	measurements.push({ completion: results[0] });
	await Promise.all(pages.map((page) => page.close()));
});

test("filename pills open the panel without toggling source expansion and read errors remain visible", async () => {
	for (const local of [false, true]) {
		const page = await pageFor(local);
		await command(page, { command: "create", filename: "notes.md", content: "# Note" });
		await page.evaluate(() =>
			window.artifactsFixture.renderTool(
				{ command: "create", filename: "notes.md", content: "# Note" },
				undefined,
				true,
			),
		);
		await settle(page);
		await page.locator("#tool-renderer span.text-foreground").filter({ hasText: "notes.md" }).click();
		assert.equal(await page.evaluate(() => window.artifactsFixture.opened), 1);
		assert.equal(await page.locator("#tool-renderer button[aria-expanded]").getAttribute("aria-expanded"), "false");
		await page.evaluate(() =>
			window.artifactsFixture.renderTool(
				{ command: "get", filename: "missing.md" },
				{
					role: "toolResult",
					toolName: "artifacts",
					toolCallId: "failed",
					content: [{ type: "text", text: "Error: missing" }],
					isError: true,
					timestamp: Date.now(),
				},
			),
		);
		await settle(page);
		assert.equal(await page.getByText("Error: missing", { exact: true }).isVisible(), true);
		await page.close();
	}
});

test("HTML syntax, uncaught and rejection diagnostics retain baseline no-logs tool and visible preview behavior", async () => {
	const results = [];
	for (const local of [false, true]) {
		const page = await pageFor(local);
		const outputs = [];
		for (const [filename, script] of [
			["empty.html", ""],
			["syntax.html", "const = 1;"],
			["uncaught.html", 'throw new Error("Artifact failure")'],
			["rejection.html", 'Promise.reject(new Error("Async failure"))'],
		]) {
			const result = await command(page, {
				command: "create",
				filename,
				content: `<body><h1>Diagnostics fixture</h1><script>${script}</script>`,
			});
			const logs = await command(page, { command: "logs", filename });
			outputs.push({ filename, create: result.content[0].text, logs: logs.content[0].text });
			assert.equal(await page.locator("artifacts-panel .text-destructive").count(), 0);
			assert.match(await page.locator("artifacts-panel").innerText(), new RegExp(filename.replace(".", "\\.")));
		}
		results.push(outputs);
		await page.close();
	}
	assert.deepEqual(results[1], results[0]);
	measurements.push({ diagnostics: results[0] });
});

test("HTML iframe, source and collapsed console geometry match the visible baseline", async () => {
	const pages = await Promise.all([pageFor(false), pageFor()]);
	const results = [];
	for (const [index, page] of pages.entries()) {
		await command(page, {
			command: "create",
			filename: "dashboard.html",
			content:
				'<body style="background:#f5f5f5"><h1>Artifact dashboard</h1><p>Interactive HTML preview</p><script>console.log("Dashboard ready");console.error("Example console error")</script>',
		});
		await settle(page);
		results.push(
			await page.evaluate(() => {
				const panel = document.querySelector("artifacts-panel");
				const header = panel.firstElementChild.firstElementChild;
				const bounds = (element) => {
					const rect = element.getBoundingClientRect();
					return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
				};
				const consoleButton = [...panel.querySelectorAll("button")].find((button) =>
					/console/i.test(button.textContent),
				);
				return {
					header: bounds(header),
					controls: [...header.querySelectorAll("button[title]")].map((button) => ({
						title: button.title,
						bounds: bounds(button),
					})),
					iframe: bounds(panel.querySelector("iframe")),
					console: bounds(consoleButton),
					consoleText: consoleButton.textContent.replace(/\s+/g, " ").trim(),
				};
			}),
		);
		await capture(page, `${index ? "local" : "baseline"}-html-dashboard`);
		await page.getByTitle("Code", { exact: true }).click();
		assert.match(await page.locator("artifacts-panel pre:visible").innerText(), /Artifact dashboard/);
		await page.getByTitle("Preview", { exact: true }).click();
		await page.getByRole("button", { name: /console/i }).click();
		await settle(page);
		await page.getByText("[error] Example console error", { exact: true }).waitFor({ state: "visible" });
		await page.getByTitle("Autoscroll enabled", { exact: true }).click();
		assert.equal(await page.getByTitle("Autoscroll disabled", { exact: true }).count(), 1);
		await page.evaluate(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: {
					writeText: async (text) => {
						window.copiedLogs = text;
					},
				},
			});
		});
		await page.locator('button[title="Copy logs"]').click();
		assert.equal(
			await page.evaluate(() => window.copiedLogs),
			"[log] Dashboard ready\n[error] Example console error",
		);
	}
	assert.deepEqual(results[1], results[0]);
	measurements.push({ html: { baseline: results[0], local: results[1] } });
	await Promise.all(pages.map((page) => page.close()));
});
