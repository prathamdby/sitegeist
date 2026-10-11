import { resolve } from "node:path";

export function settingsBridge(root) {
	return {
		name: "sitegeist-settings",
		setup(build) {
			build.onResolve({ filter: /(?:^|\/)(?:ModelSelector|SettingsDialog)\.js$/ }, (args) => {
				if (
					!args.path.startsWith("@mariozechner/pi-web-ui/") &&
					!/[\\/]pi-(?:mono[\\/]packages[\\/]web-ui|web-ui)[\\/]/.test(args.importer)
				)
					return;
				return {
					path: resolve(
						root,
						"src/dialogs",
						args.path.slice(args.path.lastIndexOf("/") + 1).replace(/\.js$/, ".ts"),
					),
				};
			});
		},
	};
}
