import assert from "node:assert/strict";
import { before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
let bundled;

before(async () => {
	const result = await build({
		absWorkingDir: root,
		entryPoints: ["src/tools/javascript-repl.ts"],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
		plugins: [
			{
				name: "debug-contract-sandbox",
				setup(build) {
					build.onResolve({ filter: /SandboxIframe\.js$/ }, () => ({ path: "sandbox", namespace: "contract" }));
					build.onResolve({ filter: /AttachmentTile\.js$/ }, () => ({ path: "tile", namespace: "contract" }));
					build.onLoad({ filter: /.*/, namespace: "contract" }, ({ path }) => ({
						contents:
							path === "tile"
								? ""
								: `export class SandboxIframe {
									style = {};
									execute(...args) { return globalThis.fixture.execute(this, args); }
									remove() { globalThis.fixture.removed++; }
								}`,
					}));
				},
			},
		],
	});
	bundled = result.outputFiles[0].text;
});

function harness(outcome) {
	const calls = [];
	const fixture = {
		appended: 0,
		removed: 0,
		execute(sandbox, args) {
			calls.push({ sandbox, args });
			return typeof outcome === "function" ? outcome(...args) : Promise.resolve(outcome);
		},
	};
	const module = { exports: {} };
	runInNewContext(bundled, {
		module,
		exports: module.exports,
		fixture,
		crypto,
		TextEncoder,
		TextDecoder,
		Uint8Array,
		btoa,
		atob,
		setTimeout,
		clearTimeout,
		console,
		HTMLElement: class {},
		customElements: { define() {} },
		document: {
			createTreeWalker: () => ({}),
			body: {
				appendChild() {
					fixture.appended++;
				},
			},
		},
	});
	return { ...module.exports, fixture, calls };
}

test("generic debug tool keeps its schema and mutable provider/url contracts", async () => {
	const h = harness({ success: true, console: [] });
	const tool = h.createJavaScriptReplTool();
	assert.equal(tool.name, "javascript_repl");
	assert.equal(tool.label, "JavaScript REPL");
	assert.deepEqual(Array.from(tool.parameters.required), ["title", "code"]);
	assert.equal(tool.parameters.properties.title.type, "string");
	assert.equal(tool.parameters.properties.code.type, "string");
	let documentation = "First runtime helpers";
	let factories = 0;
	const provider = { getDescription: () => documentation };
	tool.runtimeProvidersFactory = () => {
		factories++;
		return [provider];
	};
	assert.match(tool.description, /First runtime helpers/);
	documentation = "Second runtime helpers";
	assert.match(tool.description, /Second runtime helpers/);
	const url = () => "chrome-extension://fixture/sandbox.html";
	tool.sandboxUrlProvider = url;
	const controller = new AbortController();
	const result = await tool.execute("call", { title: "Testing", code: "return 42" }, controller.signal);
	assert.equal(result.content[0].text, "Code executed successfully (no output)");
	assert.equal(result.details.files.length, 0);
	assert.equal(factories, 3);
	assert.equal(h.calls[0].sandbox.sandboxUrlProvider, url);
	assert.equal(h.calls[0].args[1], "return 42");
	assert.equal(h.calls[0].args[2][0], provider);
	assert.equal(h.calls[0].args[4], controller.signal);
	assert.equal(h.fixture.appended, 1);
	assert.equal(h.fixture.removed, 1);
	await tool.execute("next", { title: "Next", code: "" });
	assert.notEqual(h.calls[0].args[0], h.calls[1].args[0]);
	assert.equal(
		(await tool.execute("missing-file", { title: "Missing file", code: "// returnFile" })).content[0].text,
		"[No files returned - check async operations]",
	);
});

test("debug output preserves console order, null/object returns and exact UTF-8/binary files", async () => {
	const h = harness({
		success: true,
		console: [
			{ type: "warn", text: "warning" },
			{ type: "error", text: "stderr" },
		],
		returnValue: { total: 42 },
		files: [
			{ fileName: "folder/文.txt", mimeType: "text/plain", content: "hé 文" },
			{ fileName: "bytes.bin", mimeType: "application/octet-stream", content: new Uint8Array([0, 127, 255]) },
		],
	});
	const result = await h.createJavaScriptReplTool().execute("call", { title: "Output", code: "" });
	assert.equal(
		result.content[0].text,
		'warning\nstderr\n\n=> {\n  "total": 42\n}\n[Files returned: 2]\n  - folder/文.txt (text/plain)\n  - bytes.bin (application/octet-stream)',
	);
	assert.equal(result.details.files[0].size, new TextEncoder().encode("hé 文").length);
	assert.equal(Buffer.from(result.details.files[0].contentBase64, "base64").toString("utf8"), "hé 文");
	assert.deepEqual([...Buffer.from(result.details.files[1].contentBase64, "base64")], [0, 127, 255]);
	assert.equal(
		(
			await harness({ success: true, console: [], returnValue: null })
				.createJavaScriptReplTool()
				.execute("", { title: "Null", code: "" })
		).content[0].text,
		"=> null",
	);
});

test("debug failures and abort retain their public text and always remove the sandbox", async () => {
	for (const [outcome, expected] of [
		[
			{ success: false, console: [{ type: "log", text: "before" }], error: { message: "boom", stack: "STACK" } },
			"before\n\nError: boom\nSTACK",
		],
		[{ success: false, console: [], error: { message: "Execution aborted", stack: "" } }, "Error: Execution aborted"],
		[() => Promise.reject(new Error("setup failed")), "setup failed"],
	]) {
		const h = harness(outcome);
		await assert.rejects(
			h.createJavaScriptReplTool().execute("", { title: "Failure", code: "" }),
			(error) => error.message === expected,
		);
		assert.equal(h.fixture.appended, 1);
		assert.equal(h.fixture.removed, 1);
	}
});
