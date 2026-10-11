import { html, render } from "lit";
import { getToolRenderer, renderTool, setShowJsonMode } from "../../src/chat/renderers/tool-registry.js";
import type { ToolResultMessage } from "../../src/pi/models.js";
import { FileDownloadRuntimeProvider } from "../../src/sandbox/FileDownloadRuntimeProvider.js";
import { createJavaScriptReplTool, type JavaScriptReplToolResult } from "../../src/tools/javascript-repl.js";

const tool = createJavaScriptReplTool();
tool.runtimeProvidersFactory = () => [new FileDownloadRuntimeProvider()];
tool.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");

const fixture = {
	registered: !!getToolRenderer("javascript_repl"),
	description: tool.description,
	preparing() {
		render(renderTool(tool.name, undefined, undefined, true).content, document.body);
	},
	async run(code: string, isError = false) {
		const params = { title: "Generic debug output", code };
		let result: ToolResultMessage<JavaScriptReplToolResult>;
		try {
			const output = await tool.execute("generic-output", params);
			result = {
				role: "toolResult",
				toolCallId: "generic-output",
				toolName: tool.name,
				...output,
				isError,
				timestamp: 0,
			};
		} catch (error) {
			result = {
				role: "toolResult",
				toolCallId: "generic-output",
				toolName: tool.name,
				content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
				details: {},
				isError: true,
				timestamp: 0,
			};
		}
		render(html`<main class="p-6">${renderTool(tool.name, params, result).content}</main>`, document.body);
		return result;
	},
	json(enabled: boolean) {
		setShowJsonMode(enabled);
	},
};

Object.assign(window, { debugReplFixture: fixture });
