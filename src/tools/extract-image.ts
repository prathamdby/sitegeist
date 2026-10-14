import { html } from "lit";
import { Image as ImageIcon } from "lucide";
import { type Static, Type } from "typebox";
import { isTabScopeEnabled, resolveActingTab } from "../browser/session-tabs.js";
import {
	registerToolRenderer,
	renderHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "../chat/renderers/index.js";
import type { AgentTool, AgentToolResult } from "../pi/agent.js";
import type { ImageContent, TextContent, ToolResultMessage } from "../pi/models.js";

const EXTRACT_IMAGE_DESCRIPTION = `Extract images from the current page. Returns image data that you can see and analyze.

Modes:
- selector: Extract an image matching a CSS selector (e.g. "img.hero", "#logo", "img:nth-child(2)")
- screenshot: Capture the visible area of the current tab`;

const extractImageSchema = Type.Object({
	mode: Type.Union([Type.Literal("selector"), Type.Literal("screenshot")], {
		description: "How to extract: 'selector' for a specific image, 'screenshot' for visible tab",
	}),
	selector: Type.Optional(
		Type.String({ description: "CSS selector for the image element (required for 'selector' mode)" }),
	),
	maxWidth: Type.Optional(
		Type.Number({ description: "Max width to resize image to (default 800). Reduces token usage." }),
	),
});

type ExtractImageParams = Static<typeof extractImageSchema>;

interface ExtractImageDetails {
	mode: string;
	selector?: string;
}

/**
 * Get image info from the page via userScripts.
 * Only reads the src/currentSrc URL or data URL from the DOM.
 * Does NOT try to draw or fetch anything in page context.
 */
async function getImageInfoFromPage(
	tabId: number,
	selector: string,
): Promise<{ src: string; width: number; height: number } | string> {
	const code = `(async () => {
		const sel = ${JSON.stringify(selector)};
		const el = document.querySelector(sel);
		if (!el) return { success: false, error: 'No element found for selector: ' + sel };

		if (el instanceof HTMLImageElement) {
			if (!el.complete) {
				await new Promise((resolve, reject) => {
					el.onload = resolve;
					el.onerror = () => reject(new Error('Image failed to load'));
					setTimeout(() => reject(new Error('Image load timeout')), 10000);
				});
			}
			const src = el.currentSrc || el.src;
			if (!src) return { success: false, error: 'Image has no src' };
			return { success: true, src, width: el.naturalWidth, height: el.naturalHeight };
		}

		if (el instanceof HTMLCanvasElement) {
			try {
				const dataUrl = el.toDataURL('image/png');
				return { success: true, src: dataUrl, width: el.width, height: el.height };
			} catch (e) {
				return { success: false, error: 'Cannot read canvas: ' + e.message };
			}
		}

		// Check for background-image
		const bg = getComputedStyle(el).backgroundImage;
		if (bg && bg !== 'none') {
			const match = bg.match(/url\\(["']?(.+?)["']?\\)/);
			if (match) return { success: true, src: match[1], width: 0, height: 0 };
		}

		return { success: false, error: 'Element <' + el.tagName.toLowerCase() + '> is not an image, canvas, or element with background-image' };
	})()`;

	try {
		await chrome.userScripts.configureWorld({
			worldId: "sitegeist-extract-image",
			messaging: true,
		});
	} catch {
		// Already configured
	}

	const results = await chrome.userScripts.execute({
		js: [{ code }],
		target: { tabId, allFrames: false },
		world: "USER_SCRIPT",
		worldId: "sitegeist-extract-image",
		injectImmediately: true,
	} as any);

	const result = (results as any)?.[0]?.result;
	if (!result) return "Failed to execute script in page";
	if (!result.success) return result.error;
	return { src: result.src, width: result.width || 0, height: result.height || 0 };
}

/**
 * Fetch an image URL from the extension context (has host_permissions),
 * resize it, and return as base64 ImageContent.
 */
async function fetchAndResizeImage(src: string, maxWidth: number): Promise<ImageContent> {
	let blob: Blob;

	if (src.startsWith("data:")) {
		const response = await fetch(src);
		blob = await response.blob();
	} else {
		const response = await fetch(src);
		if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
		blob = await response.blob();
	}

	const img = await createImageBitmap(blob);
	let w = img.width;
	let h = img.height;

	if (w > maxWidth) {
		h = Math.round(h * (maxWidth / w));
		w = maxWidth;
	}

	const canvas = new OffscreenCanvas(w, h);
	const ctx = canvas.getContext("2d")!;
	ctx.drawImage(img, 0, 0, w, h);

	const outBlob = await canvas.convertToBlob({ type: "image/png" });
	const reader = new FileReader();
	const base64 = await new Promise<string>((resolve) => {
		reader.onload = () => resolve((reader.result as string).split(",")[1]);
		reader.readAsDataURL(outBlob);
	});

	return { type: "image", data: base64, mimeType: "image/png" };
}

async function captureScreenshot(maxWidth: number, windowId: number): Promise<ImageContent> {
	const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	return fetchAndResizeImage(dataUrl, maxWidth);
}

/**
 * Capture an inactive owned tab via the debugger protocol. Attaches,
 * captures a screenshot, and always detaches. Used only when tab scope is
 * on and the acting tab is not the visible tab of its window, so the agent
 * never receives pixels from a foreign tab.
 */
async function captureInactiveTabViaDebugger(tabId: number, maxWidth: number): Promise<ImageContent> {
	try {
		await chrome.debugger.attach({ tabId }, "1.3");
	} catch (err) {
		if (!(err instanceof Error) || !err.message?.includes("already attached")) {
			throw err;
		}
	}
	try {
		const result = (await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
			format: "png",
		})) as { data?: string };
		if (!result?.data) {
			throw new Error("Debugger capture returned no image data");
		}
		return fetchAndResizeImage(`data:image/png;base64,${result.data}`, maxWidth);
	} finally {
		await chrome.debugger.detach({ tabId }).catch(() => {});
	}
}

export class ExtractImageTool implements AgentTool<typeof extractImageSchema, ExtractImageDetails> {
	name = "extract_image";
	label = "Extract Image";
	description = EXTRACT_IMAGE_DESCRIPTION;
	parameters = extractImageSchema;
	windowId?: number;

	async execute(
		_toolCallId: string,
		args: ExtractImageParams,
		_signal?: AbortSignal,
	): Promise<AgentToolResult<ExtractImageDetails>> {
		const maxWidth = args.maxWidth || 800;
		const content: (TextContent | ImageContent)[] = [];
		const details: ExtractImageDetails = { mode: args.mode, selector: args.selector };

		if (args.mode === "screenshot") {
			if (!this.windowId) throw new Error("windowId not set on ExtractImageTool");
			if (await isTabScopeEnabled()) {
				// Act on the session's acting tab. Never capture a foreign
				// visible tab: capture the acting tab directly, via debugger
				// when it is not the visible tab of its window.
				const acting = await resolveActingTab();
				if (acting.id === undefined) throw new Error("No acting tab");
				const [visible] = await chrome.tabs.query({ active: true, windowId: acting.windowId });
				if (visible?.id === acting.id) {
					const image = await captureScreenshot(maxWidth, acting.windowId);
					content.push(image);
				} else {
					const image = await captureInactiveTabViaDebugger(acting.id, maxWidth);
					content.push(image);
				}
			} else {
				const image = await captureScreenshot(maxWidth, this.windowId);
				content.push(image);
			}
			content.push({ type: "text", text: `Screenshot captured (max ${maxWidth}px width)` });
		} else if (args.mode === "selector") {
			if (!args.selector) throw new Error("selector is required for 'selector' mode");
			const tab = (await isTabScopeEnabled())
				? await resolveActingTab()
				: (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
			if (!tab?.id) throw new Error("No active tab");

			const info = await getImageInfoFromPage(tab.id, args.selector);
			if (typeof info === "string") throw new Error(info);

			const image = await fetchAndResizeImage(info.src, maxWidth);
			content.push(image);
			content.push({
				type: "text",
				text: `Image extracted from "${args.selector}" (${info.width}x${info.height}, resized to max ${maxWidth}px)`,
			});
		}

		return { content, details };
	}
}

// Renderer
const extractImageRenderer: ToolRenderer<ExtractImageParams, ExtractImageDetails> = {
	render(
		params: ExtractImageParams | undefined,
		result: ToolResultMessage<ExtractImageDetails> | undefined,
	): ToolRenderResult {
		const mode = params?.mode || "unknown";
		const selector = params?.selector || "";
		const label = mode === "screenshot" ? "Screenshot" : `Image: ${selector}`;
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";

		const hasImage = result?.content?.some((c) => c.type === "image");

		return {
			content: html`
				${renderHeader(state, ImageIcon, label)}
				${
					hasImage
						? html`<div class="p-2">
							${result?.content
								?.filter((c) => c.type === "image")
								.map(
									(c) =>
										html`<img
											src="data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}"
											class="max-w-full rounded"
										/>`,
								)}
						</div>`
						: ""
				}
			`,
			isCustom: false,
		};
	},
};

export function registerExtractImageRenderer() {
	registerToolRenderer("extract_image", extractImageRenderer);
}
