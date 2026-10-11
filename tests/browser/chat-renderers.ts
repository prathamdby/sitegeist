import { MessageList as BaselineList } from "@mariozechner/pi-web-ui/dist/components/MessageList.js";
import { ToolMessage as BaselineTool } from "@mariozechner/pi-web-ui/dist/components/Messages.js";
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "@mariozechner/mini-lit/dist/CodeBlock.js";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { getTranslations, setLanguage } from "@mariozechner/mini-lit";
import {
	AgentInterface as BaselineController,
	ExpandableSection as BaselineExpandable,
	ThinkingBlock as BaselineThinking,
	BashRenderer,
	renderCollapsibleHeader as baselineHeader,
	setShowJsonMode as baselineJson,
	CalculateRenderer,
	GetCurrentTimeRenderer,
	registerToolRenderer,
	setAppStorage as setBaselineStorage,
} from "@mariozechner/pi-web-ui";
import { html, render } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { Code } from "lucide";
import { Type } from "typebox";
import { Agent as NativeBaselineAgent } from "../../../pi-mono/packages/agent/dist/index.js";
import type { AgentInterface } from "../../src/chat/AgentInterface.js";
import {
	ExpandableSection,
	BashRenderer as LocalBash,
	CalculateRenderer as LocalCalculate,
	GetCurrentTimeRenderer as LocalTime,
	MessageList,
	registerToolRenderer as registerLocalTool,
	registerMessageRenderer,
	renderCollapsibleHeader,
	setShowJsonMode,
	ThinkingBlock,
	ToolMessage,
} from "../../src/chat/renderers/index.js";
import { registerNavigationRenderer } from "../../src/messages/NavigationMessage.js";
import { registerUserMessageRenderer } from "../../src/messages/UserMessageRenderer.js";
import { registerWelcomeRenderer } from "../../src/messages/WelcomeMessage.js";
import type { Agent } from "../../src/pi/agent.js";
import { getModel } from "../../src/pi/models.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";

registerToolRenderer("bash", new BashRenderer());
registerToolRenderer("calculate", new CalculateRenderer());
registerToolRenderer("get_current_time", new GetCurrentTimeRenderer());
registerLocalTool("bash", new LocalBash());
registerLocalTool("calculate", new LocalCalculate());
registerLocalTool("get_current_time", new LocalTime());

const usage = {
	input: 120,
	output: 35,
	cacheRead: 10,
	cacheWrite: 5,
	totalTokens: 170,
	cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
};
const assistant: AssistantMessage = {
	role: "assistant",
	api: "anthropic-messages",
	provider: "anthropic",
	model: "fixture",
	timestamp: 1,
	usage,
	stopReason: "toolUse",
	content: [
		{ type: "thinking", thinking: "Reasoning **detail**" },
		{ type: "text", text: "Before **tool**" },
		{ type: "toolCall", id: "one", name: "unknown", arguments: { query: "fixture" } },
		{ type: "text", text: "After tool" },
	],
};
const result: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "one",
	toolName: "unknown",
	content: [{ type: "text", text: "Result body" }],
	isError: false,
	timestamp: 2,
};
let costs = 0;
let openedUrl = "";
let tutorialPrompt = "";
const releases: (() => void)[] = [];
let heldPrompt: Promise<void> | undefined;
const storage = new SitegeistAppStorage();
storage.skills.getSkillsForUrl = async () => [];
setAppStorage(storage);
globalThis.chrome = {
	runtime: { onMessage: { addListener() {} } },
	tabs: {
		create: ({ url }) => {
			openedUrl = url;
		},
	},
};
async function show(list: BaselineList | MessageList | BaselineTool | ToolMessage, options: Record<string, unknown>) {
	Object.assign(list, options);
	document.body.replaceChildren(list);
	await list.updateComplete;
	await new Promise((resolve) => setTimeout(resolve, 100));
	return list.outerHTML;
}
window.fixture = {
	async baseline(options = {}) {
		const list = new BaselineList();
		Object.assign(list, {
			messages: [{ role: "user", content: "Question", timestamp: 0 }, assistant, result],
			...options,
		});
		document.body.replaceChildren(list);
		await list.updateComplete;
		await new Promise((resolve) => setTimeout(resolve, 100));
		return list.outerHTML;
	},
	async tool(options = {}) {
		const tool = new BaselineTool();
		Object.assign(tool, { toolCall: assistant.content[2], result, ...options });
		document.body.replaceChildren(tool);
		await tool.updateComplete;
		await new Promise((resolve) => setTimeout(resolve, 100));
		return tool.outerHTML;
	},
	async local(options = {}) {
		return show(new MessageList(), {
			messages: [{ role: "user", content: "Question", timestamp: 0 }, assistant, result],
			onCostClick: () => {
				costs++;
			},
			...options,
		});
	},
	async localTool(options = {}) {
		return show(new ToolMessage(), { toolCall: assistant.content[2], result, ...options });
	},
	json(local: boolean, enabled: boolean) {
		(local ? setShowJsonMode : baselineJson)(enabled);
	},
	language(language: string) {
		setLanguage(language);
		return getTranslations();
	},
	async thinking(local: boolean, streaming: boolean) {
		const element = local ? new ThinkingBlock() : new BaselineThinking();
		element.content = "Reasoning **detail**";
		element.isStreaming = streaming;
		document.body.replaceChildren(element);
		await element.updateComplete;
	},
	header(local: boolean) {
		document.body.replaceChildren();
		const container = document.createElement("div");
		document.body.append(container);
		const content = createRef<HTMLElement>();
		const chevron = createRef<HTMLElement>();
		render(
			html`<div>${(local ? renderCollapsibleHeader : baselineHeader)("complete", Code, "Details", content, chevron, false)}<div ${ref(content)} class="overflow-hidden transition-all duration-200 ease-in-out max-h-0">Hidden details</div></div>`,
			container,
		);
	},
	async expandable(local: boolean) {
		const element = local ? new ExpandableSection() : new BaselineExpandable();
		element.summary = "Expand";
		element.append(document.createTextNode("Expanded content"));
		document.body.replaceChildren(element);
		await element.updateComplete;
	},
	custom(role: "user" | "navigation") {
		registerMessageRenderer(role, {
			render: (message) => html`<div data-custom=${message.role}>Custom ${message.role}</div>`,
		});
	},
	async actualCustom() {
		const welcome = { role: "welcome", tutorials: [{ label: "Try tutorial", prompt: "Tutorial request" }] };
		const agent = {
			state: { messages: [welcome] },
			replaceMessages(messages) {
				this.state.messages = messages;
			},
		};
		const agentInterface = {
			async sendMessage(prompt: string) {
				tutorialPrompt = prompt;
			},
		};
		registerUserMessageRenderer();
		registerNavigationRenderer();
		registerWelcomeRenderer(agent as unknown as Agent, agentInterface as AgentInterface);
		await show(new MessageList(), {
			messages: [
				welcome,
				{
					role: "navigation",
					title: "Fixture page",
					url: "https://example.test/",
					favicon: "data:,",
					skillsOutput: "",
				},
				{ role: "user", content: "Styled question", timestamp: 1 },
			],
		});
		return agent;
	},
	async baselineHold() {
		let turn = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const agent = new NativeBaselineAgent({
			initialState: {
				model,
				tools: [
					{
						name: "unknown",
						label: "Unknown",
						description: "Fixture",
						parameters: Type.Object({}),
						execute: async () => {
							await new Promise<void>((resolve) => releases.push(resolve));
							return { content: [{ type: "text", text: "Completed tool" }], details: {} };
						},
					},
				],
			},
			toolExecution: "sequential",
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				const message: AssistantMessage = {
					...assistant,
					timestamp: ++turn,
					stopReason: turn === 1 ? "toolUse" : "stop",
					content:
						turn === 1
							? [
									{ type: "toolCall", id: "first", name: "unknown", arguments: {} },
									{ type: "toolCall", id: "second", name: "unknown", arguments: {} },
								]
							: [{ type: "text", text: "Finished turn" }],
				};
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				return stream;
			},
		});
		setBaselineStorage(storage);
		const controller = new BaselineController();
		controller.session = agent;
		document.body.replaceChildren(controller);
		await controller.updateComplete;
		await new Promise((resolve) => setTimeout(resolve, 150));
		heldPrompt = agent.prompt("Two tools");
		await new Promise((resolve) => setTimeout(resolve, 150));
	},
	async releaseHeld() {
		releases.shift()?.();
		await new Promise((resolve) => setTimeout(resolve, 150));
		if (!releases.length) await heldPrompt;
	},
	get openedUrl() {
		return openedUrl;
	},
	get tutorialPrompt() {
		return tutorialPrompt;
	},
	get costs() {
		return costs;
	},
	assistant,
	result,
};
