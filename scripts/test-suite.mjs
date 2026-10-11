import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = new URL("../tests/", import.meta.url);
const suites = readdirSync(directory).filter((name) => name.endsWith(".test.mjs"));
const browserSuites = new Set(
	suites.filter((name) => /from\s+["']@playwright\/test["']/.test(readFileSync(new URL(name, directory), "utf8"))),
);
const selection = process.argv[2];
let files;
switch (selection) {
	case "critical":
		files = [
			"foundation.test.mjs",
			"models.test.mjs",
			"model-selection.test.mjs",
			"storage.test.mjs",
			"attachments-runtime.test.mjs",
			"navigation-steering.test.mjs",
			"artifacts-runtime.test.mjs",
			"artifacts-contract.test.mjs",
			"artifacts-renderer-contract.test.mjs",
			"artifact-preview-contract.test.mjs",
			"debug-repl-contract.test.mjs",
		];
		if (suites.some((name) => name.startsWith("sandbox-"))) {
			files.push("sandbox-routing.test.mjs", "sandbox-native-input.test.mjs");
		}
		break;
	case "unit":
		files = suites.filter((name) => !browserSuites.has(name));
		break;
	case "browser":
		files = [...browserSuites];
		break;
	case "all":
		files = suites;
		break;
	default:
		throw new Error("Select a test suite: critical, unit, browser or all");
}
if (files.length === 0) throw new Error(`No ${selection} test suites found`);
if (files.some((name) => browserSuites.has(name)) && selection === "critical") {
	throw new Error("Critical CI contracts must not import Playwright");
}
console.log(`Running ${selection} suites: ${files.join(", ")}`);
const child = spawn(
	process.execPath,
	[
		"--import",
		"tsx",
		"--test",
		"--test-concurrency=1",
		"--test-timeout=120000",
		...files.map((name) => fileURLToPath(new URL(name, directory))),
	],
	{ stdio: "inherit" },
);
child.once("error", (error) => {
	console.error(`Unable to start ${selection} tests: ${error.message}`);
	process.exitCode = 1;
});
child.once("exit", (code, signal) => {
	process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
});
