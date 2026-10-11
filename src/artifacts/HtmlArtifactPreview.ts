import { type ConsoleLog, ConsoleRuntimeProvider } from "../sandbox/ConsoleRuntimeProvider.js";
import { RuntimeMessageBridge } from "../sandbox/RuntimeMessageBridge.js";
import { RUNTIME_MESSAGE_ROUTER } from "../sandbox/RuntimeMessageRouter.js";
import type { MessageConsumer, SandboxRuntimeProvider } from "../sandbox/types.js";

function installPreviewNavigation(sandboxId: string): void {
	const send = (url: string) => {
		window.parent.postMessage({ channel: "sitegeist-artifact-navigation", sandboxId, url }, "*");
	};
	document.addEventListener("click", (event) => {
		const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
		if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
		const href = anchor.getAttribute("href");
		if (!href || href.startsWith("#")) return;
		event.preventDefault();
		send(anchor.href);
	});
}

export class HtmlArtifactPreview extends HTMLElement {
	sandboxUrlProvider?: () => string;
	ready: Promise<void> = Promise.resolve();
	private consoleProvider = new ConsoleRuntimeProvider();
	private cleanup?: () => void;

	connectedCallback(): void {
		this.style.cssText = "display: block; width: 100%; height: 100%; min-height: 0;";
	}

	disconnectedCallback(): void {
		this.cleanup?.();
	}

	getLogs(): ConsoleLog[] {
		return this.consoleProvider.getLogs();
	}

	loadContent(
		sandboxId: string,
		html: string,
		providers: SandboxRuntimeProvider[] = [],
		consumers: MessageConsumer[] = [],
	): void {
		this.cleanup?.();
		const consoleProvider = new ConsoleRuntimeProvider();
		this.consoleProvider = consoleProvider;
		const runtimeProviders = [consoleProvider, ...providers];
		const iframe = document.createElement("iframe");
		iframe.setAttribute("sandbox", "allow-scripts allow-modals");
		iframe.style.cssText = "width: 100%; height: 100%; border: none; display: block; background: white;";
		const controller = new AbortController();
		let resolveReady: () => void;
		this.ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		let settled = false;
		let loaded = false;
		let disposed = false;
		let prepared = "";
		const started: SandboxRuntimeProvider[] = [];
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveReady();
		};
		const listener = (event: MessageEvent) => {
			if (event.source !== iframe.contentWindow || disposed) return;
			const message = event.data;
			if (!message || typeof message !== "object") return;
			if (message.type === "sandbox-ready" && !loaded && this.sandboxUrlProvider) {
				if (message.channel !== undefined && message.channel !== "sitegeist-runtime") return;
				loaded = true;
				iframe.contentWindow?.postMessage(
					{ type: "sandbox-load", channel: "sitegeist-runtime", sandboxId, code: prepared },
					"*",
				);
				return;
			}
			if (message.sandboxId !== sandboxId) return;
			if (message.channel === "sitegeist-artifact-navigation" && typeof message.url === "string") {
				try {
					const url = new URL(message.url);
					if (["https:", "http:", "mailto:"].includes(url.protocol))
						window.open(url.href, "_blank", "noopener,noreferrer");
				} catch {}
				return;
			}
			if (message.channel !== "sitegeist-runtime") return;
			if (message.type === "sandbox-error") {
				this.dispatchEvent(new Event("console-update"));
				finish();
			} else if (message.type === "artifact-ready") {
				finish();
			}
		};
		const timer = setTimeout(finish, 120000);
		this.cleanup = () => {
			if (disposed) return;
			disposed = true;
			finish();
			controller.abort();
			window.removeEventListener("message", listener);
			RUNTIME_MESSAGE_ROUTER.unregisterSandbox(sandboxId);
			iframe.remove();
			for (const provider of started) {
				try {
					provider.onExecutionEnd?.(sandboxId);
				} catch (error) {
					console.error("HTML preview provider cleanup failed", error);
				}
			}
		};
		try {
			prepared = this.prepareHtmlDocument(sandboxId, html, runtimeProviders);
			RUNTIME_MESSAGE_ROUTER.registerSandbox(sandboxId, runtimeProviders, [
				...consumers,
				{
					handleMessage: async (message) => {
						if (
							["console", "console-error", "execution-error", "console-complete", "execution-complete"].includes(
								message.type,
							)
						) {
							this.dispatchEvent(new Event("console-update"));
						}
					},
				},
			]);
			for (const provider of runtimeProviders) {
				started.push(provider);
				provider.onExecutionStart?.(sandboxId, controller.signal);
			}
			window.addEventListener("message", listener);
			this.replaceChildren(iframe);
			RUNTIME_MESSAGE_ROUTER.setSandboxIframe(sandboxId, iframe);
			if (this.sandboxUrlProvider) iframe.src = this.sandboxUrlProvider();
			else iframe.srcdoc = prepared;
		} catch (error) {
			console.error("HTML artifact preview setup failed:", error instanceof Error ? error.message : String(error));
			this.cleanup();
		}
	}

	prepareHtmlDocument(
		sandboxId: string,
		html: string,
		providers: SandboxRuntimeProvider[] = [],
		options: { isStandalone?: boolean } = {},
	): string {
		const online = !options.isStandalone;
		const sandboxLiteral = JSON.stringify(sandboxId).replace(/</g, "\\u003c");
		const runtime = providers
			.map((provider) => {
				const data = Object.entries(provider.getData())
					.map(
						([key, value]) =>
							`window[${JSON.stringify(key).replace(/</g, "\\u003c")}] = JSON.parse(${JSON.stringify(JSON.stringify(value)).replace(/</g, "\\u003c")});`,
					)
					.join("\n");
				return `${data}\n(${provider.getRuntime().toString()})(${sandboxLiteral});`;
			})
			.join("\n");
		const bridge = online ? RuntimeMessageBridge.generateBridgeCode({ context: "sandbox-iframe", sandboxId }) : "";
		const navigation = online ? `(${installPreviewNavigation.toString()})(${sandboxLiteral});` : "";
		const ready = online
			? `document.addEventListener("DOMContentLoaded", () => window.parent.postMessage({ channel: "sitegeist-runtime", sandboxId: ${sandboxLiteral}, type: "artifact-ready" }, "*"), { once: true });`
			: "";
		const script = `<script>${`${bridge}\n${runtime}\n${navigation}\n${ready}`.replace(/<\/script/gi, "<\\/script")}</script>`;
		const head = /<head\b[^>]*>/i.exec(html);
		if (head)
			return `${html.slice(0, head.index + head[0].length)}${script}${html.slice(head.index + head[0].length)}`;
		const root = /<html\b[^>]*>/i.exec(html);
		if (root)
			return `${html.slice(0, root.index + root[0].length)}<head>${script}</head>${html.slice(root.index + root[0].length)}`;
		return `<!doctype html><html><head><meta charset="utf-8">${script}</head><body>${html}</body></html>`;
	}
}

customElements.define("sitegeist-html-preview", HtmlArtifactPreview);
