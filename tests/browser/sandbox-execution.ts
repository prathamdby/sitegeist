import { ArtifactsRuntimeProvider } from "../../src/artifacts/ArtifactsRuntimeProvider.js";
import { AttachmentsRuntimeProvider } from "../../src/attachments/AttachmentsRuntimeProvider.js";
import { FileDownloadRuntimeProvider } from "../../src/sandbox/FileDownloadRuntimeProvider.js";
import { SandboxIframe } from "../../src/sandbox/SandboxIframe.js";
import type { SandboxRuntimeProvider } from "../../src/sandbox/types.js";
import { SitegeistAppStorage, setAppStorage } from "../../src/storage/app-storage.js";
import { skillTool } from "../../src/tools/skill.js";

const storage = new SitegeistAppStorage();
setAppStorage(storage);

let active: SandboxIframe | undefined;
let controller: AbortController | undefined;
const lifecycle: string[] = [];
const violations: string[] = [];
const artifactMessages: Array<{ role: string; action: string; filename: string; content?: string }> = [];
const artifacts = new Map<string, { content: string }>();
document.addEventListener("securitypolicyviolation", (event) => violations.push(event.violatedDirective));

const fixture = {
	lifecycle,
	violations,
	artifactMessages,
	async skill(action: "create" | "rewrite", library: string) {
		controller = new AbortController();
		try {
			await skillTool.execute(
				"skill-fixture",
				{
					action,
					name: "fixture-skill",
					data: {
						name: "fixture-skill",
						domainPatterns: ["fixture.invalid"],
						shortDescription: "Fixture",
						description: "Fixture",
						examples: "fixtureFunction()",
						library,
					},
				},
				controller.signal,
			);
			return { success: true, saved: (await storage.skills.getSkill("fixture-skill"))?.library };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				saved: (await storage.skills.getSkill("fixture-skill"))?.library,
			};
		}
	},
	async execute(code: string, packaged = true) {
		controller = new AbortController();
		const sandbox = new SandboxIframe();
		active = sandbox;
		if (packaged) sandbox.sandboxUrlProvider = () => chrome.runtime.getURL("sandbox.html");
		sandbox.style.display = "none";
		document.body.append(sandbox);
		const provider: SandboxRuntimeProvider = {
			getData: () => ({ number: 7 }),
			getDescription: () => "Fixture async runtime",
			getRuntime: () => () => {
				const target = window as unknown as {
					sendRuntimeMessage: (message: { type: string }) => Promise<{ value: number }>;
					asyncNumber: () => Promise<number>;
				};
				target.asyncNumber = async () => (await target.sendRuntimeMessage({ type: "fixture-number" })).value;
			},
			async handleMessage(message, respond) {
				if (message.type !== "fixture-number") return;
				await new Promise((resolve) => setTimeout(resolve, 10));
				respond({ success: true, value: 14 });
			},
			onExecutionStart: () => lifecycle.push("start"),
			onExecutionEnd: () => lifecycle.push("end"),
		};
		try {
			return await sandbox.execute(
				crypto.randomUUID(),
				code,
				[
					provider,
					new FileDownloadRuntimeProvider(),
					new ArtifactsRuntimeProvider(
						{
							artifacts,
							tool: {
								async execute(_id, args) {
									if (args.command === "delete") artifacts.delete(args.filename);
									else artifacts.set(args.filename, { content: args.content ?? "" });
									return { content: [{ type: "text", text: "" }] };
								},
							},
						},
						{
							appendMessage(message) {
								artifactMessages.push(message);
							},
						},
						true,
					),
					new AttachmentsRuntimeProvider([
						{
							id: "restored",
							type: "document",
							fileName: "restored.txt",
							mimeType: "text/plain",
							size: 4,
							content: "AAH+/w==",
							extractedText: "restored text",
						},
					]),
				],
				[],
				controller.signal,
			);
		} finally {
			sandbox.remove();
			if (active === sandbox) active = undefined;
		}
	},
	abort() {
		controller?.abort();
	},
	disconnect() {
		active?.remove();
	},
};

declare global {
	interface Window {
		sandboxExecutionFixture: typeof fixture;
	}
}
window.sandboxExecutionFixture = fixture;
