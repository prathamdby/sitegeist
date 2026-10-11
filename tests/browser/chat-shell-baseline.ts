import { ChatPanel } from "@mariozechner/pi-web-ui";
import { Agent } from "../../src/pi/agent.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";
import { initialMessages, model } from "./chat-fixture-data.js";

setAppStorage(new SitegeistAppStorage());
const agent = new Agent({
	initialState: { model, thinkingLevel: "medium", messages: initialMessages() },
	streamFn: () => {
		throw new Error("Layout baseline must not dispatch a request");
	},
});
document.documentElement.style.height = "100%";
document.body.style.cssText = "margin:0;height:100%";
const panel = new ChatPanel();
document.body.append(panel);
await panel.setAgent(agent, { toolsFactory: () => [] });
await panel.updateComplete;
await panel.agentInterface?.updateComplete;
document.body.dataset.baselineReady = "true";
