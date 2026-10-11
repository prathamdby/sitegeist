import { GlobalWorkerOptions } from "pdfjs-dist";
import { AttachmentOverlay } from "../../src/attachments/AttachmentOverlay.js";
import { AttachmentsRuntimeProvider } from "../../src/attachments/AttachmentsRuntimeProvider.js";
import { loadAttachment } from "../../src/attachments/processing.js";
import type { Attachment } from "../../src/attachments/types.js";
import { executeJavaScript } from "../../src/tools/repl/repl.js";

const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) =>
	violations.push(`${event.violatedDirective}: ${event.blockedURI}`),
);

const fixture = {
	violations,
	async pdf(base64: string) {
		const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
		const attachment = await loadAttachment(new File([bytes], "csp.pdf", { type: "application/pdf" }));
		return { attachment, workerSrc: GlobalWorkerOptions.workerSrc };
	},
	preview(attachment: Attachment) {
		AttachmentOverlay.open(attachment);
	},
	async repl() {
		const attachment = await loadAttachment(new File(["restored text"], "restored.txt", { type: "text/plain" }));
		return executeJavaScript(
			"const files = listAttachments(); console.log(files[0].fileName); console.log(readTextAttachment(files[0].id)); console.log(Array.from(readBinaryAttachment(files[0].id)).join(','));",
			[new AttachmentsRuntimeProvider([structuredClone(attachment)])],
			undefined,
			() => chrome.runtime.getURL("sandbox.html"),
		);
	},
};

declare global {
	interface Window {
		attachmentCspFixture: typeof fixture;
	}
}
window.attachmentCspFixture = fixture;
