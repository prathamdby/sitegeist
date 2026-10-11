import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code } from "lucide";
import { type Static, Type } from "typebox";
import "../attachments/AttachmentTile.js";
import type { Attachment } from "../attachments/types.js";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	renderHeader,
	type ToolRenderer,
} from "../chat/renderers/tool-registry.js";
import type { AgentTool } from "../pi/agent.js";
import { SandboxIframe } from "../sandbox/SandboxIframe.js";
import type { SandboxFile, SandboxRuntimeProvider } from "../sandbox/types.js";

const javascriptReplSchema = Type.Object({
	title: Type.String({ description: "Brief active-form title describing the code's purpose" }),
	code: Type.String({ description: "JavaScript code to execute" }),
});

export type JavaScriptReplParams = Static<typeof javascriptReplSchema>;
export interface JavaScriptReplToolResult {
	files?: Array<{ fileName: string; mimeType: string; size?: number; contentBase64: string }>;
}

export async function executeJavaScript(
	code: string,
	runtimeProviders: SandboxRuntimeProvider[],
	signal?: AbortSignal,
	sandboxUrlProvider?: () => string,
): Promise<{ output: string; files?: SandboxFile[] }> {
	const sandbox = new SandboxIframe();
	sandbox.style.display = "none";
	sandbox.sandboxUrlProvider = sandboxUrlProvider;
	document.body.appendChild(sandbox);
	try {
		const result = await sandbox.execute(`repl-${crypto.randomUUID()}`, code, runtimeProviders, [], signal);
		let output = result.console.map((entry) => `${entry.text}\n`).join("");
		if (!result.success) {
			throw new Error(
				`${output}${output ? "\n" : ""}Error: ${result.error?.message || "Unknown error"}\n${result.error?.stack || ""}`.trim(),
			);
		}
		if (result.returnValue !== undefined) {
			output += `${output ? "\n" : ""}=> ${typeof result.returnValue === "object" ? JSON.stringify(result.returnValue, null, 2) : String(result.returnValue)}`;
		}
		if (result.files?.length) {
			output += `\n[Files returned: ${result.files.length}]\n`;
			output += result.files.map((file) => `  - ${file.fileName} (${file.mimeType})\n`).join("");
		} else if (code.includes("returnFile")) {
			output += "\n[No files returned - check async operations]";
		}
		return { output: output.trim() || "Code executed successfully (no output)", files: result.files };
	} finally {
		sandbox.remove();
	}
}

export function createJavaScriptReplTool(): AgentTool<typeof javascriptReplSchema, JavaScriptReplToolResult> & {
	runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
	sandboxUrlProvider?: () => string;
} {
	const tool: AgentTool<typeof javascriptReplSchema, JavaScriptReplToolResult> & {
		runtimeProvidersFactory?: () => SandboxRuntimeProvider[];
		sandboxUrlProvider?: () => string;
	} = {
		name: "javascript_repl",
		label: "JavaScript REPL",
		parameters: javascriptReplSchema,
		get description() {
			return `# JavaScript REPL
Execute JavaScript in an isolated browser sandbox for calculations, data processing, and artifact creation.
Use async/await and browser APIs, including DOM, Canvas, Fetch, and dynamic URL-based package imports.
Globals do not persist between calls. Use the available artifact helpers to save intermediate results.
Console output, return values, errors, and returned files are captured. Use fixed dimensions for graphics;
disable responsive sizing and animation when rendering charts.

## Input
- title: a brief active-form description of the task
- code: JavaScript to execute; use an explicit return for the result

## Available runtime helpers
${(tool.runtimeProvidersFactory?.() ?? []).map((provider) => provider.getDescription()).join("\n\n")}`;
		},
		async execute(_toolCallId, params, signal) {
			const result = await executeJavaScript(
				params.code,
				tool.runtimeProvidersFactory?.() ?? [],
				signal,
				tool.sandboxUrlProvider,
			);
			const files = (result.files ?? []).map((file) => {
				const bytes = typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content;
				let binary = "";
				for (let offset = 0; offset < bytes.length; offset += 32768) {
					binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
				}
				return {
					fileName: file.fileName,
					mimeType: file.mimeType,
					size: bytes.byteLength,
					contentBase64: btoa(binary),
				};
			});
			return { content: [{ type: "text", text: result.output }], details: { files } };
		},
	};
	return tool;
}

export const javascriptReplRenderer: ToolRenderer<JavaScriptReplParams, JavaScriptReplToolResult> = {
	render(params, result, isStreaming = false) {
		const state = result?.isError ? "error" : !result && isStreaming ? "inprogress" : "complete";
		if (!params) {
			return { isCustom: false, content: renderHeader(state, Code, "Preparing JavaScript...") };
		}
		const contentRef = createRef<HTMLElement>();
		const chevronRef = createRef<HTMLElement>();
		const files: Attachment[] = (result?.details?.files ?? []).map((file, index) => {
			let extractedText: string | undefined;
			if (/^(text\/|application\/(json|javascript))|xml/.test(file.mimeType)) {
				try {
					extractedText = new TextDecoder().decode(
						Uint8Array.from(atob(file.contentBase64), (c) => c.charCodeAt(0)),
					);
				} catch {}
			}
			return {
				id: `${result?.toolCallId}-${index}`,
				type: file.mimeType.startsWith("image/") ? "image" : "document",
				fileName: file.fileName,
				mimeType: file.mimeType,
				size: file.size ?? 0,
				content: file.contentBase64,
				preview: file.mimeType.startsWith("image/") ? file.contentBase64 : undefined,
				extractedText,
			};
		});
		const output = result?.content.find((block) => block.type === "text")?.text ?? "";
		return {
			isCustom: false,
			content: html`<div>${renderCollapsibleHeader(state, Code, params.title || "Executing JavaScript", contentRef, chevronRef)}<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3"><code-block language="javascript" .code=${params.code || ""}></code-block>${output ? html`<sitegeist-console-block .content=${output} .variant=${result?.isError ? "error" : "default"}></sitegeist-console-block>` : ""}</div>${files.length ? html`<div class="flex flex-wrap gap-2 mt-3">${files.map((attachment) => html`<attachment-tile .attachment=${attachment}></attachment-tile>`)}</div>` : ""}</div>`,
		};
	},
};

registerToolRenderer("javascript_repl", javascriptReplRenderer);
