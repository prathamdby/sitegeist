import type { LitElement } from "lit";
import type { Attachment } from "../../src/attachments/types.js";

export interface AttachmentUIFixture {
	open(attachment: Attachment): void;
	tiles(attachments: Attachment[], showDelete?: boolean): Promise<void>;
	closed: number;
	deleted: string[];
}

export function installAttachmentFixture(
	Tile: new () => LitElement & { attachment: Attachment; showDelete: boolean; onDelete?: () => void },
	Overlay: { open(attachment: Attachment, onClose?: () => void): void },
): AttachmentUIFixture {
	document.body.style.cssText = "margin:0;padding:24px";
	const host = document.createElement("div");
	host.id = "tiles";
	host.className = "flex flex-wrap gap-2";
	document.body.append(host);
	const fixture: AttachmentUIFixture = {
		closed: 0,
		deleted: [],
		open(attachment) {
			Overlay.open(attachment, () => fixture.closed++);
		},
		async tiles(attachments, showDelete = true) {
			host.replaceChildren();
			for (const attachment of attachments) {
				const tile = new Tile();
				tile.attachment = attachment;
				tile.showDelete = showDelete;
				tile.onDelete = () => fixture.deleted.push(attachment.id);
				host.append(tile);
				await tile.updateComplete;
			}
		},
	};
	window.attachmentFixture = fixture;
	return fixture;
}

declare global {
	interface Window {
		attachmentFixture: AttachmentUIFixture;
	}
}
