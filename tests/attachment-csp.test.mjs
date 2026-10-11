import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));

function pdf() {
	const text = "BT /F1 12 Tf 72 720 Td (Extension CSP fixture) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
	];
	let output = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index++) {
		offsets.push(output.length);
		output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}
	const xref = output.length;
	output += `xref\n0 6\n0000000000 65535 f \n${offsets
		.slice(1)
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output).toString("base64");
}

test(
	"PDF parsing and packaged REPL attachment helpers work under the unchanged extension CSP",
	{ timeout: 60000 },
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "sitegeist-attachment-csp-"));
		let context;
		try {
			const extension = join(directory, "extension");
			mkdirSync(join(extension, "pdfjs-dist/build"), { recursive: true });
			const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
			writeFileSync(
				join(extension, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					name: "Attachment migration CSP fixture",
					version: "1.0.0",
					background: { service_worker: "background.js" },
					sandbox: manifest.sandbox,
					content_security_policy: manifest.content_security_policy,
				}),
			);
			writeFileSync(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});");
			writeFileSync(
				join(extension, "fixture.html"),
				'<!doctype html><script type="module" src="fixture.js"></script>',
			);
			for (const file of ["sandbox.html", "sandbox.js"])
				copyFileSync(join(root, "static", file), join(extension, file));
			copyFileSync(
				join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
				join(extension, "pdfjs-dist/build/pdf.worker.min.mjs"),
			);
			await build({
				entryPoints: ["tests/browser/attachment-csp.ts"],
				absWorkingDir: root,
				bundle: true,
				platform: "browser",
				format: "esm",
				outfile: join(extension, "fixture.js"),
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
				args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
			});
			const background = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
			const id = new URL(background.url()).hostname;
			const page = await context.newPage();
			const workers = [];
			page.on("worker", (worker) => workers.push(worker.url()));
			await page.goto(`chrome-extension://${id}/fixture.html`);
			await page.waitForFunction(() => Boolean(window.attachmentCspFixture));
			const result = await page.evaluate((data) => window.attachmentCspFixture.pdf(data), pdf());
			assert.match(result.attachment.extractedText, /Extension CSP fixture/);
			assert.match(result.attachment.preview, /^iVBOR/);
			assert.ok(
				workers.includes(`chrome-extension://${id}/pdfjs-dist/build/pdf.worker.min.mjs`),
				JSON.stringify(workers),
			);
			await page.evaluate((attachment) => window.attachmentCspFixture.preview(attachment), result.attachment);
			await page.locator("attachment-overlay canvas").waitFor();
			assert.equal(await page.locator("attachment-overlay canvas").count(), 1);
			assert.equal(
				workers.filter((url) => url === `chrome-extension://${id}/pdfjs-dist/build/pdf.worker.min.mjs`).length,
				2,
			);
			await page.keyboard.press("Escape");
			await page.locator("attachment-overlay").waitFor({ state: "detached" });
			const repl = await page.evaluate(() => window.attachmentCspFixture.repl());
			assert.match(repl.output, /restored.txt/);
			assert.match(repl.output, /restored text/);
			assert.match(repl.output, /114,101,115,116,111,114,101,100,32,116,101,120,116/);
			assert.deepEqual(await page.evaluate(() => window.attachmentCspFixture.violations), []);
		} finally {
			await context?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
