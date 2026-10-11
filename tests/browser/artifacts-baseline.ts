import { ArtifactsPanel, type ArtifactsParams } from "@mariozechner/pi-web-ui/dist/tools/artifacts/artifacts.js";
import { ArtifactsToolRenderer } from "@mariozechner/pi-web-ui/dist/tools/artifacts/artifacts-tool-renderer.js";
import { installArtifactsFixture } from "./artifacts-fixture.js";

let renderer: ArtifactsToolRenderer;
installArtifactsFixture(ArtifactsPanel, (params, result, streaming, panel) => {
	renderer ??= new ArtifactsToolRenderer(panel);
	return renderer.render(params as ArtifactsParams | undefined, result, streaming).content;
});
