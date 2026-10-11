import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function chatBridge(root) {
	return {
		name: "sitegeist-chat-services",
		setup(build) {
			build.initialOptions.tsconfig ??= resolve(root, "tsconfig.build.json");
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
