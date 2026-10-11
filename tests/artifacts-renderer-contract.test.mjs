import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

test("artifact renderers retain the standard wrapper contract for partial, completed and error results", async () => {
	const bundled = await build({
		entryPoints: ["src/artifacts/ArtifactsToolRenderer.ts"],
		bundle: true,
		write: false,
		format: "cjs",
		platform: "node",
	});
	const module = { exports: {} };
	runInNewContext(bundled.outputFiles[0].text, {
		module,
		exports: module.exports,
		HTMLElement: class {},
		customElements: { define() {} },
		localStorage: { getItem: () => "en" },
		document: {
			createTreeWalker: () => ({}),
			createElementNS: () => ({
				setAttribute() {},
				appendChild() {},
				outerHTML: "<svg></svg>",
				classList: { add() {} },
			}),
		},
	});
	const renderer = new module.exports.ArtifactsToolRenderer();
	for (const params of [
		undefined,
		{},
		{ command: "create" },
		...["create", "update", "rewrite", "get", "delete", "logs"].map((command) => ({
			command,
			filename: "report.md",
			content: "# Report",
			old_str: "old",
			new_str: "new",
		})),
	]) {
		for (const isError of [undefined, false, true]) {
			const result =
				isError === undefined
					? undefined
					: {
							role: "toolResult",
							toolName: "artifacts",
							toolCallId: "call",
							content: [{ type: "text", text: "Result" }],
							isError,
							timestamp: 0,
						};
			assert.equal(renderer.render(params, result, true).isCustom, false);
		}
	}
});
