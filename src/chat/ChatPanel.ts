import type { AgentTool } from "@earendil-works/pi-agent-core";
import { i18n } from "@mariozechner/mini-lit";
import { Badge } from "@mariozechner/mini-lit/dist/Badge.js";
import "@mariozechner/pi-web-ui/dist/components/CustomProviderCard.js";
import { ArtifactsRuntimeProvider } from "@mariozechner/pi-web-ui/dist/components/sandbox/ArtifactsRuntimeProvider.js";
import type { SandboxRuntimeProvider } from "@mariozechner/pi-web-ui/dist/components/sandbox/SandboxRuntimeProvider.js";
import { ArtifactsPanel } from "@mariozechner/pi-web-ui/dist/tools/artifacts/artifacts.js";
import { ArtifactsToolRenderer } from "@mariozechner/pi-web-ui/dist/tools/artifacts/artifacts-tool-renderer.js";
import { html, LitElement } from "lit";
import { customElement, state } from "lit/decorators.js";
import { AttachmentsRuntimeProvider } from "../attachments/AttachmentsRuntimeProvider.js";
import { type Agent, executableTool } from "../pi/agent.js";
import { AgentInterface } from "./AgentInterface.js";
import { registerToolRenderer } from "./renderers/index.js";

export interface ChatPanelConfig {
	onApiKeyRequired?: (provider: string) => Promise<boolean>;
	onBeforeSend?: () => void | Promise<void>;
	onCostClick?: () => void;
	onModelSelect?: () => void;
	sandboxUrlProvider?: () => string;
	toolsFactory?: (
		agent: Agent,
		agentInterface: AgentInterface,
		artifactsPanel: ArtifactsPanel,
		runtimeProvidersFactory: () => SandboxRuntimeProvider[],
	) => AgentTool[];
}

@customElement("sitegeist-chat-panel")
export class ChatPanel extends LitElement {
	agent?: Agent;
	agentInterface?: AgentInterface;
	artifactsPanel?: ArtifactsPanel;
	@state() private showArtifacts = false;
	@state() private artifactCount = 0;
	@state() private windowWidth = window.innerWidth;
	private onResize = () => {
		this.windowWidth = window.innerWidth;
	};

	protected override createRenderRoot() {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.cssText = "display: flex; width: 100%; height: 100%; flex-direction: column; min-height: 0;";
		window.addEventListener("resize", this.onResize);
		this.onResize();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		window.removeEventListener("resize", this.onResize);
	}

	async setAgent(agent: Agent, config: ChatPanelConfig = {}): Promise<void> {
		this.agent = agent;
		const controller = new AgentInterface();
		controller.session = agent;
		controller.showThemeToggle = false;
		controller.onApiKeyRequired = config.onApiKeyRequired;
		controller.onBeforeSend = config.onBeforeSend;
		controller.onCostClick = config.onCostClick;
		controller.onModelSelect = config.onModelSelect;
		this.agentInterface = controller;
		const artifacts = new ArtifactsPanel();
		let restoring = true;
		artifacts.agent = agent;
		artifacts.sandboxUrlProvider = config.sandboxUrlProvider;
		artifacts.onArtifactsChange = () => {
			const count = artifacts.artifacts.size;
			if (!restoring && count > this.artifactCount) this.showArtifacts = true;
			if (count === 0) this.showArtifacts = false;
			this.artifactCount = count;
		};
		artifacts.onClose = () => {
			this.showArtifacts = false;
		};
		artifacts.onOpen = () => {
			if (!restoring) this.showArtifacts = true;
		};
		this.artifactsPanel = artifacts;
		this.showArtifacts = false;
		this.artifactCount = 0;
		registerToolRenderer("artifacts", new ArtifactsToolRenderer(artifacts));
		const providers = (): SandboxRuntimeProvider[] => {
			const attachments = agent.state.messages.flatMap((message) =>
				message.role === "user-with-attachments" ? (message.attachments ?? []) : [],
			);
			return [new AttachmentsRuntimeProvider(attachments), new ArtifactsRuntimeProvider(artifacts, agent, true)];
		};
		agent.setTools([
			executableTool(artifacts.tool),
			...(config.toolsFactory?.(agent, controller, artifacts, providers) ?? []),
		]);
		await artifacts.reconstructFromMessages(agent.state.messages);
		restoring = false;
		this.artifactCount = artifacts.artifacts.size;
		this.showArtifacts = false;
		this.requestUpdate();
	}

	override render() {
		const overlay = this.windowWidth < 800;
		if (this.artifactsPanel) {
			this.artifactsPanel.collapsed = !this.showArtifacts;
			this.artifactsPanel.overlay = overlay;
		}
		return html`<div class="relative w-full h-full overflow-hidden flex">
			<div class="h-full" style=${`width: ${this.showArtifacts && !overlay ? "50%" : "100%"};`}>${this.agentInterface}</div>
			${
				this.artifactCount && !this.showArtifacts
					? html`<button class="absolute z-30 top-4 left-1/2 -translate-x-1/2 pointer-events-auto" title=${i18n("Show artifacts")} @click=${() => {
							this.showArtifacts = true;
						}}>${Badge({ children: html`<span class="inline-flex items-center gap-1"><span>${i18n("Artifacts")}</span><span class="text-[10px] leading-none bg-primary-foreground/20 text-primary-foreground rounded px-1 font-mono tabular-nums">${this.artifactCount}</span></span>` })}</button>`
					: ""
			}
			<div class="h-full ${overlay ? "absolute inset-0 pointer-events-none" : ""}" style=${overlay ? "" : this.showArtifacts ? "width: 50%;" : "display: none;"}>${this.artifactsPanel}</div>
		</div>`;
	}
}
