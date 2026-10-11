import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Attachment } from "@mariozechner/pi-web-ui/dist/utils/attachment-utils.js";

export type UserMessageWithAttachments = {
	role: "user-with-attachments";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
	attachments?: Attachment[];
};

export interface ArtifactMessage {
	role: "artifact";
	action: "create" | "update" | "delete";
	filename: string;
	content?: string;
	title?: string;
	timestamp: string;
}
