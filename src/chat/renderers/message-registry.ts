import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TemplateResult } from "lit";

export interface MessageRenderer<TMessage extends AgentMessage = AgentMessage> {
	render(message: TMessage): TemplateResult;
}

const renderers = new Map<AgentMessage["role"], MessageRenderer>();

export function registerMessageRenderer<TRole extends AgentMessage["role"]>(
	role: TRole,
	renderer: MessageRenderer<Extract<AgentMessage, { role: TRole }>>,
): void {
	renderers.set(role, renderer as MessageRenderer);
}

export function getMessageRenderer(role: AgentMessage["role"]): MessageRenderer | undefined {
	return renderers.get(role);
}

export function renderMessage(message: AgentMessage): TemplateResult | undefined {
	return getMessageRenderer(message.role)?.render(message);
}
