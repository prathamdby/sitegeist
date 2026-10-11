import { AttachmentTile } from "@mariozechner/pi-web-ui/dist/components/AttachmentTile.js";
import { AttachmentOverlay } from "@mariozechner/pi-web-ui/dist/dialogs/AttachmentOverlay.js";
import { loadAttachment } from "@mariozechner/pi-web-ui/dist/utils/attachment-utils.js";
import "../../src/utils/i18n-extension.js";
import { installAttachmentFixture } from "./attachments-ui-fixture.js";

installAttachmentFixture(AttachmentTile, AttachmentOverlay);
Object.assign(window.attachmentFixture, { loadAttachment });
document.body.dataset.attachmentReady = "true";
