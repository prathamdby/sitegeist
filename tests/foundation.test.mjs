import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream, getCurrentTools, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { browserMessageTransformer } from "../src/messages/message-transformer.ts";
import { Agent, executableTool } from "../src/pi/agent.ts";
import { CostRecorder } from "../src/pi/costs.ts";
import { getModel } from "../src/pi/models.ts";
import { selectionRequiredModel } from "../src/pi/selection.ts";

const model = getModel("openai", "gpt-4o-mini");
assert.ok(model);

function assistant(content, stopReason = "stop") {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason,
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
	};
}

function response(message) {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	if (message.stopReason === "aborted") {
		stream.push({ type: "error", reason: "aborted", error: message });
	} else {
		stream.push({ type: "done", reason: message.stopReason, message });
	}
	return stream;
}

test("new agent preserves the prompt and tool declarations through the browser converter", async () => {
	const requests = [];
	const executed = [];
	const agent = new Agent({
		initialState: { systemPrompt: "Retain this exact system prompt.", model },
		convertToLlm: browserMessageTransformer,
		toolExecution: "sequential",
		streamFn: (_model, context) => {
			requests.push(context);
			return response(
				requests.length === 1
					? assistant(
							[
								{ type: "toolCall", id: "one", name: "echo", arguments: { text: "first" } },
								{ type: "toolCall", id: "two", name: "echo", arguments: { text: "second" } },
							],
							"toolUse",
						)
					: assistant([{ type: "text", text: "Done" }]),
			);
		},
	});
	agent.setTools([
		executableTool({
			name: "echo",
			label: "Echo",
			description: "Echo text",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (id, args) => {
				executed.push([id, args.text]);
				return { content: [{ type: "text", text: args.text }], details: { id } };
			},
		}),
	]);
	const events = [];
	let previousMessages = agent.state.messages;
	agent.subscribe((event) => {
		events.push(event.type);
		if (event.type === "message_end") {
			assert.notEqual(agent.state.messages, previousMessages);
			previousMessages = agent.state.messages;
		}
		if (event.type === "agent_end") assert.equal(agent.state.isStreaming, false);
	});
	await agent.prompt("Run both tools.");
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.equal(getCurrentSystemPrompt(request.messages), "Retain this exact system prompt.");
		const tools = getCurrentTools(request.messages);
		assert.equal(tools.length, 1);
		assert.equal(tools[0].name, "echo");
		assert.equal(tools[0].parameters.properties.text.type, "string");
	}
	assert.deepEqual(executed, [["one", "first"], ["two", "second"]]);
	assert.equal(events.filter((event) => event === "tool_execution_end").length, 2);
	assert.equal(events.at(-1), "agent_end");
	assert.equal(agent.state.isStreaming, false);
});

test("converter retains system deltas and converts image/document attachments", async () => {
	const system = { role: "system", content: "prompt", sections: { policy: "same policy" }, toolsRemoved: [], timestamp: 0 };
	const converted = await browserMessageTransformer([
		system,
		{ role: "welcome", tutorials: [] },
		{
			role: "user-with-attachments",
			content: "Inspect these files",
			timestamp: 3,
			attachments: [
				{ type: "image", content: "fixture-base64", mimeType: "image/png" },
				{ type: "document", fileName: "fixture.txt", extractedText: "Document text" },
			],
		},
	]);
	assert.equal(converted[0], system);
	assert.deepEqual(converted[1].content, [
		{ type: "text", text: "Inspect these files" },
		{ type: "image", data: "fixture-base64", mimeType: "image/png" },
		{ type: "text", text: "\n\n[Document: fixture.txt]\nDocument text" },
	]);
});

test("legacy session records retain their messages and fields while acquiring a prompt baseline", () => {
	const messages = [
		{ role: "user", content: "Old conversation", timestamp: 1, extraSavedField: "retain" },
		assistant([{ type: "text", text: "Previous answer" }]),
		{ role: "navigation", url: "https://example.test", title: "Fixture", skillsOutput: "", savedField: true },
	];
	const before = structuredClone(messages);
	const agent = new Agent({
		initialState: { model, messages, systemPrompt: "Restored prompt" },
		streamFn: () => response(assistant([])),
	});
	assert.deepEqual(agent.state.messages.slice(1), before);
	assert.equal(agent.state.messages[1], messages[0]);
	assert.equal(agent.state.systemPrompt, "Restored prompt");
	agent.replaceMessages(agent.state.messages.slice(1));
	assert.equal(agent.state.systemPrompt, "Restored prompt");
	assert.deepEqual(agent.state.messages.slice(1), before);
});

test("costs are attributed to the response and consumed only once; restored history is never charged again", () => {
	const recorder = new CostRecorder();
	const restored = assistant([]);
	recorder.seed([restored]);
	assert.equal(recorder.take(restored), undefined);
	const fresh = assistant([{ type: "text", text: "New response" }]);
	assert.deepEqual(recorder.take(fresh), { provider: model.provider, model: model.id, cost: 0.3 });
	assert.equal(recorder.take(fresh), undefined);
});

test("a missing model asks for selection without sending, changing providers, or losing saved messages", async () => {
	const messages = [{ role: "user", content: "Saved conversation", timestamp: 1 }];
	const agent = new Agent({
		initialState: { model: selectionRequiredModel, messages },
		streamFn: () => { throw new Error("A missing selection must never dispatch"); },
	});
	let selections = 0;
	agent.onModelRequired = () => { selections++; };
	await agent.prompt("Tutorial prompt");
	await agent.continue();
	assert.equal(selections, 2);
	assert.equal(agent.state.model, selectionRequiredModel);
	assert.deepEqual(agent.state.messages, messages);
	assert.equal(agent.state.isStreaming, false);
});

test("abort reaches the running tool and settles the new agent without another network dispatch", async () => {
	let calls = 0;
	let started;
	const toolStarted = new Promise((resolve) => { started = resolve; });
	const agent = new Agent({
		initialState: { model, systemPrompt: "Cancellation fixture" },
		convertToLlm: browserMessageTransformer,
		streamFn: (_model, _context, options) => {
			if (options.signal.aborted) {
				return response({ ...assistant([], "aborted"), errorMessage: "cancelled" });
			}
			calls++;
			return response(assistant([{ type: "toolCall", id: "wait", name: "wait", arguments: {} }], "toolUse"));
		},
	});
	agent.setTools([executableTool({
		name: "wait",
		label: "Wait",
		description: "Wait for cancellation",
		parameters: Type.Object({}),
		execute: (_id, _args, signal) => new Promise((_resolve, reject) => {
			started();
			signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
		}),
	})]);
	const running = agent.prompt("Wait");
	await toolStarted;
	agent.abort();
	await running;
	await agent.waitForIdle();
	assert.equal(calls, 1);
	assert.equal(agent.state.isStreaming, false);
	assert.equal(agent.state.pendingToolCalls.size, 0);
});
