import type { Usage } from "@earendil-works/pi-ai";

export function formatTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

export function formatCost(cost: number): string {
	return `$${cost.toFixed(4)}`;
}

export function formatUsage(usage: Usage): string {
	return [
		usage.input ? `↑${formatTokenCount(usage.input)}` : "",
		usage.output ? `↓${formatTokenCount(usage.output)}` : "",
		usage.cacheRead ? `R${formatTokenCount(usage.cacheRead)}` : "",
		usage.cacheWrite ? `W${formatTokenCount(usage.cacheWrite)}` : "",
		usage.cost?.total ? formatCost(usage.cost.total) : "",
	]
		.filter(Boolean)
		.join(" ");
}
