import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import { ArtifactsRuntimeProvider } from "../src/artifacts/ArtifactsRuntimeProvider.ts";
import { AttachmentsRuntimeProvider } from "../src/attachments/AttachmentsRuntimeProvider.ts";

const bundled = await build({
	stdin: {
		contents:
			'import { HtmlArtifactPreview } from "./src/artifacts/HtmlArtifactPreview.ts"; globalThis.Preview = HtmlArtifactPreview;',
		resolveDir: process.cwd(),
	},
	bundle: true,
	format: "iife",
	write: false,
	target: "es2022",
});

function harness() {
	const frames = [];
	const opened = [];
	const errors = [];
	class Element extends EventTarget {
		style = {};
		children = [];
		replaceChildren(...children) {
			this.children = children;
		}
	}
	const window = new EventTarget();
	window.open = (...args) => opened.push(args);
	const document = {
		createElement(tag) {
			assert.equal(tag, "iframe");
			const frame = {
				attributes: {},
				style: {},
				messages: [],
				setAttribute(key, value) {
					this.attributes[key] = value;
				},
				remove() {
					this.removed = true;
				},
			};
			frame.contentWindow = { postMessage: (message) => frame.messages.push(message) };
			frames.push(frame);
			return frame;
		},
	};
	const context = {
		window,
		document,
		HTMLElement: Element,
		customElements: { define() {} },
		AbortController,
		setTimeout,
		clearTimeout,
		URL,
		console: { ...console, error: (...args) => errors.push(args) },
		Event,
	};
	runInNewContext(bundled.outputFiles[0].text, context);
	const preview = new context.Preview();
	const message = (data, source = frames.at(-1)?.contentWindow) => {
		const event = new Event("message");
		Object.assign(event, { data, source });
		window.dispatchEvent(event);
	};
	return { preview, frames, opened, errors, message };
}

test("preview setup failures report diagnostics, settle readiness and end every started provider", async () => {
	const h = harness();
	let ended = 0;
	const provider = {
		getData: () => ({}),
		getRuntime: () => () => {},
		getDescription: () => "",
		onExecutionStart() {
			throw new Error("setup-probe");
		},
		onExecutionEnd() {
			ended++;
		},
	};
	h.preview.loadContent("setup", "<h1>safe</h1>", [provider]);
	await h.preview.ready;
	assert.equal(ended, 1);
	assert.equal(h.frames[0].removed, true);
	assert.equal(h.errors[0][0], "HTML artifact preview setup failed:");
	assert.match(h.errors[0].join(" "), /setup-probe/);
	h.message({
		channel: "sitegeist-runtime",
		sandboxId: "setup",
		type: "artifact-operation",
		action: "list",
		messageId: "late",
		messageType: "request-response",
	});
	assert.deepEqual(h.frames[0].messages, []);
});

test("HTML preview lifecycle binds only its opaque iframe, then disposes old routing", async () => {
	const h = harness();
	let starts = 0;
	let ends = 0;
	const provider = {
		getData: () => ({}),
		getRuntime: () => () => {},
		getDescription: () => "",
		onExecutionStart: () => starts++,
		onExecutionEnd: () => ends++,
	};
	h.preview.sandboxUrlProvider = () => "chrome-extension://fixture/sandbox.html";
	h.preview.loadContent("preview-1", "<h1>safe</h1>", [provider]);
	const first = h.frames[0];
	assert.equal(first.attributes.sandbox, "allow-scripts allow-modals");
	assert.equal(first.src, "chrome-extension://fixture/sandbox.html");
	h.message({ type: "sandbox-ready", channel: "sitegeist-runtime" }, {});
	h.message({ type: "sandbox-ready", channel: "other" });
	assert.equal(first.messages.length, 0);
	h.message({ type: "sandbox-ready" });
	assert.equal(first.messages.length, 1);
	assert.equal(first.messages[0].sandboxId, "preview-1");
	h.message({ type: "artifact-ready", channel: "sitegeist-runtime", sandboxId: "preview-1" });
	await h.preview.ready;
	h.preview.loadContent("preview-2", "<h1>new</h1>", [provider]);
	assert.equal(first.removed, true);
	assert.equal(starts, 2);
	assert.equal(ends, 1);
	h.preview.disconnectedCallback();
	await h.preview.ready;
	assert.equal(ends, 2);
});

test("HTML previews deny forged writes and privileged runtime requests without exposing host data", async () => {
	const h = harness();
	const mutations = [];
	const panel = {
		artifacts: new Map([["notes.txt", { content: "original" }]]),
		tool: { execute: async (...args) => mutations.push(args) },
	};
	h.preview.loadContent("isolated", "<h1>preview</h1>", [new ArtifactsRuntimeProvider(panel, undefined, false)]);
	const envelope = {
		channel: "sitegeist-runtime",
		sandboxId: "isolated",
		messageType: "request-response",
		type: "artifact-operation",
		action: "createOrUpdate",
		filename: "notes.txt",
		content: "forged",
	};
	h.message({ ...envelope, messageId: "wrong-source" }, {});
	h.message({ ...envelope, messageId: "wrong-channel", channel: "other" });
	h.message({ ...envelope, messageId: "write" });
	h.message({ ...envelope, messageId: "delete", action: "delete" });
	for (const type of ["browser-js", "navigate", "native-click", "file-download"])
		h.message({ ...envelope, type, messageId: type });
	await new Promise((resolve) => setImmediate(resolve));
	const replies = h.frames[0].messages;
	assert.equal(replies.length, 2);
	assert.ok(replies.every(({ success, error }) => success === false && /read-only/.test(error)));
	assert.equal(panel.artifacts.get("notes.txt").content, "original");
	assert.deepEqual(mutations, []);
	h.preview.disconnectedCallback();
	h.message({ ...envelope, messageId: "disposed" });
	assert.equal(replies.length, 2);
});

test("standalone HTML embeds escaped artifact/attachment snapshots without bridge or parent navigation", async () => {
	const h = harness();
	const panel = {
		artifacts: new Map([
			["__proto__", { content: "</script><script>unexpected()</script>" }],
			["data.json", { content: '{"ok":true}' }],
		]),
		tool: {
			execute() {
				throw new Error("offline");
			},
		},
	};
	const providers = [
		new ArtifactsRuntimeProvider(panel, undefined, false),
		new AttachmentsRuntimeProvider([
			{ id: "file", fileName: "text.txt", mimeType: "text/plain", size: 5, content: "aGVsbG8=" },
		]),
	];
	const content = h.preview.prepareHtmlDocument(
		"offline",
		"<!doctype html><html><head><title>Title</title></head><body><h1>Report</h1></body></html>",
		providers,
		{ isStandalone: true },
	);
	assert.ok(content.startsWith("<!doctype html><html><head>"));
	assert.equal(content.match(/<script>/g).length, 1);
	assert.equal(content.match(/<\/script>/g).length, 1);
	assert.ok(content.endsWith("<body><h1>Report</h1></body></html>"));
	assert.doesNotMatch(content, /sitegeist-artifact-navigation|runtime-response|artifact-ready/);
	const window = {};
	const source = content.match(/<script>([\s\S]*?)<\/script>/)[1];
	runInNewContext(source, { window, atob, Uint8Array });
	assert.equal(window.sendRuntimeMessage, undefined);
	assert.equal(await window.getArtifact("__proto__"), "</script><script>unexpected()</script>");
	assert.deepEqual(JSON.parse(JSON.stringify(await window.getArtifact("data.json"))), { ok: true });
	assert.equal(window.readTextAttachment("file"), "hello");
	await assert.rejects(window.createOrUpdateArtifact("data.json", {}), /read-only/);
});

test("fragment/root wrappers escape runtime literals without disabling agent-authored scripts", () => {
	const h = harness();
	const provider = {
		getData: () => ({ snapshot: "</ScRiPt><script>window.payloadExecuted=true</script>" }),
		getRuntime: () => (id) => {
			window.runtimeId = id;
			window.literal = "</ScRiPt><script>window.payloadExecuted=true</script>";
		},
	};
	const agentHtml = "<h1>safe</h1><script>window.agentRan=true</script>";
	for (const html of ["<h1>safe</h1>", "<html><body><h1>safe</h1></body></html>", agentHtml]) {
		for (const isStandalone of [true, false]) {
			const id = "artifact-<!--<script></ScRiPt>.html";
			const content = h.preview.prepareHtmlDocument(id, html, [provider], { isStandalone });
			assert.match(content, /^<!doctype html><html><head>|^<html><head>/);
			const source = content.match(/<script>([\s\S]*?)<\/script>/)[1];
			assert.doesNotMatch(source, /<!--/);
			assert.match(source, /<\\\/script/i);
			const window = new EventTarget();
			window.parent = { postMessage() {} };
			runInNewContext(source, { window, document: { addEventListener() {} }, setTimeout, clearTimeout });
			assert.equal(window.payloadExecuted, undefined);
			assert.equal(window.runtimeId, id);
			assert.equal(window.snapshot, "</ScRiPt><script>window.payloadExecuted=true</script>");
			assert.equal(content.match(/<\/script>/gi).length, html === agentHtml ? 2 : 1);
			if (html === agentHtml) assert.ok(content.endsWith(`${agentHtml}</body></html>`));
			window.__runtimeBridgeCleanup?.();
		}
	}
	const policy = JSON.parse(
		readFileSync(new URL("../static/manifest.chrome.json", import.meta.url), "utf8"),
	).content_security_policy;
	assert.equal(policy.extension_pages, "script-src 'self'; object-src 'self'");
});

test("preview navigation rejects forged senders, stale IDs and active URL schemes", () => {
	const h = harness();
	h.preview.loadContent("links", "<h1>links</h1>");
	const data = { channel: "sitegeist-artifact-navigation", sandboxId: "links", url: "https://example.com/path" };
	h.message(data, {});
	h.message({ ...data, sandboxId: "old" });
	for (const url of [
		"javascript:alert(1)",
		"data:text/html,test",
		"chrome-extension://fixture/debug.html",
		"file:///etc/passwd",
	])
		h.message({ ...data, url });
	assert.deepEqual(h.opened, []);
	h.message(data);
	assert.deepEqual(h.opened, [["https://example.com/path", "_blank", "noopener,noreferrer"]]);
	h.preview.disconnectedCallback();
});
