import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const recorded = JSON.parse(readFileSync(join(root, "tests/fixtures/contracts/sandbox-execution.json"), "utf8"));

test(
	"production sandbox execution, async helpers, files and cleanup under the unchanged extension CSP",
	{ timeout: 60000 },
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "sitegeist-sandbox-"));
		let context;
		try {
			const extension = join(directory, "extension");
			mkdirSync(extension);
			const manifest = JSON.parse(readFileSync(join(root, "static/manifest.chrome.json"), "utf8"));
			writeFileSync(
				join(extension, "manifest.json"),
				JSON.stringify({
					manifest_version: 3,
					name: "Sandbox migration fixture",
					version: "1.0.0",
					background: { service_worker: "background.js" },
					permissions: ["tabs"],
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
			await build({
				entryPoints: ["tests/browser/sandbox-execution.ts"],
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
			const page = await context.newPage();
			await page.goto(`chrome-extension://${new URL(background.url()).hostname}/fixture.html`);
			await page.waitForFunction(() => Boolean(window.sandboxExecutionFixture));
			const execute = (code) => page.evaluate((code) => window.sandboxExecutionFixture.execute(code), code);
			const script =
				'console.log("log", {value: 7}); console.warn("warn"); console.info("info"); console.error("error"); return await asyncNumber();';
			const baseline = { console: recorded.console, returnValue: recorded.returnValue };
			const result = await execute(script);
			assert.equal(result.success, true);
			assert.equal(result.returnValue, 14);
			assert.deepEqual(result.console, baseline.console);
			assert.equal(result.returnValue, baseline.returnValue);
			const callbackScript =
				'onCompleted(async success => { console.log(success ? await asyncNumber() : "failed"); }); return 21;';
			const callbacks = await execute(callbackScript);
			const baselineCallbacks = recorded.callbacks;
			assert.deepEqual(callbacks, baselineCallbacks);
			for (const [index, callback] of [
				'() => { throw new Error("callback"); }',
				'async () => { throw new Error("async callback"); }',
			].entries()) {
				const callbackFailure = `onCompleted(${callback}); return 9;`;
				const normalize = (result) => ({
					...result,
					console: result.console.map((log) => ({
						...log,
						args: log.args?.map((arg) => (arg instanceof Error ? { name: arg.name, message: arg.message } : arg)),
					})),
				});
				assert.deepEqual(normalize(await execute(callbackFailure)), recorded.callbackErrors[index]);
			}
			const fileScript =
				'await returnDownloadableFile("bytes.bin", new Uint8Array([0,1,254,255]), "application/octet-stream"); await returnDownloadableFile("text.txt", "héllo", "text/plain"); return readTextAttachment("restored") + ":" + Array.from(readBinaryAttachment("restored")).join(",");';
			const files = await execute(fileScript);
			const baselineFiles = {
				...recorded.files,
				files: recorded.files.files.map((file) => ({
					...file,
					content: typeof file.content === "string" ? file.content : Uint8Array.from(Object.values(file.content)),
				})),
			};
			assert.deepEqual(files, baselineFiles);
			assert.equal(files.success, true);
			assert.equal(files.returnValue, "restored text:0,1,254,255");
			assert.equal(files.files[0].fileName, "bytes.bin");
			assert.deepEqual(Object.values(files.files[0].content), [0, 1, 254, 255]);
			assert.equal(files.files[1].content, "héllo");
			const artifactScript =
				'await createOrUpdateArtifact("bridge.json", {value: 42}); const names = await listArtifacts(); const data = await getArtifact("bridge.json"); await deleteArtifact("bridge.json"); return {names,data,after:await listArtifacts()};';
			const artifacts = await execute(artifactScript);
			assert.equal(artifacts.success, true);
			assert.deepEqual(artifacts.returnValue, { names: ["bridge.json"], data: { value: 42 }, after: [] });
			const artifactMessages = await page.evaluate(() =>
				window.sandboxExecutionFixture.artifactMessages.map(({ role, action, filename, content }) => ({
					role,
					action,
					filename,
					content,
				})),
			);
			assert.equal(artifactMessages.length, 2);
			assert.deepEqual(
				artifactMessages.map(({ role, action, filename }) => ({ role, action, filename })),
				[
					{ role: "artifact", action: "create", filename: "bridge.json" },
					{ role: "artifact", action: "delete", filename: "bridge.json" },
				],
			);
			const failure = await execute('console.log("before"); throw new Error("fixture failure");');
			assert.equal(failure.success, false);
			assert.equal(failure.error.message, "fixture failure");
			assert.match(failure.error.stack, /fixture failure/);
			assert.ok(failure.console.some((entry) => entry.text === "before"));
			const syntax = await execute("const invalid = ;");
			assert.equal(syntax.success, false);
			assert.match(syntax.error.message, /syntax|Unexpected/i);
			assert.equal((await execute('return "</script>";')).returnValue, "</script>");
			const explicit = "await complete(undefined, 9); return 2;";
			assert.deepEqual(await execute(explicit), recorded.explicit);
			const explicitErrorScript = 'await complete(new Error("explicit")); return 2;';
			const explicitError = await execute(explicitErrorScript);
			const baselineExplicitError = recorded.explicitError;
			assert.equal(explicitError.success, baselineExplicitError.success);
			assert.equal(explicitError.error.name, baselineExplicitError.error.name);
			assert.equal(explicitError.error.message, baselineExplicitError.error.message);
			const rejection = await execute(
				'Promise.reject(new Error("unhandled")); await new Promise(resolve => setTimeout(resolve, 20)); return 9;',
			);
			assert.equal(rejection.success, false);
			assert.equal(rejection.error.message, "unhandled");
			for (const action of ["abort", "disconnect"]) {
				const pending = execute("await new Promise(() => {});");
				await page.waitForFunction(() => document.querySelector("sitegeist-sandbox iframe"));
				assert.equal(
					await page.locator("sitegeist-sandbox iframe").getAttribute("sandbox"),
					"allow-scripts allow-modals",
				);
				assert.equal(await page.locator("sitegeist-sandbox iframe").isVisible(), false);
				await page.evaluate((action) => window.sandboxExecutionFixture[action](), action);
				assert.equal((await pending).error.message, "Execution aborted");
				assert.equal(await page.locator("sitegeist-sandbox iframe").count(), 0);
			}
			const library = "function fixtureFunction() { return 42; }";
			assert.deepEqual(
				await page.evaluate((library) => window.sandboxExecutionFixture.skill("create", library), library),
				{ success: true, saved: library },
			);
			const invalidSkill = await page.evaluate(() =>
				window.sandboxExecutionFixture.skill("rewrite", "const invalid = ;"),
			);
			assert.equal(invalidSkill.success, false);
			assert.match(invalidSkill.error, /syntax|Unexpected/i);
			assert.equal(invalidSkill.saved, library);
			const pendingSkill = page.evaluate(() =>
				window.sandboxExecutionFixture.skill("rewrite", "await new Promise(() => {});"),
			);
			await page.waitForFunction(() => document.querySelector("sitegeist-sandbox iframe"));
			await page.evaluate(() => window.sandboxExecutionFixture.abort());
			assert.deepEqual(await pendingSkill, { success: false, error: "Execution aborted", saved: library });
			assert.equal(await page.locator("sitegeist-sandbox").count(), 0);
			const state = await page.evaluate(() => ({
				lifecycle: window.sandboxExecutionFixture.lifecycle,
				violations: window.sandboxExecutionFixture.violations,
			}));
			assert.equal(
				state.lifecycle.filter((entry) => entry === "start").length,
				state.lifecycle.filter((entry) => entry === "end").length,
			);
			assert.deepEqual(state.violations, []);
		} finally {
			await context?.close();
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
