import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { AttachmentsRuntimeProvider } from "../src/attachments/AttachmentsRuntimeProvider.ts";
import { browserMessageTransformer } from "../src/messages/message-transformer.ts";
import { Agent } from "../src/pi/agent.ts";
import { getModel } from "../src/pi/models.ts";
import { createStreamFn } from "../src/pi/stream.ts";
import { SitegeistAppStorage } from "../src/storage/app-storage.ts";

const attachments = [
	{
		id: "old-image",
		type: "image",
		fileName: "pixel.png",
		mimeType: "image/png",
		size: 4,
		content: "AAH+/w==",
		preview: "AAH+/w==",
		legacyExtra: { keep: true },
	},
	{
		id: "old-document",
		type: "document",
		fileName: "notes.txt",
		mimeType: "text/plain",
		size: 5,
		content: "aMOpbGxv",
		extractedText: "héllo",
		legacyExtra: 1,
	},
];

function runtime(files, Provider = AttachmentsRuntimeProvider) {
	const provider = new Provider(files);
	const context = vm.createContext({
		window: structuredClone(provider.getData()),
		atob,
		Uint8Array,
		TextDecoder,
	});
	vm.runInContext(`(${provider.getRuntime().toString()})("fixture-sandbox")`, context);
	return context.window;
}

test("attachment helpers are self-contained injected functions with original bytes and read-only metadata", () => {
	const target = runtime(attachments);
	assert.deepEqual(
		JSON.parse(JSON.stringify(target.listAttachments())),
		attachments.map(({ id, fileName, mimeType, size }) => ({ id, fileName, mimeType, size })),
	);
	assert.deepEqual([...target.readBinaryAttachment("old-image")], [0, 1, 254, 255]);
	assert.equal(target.readTextAttachment("old-document"), "héllo");
	assert.throws(() => target.readBinaryAttachment("missing"), /Attachment not found: missing/);
	assert.throws(() => target.readTextAttachment("notes.txt"), /Attachment not found: notes.txt/);
	const list = target.listAttachments();
	list[0].fileName = "changed";
	assert.equal(target.listAttachments()[0].fileName, "pixel.png");
	assert.deepEqual(JSON.parse(JSON.stringify(runtime([]).listAttachments())), []);
});

test("corrupt base64, non-string IDs and text fallbacks preserve the retained sandbox contract", () => {
	for (const Provider of [AttachmentsRuntimeProvider]) {
		const target = runtime(attachments, Provider);
		for (const id of [undefined, null, 7, "notes.txt"]) {
			for (const read of [target.readTextAttachment, target.readBinaryAttachment]) {
				assert.throws(() => read(id), { name: "Error", message: `Attachment not found: ${id}` });
			}
		}
		for (const extractedText of [undefined, ""]) {
			const corrupt = runtime(
				[{ ...attachments[1], id: "corrupt", content: "!!!not-base64!!!", extractedText }],
				Provider,
			);
			assert.throws(() => corrupt.readTextAttachment("corrupt"), {
				name: "Error",
				message: "Failed to decode text content for: corrupt",
			});
			assert.throws(() => corrupt.readBinaryAttachment("corrupt"), { name: "InvalidCharacterError" });
			const text = runtime([{ ...attachments[1], extractedText }], Provider);
			assert.equal(text.readTextAttachment("old-document"), atob(attachments[1].content));
		}
		const extracted = runtime([{ ...attachments[1], content: "!!!not-base64!!!" }], Provider);
		assert.equal(extracted.readTextAttachment("old-document"), "héllo");
		assert.equal(target.readTextAttachment("old-image"), atob(attachments[0].content));
	}
});

test("old-format version-3 sessions restore attachment bytes for the REPL and subsequent Pi requests", async () => {
	globalThis.indexedDB = new IDBFactory();
	globalThis.IDBKeyRange = IDBKeyRange;
	const model = getModel("openai", "gpt-4o-mini");
	const oldMessage = {
		role: "user-with-attachments",
		content: "Read both",
		attachments,
		timestamp: 7,
		preserved: true,
	};
	const storage = new SitegeistAppStorage();
	await storage.backend.set("sessions", "old-session", {
		id: "old-session",
		title: "Old upload",
		model,
		thinkingLevel: "off",
		messages: [oldMessage],
		createdAt: "2026-01-01T00:00:00Z",
		lastModified: "2026-01-01T00:00:00Z",
	});
	const restored = await storage.sessions.loadSession("old-session");
	assert.deepEqual(restored.messages[0], oldMessage);
	const requests = [];
	const agent = new Agent({
		initialState: { model },
		convertToLlm: browserMessageTransformer,
		streamFn: (_model, context) => {
			requests.push(context);
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				provider: model.provider,
				api: model.api,
				model: model.id,
				stopReason: "stop",
				timestamp: 8,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	agent.replaceMessages(restored.messages);
	const files = agent.state.messages.flatMap((message) =>
		message.role === "user-with-attachments" ? (message.attachments ?? []) : [],
	);
	const target = runtime(files);
	assert.equal(target.readTextAttachment("old-document"), "héllo");
	assert.deepEqual([...target.readBinaryAttachment("old-image")], [0, 1, 254, 255]);
	await agent.prompt("Continue from this old session");
	assert.equal(requests.length, 1);
	const sent = requests[0].messages.find((message) => message.role === "user" && Array.isArray(message.content));
	assert.deepEqual(sent.content, [
		{ type: "text", text: "Read both" },
		{ type: "image", data: "AAH+/w==", mimeType: "image/png" },
		{ type: "text", text: "\n\n[Document: notes.txt]\nhéllo" },
	]);
	await storage.sessions.saveSession("old-session", agent.state, undefined);
	const roundtrip = await storage.sessions.loadSession("old-session");
	assert.deepEqual(
		roundtrip.messages.find((message) => message.role === "user-with-attachments"),
		oldMessage,
	);
});

for (const api of ["openai-responses", "openai-completions"])
	test(`attachment image reaches the Pi 1.1.0 ${api} wire request as a base64 image URL`, async () => {
		const model = { ...getModel("openai", "gpt-4o-mini"), provider: `fixture-${api}`, api };
		const messages = await browserMessageTransformer([
			{ role: "user-with-attachments", content: "Describe", attachments, timestamp: 1 },
		]);
		const requests = [];
		const stream = createStreamFn(async () => undefined);
		await (
			await stream(
				model,
				{ messages },
				{
					apiKey: "synthetic-fixture-key",
					maxRetries: 0,
					fetch: async (input, init) => {
						requests.push({ url: String(input), body: JSON.parse(init.body) });
						return new Response(JSON.stringify({ error: { message: "synthetic response" } }), { status: 400 });
					},
				},
			)
		).result();
		assert.equal(requests.length, 1);
		const user = (requests[0].body.messages ?? requests[0].body.input).find((message) => message.role === "user");
		assert.deepEqual(
			user.content.find((part) => part.type === "image_url" || part.type === "input_image"),
			api === "openai-completions"
				? {
						type: "image_url",
						image_url: { url: "data:image/png;base64,AAH+/w==" },
					}
				: { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAH+/w==" },
		);
		assert.ok(
			user.content.some(
				(part) => (part.type === "text" || part.type === "input_text") && part.text.includes("héllo"),
			),
		);
	});
