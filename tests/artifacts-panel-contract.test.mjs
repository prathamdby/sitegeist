import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

async function createPanel() {
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
	return new module.exports.ArtifactsPanel();
}

test(
	"detached restoration resolves synchronously restored state without waiting for rendering",
	{ timeout: 2000 },
	async () => {
		const panel = await createPanel();
		let renderReads = 0;
		let changes = 0;
		Object.defineProperty(panel, "isConnected", { value: false });
		Object.defineProperty(panel, "updateComplete", {
			get() {
				renderReads++;
				return new Promise(() => {});
			},
		});
		panel.onArtifactsChange = () => changes++;
		await panel.reconstructFromMessages([]);
		const restoring = panel.reconstructFromMessages([
			{
				role: "artifact",
				action: "create",
				filename: "saved.md",
				content: "# Saved artifact",
				timestamp: "2026-10-11T00:00:00.000Z",
			},
		]);
		assert.equal(panel.artifacts.get("saved.md").content, "# Saved artifact");
		assert.equal(changes, 2);
		assert.equal(renderReads, 0);
		await restoring;
	},
);

test("connected restoration still waits for rendering", async () => {
	const panel = await createPanel();
	let finishRender;
	let restored = false;
	Object.defineProperty(panel, "isConnected", { value: true });
	Object.defineProperty(panel, "updateComplete", {
		value: new Promise((resolve) => {
			finishRender = resolve;
		}),
	});
	const restoring = panel.reconstructFromMessages([]).then(() => {
		restored = true;
	});
	await Promise.resolve();
	assert.equal(restored, false);
	finishRender();
	await restoring;
	assert.equal(restored, true);
});

test("panel logs preserves missing-file, non-HTML and empty-console contracts without rendering", async () => {
	const panel = await createPanel();
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
