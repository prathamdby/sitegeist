import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "tests/fixtures/attachments");
const recorded = JSON.parse(readFileSync(join(root, "tests/fixtures/contracts/attachment-processing.json"), "utf8"));
const expected = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8"));
let browser;
let server;
let origin;

before(async () => {
	const bundled = await build({
		entryPoints: ["tests/browser/attachment-processing.ts"],
		absWorkingDir: root,
		bundle: true,
		write: false,
		platform: "browser",
		format: "esm",
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
		alias: {
			"@mariozechner/mini-lit": join(root, "node_modules/@mariozechner/mini-lit"),
			lit: join(root, "node_modules/lit"),
		},
	});
	server = createServer((request, response) => {
		const url = new URL(request.url, "http://fixture.test");
		if (url.pathname === "/fixture.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(bundled.outputFiles[0].text);
		} else if (url.pathname === "/pdfjs-dist/build/pdf.worker.min.mjs") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(readFileSync(join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs")));
		} else if (url.pathname.startsWith("/files/")) {
			const name = url.pathname.slice("/files/".length);
			response.setHeader("Content-Type", name.endsWith(".txt") ? "text/plain" : "application/octet-stream");
			response.end(readFileSync(join(fixtures, name)));
		} else {
			response.setHeader("Content-Type", "text/html");
			response.end('<!doctype html><div id="render"></div><script type="module" src="/fixture.js"></script>');
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const executablePath =
		process.env.CHROMIUM_PATH ||
		(existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined) ||
		["/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
	browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
	await browser?.close();
	await new Promise((resolve) => server?.close(resolve) ?? resolve());
});

async function page() {
	const page = await browser.newPage();
	await page.goto(origin);
	await page.waitForFunction(() => window.attachmentProcessingFixture);
	return page;
}

test("preserved parser fixtures match measured baseline text and original bytes", async () => {
	const p = await page();
	for (const [name, snapshot] of Object.entries(expected)) {
		{
			const attachment = await p.evaluate(({ name }) => window.attachmentProcessingFixture.load(name), {
				name,
			});
			assert.deepEqual(
				Object.fromEntries(Object.keys(snapshot).map((key) => [key, attachment[key]])),
				snapshot,
				`local ${name}`,
			);
			assert.equal(attachment.content, readFileSync(join(fixtures, name)).toString("base64"));
			assert.equal(typeof attachment.id, "string");
			if (name === "sample.pdf") {
				assert.match(attachment.preview, /^iVBOR/);
				const dimensions = await p.evaluate(async (base64) => {
					const image = new Image();
					image.src = `data:image/png;base64,${base64}`;
					await image.decode();
					return [image.width, image.height];
				}, attachment.preview);
				assert.deepEqual(dimensions, [160, 106]);
			}
		}
	}
	await p.close();
});

test("File, Blob, URL, text/code and image MIME contracts survive", async () => {
	const p = await page();
	{
		for (const mode of ["file", "blob", "url"]) {
			const attachment = await p.evaluate(
				({ mode }) => window.attachmentProcessingFixture.load("sample.txt", mode, "text/plain"),
				{ mode },
			);
			assert.equal(attachment.extractedText, expected["sample.txt"].extractedText);
			assert.equal(attachment.fileName, "sample.txt");
		}
		for (const [name, mimeType] of [
			["sample.txt", "text/markdown"],
			["sample.pdf", "text/plain"],
			["sample.docx", "text/plain"],
			["sample.xls", "application/vnd.ms-excel"],
		]) {
			const a = await p.evaluate(
				({ name, mimeType }) => window.attachmentProcessingFixture.load(name, "blob", mimeType),
				{ name, mimeType },
			);
			assert.equal(a.extractedText, expected[name].extractedText);
			assert.equal(a.mimeType, mimeType === "text/plain" ? expected[name].mimeType : mimeType);
		}
		for (const extension of ["txt", "md", "json", "xml", "html", "css", "js", "ts", "jsx", "tsx", "yaml", "yml"]) {
			const a = await p.evaluate(
				({ extension }) => window.attachmentProcessingFixture.raw("const café = '<value>';", `code.${extension}`),
				{ extension },
			);
			assert.equal(a.extractedText, "const café = '<value>';");
			assert.equal(a.mimeType, "text/plain");
		}
		const image = await p.evaluate(() =>
			window.attachmentProcessingFixture.raw("image bytes", "picture.png", "image/png"),
		);
		assert.equal(image.type, "image");
		assert.equal(image.preview, image.content);
		assert.equal(image.extractedText, undefined);
		const unnamed = await p.evaluate(() => window.attachmentProcessingFixture.raw("hello", undefined, "text/plain"));
		assert.equal(unnamed.fileName, "unnamed");
	}
	await p.close();
});

test("unsupported attachments and parser errors retain the baseline guidance", async () => {
	const p = await page();
	for (const name of ["unknown.xyz", "image.png", "bad.pdf", "bad.docx", "bad.pptx"]) {
		const errors = [];
		errors.push(
			await p.evaluate(
				async ({ name }) => {
					try {
						await window.attachmentProcessingFixture.raw("invalid", name);
					} catch (error) {
						return error.message;
					}
				},
				{ name },
			),
		);
		assert.equal(errors[0], recorded.errors[name], name);
		assert.match(errors[0], /Unsupported file type|Failed to process/);
	}
	await p.close();
});

test("extract_document output and details preserve all supported formats", async () => {
	const p = await page();
	for (const name of Object.keys(expected)) {
		const baseline = recorded.tools[name];
		const local = await p.evaluate((name) => window.attachmentProcessingFixture.tool(name), name);
		assert.deepEqual(local, baseline, name);
		assert.deepEqual(local.content, [{ type: "text", text: expected[name].extractedText }]);
	}
	assert.equal(await p.evaluate(() => window.attachmentProcessingFixture.registered), true);
	await p.close();
});

test("direct fetch, proxy retries, mutable proxy settings and manual-download errors match baseline", async () => {
	const p = await page();
	for (const scenario of [
		"ok",
		"http",
		"ordinary",
		"type-error",
		"cors-error",
		"cors",
		"proxy-ok",
		"header-size",
		"boundary-size",
		"actual-size",
		"empty",
		"preabort",
		"fetch-abort",
	]) {
		for (const proxy of [undefined, "https://proxy.test/?url="]) {
			const baseline = recorded.fetch[`${scenario} ${proxy}`];
			const local = await p.evaluate(
				({ scenario, proxy }) => window.attachmentProcessingFixture.simulate(scenario, undefined, proxy),
				{ scenario, proxy },
			);
			assert.deepEqual(local, baseline, `${scenario} ${proxy}`);
		}
	}
	for (const url of ["", "not-a-url", "https://example.test/unknown.xyz", "https://example.test/"]) {
		const baseline = recorded.invalidUrls[url];
		const local = await p.evaluate((url) => window.attachmentProcessingFixture.simulate("ok", url), url);
		assert.deepEqual(local, baseline, url);
	}
	const first = recorded.mutableProxy;
	const second = await p.evaluate(() => window.attachmentProcessingFixture.mutableProxy());
	assert.deepEqual(second, first);
	assert.match(second[3], /^https:\/\/second.test/);
	await p.close();
});

test("abort signals cancel direct/proxy fetch and stop extraction after bytes arrive", async () => {
	const p = await page();
	for (const scenario of ["signal-abort", "proxy-abort", "body-abort"]) {
		const result = await p.evaluate(
			(scenario) => window.attachmentProcessingFixture.simulate(scenario, undefined, "https://proxy.test/?url="),
			scenario,
		);
		assert.match(result.error, /aborted/i);
		assert.ok(result.calls.every((call) => call.signal));
		assert.equal(result.calls.length, scenario === "proxy-abort" ? 2 : 1);
	}
	await p.close();
});

test("PDF worker asset and per-document cleanup work with concurrent documents", async () => {
	const p = await page();
	const workers = [];
	p.on("worker", (worker) => workers.push(worker.url()));
	assert.equal(
		await p.evaluate(() => window.attachmentProcessingFixture.workerSrc),
		"pdfjs-dist/build/pdf.worker.min.mjs",
	);
	const lifecycle = await p.evaluate(() => window.attachmentProcessingFixture.pdfLifecycle());
	assert.deepEqual(lifecycle.pages, [2, 2]);
	assert.equal(lifecycle.text, "Second PDF page");
	assert.equal(lifecycle.byteLength, expected["sample.pdf"].size);
	assert.equal(workers.length, 2);
	assert.ok(workers.every((url) => url === `${origin}/pdfjs-dist/build/pdf.worker.min.mjs`));
	await p.close();
});

test(
	"aborting pending PDF startup terminates its worker before a held module request is released",
	{ timeout: 15000 },
	async () => {
		const p = await page();
		let requestHeld;
		const held = new Promise((resolve) => {
			requestHeld = resolve;
		});
		let release;
		const released = new Promise((resolve) => {
			release = resolve;
		});
		await p.route("**/pdfjs-dist/build/pdf.worker.min.mjs", async (route) => {
			requestHeld();
			await released;
			await route.continue().catch(() => {});
		});
		try {
			await p.evaluate(() => window.attachmentProcessingFixture.trackPdfWorkers());
			await p.evaluate(() => window.attachmentProcessingFixture.startPdfLoad());
			await held;
			assert.equal(await p.evaluate(() => window.attachmentProcessingFixture.pdfWorkerCounts.created), 1);
			await p.evaluate(() => window.attachmentProcessingFixture.abortPdfLoad());
			await p.waitForFunction(() => window.attachmentProcessingFixture.pdfStartupResult);
			assert.deepEqual(await p.evaluate(() => window.attachmentProcessingFixture.pdfStartupResult), {
				name: "AbortError",
				message: "PDF loading aborted",
			});
			assert.equal(await p.evaluate(() => window.attachmentProcessingFixture.pdfWorkerCounts.terminated), 1);
			assert.equal(p.workers().length, 0);
		} finally {
			release();
			await p.close();
		}
	},
);

test("an already aborted PDF load creates no worker", async () => {
	const p = await page();
	let workers = 0;
	p.on("worker", () => workers++);
	await p.evaluate(() => window.attachmentProcessingFixture.startPdfLoad(true));
	await p.waitForFunction(() => window.attachmentProcessingFixture.pdfStartupResult);
	assert.equal(await p.evaluate(() => window.attachmentProcessingFixture.pdfStartupResult.name), "AbortError");
	assert.equal(workers, 0);
	await p.close();
});

test(
	"a missing or broken PDF worker module rejects loading and terminates the worker",
	{ timeout: 15000 },
	async () => {
		for (const status of [200, 404]) {
			const p = await page();
			await p.route("**/pdfjs-dist/build/pdf.worker.min.mjs", (route) =>
				route.fulfill({
					status,
					contentType: "text/javascript",
					body: 'throw new Error("PDF worker startup fixture failure");',
				}),
			);
			try {
				await p.evaluate(() => window.attachmentProcessingFixture.trackPdfWorkers());
				await p.evaluate(() => window.attachmentProcessingFixture.startPdfLoad());
				await p.waitForFunction(() => window.attachmentProcessingFixture.pdfStartupResult);
				const result = await p.evaluate(() => window.attachmentProcessingFixture.pdfStartupResult);
				assert.equal(result.name, "Error");
				assert.match(
					result.message,
					status === 200 ? /PDF worker startup fixture failure/ : /Failed to load PDF worker/,
				);
				assert.deepEqual(await p.evaluate(() => window.attachmentProcessingFixture.pdfWorkerCounts), {
					created: 1,
					terminated: 1,
				});
			} finally {
				await p.close();
			}
		}
	},
);

test("extract_document preserves header states, extracted text disclosure and error rendering", async () => {
	const p = await page();
	for (const state of ["preparing", "extracting", "streaming", "complete", "error"]) {
		const snapshots = [recorded.renderers[state]];
		assert.equal(
			(
				await p.evaluate(({ state }) => window.attachmentProcessingFixture.show(state), {
					state,
				})
			).isCustom,
			false,
		);
		snapshots.push({
			label: await p
				.locator("#render > div")
				.evaluate((element) => element.querySelector("button")?.textContent.trim() || element.textContent.trim()),
			spinners: await p.locator("#render .animate-spin").count(),
			error: await p.locator("#render .text-destructive").count(),
		});
		if (state !== "preparing") {
			const disclosure = p.locator("#render > div > div").last();
			assert.match(await disclosure.getAttribute("class"), /max-h-0/);
			await p.locator("#render button").first().click();
			assert.doesNotMatch(await disclosure.getAttribute("class"), /max-h-0/);
			if (state === "complete")
				assert.equal(await p.locator("code-block code").innerText(), "Fixture extracted text");
			if (state === "error") assert.match(await p.locator("sitegeist-console-block").innerText(), /Fixture error/);
		}
		assert.deepEqual(snapshots[1], snapshots[0], state);
	}
	await p.close();
});

test("special filenames and spreadsheet sheet names preserve raw prompt annotation markup", async () => {
	const measured = JSON.parse(readFileSync(join(fixtures, "edge-cases.json"), "utf8"));
	const p = await page();
	try {
		for (const extension of ["pdf", "docx", "pptx", "xlsx", "xls"]) {
			const fileName = `corrupt%ZZ" <file>&.${extension}`;
			{
				const outcome = await p.evaluate(
					({ sourceName, fileName }) => window.attachmentProcessingFixture.renamedDocument(sourceName, fileName),
					{ sourceName: `sample.${extension}`, fileName },
				);
				assert.deepEqual(outcome, measured.names[extension]);
				assert.ok(outcome.extractedText.includes(`filename="${fileName}"`));
			}
		}
		{
			const outcome = await p.evaluate(() =>
				window.attachmentProcessingFixture.renamedDocument("special-names.xlsx", 'special" <file>&.xlsx'),
			);
			assert.deepEqual(outcome, measured.names.specialSheet);
			assert.ok(outcome.extractedText.includes('<sheet name="Quote" <angle>&" index="1">'));
		}
	} finally {
		await p.close();
	}
});

test("headerless documents retain URL filename rules and enforce the actual body limit after reading", async () => {
	const measured = JSON.parse(readFileSync(join(fixtures, "edge-cases.json"), "utf8"));
	const p = await page();
	try {
		for (const url of [
			"https://example.test/download?file=sample.pdf",
			"https://example.test/download?file=sample.pdf#document",
		]) {
			const baseline = recorded.headerless[url] ?? recorded.fragmentUrls[url] ?? recorded.queryUrl;
			const local = await p.evaluate((url) => window.attachmentProcessingFixture.headerlessDocument(url), url);
			assert.deepEqual(local, baseline);
			assert.equal(local.error, "Unsupported file type: application/octet-stream");
			assert.equal(local.bodyReads, 1);
		}
		const baseline = recorded.headerlessSize;
		const local = await p.evaluate(() =>
			window.attachmentProcessingFixture.headerlessDocument("https://example.test/sample.pdf", true),
		);
		assert.deepEqual(local, baseline);
		assert.equal(local.error, measured.urls.headerlessSize.error);
		assert.equal(local.bodyReads, 1);
	} finally {
		await p.close();
	}
});

test("zero-byte documents and text mislabeled as PDF retain actual parser outcomes", async () => {
	const measured = JSON.parse(readFileSync(join(fixtures, "edge-cases.json"), "utf8"));
	const p = await page();
	try {
		for (const extension of ["pdf", "docx", "pptx", "xlsx", "xls", "txt"]) {
			{
				const outcome = await p.evaluate(({ name }) => window.attachmentProcessingFixture.emptyOrMislabeled(name), {
					name: `empty.${extension}`,
				});
				assert.deepEqual(outcome, measured.empty[extension], `local ${extension}`);
			}
		}
		for (const name of ["unknown", "mislabeled.txt"]) {
			{
				const outcome = await p.evaluate(
					({ name }) =>
						window.attachmentProcessingFixture.emptyOrMislabeled(name, "plain text", "application/pdf"),
					{ name },
				);
				assert.deepEqual(outcome, measured.empty[name]);
			}
		}
	} finally {
		await p.close();
	}
});

test("existing URL scheme and private-host behavior is preserved with every fetch stubbed", async () => {
	const p = await page();
	try {
		for (const url of [
			"http://127.0.0.1:8080/sample.txt",
			"http://localhost/sample.txt",
			"http://10.0.0.1/sample.txt",
			"http://192.168.1.1/sample.txt",
			"http://169.254.169.254/sample.txt",
			"data:text/plain,fixture.txt",
		]) {
			const baseline = recorded.unrestrictedUrls[url];
			const local = await p.evaluate((url) => window.attachmentProcessingFixture.unrestrictedUrl(url), url);
			assert.deepEqual(local, baseline, url);
			assert.deepEqual(local.calls, [url]);
			assert.deepEqual(local.result.content, [{ type: "text", text: "Fixture URL text" }]);
		}
	} finally {
		await p.close();
	}
});

test("fragment extensions and query slash ordering retain successful baseline parsing and filenames", async () => {
	const measured = JSON.parse(readFileSync(join(fixtures, "edge-cases.json"), "utf8"));
	const p = await page();
	try {
		for (const [url, fileName] of [
			["https://example.test/download#sample.pdf", "download#sample.pdf"],
			["https://example.test/download#sample.pdf?token=value", "download#sample.pdf"],
			["https://example.test/download?redirect=/nested/sample.pdf", "sample.pdf"],
			["https://example.test/download#docs/path/sample.pdf", "sample.pdf"],
		]) {
			const baseline = recorded.headerless[url] ?? recorded.fragmentUrls[url] ?? recorded.queryUrl;
			const local = await p.evaluate((url) => window.attachmentProcessingFixture.headerlessDocument(url), url);
			assert.deepEqual(local, baseline, url);
			assert.equal(local.bodyReads, 1);
			assert.equal(local.result.details.fileName, fileName);
			assert.equal(local.result.details.format, "pdf");
			assert.equal(
				local.result.details.extractedText,
				expected["sample.pdf"].extractedText.replace('filename="sample.pdf"', `filename="${fileName}"`),
			);
			if (url === "https://example.test/download#sample.pdf") {
				assert.deepEqual(local.result, measured.urls[url]);
			}
		}
		const url = "https://example.test/sample.pdf?redirect=/nested/sample.txt";
		const baseline = recorded.headerless[url] ?? recorded.fragmentUrls[url] ?? recorded.queryUrl;
		const local = await p.evaluate((url) => window.attachmentProcessingFixture.headerlessDocument(url), url);
		assert.deepEqual(local, baseline);
		assert.equal(local.result.details.fileName, "sample.txt");
		assert.equal(local.result.details.format, "unknown");
		assert.equal(local.result.details.extractedText, readFileSync(join(fixtures, "sample.pdf"), "utf8"));
	} finally {
		await p.close();
	}
});
