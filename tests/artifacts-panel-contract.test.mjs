import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

test("panel logs preserves missing-file, non-HTML and empty-console contracts without rendering", async () => {
	const bundled = await build({
		entryPoints: ["src/artifacts/ArtifactsPanel.ts"],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		plugins: [
			{
				name: "panel-contract-view",
				setup(builder) {
					builder.onResolve({ filter: /views\/ArtifactView\.js$/ }, () => ({
						path: "view",
						namespace: "contract",
					}));
					builder.onLoad({ filter: /.*/, namespace: "contract" }, () => ({
						contents: `
				export const artifactKind = filename => filename.endsWith(".html") ? "html" : "text";
				export class ArtifactView {
					updateComplete = Promise.resolve(); ready = Promise.resolve();
					addEventListener() {} getLogs() { return ""; }
				}
			`,
					}));
				},
			},
		],
	});
	const module = { exports: {} };
	runInNewContext(bundled.outputFiles[0].text, {
		module,
		exports: module.exports,
		HTMLElement: class {},
		customElements: { define() {} },
		TextEncoder,
		TextDecoder,
		URL,
		AbortController,
		setTimeout,
		clearTimeout,
		console,
		document: { createTreeWalker: () => ({}) },
		localStorage: { getItem: () => "en" },
	});
	const panel = new module.exports.ArtifactsPanel();
	Object.defineProperty(panel, "updateComplete", { value: Promise.resolve() });
	const missing = await panel.tool.execute("", { command: "logs", filename: "missing.html" });
	assert.equal(missing.isError, true);
	assert.equal(missing.content[0].text, "Error: File missing.html not found. No files have been created yet.");
	for (const filename of ["notes.txt", "empty.html"])
		panel.artifacts.set(filename, { filename, content: "data", createdAt: new Date(), updatedAt: new Date() });
	const text = await panel.tool.execute("", { command: "logs", filename: "notes.txt" });
	assert.equal(text.isError, true);
	assert.equal(
		text.content[0].text,
		"Error: File notes.txt is not an HTML file. Logs are only available for HTML files.",
	);
	const html = await panel.tool.execute("", { command: "logs", filename: "empty.html" });
	assert.notEqual(html.isError, true);
	assert.equal(html.content[0].text, "No logs for empty.html");
});
