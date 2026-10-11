import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function attachmentBridge(root) {
	return {
		name: "sitegeist-attachment-services",
		setup(build) {
			build.initialOptions.tsconfig ??= resolve(root, "tsconfig.build.json");
			const attachments = new Map([
				["attachment-utils.js", "src/attachments/processing.ts"],
				["AttachmentTile.js", "src/attachments/AttachmentTile.ts"],
				["AttachmentOverlay.js", "src/attachments/AttachmentOverlay.ts"],
				["AttachmentsRuntimeProvider.js", "src/attachments/AttachmentsRuntimeProvider.ts"],
				["extract-document.js", "src/tools/extract-document.ts"],
			]);
			build.onResolve(
				{
					filter:
						/(?:^|\/)(?:attachment-utils|AttachmentTile|AttachmentOverlay|AttachmentsRuntimeProvider|extract-document)\.js$/,
				},
				(args) => {
					if (
						!args.path.startsWith("@mariozechner/pi-web-ui/") &&
						!/[\\/]pi-(?:mono[\\/]packages[\\/]web-ui|web-ui)[\\/]/.test(args.importer)
					)
						return;
					return { path: resolve(root, attachments.get(args.path.split("/").at(-1))) };
				},
			);
		},
	};
}

export function chatBridge(root) {
	return {
		name: "sitegeist-chat-services",
		setup(build) {
			attachmentBridge(root).setup(build);
			build.onResolve({ filter: /^@mariozechner\/pi-web-ui\/dist\// }, (args) => ({
				path: realpathSync(resolve(root, "node_modules", args.path)),
			}));
			build.onResolve({ filter: /(?:^|\/)renderer-registry\.js$/ }, (args) => {
				if (!/[\\/]pi-(?:mono[\\/]packages[\\/]web-ui|web-ui)[\\/]/.test(args.importer)) return;
				return { path: resolve(root, "src/chat/renderers/index.ts") };
			});
		},
	};
}
