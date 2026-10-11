import { ATTACHMENTS_RUNTIME_DESCRIPTION } from "../prompts/attachments.js";
import type { SandboxRuntimeProvider } from "../sandbox/types.js";
import type { Attachment } from "./types.js";

type RuntimeAttachment = Pick<Attachment, "id" | "fileName" | "mimeType" | "size" | "content" | "extractedText">;

type AttachmentWindow = Window & {
	attachments: RuntimeAttachment[];
	listAttachments: () => Omit<RuntimeAttachment, "content" | "extractedText">[];
	readTextAttachment: (id: string) => string;
	readBinaryAttachment: (id: string) => Uint8Array;
};

export class AttachmentsRuntimeProvider implements SandboxRuntimeProvider {
	constructor(private readonly attachments: Attachment[]) {}

	getData(): { attachments: RuntimeAttachment[] } {
		return {
			attachments: this.attachments.map(({ id, fileName, mimeType, size, content, extractedText }) => ({
				id,
				fileName,
				mimeType,
				size,
				content,
				extractedText,
			})),
		};
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const target = window as unknown as AttachmentWindow;
			target.listAttachments = () =>
				target.attachments.map(({ id, fileName, mimeType, size }) => ({ id, fileName, mimeType, size }));
			target.readBinaryAttachment = (id) => {
				const attachment = target.attachments.find((file) => file.id === id);
				if (!attachment) throw new Error(`Attachment not found: ${id}`);
				return Uint8Array.from(atob(attachment.content), (character) => character.charCodeAt(0));
			};
			target.readTextAttachment = (id) => {
				const attachment = target.attachments.find((file) => file.id === id);
				if (!attachment) throw new Error(`Attachment not found: ${id}`);
				if (attachment.extractedText) return attachment.extractedText;
				try {
					return atob(attachment.content);
				} catch {
					throw new Error(`Failed to decode text content for: ${id}`);
				}
			};
		};
	}

	getDescription(): string {
		return ATTACHMENTS_RUNTIME_DESCRIPTION;
	}
}
