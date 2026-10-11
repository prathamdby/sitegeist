import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { i18n, icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { X } from "lucide";
import { AttachmentsRuntimeProvider } from "../attachments/AttachmentsRuntimeProvider.js";
import type { Agent } from "../pi/agent.js";
import type { SandboxRuntimeProvider } from "../sandbox/types.js";
import { ArtifactsRuntimeProvider } from "./ArtifactsRuntimeProvider.js";
import { type ArtifactResult, ArtifactsState, artifactsParamsSchema } from "./ArtifactsState.js";
import { ArtifactView, artifactKind } from "./views/ArtifactView.js";

export type { Artifact, ArtifactsParams } from "./ArtifactsState.js";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages {
		"Close artifacts": string;
	}
}

@customElement("artifacts-panel")
export class ArtifactsPanel extends LitElement {
	private readonly store = new ArtifactsState();
	private readonly views = new Map<string, ArtifactView>();
	private readonly contentRef = createRef<HTMLElement>();
	@state() private activeFilename = "";
	@property({ type: Boolean }) collapsed = false;
	@property({ type: Boolean }) overlay = false;
	agent?: Agent;
	sandboxUrlProvider?: () => string;
	onArtifactsChange?: () => void;
	onClose?: () => void;
	onOpen?: () => void;

	get artifacts() {
		return this.store.artifacts;
	}
	protected override createRenderRoot() {
		return this;
	}

	private providers(): SandboxRuntimeProvider[] {
		const attachments =
			this.agent?.state.messages.flatMap((message) =>
				message.role === "user-with-attachments" ? (message.attachments ?? []) : [],
			) ?? [];
		return [new AttachmentsRuntimeProvider(attachments), new ArtifactsRuntimeProvider(this, this.agent, false)];
	}

	private view(filename: string): ArtifactView | undefined {
		const artifact = this.artifacts.get(filename);
		if (!artifact) return;
		let view = this.views.get(filename);
		if (!view) {
			view = new ArtifactView();
			view.filename = filename;
			view.kind = artifactKind(filename);
			view.runtimeProvidersFactory = () => this.providers();
			view.addEventListener("artifact-view-change", () => this.requestUpdate());
			this.views.set(filename, view);
		}
		view.sandboxUrlProvider = this.sandboxUrlProvider;
		view.content = artifact.content;
		return view;
	}

	openArtifact(filename: string): void {
		if (!this.artifacts.has(filename)) return;
		this.activeFilename = filename;
		this.onOpen?.();
	}

	get tool(): AgentTool<typeof artifactsParamsSchema, undefined> {
		return {
			name: "artifacts",
			label: "Artifacts",
			parameters: artifactsParamsSchema,
			description: `Create and manage persistent files alongside the conversation. Use this tool to author notes, analysis, Markdown, HTML applications, SVG, text, code and data. Use REPL artifact storage helpers when code processes data or generates binary PDF, DOCX, Excel or image files.

Commands: create(filename, content), update(filename, old_str, new_str), rewrite(filename, content), get(filename), delete(filename), logs(filename). Prefer targeted update over rewriting the entire file. Update replaces the first occurrence of old_str. Binary file content is base64.

HTML artifacts are self-contained interactive documents in an isolated sandbox. Set a background color and use responsive layouts. ES modules from esm.sh and Tailwind CDN are supported. No localStorage/sessionStorage. Artifacts can read other artifacts and user attachments but cannot create or modify them. Downloads embed snapshots for standalone offline use.

${this.providers()
	.map((provider) => provider.getDescription())
	.join("\n")}`,
			execute: async (_id, params): Promise<ArtifactResult> => {
				const started = Date.now();
				if (params.command === "logs") {
					if (!this.artifacts.has(params.filename)) return this.store.execute({ ...params, command: "get" });
					if (artifactKind(params.filename) !== "html")
						return {
							content: [
								{
									type: "text",
									text: `Error: File ${params.filename} is not an HTML file. Logs are only available for HTML files.`,
								},
							],
							details: undefined,
							isError: true,
						};
					const view = this.view(params.filename);
					await this.updateComplete;
					await view?.updateComplete;
					await view?.ready;
					return {
						content: [{ type: "text", text: view?.getLogs() || `No logs for ${params.filename}` }],
						details: undefined,
					};
				}
				const result = this.store.execute(params);
				if (result.isError || params.command === "get") return result;
				if (params.command === "delete") {
					this.views.get(params.filename)?.remove();
					this.views.delete(params.filename);
					if (this.activeFilename === params.filename)
						this.activeFilename = this.artifacts.keys().next().value ?? "";
				} else this.activeFilename = params.filename;
				this.requestUpdate();
				this.onArtifactsChange?.();
				await this.updateComplete;
				for (const view of this.views.values()) {
					if (view.kind === "html" && view.filename !== params.filename) await view.reload();
				}
				const view = this.views.get(params.filename);
				await view?.updateComplete;
				await view?.ready;
				if (view?.kind === "html") {
					await new Promise((resolve) => setTimeout(resolve, Math.max(0, 1500 - (Date.now() - started))));
					const logs = view.getLogs() || `No logs for ${params.filename}`;
					if (result.content[0]?.type === "text") result.content[0].text += `\n${logs}`;
				}
				return result;
			},
		};
	}

	async reconstructFromMessages(messages: Array<AgentMessage | { role: "aborted" }>): Promise<void> {
		for (const view of this.views.values()) view.remove();
		this.views.clear();
		this.store.reconstruct(messages);
		this.activeFilename = this.artifacts.keys().next().value ?? "";
		this.requestUpdate();
		this.onArtifactsChange?.();
		await this.updateComplete;
	}

	protected override updated(): void {
		const container = this.contentRef.value;
		if (!container) return;
		for (const filename of this.artifacts.keys()) {
			const view = this.view(filename);
			if (!view) continue;
			view.style.cssText = `display: ${filename === this.activeFilename ? "block" : "none"}; height: 100%;`;
			if (view.parentElement !== container) container.append(view);
		}
	}

	override render() {
		const active = this.view(this.activeFilename);
		return html`<div class="${this.collapsed ? "hidden" : ""} ${this.overlay ? "fixed inset-0 z-40 pointer-events-auto backdrop-blur-sm bg-background/95" : "relative"} h-full flex flex-col bg-background text-card-foreground ${this.overlay ? "" : "border-l border-border"} overflow-hidden shadow-xl">
			${
				this.artifacts.size
					? html`<div class="flex items-center justify-between border-b border-border bg-background"><div class="flex overflow-x-auto">${[
							...this.artifacts.keys(),
						].map(
							(filename) =>
								html`<button class="px-3 py-2 whitespace-nowrap border-b-2 ${filename === this.activeFilename ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}" data-filename=${filename} @click=${() => {
									this.activeFilename = filename;
								}}><span class="font-mono text-xs">${filename}</span></button>`,
						)}</div><div class="flex items-center gap-1 px-2">${active?.getHeaderButtons() ?? ""}${Button({ variant: "ghost", size: "sm", title: i18n("Close artifacts"), children: icon(X, "sm"), onClick: () => this.onClose?.() })}</div></div>`
					: ""
			}
			<div ${ref(this.contentRef)} class="flex-1 overflow-hidden"></div>
		</div>`;
	}
}
