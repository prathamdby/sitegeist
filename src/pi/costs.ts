import type { AgentMessage } from "@earendil-works/pi-agent-core";

export class CostRecorder {
	private readonly recorded = new WeakSet<AgentMessage>();

	seed(messages: readonly AgentMessage[]): void {
		for (const message of messages) this.recorded.add(message);
	}

	take(message: AgentMessage): { provider: string; model: string; cost: number } | undefined {
		if (message.role !== "assistant" || !(message.usage?.cost?.total > 0) || this.recorded.has(message)) {
			return undefined;
		}
		this.recorded.add(message);
		return { provider: message.provider, model: message.model, cost: message.usage.cost.total };
	}
}
