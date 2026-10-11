import { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { setLanguage } from "@mariozechner/mini-lit";
import type { Attachment } from "@mariozechner/pi-web-ui/dist/utils/attachment-utils.js";
import { ChatPanel } from "../../src/chat/ChatPanel.js";
import { Agent } from "../../src/pi/agent.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";
import { assistant, initialMessages, model } from "./chat-fixture-data.js";

const storage = new SitegeistAppStorage();
setAppStorage(storage);
const events: unknown[][] = [];
let releaseStream: () => void = () => {};
let holdStream = false;
let delayStreamStart = false;
let releaseStreamStart: () => void = () => {};
const agent = new Agent({
	initialState: {
		model,
		thinkingLevel: "medium",
		messages: initialMessages(),
	},
	streamFn: (_model, _context, options) => {
		const stream = new AssistantMessageEventStream();
		const message = assistant("Streaming fixture reply");
		message.content = [
			{ type: "thinking", thinking: "Fixture reasoning" },
			{ type: "text", text: "Streaming fixture reply" },
		];
		let ended = false;
		const finish = (aborted: boolean) => {
			if (ended) return;
			ended = true;
			if (aborted) {
				message.stopReason = "aborted";
				message.errorMessage = "Fixture aborted";
				stream.push({ type: "error", reason: "aborted", error: message });
			} else stream.push({ type: "done", reason: "stop", message });
		};
		releaseStream = () => finish(false);
		options?.signal?.addEventListener("abort", () => finish(true), { once: true });
		const begin = () => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "thinking_delta", contentIndex: 0, delta: "Fixture reasoning", partial: message });
			stream.push({ type: "text_delta", contentIndex: 1, delta: "Streaming fixture reply", partial: message });
			if (!holdStream) finish(false);
		};
		releaseStreamStart = begin;
		if (!delayStreamStart) queueMicrotask(begin);
		return stream;
	},
});
await storage.providerKeys.set("anthropic", "fixture-not-a-real-key");
document.documentElement.style.height = "100%";
document.body.style.cssText = "margin:0;height:100%";
const panel = new ChatPanel();
document.body.append(panel);
await panel.setAgent(agent, {
	onBeforeSend: () => {
		events.push(["beforeSend"]);
	},
	onCostClick: () => {
		events.push(["cost"]);
	},
	onModelSelect: () => {
		events.push(["model"]);
	},
	toolsFactory: () => [],
});
await panel.updateComplete;
await panel.agentInterface?.updateComplete;
const controller = panel.agentInterface;
if (!controller) throw new Error("Fixture controller missing");
const fixture = {
	panel,
	agent,
	controller,
	events,
	storage,
	language(code: string) {
		setLanguage(code);
	},
	setInput(text: string, attachments: Attachment[] = []) {
		controller.setInput(text, attachments);
	},
	holdStream(value: boolean) {
		holdStream = value;
	},
	delayStreamStart(value: boolean) {
		delayStreamStart = value;
	},
	releaseStreamStart() {
		releaseStreamStart();
	},
	releaseStream() {
		releaseStream();
	},
	async keyDenied() {
		await storage.providerKeys.delete("anthropic");
		agent.getApiKey = async () => undefined;
		controller.onApiKeyRequired = async () => false;
	},
	async keyGranted() {
		await storage.providerKeys.set("anthropic", "fixture-not-a-real-key");
		agent.getApiKey = async () => "fixture-not-a-real-key";
	},
	rejectBeforeSend() {
		controller.onBeforeSend = async () => {
			throw new Error("Fixture rejected");
		};
	},
	async sendDirect(text: string) {
		try {
			await controller.sendMessage(text);
			return null;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	},
	async createArtifact() {
		const tool = agent.state.tools.find((item) => item.name === "artifacts");
		if (!tool) throw new Error("Fixture artifacts tool missing");
		return tool.execute("fixture", {
			command: "create",
			filename: "notes.md",
			content: "# Fixture artifact\n\nReusable layout reference.",
		});
	},
};
declare global {
	interface Window {
		chatFixture: typeof fixture;
	}
}
window.chatFixture = fixture;
