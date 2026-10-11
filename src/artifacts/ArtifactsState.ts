import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";

export interface Artifact {
	filename: string;
	content: string;
	createdAt: Date;
	updatedAt: Date;
}

export const artifactsParamsSchema = Type.Object({
	command: Type.String({
		enum: ["create", "update", "rewrite", "get", "delete", "logs"],
		description: "The operation to perform",
	}),
	filename: Type.String({ description: "Filename including extension (e.g., 'index.html', 'script.js')" }),
	content: Type.Optional(Type.String({ description: "File content" })),
	old_str: Type.Optional(Type.String({ description: "String to replace (for update command)" })),
	new_str: Type.Optional(Type.String({ description: "Replacement string (for update command)" })),
});

export type ArtifactsParams = Static<typeof artifactsParamsSchema>;
export type ArtifactResult = AgentToolResult<undefined> & { isError?: boolean };

export class ArtifactsState {
	readonly artifacts = new Map<string, Artifact>();

	execute(params: ArtifactsParams): ArtifactResult {
		const { command, filename, content, old_str, new_str } = params;
		let text = "";
		let error = "";
		const artifact = this.artifacts.get(filename);
		const missing = `File ${filename} not found. ${this.artifacts.size ? `Available files: ${[...this.artifacts.keys()].join(", ")}` : "No files have been created yet."}`;
		const now = new Date();
		switch (command) {
			case "create":
				if (!filename || !content) error = "create command requires filename and content";
				else if (artifact) error = `File ${filename} already exists`;
				else {
					this.artifacts.set(filename, { filename, content, createdAt: now, updatedAt: now });
					text = `Created file ${filename}`;
				}
				break;
			case "update":
				if (!old_str || new_str === undefined) error = "update command requires old_str and new_str";
				else if (!artifact) error = missing;
				else if (!artifact.content.includes(old_str))
					error = `String not found in file. Here is the full content:\n\n${artifact.content}`;
				else {
					artifact.content = artifact.content.replace(old_str, new_str);
					artifact.updatedAt = now;
					text = `Updated file ${filename}`;
				}
				break;
			case "rewrite":
				if (!content) error = "rewrite command requires content";
				else if (!artifact) error = missing;
				else {
					artifact.content = content;
					artifact.updatedAt = now;
				}
				break;
			case "get":
				if (!artifact) error = missing;
				else text = artifact.content;
				break;
			case "delete":
				if (!artifact) error = missing;
				else {
					this.artifacts.delete(filename);
					text = `Deleted file ${filename}`;
				}
				break;
			default:
				error = `Unknown command ${command}`;
		}
		return {
			content: [{ type: "text", text: error ? `Error: ${error}` : text }],
			details: undefined,
			...(error ? { isError: true } : {}),
		};
	}

	reconstruct(messages: Array<AgentMessage | { role: "aborted" }>): void {
		this.artifacts.clear();
		const calls = new Map<string, ArtifactsParams>();
		for (const message of messages) {
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall" && block.name === "artifacts") {
						const args = block.arguments;
						if (typeof args.command === "string" && typeof args.filename === "string")
							calls.set(block.id, {
								command: args.command,
								filename: args.filename,
								...(typeof args.content === "string" ? { content: args.content } : {}),
								...(typeof args.old_str === "string" ? { old_str: args.old_str } : {}),
								...(typeof args.new_str === "string" ? { new_str: args.new_str } : {}),
							});
					}
				}
			} else if (message.role === "toolResult" && message.toolName === "artifacts") {
				const params = calls.get(message.toolCallId);
				calls.delete(message.toolCallId);
				if (
					!params ||
					message.isError ||
					message.content.some((block) => block.type === "text" && block.text.startsWith("Error:"))
				)
					continue;
				if (["create", "update", "rewrite", "delete"].includes(params.command)) this.execute(params);
			} else if (message.role === "artifact") {
				if (message.action === "delete") this.artifacts.delete(message.filename);
				else if (message.content !== undefined) {
					const date = new Date(message.timestamp);
					const existing = this.artifacts.get(message.filename);
					this.artifacts.set(message.filename, {
						filename: message.filename,
						content: message.content,
						createdAt: existing?.createdAt ?? date,
						updatedAt: date,
					});
				}
			}
		}
	}
}
