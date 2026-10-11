import type { LitElement, TemplateResult } from "lit";
import { render } from "lit";
import "../../src/utils/i18n-extension.js";
import type { ArtifactsParams } from "../../src/artifacts/ArtifactsState.js";
import type { ToolResultMessage } from "../../src/pi/models.js";

export interface ArtifactPanelFixture extends LitElement {
	artifacts: Map<string, { filename: string; content: string; createdAt: Date; updatedAt: Date }>;
	tool: { execute(id: string, params: ArtifactsParams): Promise<unknown> };
	openArtifact(filename: string): void;
	reconstructFromMessages(messages: never[]): Promise<void>;
	onOpen?: () => void;
	onClose?: () => void;
	onArtifactsChange?: () => void;
	collapsed: boolean;
	overlay: boolean;
}

export function installArtifactsFixture<T extends ArtifactPanelFixture>(
	Panel: new () => T,
	renderer?: (
		params: Partial<ArtifactsParams> | undefined,
		result: ToolResultMessage<undefined> | undefined,
		streaming: boolean,
		panel: T,
	) => TemplateResult,
): void {
	document.body.style.cssText = "margin:0;height:100vh;width:100vw;overflow:hidden";
	const panel = new Panel();
	panel.style.cssText = "display:block;width:100%;height:100%";
	document.body.append(panel);
	const fixture = {
		panel,
		opened: 0,
		closed: 0,
		changed: 0,
		async command(params: ArtifactsParams) {
			try {
				const result = await panel.tool.execute("fixture", params);
				await panel.updateComplete;
				return result;
			} catch (error) {
				return { thrown: error instanceof Error ? error.message : String(error) };
			}
		},
		async reconstruct(messages: never[]) {
			await panel.reconstructFromMessages(messages);
			await panel.updateComplete;
		},
		state() {
			return {
				artifacts: [...panel.artifacts].map(([filename, artifact]) => ({ filename, content: artifact.content })),
				opened: fixture.opened,
				closed: fixture.closed,
				changed: fixture.changed,
			};
		},
		renderTool(
			params: Partial<ArtifactsParams> | undefined,
			result: ToolResultMessage<undefined> | undefined,
			streaming = false,
		) {
			if (!renderer) return;
			let host = document.getElementById("tool-renderer");
			if (!host) {
				host = document.createElement("div");
				host.id = "tool-renderer";
				document.body.append(host);
			}
			render(renderer(params, result, streaming, panel), host);
		},
	};
	panel.onOpen = () => fixture.opened++;
	panel.onClose = () => fixture.closed++;
	panel.onArtifactsChange = () => fixture.changed++;
	window.artifactsFixture = fixture;
	document.body.dataset.artifactsReady = "true";
}

declare global {
	interface Window {
		artifactsFixture: {
			panel: ArtifactPanelFixture;
			opened: number;
			closed: number;
			changed: number;
			command(params: ArtifactsParams): Promise<unknown>;
			reconstruct(messages: never[]): Promise<void>;
			state(): unknown;
			renderTool(
				params: Partial<ArtifactsParams> | undefined,
				result: ToolResultMessage<undefined> | undefined,
				streaming?: boolean,
			): void;
		};
	}
}
