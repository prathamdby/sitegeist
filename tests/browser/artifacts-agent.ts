import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ArtifactsPanel } from "../../src/artifacts/ArtifactsPanel.js";
import { browserMessageTransformer } from "../../src/messages/message-transformer.js";
import { Agent, executableTool } from "../../src/pi/agent.js";
import { getModel } from "../../src/pi/models.js";

export async function runArtifactAgentRoundtrip(panel: ArtifactsPanel) {
	const model = getModel("openai", "gpt-4o-mini");
	let turn = 0;
	const requests: number[] = [];
	const agent = new Agent({
		initialState: { model, tools: [executableTool(panel.tool)] },
		toolExecution: "sequential",
		convertToLlm: browserMessageTransformer,
		streamFn: (_model, context) => {
			requests.push(context.messages.length);
			const stream = createAssistantMessageEventStream();
			const content =
				turn++ === 0
					? [
							{
								type: "toolCall" as const,
								id: "artifact-create",
								name: "artifacts",
								arguments: {
									command: "create",
									filename: "agent-report.html",
									content:
										"<!doctype html><html><head><title>Agent report</title></head><body><h1>Initial report</h1></body></html>",
								},
							},
							{
								type: "toolCall" as const,
								id: "artifact-update",
								name: "artifacts",
								arguments: {
									command: "update",
									filename: "agent-report.html",
									old_str: "Initial report",
									new_str: "Updated report",
								},
							},
							{
								type: "toolCall" as const,
								id: "artifact-rejected",
								name: "artifacts",
								arguments: {
									command: "update",
									filename: "agent-report.html",
									old_str: "not in the file",
									new_str: "must not appear",
								},
							},
							{
								type: "toolCall" as const,
								id: "artifact-read",
								name: "artifacts",
								arguments: { command: "get", filename: "agent-report.html" },
							},
						]
					: [{ type: "text" as const, text: "Updated the report." }];
			const stopReason = content[0].type === "toolCall" ? ("toolUse" as const) : ("stop" as const);
			stream.push({
				type: "done",
				reason: stopReason,
				message: {
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
					stopReason,
					timestamp: turn,
				},
			});
			return stream;
		},
	});
	panel.agent = agent;
	await agent.prompt("Create the report, update it, and read it back.");
	const before = panel.artifacts.get("agent-report.html")?.content;
	await panel.reconstructFromMessages(agent.state.messages);
	return {
		requests: requests.length,
		before,
		restored: panel.artifacts.get("agent-report.html")?.content,
		results: agent.state.messages.flatMap((message) =>
			message.role === "toolResult"
				? [
						{
							id: message.toolCallId,
							isError: message.isError,
							text: message.content.find((part) => part.type === "text")?.text,
						},
					]
				: [],
		),
	};
}
