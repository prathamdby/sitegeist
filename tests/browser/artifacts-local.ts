import { ArtifactsPanel } from "../../src/artifacts/ArtifactsPanel.js";
import { ArtifactsToolRenderer } from "../../src/artifacts/ArtifactsToolRenderer.js";
import { registerToolRenderer, renderTool } from "../../src/chat/renderers/index.js";
import { runArtifactAgentRoundtrip } from "./artifacts-agent.js";
import { installArtifactsFixture } from "./artifacts-fixture.js";

let renderer: ArtifactsToolRenderer;
installArtifactsFixture(ArtifactsPanel, (params, result, streaming, panel) => {
	renderer ??= new ArtifactsToolRenderer(panel);
	registerToolRenderer("artifacts", renderer);
	return renderTool("artifacts", params, result, streaming).content;
});
Object.assign(window, {
	runArtifactAgentRoundtrip: () => runArtifactAgentRoundtrip(window.artifactsFixture.panel as ArtifactsPanel),
});
