import { ConsoleRuntimeProvider } from "./ConsoleRuntimeProvider.js";
import { RuntimeMessageBridge } from "./RuntimeMessageBridge.js";
import { RUNTIME_MESSAGE_ROUTER } from "./RuntimeMessageRouter.js";
import type { MessageConsumer, SandboxResult, SandboxRuntimeProvider } from "./types.js";

export type { SandboxFile, SandboxResult } from "./types.js";

export class SandboxIframe extends HTMLElement {
	sandboxUrlProvider?: () => string;
	private cancel?: () => void;

	disconnectedCallback(): void {
		this.cancel?.();
	}

	execute(
		sandboxId: string,
		code: string,
		providers: SandboxRuntimeProvider[] = [],
		consumers: MessageConsumer[] = [],
		signal?: AbortSignal,
	): Promise<SandboxResult> {
		this.cancel?.();
		if (signal?.aborted) {
			return Promise.resolve({ success: false, console: [], error: { message: "Execution aborted", stack: "" } });
		}
		const consoleProvider = new ConsoleRuntimeProvider();
		const files: NonNullable<SandboxResult["files"]> = [];
		const runtimeProviders: SandboxRuntimeProvider[] = [consoleProvider, ...providers];
		const iframe = document.createElement("iframe");
		iframe.setAttribute("sandbox", "allow-scripts allow-modals");
		iframe.style.display = "none";
		const controller = new AbortController();
		return new Promise((resolve) => {
			let settled = false;
			let loaded = false;
			let timer: ReturnType<typeof setTimeout>;
			const started: SandboxRuntimeProvider[] = [];
			const finish = (result: SandboxResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				window.removeEventListener("message", ready);
				signal?.removeEventListener("abort", abort);
				RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
				controller.abort();
				iframe.remove();
				this.cancel = undefined;
				for (const provider of started) {
					try {
						provider.onExecutionEnd?.(sandboxId);
					} catch (error) {
						console.error("Sandbox provider cleanup failed", error);
					}
				}
				resolve(result);
			};
			const fail = (message: string, stack = "") =>
				finish({ success: false, console: consoleProvider.getLogs(), files, error: { message, stack } });
			const abort = () => fail("Execution aborted");
			const ready = (event: MessageEvent) => {
				if (event.source !== iframe.contentWindow || settled) return;
				const data = event.data;
				if (!data || (data.channel !== undefined && data.channel !== "sitegeist-runtime")) return;
				if (data.type === "sandbox-error") {
					if (data.sandboxId !== sandboxId) return;
					fail(typeof data.error === "string" ? data.error : "Sandbox error", data.stack ?? "");
				} else if (data.type === "sandbox-ready" && !loaded) {
					loaded = true;
					iframe.contentWindow?.postMessage(
						{ type: "sandbox-load", channel: "sitegeist-runtime", sandboxId, code: documentCode },
						"*",
					);
				}
			};
			let documentCode: string;
			try {
				documentCode = this.prepareDocument(sandboxId, code, runtimeProviders);
				RUNTIME_MESSAGE_ROUTER.registerSandbox(sandboxId, runtimeProviders, [
					...consumers,
					{
						async handleMessage(message) {
							if (message.type === "file-returned") {
								if (
									typeof message.fileName === "string" &&
									typeof message.mimeType === "string" &&
									(typeof message.content === "string" || message.content instanceof Uint8Array)
								) {
									files.push({
										fileName: message.fileName,
										content: message.content,
										mimeType: message.mimeType,
									});
								}
								return;
							}
							if (message.type !== "execution-complete") return;
							finish({
								success: message.success === true,
								console: consoleProvider.getLogs(),
								...(message.success === true ? { returnValue: message.returnValue } : {}),
								files,
								...(message.error ? { error: message.error as SandboxResult["error"] } : {}),
							});
						},
					},
				]);
				for (const provider of runtimeProviders) {
					started.push(provider);
					provider.onExecutionStart?.(sandboxId, controller.signal);
				}
				this.cancel = abort;
				signal?.addEventListener("abort", abort, { once: true });
				window.addEventListener("message", ready);
				timer = setTimeout(() => fail("Execution timeout: Code did not complete within 120 seconds"), 120000);
				this.replaceChildren(iframe);
				RUNTIME_MESSAGE_ROUTER.setSandboxIframe(sandboxId, iframe);
				if (this.sandboxUrlProvider) {
					iframe.src = this.sandboxUrlProvider();
				} else {
					iframe.srcdoc = documentCode;
				}
				if (signal?.aborted) abort();
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : "");
			}
		});
	}

	private prepareDocument(sandboxId: string, code: string, providers: SandboxRuntimeProvider[]): string {
		const bridge = RuntimeMessageBridge.generateBridgeCode({ context: "sandbox-iframe", sandboxId });
		const injections = providers
			.map((provider) => {
				const data = Object.entries(provider.getData())
					.map(([key, value]) => `window[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
					.join("\n");
				return `${data}\n(${provider.getRuntime().toString()})(${JSON.stringify(sandboxId)});`;
			})
			.join("\n");
		const script = `(async () => {
const __complete = (result) => window.parent.postMessage({
	channel: "sitegeist-runtime", sandboxId: ${JSON.stringify(sandboxId)}, type: "execution-complete", ...result
}, "*");
const __callbacks = async success => {
	let timer;
	try {
		await Promise.race([
			Promise.all((window.__completionCallbacks || []).map(callback => callback(success))),
			new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Completion timeout")), 5000); })
		]);
	} catch (error) {
		console.error("Completion callback error:", error);
	} finally { clearTimeout(timer); }
};
try {
${bridge}
${injections}
	const returnValue = await (async () => {\n${code}\n})();
	await __callbacks(true);
	window.__consoleRuntimeCleanup?.();
	window.__runtimeBridgeCleanup?.();
	__complete({ success: true, returnValue });
} catch (error) {
	try { await __callbacks(false); } catch {}
	window.__consoleRuntimeCleanup?.();
	window.__runtimeBridgeCleanup?.();
	__complete({ success: false, error: { message: error?.message || String(error), stack: error?.stack || "" } });
}
})();`;
		const errors = `window.addEventListener("error", event => window.parent.postMessage({
	channel: "sitegeist-runtime", sandboxId: ${JSON.stringify(sandboxId)}, type: "execution-complete",
	success: false, error: { message: event.message, stack: event.error?.stack || "" }
}, "*"));
window.addEventListener("unhandledrejection", event => window.parent.postMessage({
	channel: "sitegeist-runtime", sandboxId: ${JSON.stringify(sandboxId)}, type: "execution-complete",
	success: false, error: { message: event.reason?.message || String(event.reason), stack: event.reason?.stack || "" }
}, "*"));`;
		return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${errors.replace(/<\/script/gi, "<\\/script")}</script><script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
	}
}

customElements.define("sitegeist-sandbox", SandboxIframe);
