import { AssistantMessageEventStream, type Context } from "@earendil-works/pi-ai";
import { AttachmentOverlay } from "../../src/attachments/AttachmentOverlay.js";
import { AttachmentsRuntimeProvider } from "../../src/attachments/AttachmentsRuntimeProvider.js";
import { AttachmentTile } from "../../src/attachments/AttachmentTile.js";
import { loadAttachment } from "../../src/attachments/processing.js";
import type { Attachment } from "../../src/attachments/types.js";
import { AgentInterface } from "../../src/chat/AgentInterface.js";
import "../../src/chat/renderers/MessageList.js";
import { browserMessageTransformer } from "../../src/messages/message-transformer.js";
import { Agent } from "../../src/pi/agent.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";
import { executeJavaScript } from "../../src/tools/repl/repl.js";
import { installAttachmentFixture } from "./attachments-ui-fixture.js";
import { assistant, model } from "./chat-fixture-data.js";

const ui = installAttachmentFixture(AttachmentTile, AttachmentOverlay);
const storage = new SitegeistAppStorage();
setAppStorage(storage);
await storage.providerKeys.set(model.provider, "attachment-fixture-not-a-real-key");
const contexts: Context[] = [];
const agent = new Agent({
	initialState: { model },
	convertToLlm: browserMessageTransformer,
	streamFn: (_model, context) => {
		contexts.push(structuredClone(context));
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant("Attachment received") }));
		return stream;
	},
});
const controller = new AgentInterface();
controller.session = agent;
controller.style.cssText = "height:500px;display:none";
document.body.append(controller);
await controller.updateComplete;
controller.style.display = "none";
const composer = controller.querySelector("sitegeist-message-editor");
if (!composer) throw new Error("Attachment fixture composer missing");
Object.assign(ui, {
	loadAttachment,
	agent,
	controller,
	composer,
	contexts,
	showComposer() {
		controller.style.display = "flex";
	},
	async repl(attachments: Attachment[]) {
		agent.replaceMessages([{ role: "user-with-attachments", content: "Restored files", attachments, timestamp: 0 }]);
		await controller.updateComplete;
		const restored = agent.state.messages.flatMap((message) =>
			message.role === "user-with-attachments" ? (message.attachments ?? []) : [],
		);
		const result = await executeJavaScript(
			`return {files:listAttachments(), text:readTextAttachment(${JSON.stringify(attachments[1].id)}), bytes:Array.from(readBinaryAttachment(${JSON.stringify(attachments[0].id)}))}`,
			[new AttachmentsRuntimeProvider(restored)],
		);
		return result.output;
	},
});
document.body.dataset.attachmentReady = "true";
