import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chatBridge } from "./chat-bridge.mjs";
import { settingsBridge } from "./settings-bridge.mjs";
import { storageBridge } from "./storage-bridge.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
	plugins: [storageBridge(root), settingsBridge(root), chatBridge(root)],
	absWorkingDir: root,
	entryPoints: ["src/sidepanel.ts", "src/debug.ts", "src/background.ts"],
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "chrome120",
	outdir: "bundle-probe",
	write: false,
	metafile: true,
	define: { "process.env.NODE_ENV": '"production"', "process.env.TARGET_BROWSER": '"chrome"', global: "globalThis" },
	inject: [`${root}scripts/process-shim.js`],
	alias: {
		process: `${root}scripts/process-shim.js`,
		"@mariozechner/pi-ai": `${root}src/pi/models.ts`,
		"@mariozechner/pi-agent-core": `${root}src/pi/agent.ts`,
		"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
		lit: `${root}node_modules/lit`,
	},
});

const inputs = Object.keys(result.metafile.inputs);
const legacy = inputs.filter((path) =>
	/(?:node_modules\/@mariozechner\/pi-(?:ai|agent-core)\/|pi-mono\/packages\/(?:ai|agent)\/)/.test(path),
);
assert.deepEqual(legacy, [], "Legacy SDK implementations must not enter the browser bundle");
assert.deepEqual(
	inputs.filter((path) => /pi-(?:mono\/packages\/web-ui|web-ui)\/(?:dist|src)\/storage\//.test(path)),
	[],
	"Legacy storage implementations must not enter the browser bundle",
);
assert.ok(inputs.some((path) => path.includes("@earendil-works/pi-agent-core/dist/agent.js")));
assert.deepEqual(
	inputs.filter((path) =>
		/pi-(?:mono\/packages\/web-ui|web-ui)\/(?:dist|src)\/dialogs\/(?:ModelSelector|SettingsDialog)\./.test(path),
	),
	[],
	"Legacy selector/settings implementations must not enter the browser bundle",
);
assert.ok(inputs.some((path) => path.includes("@earendil-works/pi-ai/dist/models.js")));
assert.deepEqual(
	inputs.filter((path) =>
		/pi-(?:mono\/packages\/web-ui|web-ui)\/(?:dist|src)\/(?:ChatPanel\.|components\/(?:AgentInterface|MessageEditor|MessageList|Messages|StreamingMessageContainer|ThinkingBlock|message-renderer-registry)\.|tools\/(?:renderer-registry\.|renderers\/(?:BashRenderer|CalculateRenderer|DefaultRenderer|GetCurrentTimeRenderer)\.))/.test(
			path,
		),
	),
	[],
	"Legacy chat shell and renderer implementations must not enter the browser bundle",
);
assert.deepEqual(
	inputs.filter((path) =>
		/pi-(?:mono\/packages\/web-ui|web-ui)\/(?:dist|src)\/(?:utils\/attachment-utils\.|components\/(?:AttachmentTile|sandbox\/AttachmentsRuntimeProvider)\.|dialogs\/AttachmentOverlay\.|tools\/extract-document\.)/.test(
			path,
		),
	),
	[],
	"Legacy attachment and document extraction implementations must not enter the browser bundle",
);
const runtime = await build({
	plugins: [storageBridge(root), settingsBridge(root), chatBridge(root)],
	absWorkingDir: root,
	entryPoints: ["src/tools/repl/repl.ts", "src/tools/repl/runtime-providers.ts", "src/tools/skill.ts"],
	bundle: true,
	platform: "browser",
	format: "esm",
	target: "chrome120",
	outdir: "runtime-probe",
	write: false,
	metafile: true,
	define: { "process.env.NODE_ENV": '"production"', "process.env.TARGET_BROWSER": '"chrome"', global: "globalThis" },
	inject: [`${root}scripts/process-shim.js`],
	alias: {
		process: `${root}scripts/process-shim.js`,
		"@mariozechner/pi-ai": `${root}src/pi/models.ts`,
		"@mariozechner/pi-agent-core": `${root}src/pi/agent.ts`,
		"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
		lit: `${root}node_modules/lit`,
	},
});
assert.deepEqual(
	Object.keys(runtime.metafile.inputs).filter((path) =>
		/pi-(?:mono\/packages\/web-ui|web-ui)\/(?:dist|src)\/components\/(?:SandboxedIframe\.|sandbox\/)/.test(path),
	),
	[],
	"Production REPL, skills and browser helpers must not include retained sandbox implementations",
);
console.log(
	`Browser bundle verified: ${inputs.length} inputs, zero retired SDK/UI implementations; production runtime is local.`,
);
