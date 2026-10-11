import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const retiredPackage = /(?:^|\/)@(?:mariozechner\/pi-|earendil-works\/pi-web-ui)/;
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
for (const [path, entry] of Object.entries(lock.packages)) {
	assert.ok(!retiredPackage.test(path), `Retired package in lockfile: ${path}`);
	assert.ok(!entry.link && !entry.resolved?.startsWith("file:"), `Sibling dependency in lockfile: ${path}`);
}
assert.equal(lock.packages["node_modules/@earendil-works/pi-ai"].version, "1.1.0");
assert.equal(lock.packages["node_modules/@earendil-works/pi-agent-core"].version, "1.1.0");
assert.equal(lock.packages["node_modules/@mariozechner/mini-lit"].version, "0.2.1");

const installed = JSON.parse(execFileSync("npm", ["ls", "--all", "--json"], { cwd: root, encoding: "utf8" }));
function auditDependencies(tree) {
	for (const [name, dependency] of Object.entries(tree.dependencies ?? {})) {
		assert.ok(!retiredPackage.test(name), `Retired installed package: ${name}`);
		auditDependencies(dependency);
	}
}
auditDependencies(installed);

let sourceCount = 0;
function auditImports(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			auditImports(path);
			continue;
		}
		if (!/\.(?:ts|mjs|js)$/.test(entry.name)) continue;
		sourceCount++;
		const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
		function visit(node) {
			const specifier =
				ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
					? node.moduleSpecifier
					: ts.isCallExpression(node) &&
							(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
								node.expression.getText(source) === "require")
						? node.arguments[0]
						: undefined;
			if (specifier && ts.isStringLiteralLike(specifier)) {
				assert.ok(!retiredPackage.test(specifier.text), `Retired import in ${path}: ${specifier.text}`);
				assert.ok(
					!/pi-mono|(?:^|\/)\.\.\/mini-lit/.test(specifier.text),
					`Sibling import in ${path}: ${specifier.text}`,
				);
				assert.ok(!specifier.text.startsWith("@earendil-works/pi-ai/compat"), `Compatibility import in ${path}`);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
}
for (const directory of ["src", "scripts", "tests"]) auditImports(join(root, directory));

const options = {
	absWorkingDir: root,
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "chrome120",
	write: false,
	metafile: true,
	define: { "process.env.NODE_ENV": '"production"', "process.env.TARGET_BROWSER": '"chrome"', global: "globalThis" },
	inject: [join(root, "scripts/process-shim.js")],
	alias: { process: join(root, "scripts/process-shim.js") },
};
const results = await Promise.all([
	build({
		...options,
		entryPoints: ["src/sidepanel.ts", "src/debug.ts", "src/icons.ts", "src/background.ts"],
		outdir: "bundle-probe",
	}),
	build({
		...options,
		entryPoints: ["src/tools/repl/repl.ts", "src/tools/repl/runtime-providers.ts", "src/tools/skill.ts"],
		outdir: "runtime-probe",
	}),
]);
const inputs = new Set(results.flatMap((result) => Object.keys(result.metafile.inputs)));
for (const path of inputs) {
	assert.ok(!retiredPackage.test(path) && !path.includes("pi-mono/"), `Retired bundle input: ${path}`);
}
assert.ok([...inputs].some((path) => path.includes("@earendil-works/pi-agent-core/dist/agent.js")));
assert.ok([...inputs].some((path) => path.includes("@earendil-works/pi-ai/dist/models.js")));
assert.ok(![...inputs].some((path) => /@earendil-works\/pi-ai\/dist\/compat\./.test(path)));
console.log(
	`Verified ${sourceCount} source files, the installed dependency tree, four entrypoints and runtime helpers (${inputs.size} bundle inputs); no retired Pi packages or bridges.`,
);
