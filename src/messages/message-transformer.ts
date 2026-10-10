import type { AgentMessage } from "../pi/agent.js";
import type { Message } from "../pi/models.js";
import type { NavigationMessage } from "./NavigationMessage.js";

// Helper: Check if a message has toolCall blocks
function hasToolCalls(msg: Message): boolean {
	if (msg.role !== "assistant") return false;
	return msg.content.some((block) => block.type === "toolCall");
}

// Helper: Get all toolCall IDs from an assistant message
function getToolCallIds(msg: Message): Set<string> {
	const ids = new Set<string>();
	if (msg.role !== "assistant") return ids;

	for (const block of msg.content) {
		if (block.type === "toolCall") {
			ids.add(block.id);
		}
	}
	return ids;
}

// Helper: Check if a toolResult message matches the given tool call IDs
function isToolResultFor(msg: Message, toolCallIds: Set<string>): boolean {
	if (msg.role !== "toolResult") return false;
	return toolCallIds.has(msg.toolCallId);
}

// Reorder messages so assistant tool calls are immediately followed by their tool results
// This moves navigation and other user messages after the tool results
function reorderMessages(messages: Message[]): Message[] {
	const result: Message[] = [];
	let i = 0;

	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === "assistant" && hasToolCalls(msg)) {
			// Found assistant with tool calls
			result.push(msg);
			i++;

			// Collect tool call IDs from this assistant message
			const toolCallIds = getToolCallIds(msg);

			// Scan forward and collect messages until next assistant or end
			const toolResultMessages: Message[] = [];
			const otherMessages: Message[] = [];

			while (i < messages.length && messages[i].role !== "assistant") {
				const nextMsg = messages[i];

				if (isToolResultFor(nextMsg, toolCallIds)) {
					toolResultMessages.push(nextMsg);
				} else {
					otherMessages.push(nextMsg);
				}
				i++;
			}

			// Add tool result messages first, then other messages (like nav)
			result.push(...toolResultMessages);
			result.push(...otherMessages);
		} else {
			// Not an assistant with tool calls, just add it
			result.push(msg);
			i++;
		}
	}

	return result;
}

// Custom message transformer for browser extension
// Handles navigation messages and app-specific message types
export async function browserMessageTransformer(messages: AgentMessage[]): Promise<Message[]> {
	const transformed: Message[] = [];

	for (const m of messages) {
		// Filter out UI-only messages
		if (m.role === "artifact" || m.role === "welcome") {
			continue;
		}

		// Filter non-LLM messages
		if (
			m.role !== "system" &&
			m.role !== "user" &&
			m.role !== "user-with-attachments" &&
			m.role !== "assistant" &&
			m.role !== "toolResult" &&
			m.role !== "navigation"
		) {
			continue;
		}

		if (m.role === "navigation") {
			const nav: NavigationMessage = m;
			const tabInfo = nav.tabId !== undefined ? ` (tab id: ${nav.tabId})` : "";

			// Use cached skills output (formatted at message creation time)
			const skillsInfo = nav.skillsOutput;

			transformed.push({
				role: "user",
				content: `<browser-context>
✓ Navigation succeeded: ${nav.title}${tabInfo}
✓ URL: ${nav.url}
</browser-context>

<skills>
${skillsInfo}
</skills>

<instructions>
- DO NOT STOP - This is informational only. CONTINUE IMMEDIATELY with the next step of your multi-step workflow. This message does NOT mean you should wait for user input.
- DO NOT REPEAT THIS MESSAGE BACK TO THE USER!
</instructions>`,
				timestamp: Date.now(),
			});
		} else if (m.role === "user-with-attachments") {
			const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : [...m.content];
			for (const attachment of m.attachments ?? []) {
				if (attachment.type === "image") {
					content.push({ type: "image", data: attachment.content, mimeType: attachment.mimeType });
				} else if (attachment.extractedText) {
					content.push({
						type: "text",
						text: `\n\n[Document: ${attachment.fileName}]\n${attachment.extractedText}`,
					});
				}
			}
			transformed.push({ role: "user", content, timestamp: m.timestamp });
		} else {
			transformed.push(m);
		}
	}

	return reorderMessages(transformed);
}
