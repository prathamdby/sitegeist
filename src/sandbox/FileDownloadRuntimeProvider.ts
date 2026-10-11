import type { RuntimeMessage, RuntimeResponse, SandboxFile, SandboxRuntimeProvider } from "./types.js";

export class FileDownloadRuntimeProvider implements SandboxRuntimeProvider {
	private files: SandboxFile[] = [];

	getData(): Record<string, unknown> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		return () => {
			const target = window as Window & {
				sendRuntimeMessage?: (message: RuntimeMessage) => Promise<unknown>;
				returnDownloadableFile?: (
					fileName: string,
					content: string | Uint8Array,
					mimeType: string,
				) => Promise<void>;
			};
			target.returnDownloadableFile = async (fileName, content, mimeType) => {
				if (target.sendRuntimeMessage) {
					await target.sendRuntimeMessage({ type: "file-returned", fileName, content, mimeType });
					return;
				}
				const bytes = typeof content === "string" ? content : new Uint8Array(content);
				const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
				const link = document.createElement("a");
				link.href = url;
				link.download = fileName;
				link.click();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
			};
		};
	}

	async handleMessage(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void> {
		if (message.type !== "file-returned") return;
		if (
			typeof message.fileName !== "string" ||
			typeof message.mimeType !== "string" ||
			(typeof message.content !== "string" && !(message.content instanceof Uint8Array))
		) {
			respond({ success: false, error: "Invalid downloadable file" });
			return;
		}
		this.files.push({ fileName: message.fileName, content: message.content, mimeType: message.mimeType });
		respond({ success: true });
	}

	getFiles(): SandboxFile[] {
		return this.files.slice();
	}

	reset(): void {
		this.files = [];
	}

	getDescription(): string {
		return "returnDownloadableFile(fileName, content, mimeType) returns a one-time download to the user.";
	}
}
