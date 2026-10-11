import type { ArtifactMessage } from "../chat/types.js";
import { artifactsRuntimeDescription } from "../prompts/artifacts.js";
import type { RuntimeMessage, RuntimeResponse, SandboxRuntimeProvider } from "../sandbox/types.js";

interface ArtifactStore {
	artifacts: Map<string, { content: string }>;
	tool: {
		execute(
			id: string,
			args: { command: string; filename: string; content?: string },
		): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;
	};
}

interface ArtifactRuntimeWindow extends Window {
	artifacts: Record<string, string>;
	sendRuntimeMessage?: (message: RuntimeMessage) => Promise<RuntimeResponse>;
	listArtifacts: () => Promise<string[]>;
	getArtifact: (filename: string) => Promise<unknown>;
	createOrUpdateArtifact: (filename: string, content: unknown, mimeType?: string) => Promise<void>;
	deleteArtifact: (filename: string) => Promise<void>;
}

export class ArtifactsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(
		private readonly panel: ArtifactStore,
		private readonly agent?: { appendMessage(message: ArtifactMessage): void },
		private readonly readWrite = true,
	) {}

	getData(): Record<string, unknown> {
		return {
			artifacts: Object.fromEntries([...this.panel.artifacts].map(([name, artifact]) => [name, artifact.content])),
		};
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const target = window as unknown as ArtifactRuntimeWindow;
			target.listArtifacts = async () => {
				if (!target.sendRuntimeMessage) return Object.keys(target.artifacts);
				const response = await target.sendRuntimeMessage({ type: "artifact-operation", action: "list" });
				if (!response.success) throw new Error(String(response.error));
				return response.result as string[];
			};
			target.getArtifact = async (filename) => {
				let content: string;
				if (target.sendRuntimeMessage) {
					const response = await target.sendRuntimeMessage({
						type: "artifact-operation",
						action: "get",
						filename,
					});
					if (!response.success) throw new Error(String(response.error));
					content = response.result as string;
				} else {
					if (!Object.hasOwn(target.artifacts, filename)) {
						throw new Error(`Artifact not found (offline mode): ${filename}`);
					}
					content = target.artifacts[filename];
				}
				if (!filename.endsWith(".json")) return content;
				try {
					return JSON.parse(content);
				} catch (error) {
					throw new Error(`Failed to parse JSON from ${filename}: ${error}`);
				}
			};
			target.createOrUpdateArtifact = async (filename, content, mimeType) => {
				if (!target.sendRuntimeMessage)
					throw new Error("Cannot create/update artifacts in offline mode (read-only)");
				const response = await target.sendRuntimeMessage({
					type: "artifact-operation",
					action: "createOrUpdate",
					filename,
					content: typeof content === "string" ? content : JSON.stringify(content, null, 2),
					mimeType,
				});
				if (!response.success) throw new Error(String(response.error));
			};
			target.deleteArtifact = async (filename) => {
				if (!target.sendRuntimeMessage) throw new Error("Cannot delete artifacts in offline mode (read-only)");
				const response = await target.sendRuntimeMessage({
					type: "artifact-operation",
					action: "delete",
					filename,
				});
				if (!response.success) throw new Error(String(response.error));
			};
		};
	}

	async handleMessage(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void> {
		if (message.type !== "artifact-operation") return;
		try {
			if (message.action === "list") {
				respond({ success: true, result: [...this.panel.artifacts.keys()] });
				return;
			}
			if (message.action === "get") {
				const artifact = this.panel.artifacts.get(message.filename as string);
				if (!artifact) throw new Error(`Artifact not found: ${message.filename}`);
				respond({ success: true, result: artifact.content });
				return;
			}
			if (message.action !== "createOrUpdate" && message.action !== "delete") {
				throw new Error(`Unknown artifact action: ${message.action}`);
			}
			if (!this.readWrite) throw new Error("Artifacts are read-only in HTML previews");
			if (typeof message.filename !== "string") throw new Error("Artifact filename must be a string");
			const filename = message.filename;
			const exists = this.panel.artifacts.has(filename);
			const deleting = message.action === "delete";
			if (!deleting && typeof message.content !== "string") throw new Error("Artifact content must be a string");
			const content = message.content as string | undefined;
			const result = await this.panel.tool.execute("", {
				command: deleting ? "delete" : exists ? "rewrite" : "create",
				filename,
				...(deleting ? {} : { content }),
			});
			if (result.isError)
				throw new Error(result.content.find((part) => part.type === "text")?.text ?? "Artifact operation failed");
			this.agent?.appendMessage({
				role: "artifact",
				action: deleting ? "delete" : exists ? "update" : "create",
				filename,
				...(deleting ? {} : { content, ...(!exists ? { title: filename } : {}) }),
				timestamp: new Date().toISOString(),
			});
			respond({ success: true });
		} catch (error) {
			respond({ success: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	getDescription(): string {
		return artifactsRuntimeDescription(this.readWrite);
	}
}
