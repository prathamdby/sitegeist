import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { chatBridge } from "../scripts/chat-bridge.mjs";
import { settingsBridge } from "../scripts/settings-bridge.mjs";
import { storageBridge } from "../scripts/storage-bridge.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let browser;
let server;
let directory;
let origin;
before(async () => {
	directory = mkdtempSync(join(tmpdir(), "sitegeist-chat-"));
	execFileSync(`${root}node_modules/.bin/tailwindcss`, ["-i", `${root}src/app.css`, "-o", join(directory, "app.css")]);
	const bundled = await build({
		entryPoints: ["tests/browser/chat-shell.ts"],
		absWorkingDir: root,
		bundle: true,
		write: false,
		platform: "browser",
		format: "esm",
		plugins: [storageBridge(root), settingsBridge(root), chatBridge(root)],
		define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
		inject: [`${root}scripts/process-shim.js`],
		alias: {
			process: `${root}scripts/process-shim.js`,
			"@mariozechner/pi-ai": `${root}src/pi/models.ts`,
			"@mariozechner/pi-agent-core": `${root}src/pi/agent.ts`,
			"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
			lit: `${root}node_modules/lit`,
		},
	});
	const sidepanelBuild = (entryPoint) =>
		build({
			entryPoints: [entryPoint],
			absWorkingDir: root,
			bundle: true,
			write: false,
			platform: "browser",
			format: "esm",
			plugins: [storageBridge(root), settingsBridge(root), chatBridge(root)],
			define: { "process.env.NODE_ENV": '"test"', global: "globalThis" },
			inject: [`${root}scripts/process-shim.js`],
			alias: {
				process: `${root}scripts/process-shim.js`,
				"@mariozechner/pi-ai": `${root}src/pi/models.ts`,
				"@mariozechner/pi-agent-core": `${root}src/pi/agent.ts`,
				"@mariozechner/mini-lit": `${root}node_modules/@mariozechner/mini-lit`,
				lit: `${root}node_modules/lit`,
			},
		});
	const [seed, sidepanel, baseline] = await Promise.all([
		sidepanelBuild("tests/browser/chat-sidepanel.ts"),
		sidepanelBuild("src/sidepanel.ts"),
		sidepanelBuild("tests/browser/chat-shell-baseline.ts"),
	]);
	const css = readFileSync(join(directory, "app.css"));
	server = createServer((request, response) => {
		if (request.url === "/baseline.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(baseline.outputFiles[0].text);
			return;
		}
		if (request.url === "/baseline") {
			response.setHeader("Content-Type", "text/html");
			response.end(
				'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><script type="module" src="/baseline.js"></script>',
			);
			return;
		}
		if (request.url === "/seed.js" || request.url === "/sidepanel.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(request.url === "/seed.js" ? seed.outputFiles[0].text : sidepanel.outputFiles[0].text);
			return;
		}
		if (request.url.startsWith("/header")) {
			response.setHeader("Content-Type", "text/html");
			response.end(
				'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><script type="module" src="/seed.js"></script>',
			);
			return;
		}
		response.setHeader(
			"Content-Type",
			request.url === "/fixture.js" ? "text/javascript" : request.url === "/app.css" ? "text/css" : "text/html",
		);
		response.end(
			request.url === "/fixture.js"
				? bundled.outputFiles[0].text
				: request.url === "/app.css"
					? css
					: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><script type="module" src="/fixture.js"></script>',
		);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${server.address().port}`;
	const executablePath =
		process.env.CHROMIUM_PATH ||
		["/usr/local/bin/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find(existsSync);
	browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
});
after(async () => {
	await browser?.close();
	await new Promise((resolve) => server?.close(resolve) ?? resolve());
	if (directory) rmSync(directory, { recursive: true, force: true });
});
async function fixture(width = 1200) {
	const page = await browser.newPage({ viewport: { width, height: 800 } });
	page.on("pageerror", (error) => console.error(error));
	await page.goto(origin);
	await page.waitForFunction(() => window.chatFixture);
	return page;
}

test("composer Enter, Shift+Enter, whitespace and model/thinking/cost controls match baseline", async () => {
	const page = await fixture();
	try {
		const textarea = page.locator("textarea");
		await textarea.fill("   ");
		assert.equal(await page.locator("sitegeist-message-editor button").last().isDisabled(), true);
		await textarea.press("Enter");
		assert.equal(await textarea.inputValue(), "   ");
		await textarea.fill("  original spacing  ");
		await textarea.press("Shift+Enter");
		assert.equal(await textarea.inputValue(), "  original spacing  \n");
		await textarea.press("Enter");
		await page.waitForFunction(() =>
			window.chatFixture.agent.state.messages.some(
				(message) =>
					message.role === "assistant" &&
					message.content.some((item) => item.type === "text" && item.text === "Streaming fixture reply"),
			),
		);
		assert.equal(await textarea.inputValue(), "");
		assert.equal(
			await page.evaluate(
				() =>
					window.chatFixture.agent.state.messages.filter((message) => message.role === "user").at(-1).content[0]
						.text,
			),
			"  original spacing  \n",
		);
		await page.locator("sitegeist-message-editor button[role=combobox]").click();
		await page.getByRole("option", { name: "High", exact: true }).click();
		assert.equal(await page.evaluate(() => window.chatFixture.agent.state.thinkingLevel), "high");
		await page.locator("sitegeist-message-editor button").filter({ hasText: "claude-sonnet" }).click();
		await page.locator("sitegeist-agent-interface .h-5 span").click();
		assert.deepEqual(await page.evaluate(() => window.chatFixture.events), [["beforeSend"], ["model"], ["cost"]]);
	} finally {
		await page.close();
	}
});

test("API key denial and before-send rejection retain the complete composer", async () => {
	const page = await fixture();
	try {
		await page.evaluate(async () => {
			window.chatFixture.setInput("preserved", [
				{
					id: "doc",
					type: "document",
					fileName: "fixture.txt",
					mimeType: "text/plain",
					size: 7,
					content: "Zml4dHVyZQ==",
					extractedText: "fixture",
				},
			]);
			await window.chatFixture.keyDenied();
		});
		assert.equal(await page.evaluate(() => window.chatFixture.sendDirect("preserved")), null);
		assert.equal(await page.locator("textarea").inputValue(), "preserved");
		assert.equal(await page.locator("attachment-tile").count(), 1);
		assert.deepEqual(await page.evaluate(() => window.chatFixture.events), []);
		await page.evaluate(async () => {
			await window.chatFixture.keyGranted();
			window.chatFixture.rejectBeforeSend();
		});
		assert.equal(await page.evaluate(() => window.chatFixture.sendDirect("preserved")), "Fixture rejected");
		assert.equal(await page.locator("textarea").inputValue(), "preserved");
		assert.equal(await page.locator("attachment-tile").count(), 1);
	} finally {
		await page.close();
	}
});

test("true pre-run prompt rejection restores the draft and attachments without overwriting a newer draft", async () => {
	const page = await fixture();
	try {
		await page.evaluate(() => {
			window.chatFixture.setInput("Recover this draft", [
				{
					id: "file",
					type: "document",
					fileName: "saved.txt",
					mimeType: "text/plain",
					size: 4,
					content: "dGVzdA==",
					extractedText: "test",
				},
			]);
			window.chatFixture.agent.prompt = async () => {
				throw new Error("Fixture pre-run rejection");
			};
		});
		assert.equal(
			await page.evaluate(() => window.chatFixture.sendDirect("Recover this draft")),
			"Fixture pre-run rejection",
		);
		assert.equal(await page.locator("textarea").inputValue(), "Recover this draft");
		assert.equal(await page.locator("attachment-tile").count(), 1);
		await page.evaluate(() => {
			window.chatFixture.agent.prompt = async () => {
				window.chatFixture.setInput("Newer draft");
				throw new Error("Fixture pre-run rejection");
			};
		});
		await page.evaluate(() => window.chatFixture.sendDirect("Recover this draft"));
		assert.equal(await page.locator("textarea").inputValue(), "Newer draft");
	} finally {
		await page.close();
	}
});

test("legacy assistant usage without cost or usage still renders the conversation and token footer", async () => {
	const page = await fixture();
	try {
		await page.evaluate(async () => {
			const { agent, controller } = window.chatFixture;
			const message = structuredClone(agent.state.messages.find((item) => item.role === "assistant"));
			delete message.usage.cost;
			const withoutUsage = { ...structuredClone(message), timestamp: 42 };
			delete withoutUsage.usage;
			agent.replaceMessages([message, withoutUsage]);
			controller.requestUpdate();
			await controller.updateComplete;
		});
		assert.equal(await page.locator("sitegeist-assistant-message").count(), 2);
		assert.equal((await page.locator("sitegeist-agent-interface .h-5").innerText()).trim(), "↑1.2k ↓234 R500");
	} finally {
		await page.close();
	}
});

test("streaming text is not duplicated and Escape only aborts from the textarea", async () => {
	const page = await fixture();
	try {
		await page.evaluate(() => window.chatFixture.holdStream(true));
		await page.locator("textarea").fill("stream probe");
		await page.locator("textarea").press("Enter");
		await page.getByText("Streaming fixture reply", { exact: true }).waitFor();
		assert.equal(await page.getByText("Streaming fixture reply", { exact: true }).count(), 1);
		await page.locator("sitegeist-thinking-block .thinking-header").click();
		await page.getByText("Fixture reasoning", { exact: true }).waitFor();
		assert.equal(await page.getByText("Fixture reasoning", { exact: true }).count(), 1);
		await page.locator("sitegeist-message-editor button").first().focus();
		await page.keyboard.press("Escape");
		assert.equal(await page.evaluate(() => window.chatFixture.agent.state.isStreaming), true);
		await page.locator("textarea").fill("retained while streaming");
		await page.locator("textarea").press("Enter");
		assert.equal(
			await page.evaluate(
				() => window.chatFixture.agent.state.messages.filter((message) => message.role === "user").length,
			),
			2,
		);
		await page.evaluate(() => window.chatFixture.releaseStream());
		await page.waitForFunction(() => !window.chatFixture.agent.state.isStreaming);
		assert.equal(await page.getByText("Streaming fixture reply", { exact: true }).count(), 1);
		assert.equal(await page.getByText("Fixture reasoning", { exact: true }).count(), 1);
		assert.equal(await page.locator("textarea").inputValue(), "retained while streaming");
		await page.locator("textarea").press("Enter");
		await page.waitForFunction(() => window.chatFixture.agent.state.isStreaming);
		await page.locator("textarea").fill("after abort");
		await page.locator("textarea").press("Escape");
		await page.waitForFunction(() => !window.chatFixture.agent.state.isStreaming);
		assert.equal(await page.locator("textarea").inputValue(), "after abort");
		await page.locator("sitegeist-message-editor button").last().click();
		await page.waitForFunction(() => window.chatFixture.agent.state.isStreaming);
		await page.locator("textarea").fill("retained after stop click");
		await page.locator("sitegeist-message-editor button").last().click();
		await page.waitForFunction(() => !window.chatFixture.agent.state.isStreaming);
		assert.equal(await page.locator("textarea").inputValue(), "retained after stop click");
	} finally {
		await page.close();
	}
});

test("pre-token pending cursor gives way to one streamed reasoning/text message and clears on completion", async () => {
	const page = await fixture();
	try {
		await page.evaluate(() => {
			window.chatFixture.holdStream(true);
			window.chatFixture.delayStreamStart(true);
		});
		await page.locator("textarea").fill("Pending fixture");
		await page.locator("textarea").press("Enter");
		await page.locator("sitegeist-agent-interface .animate-pulse").waitFor();
		assert.equal(
			await page.locator("sitegeist-agent-interface .animate-pulse").getAttribute("class"),
			"mx-4 inline-block w-2 h-4 bg-muted-foreground animate-pulse",
		);
		await page.evaluate(() => window.chatFixture.releaseStreamStart());
		await page.getByText("Streaming fixture reply", { exact: true }).waitFor();
		assert.equal(await page.locator("sitegeist-agent-interface .animate-pulse").count(), 0);
		assert.equal(await page.locator("sitegeist-thinking-block .animate-shimmer").count(), 1);
		await page.evaluate(() => window.chatFixture.releaseStream());
		await page.waitForFunction(() => !window.chatFixture.agent.state.isStreaming);
		assert.equal(await page.getByText("Streaming fixture reply", { exact: true }).count(), 1);
		assert.equal(await page.locator("sitegeist-agent-interface .animate-pulse").count(), 0);
	} finally {
		await page.close();
	}
});

test("autoscroll yields away from the bottom, resumes within 50 pixels and follows viewport resizing", async () => {
	const page = await fixture(390);
	try {
		await page.evaluate(async () => {
			const { agent, controller } = window.chatFixture;
			const original = agent.state.messages.find((message) => message.role === "assistant");
			for (let index = 0; index < 30; index++)
				agent.appendMessage({ ...structuredClone(original), timestamp: 1000 + index });
			controller.requestUpdate();
			await controller.updateComplete;
		});
		await page.waitForFunction(() => {
			const area = document.querySelector("sitegeist-agent-interface .flex-1.overflow-y-auto");
			return area.scrollHeight - area.scrollTop - area.clientHeight <= 1;
		});
		const previousTop = await page.evaluate(() => {
			const area = document.querySelector("sitegeist-agent-interface .flex-1.overflow-y-auto");
			area.scrollTop = area.scrollHeight - area.clientHeight - 100;
			area.dispatchEvent(new Event("scroll"));
			return area.scrollTop;
		});
		await page.evaluate(async () => {
			const { agent, controller } = window.chatFixture;
			agent.appendMessage({
				...structuredClone(agent.state.messages.find((message) => message.role === "assistant")),
				timestamp: 2000,
			});
			controller.requestUpdate();
			await controller.updateComplete;
		});
		assert.equal(
			await page.locator("sitegeist-agent-interface .flex-1.overflow-y-auto").evaluate((area) => area.scrollTop),
			previousTop,
		);
		await page.setViewportSize({ width: 390, height: 650 });
		assert.equal(
			await page.locator("sitegeist-agent-interface .flex-1.overflow-y-auto").evaluate((area) => area.scrollTop),
			previousTop,
		);
		await page.evaluate(async () => {
			const { agent, controller } = window.chatFixture;
			const area = controller.querySelector(".flex-1.overflow-y-auto");
			area.scrollTop = area.scrollHeight - area.clientHeight - 50;
			area.dispatchEvent(new Event("scroll"));
			agent.appendMessage({
				...structuredClone(agent.state.messages.find((message) => message.role === "assistant")),
				timestamp: 3000,
			});
			controller.requestUpdate();
			await controller.updateComplete;
		});
		await page.setViewportSize({ width: 420, height: 800 });
		await page.waitForFunction(() => {
			const area = document.querySelector("sitegeist-agent-interface .flex-1.overflow-y-auto");
			return area.scrollHeight - area.scrollTop - area.clientHeight <= 1;
		});
	} finally {
		await page.close();
	}
});

test("queued scroll events after content grows do not disable active autoscroll", async () => {
	const page = await fixture(390);
	try {
		const state = await page.evaluate(async () => {
			const { agent, controller } = window.chatFixture;
			const original = agent.state.messages.find((message) => message.role === "assistant");
			for (let index = 0; index < 30; index++)
				agent.appendMessage({ ...structuredClone(original), timestamp: 4000 + index });
			controller.requestUpdate();
			await controller.updateComplete;
			for (let depth = 0; depth < 4; depth++)
				await Promise.all([...controller.querySelectorAll("*")].map((element) => element.updateComplete));
			controller.setAutoScroll(true);
			const area = controller.querySelector(".flex-1.overflow-y-auto");
			area.dispatchEvent(new Event("scroll"));
			const top = area.scrollTop;
			agent.appendMessage({ ...structuredClone(original), timestamp: 5000 });
			controller.requestUpdate();
			await controller.updateComplete;
			for (let depth = 0; depth < 4; depth++)
				await Promise.all([...controller.querySelectorAll("*")].map((element) => element.updateComplete));
			const distance = area.scrollHeight - area.scrollTop - area.clientHeight;
			area.dispatchEvent(new Event("scroll"));
			return { top, newTop: area.scrollTop, distance };
		});
		assert.equal(state.newTop, state.top);
		assert.ok(state.distance > 50);
		await page.waitForFunction(
			() => {
				const area = document.querySelector("sitegeist-agent-interface .flex-1.overflow-y-auto");
				return area.scrollHeight - area.scrollTop - area.clientHeight <= 1;
			},
			undefined,
			{ timeout: 3000 },
		);
	} finally {
		await page.close();
	}
});

test("composer drag, processing and attachment-strip presentation preserve the measured baseline", async () => {
	const page = await fixture();
	try {
		await page.evaluate(async () => {
			const editor = document.querySelector("sitegeist-message-editor");
			editor.isDragging = true;
			await editor.updateComplete;
		});
		assert.equal(
			await page.locator("sitegeist-message-editor > div").getAttribute("class"),
			"bg-card rounded-xl border shadow-sm relative border-primary border-2 bg-primary/5",
		);
		assert.equal(
			await page.locator("sitegeist-message-editor .absolute > div").getAttribute("class"),
			"text-primary font-medium",
		);
		await page.evaluate(async () => {
			const editor = document.querySelector("sitegeist-message-editor");
			editor.isDragging = false;
			editor.processingFiles = true;
			await editor.updateComplete;
		});
		assert.equal(
			await page.locator("sitegeist-message-editor .animate-spin").evaluate((icon) => icon.parentElement.className),
			"h-8 w-8 flex items-center justify-center",
		);
		assert.equal(
			await page.locator("sitegeist-message-editor .animate-spin").evaluate((icon) => icon.closest("button")),
			null,
		);
		assert.equal(await page.locator("sitegeist-message-editor button").last().isDisabled(), true);
		await page.evaluate(async () => {
			document.querySelector("sitegeist-message-editor").processingFiles = false;
			window.chatFixture.setInput("", [
				{
					id: "a",
					type: "document",
					fileName: "file.txt",
					mimeType: "text/plain",
					size: 4,
					content: "dGVzdA==",
					extractedText: "test",
				},
			]);
		});
		assert.equal(
			await page.locator("attachment-tile").evaluate((tile) => tile.parentElement.className),
			"px-4 pt-3 pb-2 flex flex-wrap gap-2",
		);
	} finally {
		await page.close();
	}
});

test("German composer thinking choices and artifact pill retain their baseline translations", async () => {
	const page = await fixture();
	try {
		await page.evaluate(() => window.chatFixture.language("de"));
		await page.waitForFunction(() =>
			document.querySelector("sitegeist-message-editor button[role=combobox]")?.textContent.includes("Mittel"),
		);
		await page.evaluate(async () => {
			await window.chatFixture.createArtifact();
			window.chatFixture.panel.artifactsPanel.onClose();
		});
		await page.getByTitle("Artefakte anzeigen").waitFor();
		assert.match(await page.getByTitle("Artefakte anzeigen").innerText(), /Artefakte/);
		const thinking = page.locator("sitegeist-message-editor button[role=combobox]");
		assert.match(await thinking.innerText(), /Mittel/);
		await thinking.click();
		await page.getByRole("option", { name: "Hoch", exact: true }).click();
		assert.equal(await page.evaluate(() => window.chatFixture.agent.state.thinkingLevel), "high");
	} finally {
		await page.close();
	}
});

test("attachment limits skip oversized and unsupported files while accepting later valid files", async () => {
	const page = await fixture();
	const alerts = [];
	page.on("dialog", async (dialog) => {
		alerts.push(dialog.message());
		await dialog.accept();
	});
	try {
		const picker = page.locator('input[type="file"]');
		await picker.setInputFiles([
			{ name: "too-big.txt", mimeType: "text/plain", buffer: Buffer.alloc(21 * 1024 * 1024) },
			{ name: "file.bad", mimeType: "application/octet-stream", buffer: Buffer.from("unsupported") },
			{ name: "valid.txt", mimeType: "text/plain", buffer: Buffer.from("Fixture text") },
		]);
		await page.locator("attachment-tile").waitFor();
		assert.equal(await page.locator("attachment-tile").count(), 1);
		assert.deepEqual(alerts, [
			"too-big.txt exceeds maximum size of 20MB",
			"Failed to process file.bad: Error: Unsupported file type: application/octet-stream",
		]);
		await page.evaluate(() =>
			window.chatFixture.setInput(
				"",
				Array.from({ length: 10 }, (_, index) => ({
					id: `doc-${index}`,
					type: "document",
					fileName: `fixture-${index}.txt`,
					mimeType: "text/plain",
					size: 7,
					content: "Zml4dHVyZQ==",
					extractedText: "fixture",
				})),
			),
		);
		await picker.setInputFiles({ name: "eleventh.txt", mimeType: "text/plain", buffer: Buffer.from("extra") });
		assert.equal(alerts.at(-1), "Maximum 10 files allowed");
		assert.equal(await page.locator("attachment-tile").count(), 10);
		await page.evaluate(() => window.chatFixture.setInput("", []));
		const transfer = await page.evaluateHandle(() => {
			const data = new DataTransfer();
			data.items.add(new File(["binary fixture"], "unsupported.exe", { type: "application/octet-stream" }));
			data.items.add(new File(["print('fixture')"], "source.py", { type: "text/plain" }));
			return data;
		});
		await page.locator("sitegeist-message-editor > div").dispatchEvent("drop", { dataTransfer: transfer });
		await page.waitForFunction(() => document.querySelector("attachment-tile")?.attachment.fileName === "source.py");
		assert.equal(await page.locator("attachment-tile").count(), 1);
		assert.equal(
			alerts.at(-1),
			"Failed to process unsupported.exe: Error: Unsupported file type: application/octet-stream",
		);
		await transfer.dispose();
	} finally {
		await page.close();
	}
});

test("artifacts auto-open, close to the centered count pill and resize at 800px", async () => {
	const page = await fixture();
	try {
		await page.evaluate(() => window.chatFixture.createArtifact());
		await page.getByTitle("Close artifacts").waitFor();
		assert.equal(await page.evaluate(() => window.chatFixture.panel.artifactsPanel.overlay), false);
		assert.equal(
			await page.evaluate(() => window.chatFixture.panel.artifactsPanel.getBoundingClientRect().width),
			600,
		);
		await page.getByTitle("Close artifacts").click();
		const pill = page.getByTitle("Show artifacts");
		await pill.waitFor();
		const bounds = await pill.boundingBox();
		assert.ok(Math.abs(bounds.x + bounds.width / 2 - 600) < 1);
		await pill.click();
		await page.setViewportSize({ width: 799, height: 800 });
		await page.waitForFunction(() => window.chatFixture.panel.artifactsPanel.overlay);
		assert.equal(
			await page.evaluate(() => window.chatFixture.panel.artifactsPanel.getBoundingClientRect().width),
			799,
		);
		await page.setViewportSize({ width: 800, height: 800 });
		await page.waitForFunction(() => !window.chatFixture.panel.artifactsPanel.overlay);
		assert.equal(
			await page.evaluate(() => window.chatFixture.panel.artifactsPanel.getBoundingClientRect().width),
			400,
		);
		await page.getByTitle("Close artifacts").click();
		await pill.waitFor();
		await page.evaluate(() =>
			window.chatFixture.agent.state.tools
				.find((tool) => tool.name === "artifacts")
				.execute("update-fixture", {
					command: "update",
					filename: "notes.md",
					old_str: "Reusable",
					new_str: "Updated",
				}),
		);
		assert.equal(await page.evaluate(() => window.chatFixture.panel.artifactsPanel.collapsed), true);
		assert.equal(await pill.isVisible(), true);
		await page.evaluate(() =>
			window.chatFixture.agent.state.tools
				.find((tool) => tool.name === "artifacts")
				.execute("delete-fixture", { command: "delete", filename: "notes.md" }),
		);
		await pill.waitFor({ state: "detached" });
		assert.equal(await page.evaluate(() => window.chatFixture.panel.artifactsPanel.artifacts.size), 0);
		await page.evaluate(async () => {
			const { agent, panel } = window.chatFixture;
			agent.appendMessage({
				role: "artifact",
				action: "create",
				filename: "restored.md",
				content: "# Saved artifact",
				timestamp: "2026-10-11T00:00:00.000Z",
			});
			await panel.setAgent(agent, { toolsFactory: () => [] });
			await panel.updateComplete;
		});
		await pill.waitFor();
		assert.equal(await page.evaluate(() => window.chatFixture.panel.artifactsPanel.collapsed), true);
		assert.equal(
			await page.evaluate(() => window.chatFixture.panel.artifactsPanel.artifacts.get("restored.md").content),
			"# Saved artifact",
		);
	} finally {
		await page.close();
	}
});

test("light, narrow and dark fixtures retain composer dimensions and produce reusable renders", async () => {
	for (const [name, width, dark] of [
		["wide-light", 1200, false],
		["narrow-light", 390, false],
		["wide-dark", 1200, true],
	]) {
		const page = await fixture(width);
		const baseline = await browser.newPage({ viewport: { width, height: 800 } });
		baseline.on("pageerror", (error) => console.error(error.stack ?? error.message));
		try {
			await baseline.goto(`${origin}/baseline`);
			await baseline.waitForFunction(() => document.body.dataset.baselineReady === "true");
			if (dark)
				await Promise.all(
					[page, baseline].map((view) => view.evaluate(() => document.documentElement.classList.add("dark"))),
				);
			await page.waitForTimeout(350);
			const bounds = await page.locator("sitegeist-message-editor > div").boundingBox();
			const expected = await baseline.locator("message-editor > div").boundingBox();
			assert.deepEqual(bounds, expected);
			assert.equal(bounds.width, width === 1200 ? 752 : 374);
			if (process.env.CHAT_RENDER_DIR) {
				mkdirSync(process.env.CHAT_RENDER_DIR, { recursive: true });
				await page.screenshot({ path: join(process.env.CHAT_RENDER_DIR, `${name}-after.png`) });
				await page.evaluate(() => window.chatFixture.createArtifact());
				await page.getByTitle("Close artifacts").waitFor();
				await page.waitForTimeout(350);
				await page.screenshot({ path: join(process.env.CHAT_RENDER_DIR, `${name}-artifact-after.png`) });
			}
		} finally {
			await page.close();
			await baseline.close();
		}
	}
});

test("actual sidepanel header opens history, persists Enter title, cancels Escape and opens costs", async () => {
	const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
	page.on("pageerror", (error) => console.error(error));
	await page.route("https://**", (route) => route.abort());
	try {
		await page.goto(`${origin}/header?session=header-fixture`);
		const title = page.getByTitle("Click to edit title");
		await title.waitFor();
		assert.equal(await title.textContent().then((value) => value.trim()), "Fixture original title");
		await page.getByTitle("Sessions", { exact: true }).click();
		await page.locator("sitegeist-session-list-dialog").waitFor({ state: "attached" });
		await page
			.locator("sitegeist-session-list-dialog")
			.getByText("Fixture original title", { exact: true })
			.waitFor();
		await page.keyboard.press("Escape");
		await page.locator("sitegeist-session-list-dialog").waitFor({ state: "detached" });
		await title.click();
		const input = page.locator('input[type="text"]');
		await input.fill("  Renamed fixture  ");
		await input.press("Enter");
		await page.waitForFunction(
			() => document.querySelector('[title="Click to edit title"]')?.textContent?.trim() === "Renamed fixture",
		);
		assert.equal(
			await page.evaluate(
				async () => (await window.headerFixture.storage.sessions.loadSession("header-fixture")).title,
			),
			"Renamed fixture",
		);
		assert.equal(
			await page.evaluate(
				async () => (await window.headerFixture.storage.sessions.getMetadata("header-fixture")).title,
			),
			"Renamed fixture",
		);
		await title.click();
		await input.fill("Cancelled title");
		await input.press("Escape");
		assert.equal(await title.textContent().then((value) => value.trim()), "Renamed fixture");
		assert.equal(
			await page.evaluate(
				async () => (await window.headerFixture.storage.sessions.loadSession("header-fixture")).title,
			),
			"Renamed fixture",
		);
		await page.locator("sitegeist-agent-interface .h-5 span").click();
		await page.getByText("Session Cost Analysis", { exact: true }).waitFor();
	} finally {
		await page.close();
	}
});
