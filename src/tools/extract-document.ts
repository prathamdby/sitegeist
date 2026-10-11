import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileText } from "lucide";
import { type Static, Type } from "typebox";
import { loadAttachment } from "../attachments/processing.js";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "../chat/renderers/tool-registry.js";
import type { AgentTool } from "../pi/agent.js";
import type { ToolResultMessage } from "../pi/models.js";

const extractDocumentSchema = Type.Object({
	url: Type.String({ description: "URL of the document to extract text from (PDF, DOCX, XLSX, or PPTX)" }),
});

export type ExtractDocumentParams = Static<typeof extractDocumentSchema>;

export interface ExtractDocumentResult {
	extractedText: string;
	format: string;
	fileName: string;
	size: number;
}

const manualDownload =
	"INSTRUCT USER: Please download the file manually and attach it to your message using the attachment button (paperclip icon) in the message input area. I can then extract the text from the attached file.";
const maxSize = 50 * 1024 * 1024;

export function createExtractDocumentTool(): AgentTool<typeof extractDocumentSchema, ExtractDocumentResult> & {
	corsProxyUrl?: string;
} {
	const tool: AgentTool<typeof extractDocumentSchema, ExtractDocumentResult> & { corsProxyUrl?: string } = {
		name: "extract_document",
		label: "Extract Document",
		description: `# Extract Document

Extract plain text from documents on the web (PDF, DOCX, XLSX, PPTX).

## When to Use
User wants you to read a document at a URL.

## Input
- { url: "https://example.com/document.pdf" } - URL to PDF, DOCX, XLSX, or PPTX

## Returns
Structured plain text with page/sheet/slide delimiters.`,
		parameters: extractDocumentSchema,
		async execute(_toolCallId, params, signal) {
			if (!params.url) throw new Error("URL is required");
			let url: URL;
			try {
				url = new URL(params.url);
			} catch {
				throw new Error(`Invalid URL: ${params.url}`);
			}
			if (signal?.aborted) throw new Error("Extract document aborted");
			let response: Response;
			try {
				response = await fetch(params.url, { signal });
			} catch (error) {
				if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
				if (!(error instanceof Error && /cors|failed to fetch/i.test(error.message))) {
					throw error;
				}
				if (!tool.corsProxyUrl) {
					throw new Error(
						'TELL USER: Unable to fetch the document due to CORS restrictions (the server blocks requests from browser extensions).\n\nTo fix this, you need to configure a CORS proxy in Sitegeist settings:\n1. Open Sitegeist settings\n2. Find "CORS Proxy URL" setting\n3. Enter a proxy URL like: https://corsproxy.io/?\n4. Save and try again\n\nAlternatively, download the file manually and attach it to your message using the attachment button (paperclip icon).',
					);
				}
				try {
					response = await fetch(tool.corsProxyUrl + encodeURIComponent(params.url), { signal });
				} catch (proxyError) {
					if (signal?.aborted || (proxyError instanceof Error && proxyError.name === "AbortError"))
						throw proxyError;
					throw new Error(
						`TELL USER: Unable to fetch the document due to CORS restrictions.\n\nTried with proxy but it also failed: ${proxyError instanceof Error ? proxyError.message : String(proxyError)}\n\n${manualDownload}`,
					);
				}
			}
			if (!response.ok) {
				throw new Error(
					`TELL USER: Unable to download the document (${response.status} ${response.statusText}). The site likely blocks automated downloads.\n\n${manualDownload}`,
				);
			}
			const checkSize = (size: number) => {
				if (size > maxSize) {
					throw new Error(
						`Document is too large (${(size / 1024 / 1024).toFixed(1)}MB). Maximum supported size is 50MB.`,
					);
				}
			};
			checkSize(Number(response.headers.get("content-length")));
			const bytes = await response.arrayBuffer();
			if (signal?.aborted) throw new Error("Extract document aborted");
			checkSize(bytes.byteLength);
			const fileName = url.pathname.split("/").pop() || "document";
			const attachment = await loadAttachment(bytes, fileName);
			if (signal?.aborted) throw new Error("Extract document aborted");
			if (!attachment.extractedText) {
				throw new Error(
					"Document format not supported. Supported formats:\n- PDF (.pdf)\n- Word (.docx)\n- Excel (.xlsx, .xls)\n- PowerPoint (.pptx)",
				);
			}
			const format = attachment.mimeType.includes("pdf")
				? "pdf"
				: attachment.mimeType.includes("wordprocessingml")
					? "docx"
					: attachment.mimeType.includes("presentationml")
						? "pptx"
						: attachment.mimeType.includes("spreadsheetml") || attachment.mimeType === "application/vnd.ms-excel"
							? "xlsx"
							: "unknown";
			return {
				content: [{ type: "text", text: attachment.extractedText }],
				details: { extractedText: attachment.extractedText, format, fileName, size: attachment.size },
			};
		},
	};
	return tool;
}

export const extractDocumentTool = createExtractDocumentTool();

export const extractDocumentRenderer: ToolRenderer<ExtractDocumentParams, ExtractDocumentResult> = {
	render(
		params: ExtractDocumentParams | undefined,
		result: ToolResultMessage<ExtractDocumentResult> | undefined,
		isStreaming = false,
	): ToolRenderResult {
		const state = result?.isError ? "error" : isStreaming && !result ? "inprogress" : "complete";
		if (!params) {
			return { isCustom: false, content: renderHeader(state, FileText, "Preparing extraction...") };
		}
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();
		const details = result?.details;
		const label = result?.isError
			? "Failed to extract document"
			: details
				? `Extracted text from ${details.fileName} (${details.format.toUpperCase()}, ${(details.size / 1024).toFixed(1)}KB)`
				: "Extracting document...";
		return {
			isCustom: false,
			content: html`<div>${renderCollapsibleHeader(state, FileText, label, contentRef, chevronRef)}<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">${params.url ? html`<div class="text-sm text-gray-600 dark:text-gray-400"><strong>URL:</strong> ${params.url}</div>` : ""}${details?.extractedText ? html`<code-block language="plaintext" .code=${details.extractedText}></code-block>` : ""}${
				result?.isError
					? html`<sitegeist-console-block .content=${result.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n")} variant="error"></sitegeist-console-block>`
					: ""
			}</div></div>`,
		};
	},
};

registerToolRenderer("extract_document", extractDocumentRenderer);
