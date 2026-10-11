import type { Agent, BeforeToolCallResult } from "@earendil-works/pi-agent-core";

export function navigationSteeringGate(agent: Agent): BeforeToolCallResult | undefined {
	if (agent.peekQueuedMessages().some((message) => message.role === "navigation")) {
		return { block: true, reason: "Skipped due to queued user message." };
	}
	return undefined;
}
