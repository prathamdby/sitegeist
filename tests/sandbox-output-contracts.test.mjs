import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { ConsoleRuntimeProvider as BaselineConsoleRuntimeProvider } from "../node_modules/@mariozechner/pi-web-ui/dist/components/sandbox/ConsoleRuntimeProvider.js";
import { FileDownloadRuntimeProvider as BaselineFileDownloadRuntimeProvider } from "../node_modules/@mariozechner/pi-web-ui/dist/components/sandbox/FileDownloadRuntimeProvider.js";
import { ConsoleRuntimeProvider } from "../src/sandbox/ConsoleRuntimeProvider.ts";
import { FileDownloadRuntimeProvider } from "../src/sandbox/FileDownloadRuntimeProvider.ts";

function onlineRuntime(provider, sandboxId = "output-fixture") {
	const responses = [];
	const pending = [];
	const console = { log() {}, warn() {}, error() {}, info() {} };
	const window = {
		...provider.getData(),
		console,
		__completionCallbacks: [],
		addEventListener() {},
		removeEventListener() {},
		sendRuntimeMessage(message) {
			const request = new Promise((resolve, reject) => {
				Promise.resolve(
					provider.handleMessage({ ...message, sandboxId }, (response) => {
						responses.push(response);
						resolve(response);
					}),
				).catch(reject);
			});
			pending.push(request);
			return request;
		},
	};
	const context = vm.createContext({ window, console, Blob, Uint8Array, TextEncoder, setTimeout, clearTimeout });
	vm.runInContext(`(${provider.getRuntime().toString()})(${JSON.stringify(sandboxId)})`, context);
	return {
		context,
		window,
		responses,
		async drain() {
			await Promise.all(pending);
		},
	};
}

function normalizedLogs(provider) {
	return provider.getLogs().map(({ type, text, args }) => ({ type, text, args: Array.from(args ?? []) }));
}

function normalizedFiles(provider) {
	return provider.getFiles().map(({ fileName, content, mimeType }) => ({
		fileName,
		content: typeof content === "string" ? content : Array.from(content),
		mimeType,
	}));
}

test("retained and local console providers keep all 10,017 logs in emission order", { timeout: 5000 }, async () => {
	const count = 10017;
	const observed = [];
	for (const Provider of [BaselineConsoleRuntimeProvider, ConsoleRuntimeProvider]) {
		const provider = new Provider();
		const runtime = onlineRuntime(provider);
		try {
			vm.runInContext(`for (let i = 0; i < ${count}; i++) console.log("entry", i);`, runtime.context);
			await runtime.drain();
			const logs = normalizedLogs(provider);
			assert.equal(logs.length, count);
			assert.equal(runtime.responses.length, count);
			assert.ok(runtime.responses.every((response) => response.success === true));
			assert.deepEqual(
				logs,
				Array.from({ length: count }, (_, i) => ({ type: "log", text: `entry ${i}`, args: ["entry", i] })),
			);
			observed.push(logs);
		} finally {
			runtime.window.__consoleRuntimeCleanup?.();
		}
	}
	assert.deepEqual(observed[1], observed[0]);
});

test(
	"retained and local file helpers preserve 17 slash/Unicode names and original contents",
	{ timeout: 5000 },
	async () => {
		const files = Array.from({ length: 17 }, (_, i) => ({
			fileName: `folder/文-é-${i}.${i % 2 ? "txt" : "bin"}`,
			content: i % 2 ? `héllo 文 ${i}` : new Uint8Array([0, i, 127, 254, 255]),
			mimeType: i % 2 ? "text/plain" : "application/octet-stream",
		}));
		const expected = files.map(({ fileName, content, mimeType }) => ({
			fileName,
			content: typeof content === "string" ? content : Array.from(content),
			mimeType,
		}));
		const observed = [];
		for (const Provider of [BaselineFileDownloadRuntimeProvider, FileDownloadRuntimeProvider]) {
			const provider = new Provider();
			const runtime = onlineRuntime(provider);
			for (const { fileName, content, mimeType } of files) {
				await runtime.window.returnDownloadableFile(fileName, content, mimeType);
			}
			await runtime.drain();
			assert.equal(runtime.responses.length, files.length);
			assert.ok(runtime.responses.every((response) => response.success === true));
			const collected = normalizedFiles(provider);
			assert.deepEqual(collected, expected);
			for (let i = 0; i < files.length; i++) {
				const content = provider.getFiles()[i].content;
				const actualBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
				const expectedBytes =
					typeof files[i].content === "string" ? new TextEncoder().encode(files[i].content) : files[i].content;
				assert.deepEqual(Array.from(actualBytes), Array.from(expectedBytes));
			}
			observed.push(collected);
		}
		assert.deepEqual(observed[1], observed[0]);
	},
);

test(
	"optional file providers accumulate across runtime installations until explicit reset",
	{ timeout: 5000 },
	async () => {
		for (const Provider of [BaselineFileDownloadRuntimeProvider, FileDownloadRuntimeProvider]) {
			const provider = new Provider();
			for (const sandboxId of ["first-execution", "second-execution"]) {
				const runtime = onlineRuntime(provider, sandboxId);
				await runtime.window.returnDownloadableFile(`folder/${sandboxId}-文.txt`, sandboxId, "text/plain");
				assert.deepEqual(runtime.responses, [{ success: true }]);
			}
			assert.deepEqual(
				provider.getFiles().map((file) => file.fileName),
				["folder/first-execution-文.txt", "folder/second-execution-文.txt"],
			);
			provider.reset();
			assert.deepEqual(provider.getFiles(), []);
			const next = onlineRuntime(provider, "after-reset");
			await next.window.returnDownloadableFile("after-reset.txt", "fresh", "text/plain");
			assert.deepEqual(normalizedFiles(provider), [
				{ fileName: "after-reset.txt", content: "fresh", mimeType: "text/plain" },
			]);
		}
	},
);
