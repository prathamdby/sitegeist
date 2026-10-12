import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import * as XLSX from "xlsx";
import { documentFixtures } from "./attachments-ui-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const work = join(tmpdir(), "sitegeist-attachments-ui");
const renders = process.env.ATTACHMENT_RENDER_DIRECTORY;
const recorded = JSON.parse(readFileSync(join(root, "tests/fixtures/contracts/attachments-ui.json"), "utf8"));
let browser;
let server;
let origin;
const attachments = [
	{
		id: "image",
		type: "image",
		fileName: "sample.png",
		mimeType: "image/png",
		size: 70,
		content: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
		preview: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
	},
	{
		id: "text",
		type: "document",
		fileName: "notes.txt",
		mimeType: "text/plain",
		size: 1024,
		content: Buffer.from("Attachment fixture\nSecond line").toString("base64"),
		extractedText: "Attachment fixture\nSecond line",
	},
	{
		id: "pdf",
		type: "document",
		fileName: "report.pdf",
		mimeType: "application/pdf",
		size: 1048576,
		content: "broken",
		extractedText: "Page 1\nDocument fixture",
		preview: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
	},
	{
		id: "docx",
		type: "document",
		fileName: "memo.docx",
		mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		size: 2048,
		content: "broken",
		extractedText: "Document fixture",
	},
	{
		id: "xlsx",
		type: "document",
		fileName: "data.xlsx",
		mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		size: 2048,
		content: "broken",
		extractedText: "Sheet: Data\nName\tValue\nAlpha\t42",
	},
	{
		id: "pptx",
		type: "document",
		fileName: "deck.pptx",
		mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		size: 4096,
		content: "broken",
		extractedText: "Slide 1\nPresentation fixture",
	},
];

before(async () => {
	mkdirSync(work, { recursive: true });
	if (renders) mkdirSync(renders, { recursive: true });
	execFileSync(`${root}node_modules/.bin/tailwindcss`, ["-i", `${root}src/app.css`, "-o", join(work, "app.css")], {
		timeout: 30000,
		stdio: "inherit",
	});
	const bundle = async (entry) => {
		const result = await build({
			entryPoints: [entry],
			absWorkingDir: root,
			bundle: true,
			write: false,
			platform: "browser",
			format: "esm",
			define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
			inject: [`${root}scripts/process-shim.js`],
			alias: {
				process: `${root}scripts/process-shim.js`,
				"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
				lit: `${root}node_modules/lit`,
			},
		});
		return result.outputFiles[0].text;
	};
	const local = await bundle("tests/browser/attachments-ui.ts");
	server = createServer((request, response) => {
		if (request.url === "/local.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(local);
		} else if (request.url === "/app.css") {
			response.setHeader("Content-Type", "text/css");
			response.end(readFileSync(join(work, "app.css")));
		} else if (request.url === "/pdfjs-dist/build/pdf.worker.min.mjs") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(readFileSync(join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs")));
		} else {
			response.setHeader("Content-Type", "text/html");
			response.end(
				`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><script type="module" src="/local.js"></script>`,
			);
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const executablePath =
		process.env.CHROMIUM_PATH ||
		[chromium.executablePath(), "/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(
			existsSync,
		);
	browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
	await browser?.close();
	await new Promise((resolve) => server?.close(resolve) ?? resolve());
});

async function fixture(width = 1200, dark = false) {
	const page = await browser.newPage({ viewport: { width, height: 800 } });
	page.on("pageerror", (error) => console.error(error));
	await page.goto(`${origin}/local`);
	await page.waitForFunction(() => document.body.dataset.attachmentReady === "true");
	await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), dark);
	return page;
}

async function screenshot(page, options = {}) {
	await page.mouse.move(0, 0);
	await page.evaluate(async () => {
		for (const element of document.querySelectorAll("attachment-overlay,mode-toggle,attachment-tile"))
			await element.updateComplete;
	});
	return page.screenshot({ animations: "disabled", ...options });
}

async function compareScreenshots(local, name) {
	const actual = await screenshot(local);
	const baseline = readFileSync(join(root, "tests/fixtures/contracts/attachment-pixels", `${name}.png`));
	assert.deepEqual(actual, baseline, name);
	if (renders) {
		writeFileSync(join(renders, `${name}-before.png`), baseline);
		writeFileSync(join(renders, `${name}-after.png`), actual);
	}
}

test("attachment baseline captures public DOM, layout and controls", { skip: !renders }, async () => {
	for (const [width, dark] of [
		[1200, false],
		[390, false],
		[1200, true],
	]) {
		const page = await fixture(width, dark);
		const prefix = `${width}-${dark ? "dark" : "light"}-after`;
		await page.evaluate((items) => window.attachmentFixture.tiles(items), attachments);
		await screenshot(page, { path: join(renders, `tiles-${prefix}.png`), animations: "disabled" });
		const measurements = await page
			.locator("attachment-tile")
			.evaluateAll((elements) =>
				elements.map((element) => ({ html: element.outerHTML, bounds: element.getBoundingClientRect().toJSON() })),
			);
		for (const attachment of attachments.filter((item) => ["image", "text", "pptx"].includes(item.id))) {
			await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
			await page.locator("attachment-overlay").waitFor({ state: "attached" });
			await page.locator("attachment-overlay > div").first().waitFor();
			await screenshot(page, { path: join(renders, `${attachment.id}-${prefix}.png`), animations: "disabled" });
			measurements.push({
				id: attachment.id,
				html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
			});
			await page.keyboard.press("Escape");
			await page.locator("attachment-overlay").waitFor({ state: "detached" });
		}
		writeFileSync(join(work, `measurement-${prefix}.json`), JSON.stringify(measurements, null, 2));
		await page.close();
	}
	assert.ok(true);
});

test("attachment baseline document previews, toggles, errors and loading states", { skip: !renders }, async () => {
	const page = await fixture();
	const documents = await documentFixtures();
	const observations = [];
	for (const attachment of documents) {
		await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
		await page.locator("attachment-overlay > div").waitFor();
		observations.push({
			id: `${attachment.id}-initial`,
			html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
		});
		await page
			.waitForFunction((id) => {
				const overlay = document.querySelector("attachment-overlay");
				return id === "pdf"
					? overlay?.querySelectorAll("canvas").length === 2
					: id === "docx"
						? overlay?.textContent?.includes("Second paragraph")
						: overlay?.textContent?.includes("Beta");
			}, attachment.id)
			.catch(async (error) => {
				writeFileSync(
					join(work, "document-failure.html"),
					await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
				);
				throw error;
			});
		await screenshot(page, {
			path: join(renders, `${attachment.id}-1200-light-after.png`),
			animations: "disabled",
		});
		observations.push({
			id: `${attachment.id}-preview`,
			html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
		});
		await page.locator("mode-toggle").getByText("Text", { exact: true }).click();
		observations.push({
			id: `${attachment.id}-text`,
			html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
		});
		await screenshot(page, {
			path: join(renders, `${attachment.id}-text-1200-light-after.png`),
			animations: "disabled",
		});
		await page.keyboard.press("Escape");
	}
	await page.evaluate(
		(item) => window.attachmentFixture.open(item),
		attachments.find((item) => item.id === "pdf"),
	);
	await page.waitForFunction(() =>
		document.querySelector("attachment-overlay")?.textContent?.includes("Error loading file"),
	);
	observations.push({
		id: "pdf-error",
		html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
	});
	writeFileSync(join(work, `documents-after.json`), JSON.stringify(observations, null, 2));
	await page.close();
});

test("attachment baseline missing text, fallback and deferred loading probe", {}, async () => {
	const page = await fixture();
	const observations = [];
	for (const attachment of [
		{ ...attachments[1], extractedText: undefined },
		{ ...attachments[1], mimeType: "application/octet-stream", fileName: "mystery.bin", extractedText: undefined },
		{ ...attachments[0], preview: undefined },
		{ ...attachments[1], content: "", extractedText: undefined, fileName: `${origin}/notes.txt` },
		{ ...(await documentFixtures())[0], extractedText: undefined },
		{ ...attachments[5], extractedText: undefined },
		{ ...attachments[1], fileName: "NOTES.PDF" },
	]) {
		await page.evaluate((item) => window.attachmentFixture.tiles([item]), attachment);
		await page.locator("attachment-tile > div").click();
		await page.locator("attachment-overlay").waitFor({ state: "attached" });
		observations.push({
			attachment,
			html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
			tile: await page.locator("attachment-tile").evaluate((element) => element.outerHTML),
		});
		if (await page.locator("mode-toggle").count()) {
			await page.locator("mode-toggle").getByText("Text", { exact: true }).click();
			observations.push({
				attachment,
				mode: "text",
				html: await page.locator("attachment-overlay").evaluate((element) => element.outerHTML),
			});
		}
		await page.keyboard.press("Escape");
	}
	assert.deepEqual(
		await page.evaluate(
			(items) =>
				items.map((item) => {
					const text = new DOMParser().parseFromString(item.html, "text/html").body.textContent;
					return text.replace(/\s+/g, " ").trim().replace(location.origin, "<fixture-origin>");
				}),
			observations,
		),
		recorded.fallback,
	);
	writeFileSync(join(work, "fallback-after.json"), JSON.stringify(observations, null, 2));
	await page.close();
});

test("attachment baseline localization probe", {}, async () => {
	const page = await fixture();
	await page.evaluate(() => localStorage.setItem("language", "de"));
	await page.evaluate((items) => window.attachmentFixture.tiles(items), attachments);
	const observations = {
		remove: await page.locator("attachment-tile button").first().getAttribute("title"),
		files: [],
	};
	for (const attachment of [
		attachments[1],
		attachments[2],
		attachments[5],
		{ ...attachments[1], extractedText: undefined },
	]) {
		await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
		await page.locator("attachment-overlay > div").waitFor();
		if (attachment.id === "pdf")
			await page.waitForFunction(() =>
				document.querySelector("attachment-overlay")?.textContent?.includes("Invalid PDF structure"),
			);
		observations.files.push(await page.locator("attachment-overlay").innerText());
		await page.keyboard.press("Escape");
	}
	assert.deepEqual(
		{ remove: observations.remove, files: observations.files.map((text) => text.replace(/\s+/g, " ").trim()) },
		recorded.locale,
	);
	writeFileSync(join(work, "locale-after.json"), JSON.stringify(observations, null, 2));
	await page.close();
});

test("local tiles and overlays match recorded layout and pixels at wide, narrow and dark widths", {}, async () => {
	for (const [width, dark] of [
		[1200, false],
		[390, false],
		[1200, true],
	]) {
		const local = await fixture(width, dark);
		try {
			for (const page of [local]) await page.evaluate((items) => window.attachmentFixture.tiles(items), attachments);
			const bounds = (page) =>
				page
					.locator("attachment-tile")
					.evaluateAll((tiles) => tiles.map((tile) => tile.getBoundingClientRect().toJSON()));
			assert.deepEqual(await bounds(local), recorded.bounds[`${width}-${dark ? "dark" : "light"}`]);
			await compareScreenshots(local, `tiles-${width}-${dark ? "dark" : "light"}`);
			for (const attachment of attachments.filter((item) => ["image", "text", "pptx"].includes(item.id))) {
				for (const page of [local]) {
					await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
					await page.locator("attachment-overlay > div").waitFor();
				}
				await compareScreenshots(local, `${attachment.id}-${width}-${dark ? "dark" : "light"}`);
				for (const page of [local]) await page.keyboard.press("Escape");
			}
		} finally {
			await local.close();
		}
	}
});

test("document preview and extracted-text pixels match recorded components", {}, async () => {
	const documents = await documentFixtures();
	for (const [width, dark] of [
		[1200, false],
		[390, false],
		[1200, true],
	]) {
		const local = await fixture(width, dark);
		try {
			for (const attachment of documents) {
				for (const page of [local]) {
					await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
					await page.waitForFunction((id) => {
						const overlay = document.querySelector("attachment-overlay");
						return id === "pdf"
							? overlay?.querySelectorAll("canvas").length === 2
							: id === "docx"
								? overlay?.textContent?.includes("Second paragraph")
								: overlay?.textContent?.includes("Beta");
					}, attachment.id);
				}
				await compareScreenshots(local, `${attachment.id}-${width}-${dark ? "dark" : "light"}`);
				for (const page of [local]) await page.locator("mode-toggle").getByText("Text", { exact: true }).click();
				await compareScreenshots(local, `${attachment.id}-text-${width}-${dark ? "dark" : "light"}`);
				for (const page of [local]) await page.keyboard.press("Escape");
			}
		} finally {
			await local.close();
		}
	}
});

test(
	"German remove, document modes, error and missing-content labels match recorded public contracts",
	{},
	async () => {
		const local = await fixture();
		try {
			for (const page of [local]) {
				await page.evaluate(() => localStorage.setItem("language", "de"));
				await page.evaluate((items) => window.attachmentFixture.tiles(items), attachments);
			}
			assert.equal(await local.locator("attachment-tile button").first().getAttribute("title"), "Entfernen");
			await compareScreenshots(local, "locale-tiles-1200-light");
			const documents = await documentFixtures();
			for (const attachment of [
				documents[1],
				documents[2],
				{ ...attachments[1], extractedText: undefined },
				{ ...attachments[5], extractedText: undefined },
				attachments[2],
			]) {
				for (const page of [local]) {
					await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
					if (attachment.id === "pdf")
						await page.waitForFunction(() =>
							document.querySelector("attachment-overlay")?.textContent?.includes("Invalid PDF structure"),
						);
					else if (["docx", "xlsx"].includes(attachment.id))
						await page.waitForFunction(
							(id) =>
								document
									.querySelector("attachment-overlay")
									?.textContent?.includes(id === "docx" ? "Second paragraph" : "Beta"),
							attachment.id,
						);
					else await page.locator("attachment-overlay pre").waitFor();
				}
				await compareScreenshots(local, `locale-${attachment.id}-1200-light`);
				for (const page of [local]) await page.keyboard.press("Escape");
			}
		} finally {
			await local.close();
		}
	},
);

test("tile preview, remove, reopen, original download, close button and backdrop", {}, async () => {
	const page = await fixture();
	try {
		await page.evaluate((items) => window.attachmentFixture.tiles(items), attachments.slice(0, 2));
		await page.locator("attachment-tile").first().hover();
		await page.locator("attachment-tile").first().getByTitle("Remove").click();
		assert.deepEqual(await page.evaluate(() => window.attachmentFixture.deleted), ["image"]);
		assert.equal(await page.locator("attachment-overlay").count(), 0);
		await page.locator("attachment-tile img").click();
		await page.locator("attachment-overlay img").waitFor();
		assert.equal(
			await page.locator("attachment-overlay img").getAttribute("src"),
			`data:image/png;base64,${attachments[0].content}`,
		);
		const downloadPromise = page.waitForEvent("download");
		await page.locator("attachment-overlay button").first().click();
		const download = await downloadPromise;
		assert.equal(download.suggestedFilename(), "sample.png");
		assert.deepEqual(readFileSync(await download.path()), Buffer.from(attachments[0].content, "base64"));
		await page.locator("attachment-overlay button").last().click();
		assert.equal(await page.locator("attachment-overlay").count(), 0);
		await page.evaluate((item) => window.attachmentFixture.open(item), attachments[0]);
		await page.locator("attachment-overlay > div").waitFor();
		await page
			.locator("attachment-overlay > div > div")
			.last()
			.click({ position: { x: 10, y: 10 } });
		assert.equal(await page.locator("attachment-overlay").count(), 0);
		assert.equal(await page.evaluate(() => window.attachmentFixture.closed), 1);
		await page.evaluate((item) => window.attachmentFixture.open(item), attachments[1]);
		const documentDownloadPromise = page.waitForEvent("download");
		await page.locator("attachment-overlay button").first().click();
		const documentDownload = await documentDownloadPromise;
		assert.equal(documentDownload.suggestedFilename(), "notes.txt");
		assert.deepEqual(readFileSync(await documentDownload.path()), Buffer.from(attachments[1].content, "base64"));
		await page.keyboard.press("Escape");
		await page.evaluate((items) => window.attachmentFixture.tiles(items, false), attachments.slice(0, 1));
		assert.equal(await page.locator("attachment-tile button").count(), 0);
	} finally {
		await page.close();
	}
});

test("PDF all pages, DOCX preview, Excel sheet switching, text modes and malformed document errors", {}, async () => {
	const documents = await documentFixtures();
	const page = await fixture();
	try {
		for (const attachment of documents) {
			await page.evaluate((item) => window.attachmentFixture.open(item), attachment);
			if (attachment.id === "pdf") {
				await page.waitForFunction(() => document.querySelectorAll("attachment-overlay canvas").length === 2);
				assert.deepEqual(
					await page
						.locator("canvas")
						.evaluateAll((canvases) => canvases.map((canvas) => [canvas.width, canvas.height])),
					[
						[450, 270],
						[450, 270],
					],
				);
			} else if (attachment.id === "docx") {
				await page.getByText("Second paragraph", { exact: true }).waitFor();
			} else {
				await page.locator("#excel-container table").first().waitFor();
				assert.equal(await page.locator("#excel-container table").nth(1).isVisible(), false);
				await page.locator("#excel-container").getByRole("button", { name: "Notes", exact: true }).click();
				assert.equal(await page.locator("#excel-container table").first().isVisible(), false);
				assert.equal(await page.locator("#excel-container table").nth(1).isVisible(), true);
				assert.equal(await page.locator("#excel-container script").count(), 0);
			}
			await page.locator("mode-toggle").getByText("Text", { exact: true }).click();
			assert.equal(await page.locator("attachment-overlay pre").textContent(), attachment.extractedText);
			await page.locator("mode-toggle button").first().click();
			await page.waitForFunction(
				(id) => !!document.querySelector(`#${id === "xlsx" ? "excel" : id}-container`)?.children.length,
				attachment.id,
			);
			await page.keyboard.press("Escape");
		}
		await page.evaluate((item) => window.attachmentFixture.open(item), attachments[2]);
		await page.getByText("Error loading file", { exact: true }).waitFor();
		assert.match(await page.locator("attachment-overlay").textContent(), /Invalid PDF structure/);
		await page.keyboard.press("Escape");
		await page.evaluate((item) => window.attachmentFixture.open(item), attachments[1]);
		assert.equal(await page.locator("attachment-overlay pre").textContent(), attachments[1].extractedText);
	} finally {
		await page.close();
	}
});

test("spreadsheet names cannot inject markup or event handlers", {}, async () => {
	const page = await fixture();
	try {
		const workbook = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Safe cell"]]), 'Name" onmouseover="evil()');
		const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
		await page.evaluate((item) => window.attachmentFixture.open(item), {
			...attachments[4],
			content: bytes.toString("base64"),
		});
		await page.locator("#excel-container table").waitFor();
		assert.equal(await page.locator("#excel-container [onmouseover]").count(), 0);
		assert.equal(await page.locator("#excel-container table").getAttribute("id"), "sheet-0");
		assert.equal(await page.locator("#excel-container button").textContent(), 'Name" onmouseover="evil()');
	} finally {
		await page.close();
	}
});

async function composer() {
	const page = await fixture();
	await page.evaluate(() => window.attachmentFixture.showComposer());
	await page.locator("textarea").waitFor();
	return page;
}

test("composer picker, image paste, document drop, remove and attachment-only provider send", {}, async () => {
	const page = await composer();
	try {
		const picker = page.locator('input[type="file"]');
		const chooserPromise = page.waitForEvent("filechooser");
		await page.locator("sitegeist-message-editor button").first().click();
		const chooser = await chooserPromise;
		assert.equal(chooser.isMultiple(), true);
		await chooser.setFiles({
			name: "sample.png",
			mimeType: "image/png",
			buffer: Buffer.from(attachments[0].content, "base64"),
		});
		await page.waitForFunction(() => window.attachmentFixture.composer.attachments.length === 1);
		assert.equal(await picker.inputValue(), "");
		await page.locator("textarea").evaluate((textarea, content) => {
			const clipboard = new DataTransfer();
			clipboard.items.add(
				new File([Uint8Array.from(atob(content), (character) => character.charCodeAt(0))], "pasted.png", {
					type: "image/png",
				}),
			);
			textarea.dispatchEvent(
				new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
			);
		}, attachments[0].content);
		await page.waitForFunction(() => window.attachmentFixture.composer.attachments.length === 2);
		await page.locator("sitegeist-message-editor > div").evaluate((target) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(["Document from drop\nSecond line"], "drop.txt", { type: "text/plain" }));
			target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }));
			target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		});
		await page.waitForFunction(() => window.attachmentFixture.composer.attachments.length === 3);
		assert.equal(await page.locator("sitegeist-message-editor").getByText("Drop files here").count(), 0);
		await page.locator("sitegeist-message-editor attachment-tile").nth(1).hover();
		await page.locator("sitegeist-message-editor attachment-tile").nth(1).getByTitle("Remove").click();
		assert.equal(await page.locator("sitegeist-message-editor attachment-tile").count(), 2);
		await page.locator("sitegeist-message-editor button").last().click();
		await page.waitForFunction(
			() => window.attachmentFixture.contexts.length === 1 && !window.attachmentFixture.agent.state.isStreaming,
		);
		const sent = await page.evaluate(() => ({
			context: window.attachmentFixture.contexts[0],
			messages: window.attachmentFixture.agent.state.messages,
			count: window.attachmentFixture.composer.attachments.length,
		}));
		assert.equal(sent.count, 0);
		const user = sent.context.messages.find((message) => message.role === "user");
		assert.ok(user);
		assert.deepEqual(
			user.content.find((part) => part.type === "image"),
			{ type: "image", data: attachments[0].content, mimeType: "image/png" },
		);
		assert.ok(
			user.content.some((part) => part.type === "text" && part.text.includes("Document from drop\nSecond line")),
		);
		const transcript = sent.messages.find((message) => message.role === "user-with-attachments");
		assert.deepEqual(
			transcript.attachments.map((item) => item.fileName),
			["sample.png", "drop.txt"],
		);
		assert.equal(transcript.attachments[0].content, attachments[0].content);
	} finally {
		await page.close();
	}
});

test("composer count and size limits, unsupported files and parser errors preserve valid uploads", {}, async () => {
	const page = await composer();
	const alerts = [];
	page.on("dialog", async (dialog) => {
		alerts.push(dialog.message());
		await dialog.accept();
	});
	try {
		const picker = page.locator('input[type="file"]');
		await picker.setInputFiles(
			Array.from({ length: 11 }, (_, index) => ({
				name: `file-${index}.txt`,
				mimeType: "text/plain",
				buffer: Buffer.from("fixture"),
			})),
		);
		await page.waitForFunction(() => !window.attachmentFixture.composer.processingFiles);
		assert.deepEqual(alerts, ["Maximum 10 files allowed"]);
		assert.equal(await page.locator("attachment-tile").count(), 0);
		await picker.setInputFiles([
			{ name: "too-large.txt", mimeType: "text/plain", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) },
			{ name: "unsupported.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0, 1, 2, 3]) },
			{ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("invalid PDF") },
			{ name: "valid.txt", mimeType: "text/plain", buffer: Buffer.from("Valid after errors") },
		]);
		await page.waitForFunction(
			() =>
				!window.attachmentFixture.composer.processingFiles &&
				window.attachmentFixture.composer.attachments.length === 1,
		);
		assert.equal(alerts.length, 4);
		assert.equal(alerts[1], "too-large.txt exceeds maximum size of 20MB");
		assert.match(alerts[2], /Failed to process unsupported.exe:.*Unsupported file type/);
		assert.match(alerts[3], /Failed to process broken.pdf:.*Invalid PDF/);
		assert.equal(await page.locator("attachment-tile [title='valid.txt']").count(), 1);
		assert.equal(await picker.inputValue(), "");
		await picker.setInputFiles(
			Array.from({ length: 9 }, (_, index) => ({
				name: `allowed-${index}.txt`,
				mimeType: "text/plain",
				buffer: Buffer.from("fixture"),
			})),
		);
		await page.waitForFunction(
			() =>
				!window.attachmentFixture.composer.processingFiles &&
				window.attachmentFixture.composer.attachments.length === 10,
		);
		await picker.setInputFiles({ name: "eleventh.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
		assert.equal(alerts.at(-1), "Maximum 10 files allowed");
		assert.equal(await page.locator("attachment-tile").count(), 10);
	} finally {
		await page.close();
	}
});

test("processing spinner blocks sends until the real parser finishes", {}, async () => {
	const page = await composer();
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	await page.route("**/pdfjs-dist/build/pdf.worker.min.mjs", async (route) => {
		await held;
		await route.continue();
	});
	try {
		const pdf = (await documentFixtures())[0];
		await page
			.locator('input[type="file"]')
			.setInputFiles({ name: pdf.fileName, mimeType: pdf.mimeType, buffer: Buffer.from(pdf.content, "base64") });
		await page.waitForFunction(() => window.attachmentFixture.composer.processingFiles);
		assert.equal(await page.locator("sitegeist-message-editor .animate-spin").count(), 1);
		assert.equal(await page.locator("sitegeist-message-editor button").last().isDisabled(), true);
		await page.locator("textarea").fill("Do not send while processing");
		await page.locator("textarea").press("Enter");
		assert.equal(await page.evaluate(() => window.attachmentFixture.contexts.length), 0);
		release();
		await page.waitForFunction(() => !window.attachmentFixture.composer.processingFiles);
		assert.equal(await page.locator("sitegeist-message-editor .animate-spin").count(), 0);
		assert.equal(await page.locator("attachment-tile").count(), 1);
	} finally {
		release();
		await page.close();
	}
});

test("restored attachments are readable inside the bundled actual REPL sandbox", {}, async () => {
	const page = await fixture();
	try {
		const output = await page.evaluate((items) => window.attachmentFixture.repl(items), attachments.slice(0, 2));
		const value = JSON.parse(output.replace(/^=> /, ""));
		assert.deepEqual(
			value.files,
			attachments.slice(0, 2).map(({ id, fileName, mimeType, size }) => ({ id, fileName, mimeType, size })),
		);
		assert.equal(value.text, attachments[1].extractedText);
		assert.deepEqual(value.bytes, [...Buffer.from(attachments[0].content, "base64")]);
		assert.equal(await page.locator("sandboxed-iframe").count(), 0);
	} finally {
		await page.close();
	}
});

async function instrumentWorkers(page) {
	await page.evaluate(() => {
		window.workerCounts = { created: 0, terminated: 0 };
		const NativeWorker = window.Worker;
		window.Worker = class extends NativeWorker {
			constructor(...args) {
				super(...args);
				window.workerCounts.created++;
			}
			terminate() {
				window.workerCounts.terminated++;
				super.terminate();
			}
		};
	});
}

test("PDF worker startup failures show recoverable overlay errors and terminate workers", {}, async () => {
	const pdf = (await documentFixtures())[0];
	for (const status of [404, 200]) {
		const page = await fixture();
		try {
			await instrumentWorkers(page);
			await page.route("**/pdfjs-dist/build/pdf.worker.min.mjs", (route) =>
				route.fulfill({
					status,
					contentType: "application/javascript",
					body: status === 200 ? 'throw new Error("PDF worker startup fixture failure")' : "Missing worker",
				}),
			);
			await page.evaluate((item) => window.attachmentFixture.open(item), pdf);
			await page.getByText("Error loading file", { exact: true }).waitFor();
			assert.match(
				await page.locator("attachment-overlay").textContent(),
				status === 200 ? /PDF worker startup fixture failure/ : /Failed to load PDF worker/,
			);
			await page.waitForFunction(() => window.workerCounts.created === 1 && window.workerCounts.terminated === 1);
			await page.keyboard.press("Escape");
			await page.unroute("**/pdfjs-dist/build/pdf.worker.min.mjs");
			await page.evaluate((item) => window.attachmentFixture.open(item), pdf);
			await page.waitForFunction(() => document.querySelectorAll("attachment-overlay canvas").length === 2);
			assert.equal(await page.getByText("Error loading file", { exact: true }).count(), 0);
			await page.keyboard.press("Escape");
			await page.waitForFunction(() => window.workerCounts.created === 2 && window.workerCounts.terminated === 2);
		} finally {
			await page.close();
		}
	}
});

test("closing during PDF loading or rendering destroys workers and ignores stale completion", {}, async () => {
	const page = await fixture();
	let release;
	const held = new Promise((resolve) => {
		release = resolve;
	});
	await page.route("**/pdfjs-dist/build/pdf.worker.min.mjs", async (route) => {
		await held;
		await route.continue();
	});
	try {
		await instrumentWorkers(page);
		const pdf = (await documentFixtures())[0];
		await page.evaluate((item) => window.attachmentFixture.open(item), pdf);
		await page.waitForFunction(() => window.workerCounts.created === 1);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => window.workerCounts.terminated === 1);
		await page.evaluate((item) => window.attachmentFixture.open(item), pdf);
		await page.waitForFunction(() => window.workerCounts.created === 2);
		await page.locator("mode-toggle").getByText("Text", { exact: true }).click();
		await page.waitForFunction(() => window.workerCounts.terminated === 2);
		assert.equal(await page.locator("attachment-overlay pre").textContent(), pdf.extractedText);
		await page.keyboard.press("Escape");
		await page.evaluate((item) => window.attachmentFixture.open(item), attachments[1]);
		release();
		assert.equal(await page.locator("attachment-overlay pre").textContent(), attachments[1].extractedText);
		assert.equal(await page.locator("attachment-overlay canvas").count(), 0);
		await page.keyboard.press("Escape");
		await page.evaluate((item) => window.attachmentFixture.open(item), pdf);
		await page.waitForFunction(() => document.querySelectorAll("attachment-overlay canvas").length === 2);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => window.workerCounts.created === 3 && window.workerCounts.terminated === 3);
		assert.equal(await page.locator("attachment-overlay").count(), 0);
	} finally {
		release();
		await page.close();
	}
});
