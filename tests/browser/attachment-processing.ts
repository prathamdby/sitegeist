import { render } from "lit";
import { GlobalWorkerOptions } from "pdfjs-dist";
import { loadAttachment, loadPdfDocument } from "../../src/attachments/processing.js";
import { getToolRenderer } from "../../src/chat/renderers/tool-registry.js";
import { createExtractDocumentTool, extractDocumentRenderer } from "../../src/tools/extract-document.js";

let pdfController: AbortController | undefined;
let pdfStartupResult: { name: string; message: string } | undefined;
const pdfWorkerCounts = { created: 0, terminated: 0 };

const fixture = {
	workerSrc: GlobalWorkerOptions.workerSrc,
	registered: getToolRenderer("extract_document") === extractDocumentRenderer,
	async load(name: string, mode: "bytes" | "file" | "blob" | "url" = "bytes", mimeType = "") {
		const bytes = await (await fetch(`/files/${name}`)).arrayBuffer();
		const source =
			mode === "file"
				? new File([bytes], name, { type: mimeType })
				: mode === "blob"
					? new Blob([bytes], { type: mimeType })
					: mode === "url"
						? `${location.origin}/files/${name}`
						: bytes;
		return loadAttachment(source, mode === "file" || mode === "url" ? undefined : name);
	},
	async raw(text: string, name?: string, mimeType?: string) {
		return loadAttachment(
			mimeType === undefined ? new TextEncoder().encode(text).buffer : new Blob([text], { type: mimeType }),
			name,
		);
	},
	async tool(name: string) {
		return createExtractDocumentTool().execute("fixture", {
			url: `${location.origin}/files/${name}`,
		});
	},
	async simulate(scenario: string, url = "https://example.test/sample.txt", proxy?: string) {
		const originalFetch = window.fetch;
		const calls: { url: string; signal: boolean }[] = [];
		const controller = new AbortController();
		if (scenario === "preabort") controller.abort();
		window.fetch = async (input, init) => {
			calls.push({ url: String(input), signal: init?.signal === controller.signal });
			if (scenario === "http") return new Response("blocked", { status: 403, statusText: "Forbidden" });
			if (scenario === "ordinary") throw new Error("Network fixture failure");
			if (scenario === "type-error") throw new TypeError("Network fixture failure");
			if (scenario === "cors-error") throw new Error("CORS blocked");
			if (scenario === "cors" || (scenario === "proxy-ok" && calls.length === 1))
				throw new TypeError("Failed to fetch");
			if (scenario === "fetch-abort" || (scenario === "proxy-abort" && calls.length === 2)) {
				throw new DOMException("Fixture aborted", "AbortError");
			}
			if (scenario === "proxy-abort") throw new TypeError("Failed to fetch");
			if (scenario === "signal-abort") {
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new DOMException("Fixture aborted", "AbortError")));
					queueMicrotask(() => controller.abort());
				});
			}
			if (scenario === "body-abort") {
				return {
					ok: true,
					headers: new Headers(),
					async arrayBuffer() {
						controller.abort();
						return new TextEncoder().encode("hello").buffer;
					},
				} as Response;
			}
			if (scenario === "actual-size") {
				return {
					ok: true,
					headers: new Headers({ "Content-Length": "1" }),
					async arrayBuffer() {
						return new ArrayBuffer(50 * 1024 * 1024 + 1);
					},
				} as Response;
			}
			return new Response(scenario === "empty" ? "" : "hello", {
				headers: {
					"Content-Type": "text/plain",
					...(scenario === "header-size" ? { "Content-Length": String(51 * 1024 * 1024) } : {}),
					...(scenario === "boundary-size" ? { "Content-Length": String(50 * 1024 * 1024) } : {}),
				},
			});
		};
		const tool = createExtractDocumentTool();
		tool.corsProxyUrl = proxy;
		try {
			return { result: await tool.execute("fixture", { url }, controller.signal), calls };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error), calls };
		} finally {
			window.fetch = originalFetch;
		}
	},
	async mutableProxy() {
		const originalFetch = window.fetch;
		const calls: string[] = [];
		window.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://example.test")) throw new TypeError("Failed to fetch");
			return new Response("hello");
		};
		const tool = createExtractDocumentTool();
		try {
			for (const proxy of ["https://first.test/?url=", "https://second.test/?url="]) {
				tool.corsProxyUrl = proxy;
				await tool.execute("fixture", { url: "https://example.test/sample.txt" });
			}
			return calls;
		} finally {
			window.fetch = originalFetch;
		}
	},
	async pdfLifecycle() {
		const bytes = await (await fetch("/files/sample.pdf")).arrayBuffer();
		const [first, second] = await Promise.all([loadPdfDocument(bytes), loadPdfDocument(new Uint8Array(bytes))]);
		const pages = [first.document.numPages, second.document.numPages];
		await first.destroy();
		const text = await (await second.document.getPage(2)).getTextContent();
		await first.destroy();
		await second.destroy();
		return {
			pages,
			byteLength: bytes.byteLength,
			text: text.items.map((item) => ("str" in item ? item.str : "")).join(" "),
		};
	},
	async startPdfLoad(preaborted = false) {
		const bytes = await (await fetch("/files/sample.pdf")).arrayBuffer();
		pdfController = new AbortController();
		pdfStartupResult = undefined;
		if (preaborted) pdfController.abort();
		void loadPdfDocument(bytes, pdfController.signal).then(
			async (loaded) => {
				await loaded.destroy();
				pdfStartupResult = { name: "complete", message: "Loaded" };
			},
			(error: Error) => {
				pdfStartupResult = { name: error.name, message: error.message };
			},
		);
	},
	abortPdfLoad() {
		pdfController?.abort();
	},
	get pdfStartupResult() {
		return pdfStartupResult;
	},
	async renamedDocument(sourceName: string, fileName: string) {
		const bytes = await (await fetch(`/files/${sourceName}`)).arrayBuffer();
		const attachment = await loadAttachment(bytes, fileName);
		return { mimeType: attachment.mimeType, extractedText: attachment.extractedText };
	},
	async emptyOrMislabeled(fileName: string, text = "", mimeType?: string) {
		try {
			const attachment = await loadAttachment(
				mimeType === undefined ? new TextEncoder().encode(text).buffer : new Blob([text], { type: mimeType }),
				fileName,
			);
			return {
				mimeType: attachment.mimeType,
				type: attachment.type,
				size: attachment.size,
				content: attachment.content,
				extractedText: attachment.extractedText,
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	},
	async headerlessDocument(url: string, oversized = false) {
		const bytes = oversized ? undefined : await (await fetch("/files/sample.pdf")).arrayBuffer();
		const originalFetch = window.fetch;
		let bodyReads = 0;
		window.fetch = async () =>
			({
				ok: true,
				headers: new Headers({ "Content-Type": "application/pdf" }),
				async arrayBuffer() {
					bodyReads++;
					return oversized ? new ArrayBuffer(50 * 1024 * 1024 + 1) : bytes!;
				},
			}) as Response;
		try {
			return {
				result: await createExtractDocumentTool().execute("fixture", { url }),
				bodyReads,
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error), bodyReads };
		} finally {
			window.fetch = originalFetch;
		}
	},
	async unrestrictedUrl(url: string) {
		const originalFetch = window.fetch;
		const calls: string[] = [];
		window.fetch = async (input) => {
			calls.push(String(input));
			return new Response("Fixture URL text", { headers: { "Content-Type": "text/plain" } });
		};
		try {
			return {
				result: await createExtractDocumentTool().execute("fixture", { url }),
				calls,
			};
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error), calls };
		} finally {
			window.fetch = originalFetch;
		}
	},
	pdfWorkerCounts,
	trackPdfWorkers() {
		const NativeWorker = window.Worker;
		window.Worker = class extends NativeWorker {
			constructor(url: string | URL, options?: WorkerOptions) {
				super(url, options);
				pdfWorkerCounts.created++;
			}
			override terminate() {
				pdfWorkerCounts.terminated++;
				super.terminate();
			}
		};
	},
	async show(state: "preparing" | "extracting" | "streaming" | "complete" | "error") {
		const result =
			state === "complete" || state === "error"
				? {
						role: "toolResult" as const,
						toolCallId: "fixture",
						toolName: "extract_document",
						timestamp: 1,
						content: [
							{ type: "text" as const, text: state === "error" ? "Fixture error" : "Fixture extracted text" },
						],
						isError: state === "error",
						...(state === "complete"
							? {
									details: {
										fileName: "sample.pdf",
										format: "pdf",
										size: 1024,
										extractedText: "Fixture extracted text",
									},
								}
							: {}),
					}
				: undefined;
		const renderer = extractDocumentRenderer;
		const rendered = renderer.render(
			state === "preparing" ? undefined : { url: "https://example.test/sample.pdf" },
			result,
			state === "streaming",
		);
		render(null, document.querySelector("#render")!);
		render(rendered.content, document.querySelector("#render")!);
		await Promise.all(
			Array.from(
				document.querySelectorAll("code-block,console-block,sitegeist-console-block"),
				(element) => (element as HTMLElement & { updateComplete: Promise<boolean> }).updateComplete,
			),
		);
		return { isCustom: rendered.isCustom };
	},
};

declare global {
	interface Window {
		attachmentProcessingFixture: typeof fixture;
	}
}
window.attachmentProcessingFixture = fixture;
