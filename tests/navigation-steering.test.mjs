import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { browserMessageTransformer } from "../src/messages/message-transformer.ts";
import { Agent } from "../src/pi/agent.ts";
import { getModel } from "../src/pi/models.ts";
import { navigationSteeringGate } from "../src/pi/navigation-steering.ts";

const model = getModel("openai", "gpt-4o-mini");

test("navigation steering skips later sequential tools before their effects and reaches the next request", async () => {
	let turn = 0;
	let agent;
	const executed = [];
	const requests = [];
	agent = new Agent({
		initialState: {
			model,
			tools: ["navigate", "interact"].map((name) => ({
				name,
				label: name,
				description: name,
				parameters: Type.Object({}),
				execute: async () => {
					executed.push(name);
					if (name === "navigate")
						agent.steer({
							role: "navigation",
							url: "https://example.org/new",
							title: "New page",
							skillsOutput: "",
						});
					return { content: [{ type: "text", text: "Complete" }], details: {} };
				},
			})),
		},
		toolExecution: "sequential",
		convertToLlm: browserMessageTransformer,
		beforeToolCall: async () => navigationSteeringGate(agent),
		streamFn: (_model, context) => {
			requests.push(context.messages);
			const stream = createAssistantMessageEventStream();
			const content =
				turn++ === 0
					? [
							{ type: "toolCall", id: "one", name: "navigate", arguments: {} },
							{ type: "toolCall", id: "two", name: "interact", arguments: {} },
						]
					: [{ type: "text", text: "Read the new page" }];
			const message = {
				role: "assistant",
				content,
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
				timestamp: turn,
			};
			stream.push({ type: "done", reason: message.stopReason, message });
			return stream;
		},
	});
	await agent.prompt("Navigate and interact");
	assert.deepEqual(executed, ["navigate"]);
	const result = agent.state.messages.find((message) => message.role === "toolResult" && message.toolCallId === "two");
	assert.equal(result.isError, true);
	assert.equal(result.content[0].text, "Skipped due to queued user message.");
	assert.equal(requests.length, 2);
	assert.equal(requests[1].at(-1).role, "user");
	assert.match(requests[1].at(-1).content, /https:\/\/example.org\/new/);
	assert.equal(agent.state.isStreaming, false);
});
