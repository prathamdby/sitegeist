import { resolve } from "node:path";

export function storageBridge(root) {
	return {
		name: "sitegeist-storage",
		setup(build) {
			build.onResolve({ filter: /(?:^|\/)storage\/.+\.js$/ }, (args) => {
				if (
					!args.path.startsWith("@mariozechner/pi-web-ui/") &&
					!/[\\/]pi-(?:mono[\\/]packages[\\/]web-ui|web-ui)[\\/]/.test(args.importer)
				)
					return;
				const path = args.path.slice(args.path.indexOf("storage/") + "storage/".length);
				const local = path === "stores/sessions-store.js" ? "stores/base-sessions-store.js" : path;
				return { path: resolve(root, "src/storage", local.replace(/\.js$/, ".ts")) };
			});
		},
	};
}
