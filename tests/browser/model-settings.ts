import { AgentInterface } from "@mariozechner/pi-web-ui";
import { AboutTab } from "../../src/dialogs/AboutTab.js";
import { ApiKeysOAuthTab } from "../../src/dialogs/ApiKeysOAuthTab.js";
import { CostsTab } from "../../src/dialogs/CostsTab.js";
import { ModelSelector } from "../../src/dialogs/ModelSelector.js";
import { ProxyTab, SettingsDialog } from "../../src/dialogs/SettingsDialog.js";
import { SkillsTab } from "../../src/dialogs/SkillsTab.js";
import { Agent } from "../../src/pi/agent.js";
import { getModel, streamSimple } from "../../src/pi/models.js";
import { applyModelSelection } from "../../src/pi/selection.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";

const storage = new SitegeistAppStorage();
setAppStorage(storage);
globalThis.chrome = { runtime: { getManifest: () => ({ version: "1.0.0" }) } };
const current = getModel("anthropic", "claude-sonnet-4-5");
const agent = new Agent({ initialState: { model: current, messages: [] }, streamFn: streamSimple });
const composer = new AgentInterface();
composer.session = agent;
let selections = 0;
let closes = 0;
document.body.innerHTML =
	'<button id="settings">Settings</button><button id="models">Models</button><div id="summary"></div>';
document.body.append(composer);
const select = (model) =>
	applyModelSelection(model, agent, storage.settings, () => {
		selections++;
		composer.requestUpdate();
		document.querySelector("#summary").textContent = model.id;
	});
document
	.querySelector("#models")
	.addEventListener("click", () => ModelSelector.open(agent.state.model, select, ["anthropic", "openai"]));
document.querySelector("#settings").addEventListener("click", () =>
	SettingsDialog.open([new ApiKeysOAuthTab(), new CostsTab(), new SkillsTab(), new ProxyTab(), new AboutTab()], () => {
		closes++;
	}),
);
composer.onModelSelect = () => ModelSelector.open(agent.state.model, select, ["anthropic", "openai"]);
window.fixture = {
	storage,
	agent,
	get selections() {
		return selections;
	},
	get closes() {
		return closes;
	},
};
