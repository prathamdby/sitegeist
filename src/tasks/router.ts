export interface RunnerEndpoint {
	postMessage(message: unknown): void;
}

export function deliverRunnerMessage(
	runners: ReadonlyMap<number, RunnerEndpoint>,
	views: ReadonlyMap<number, ReadonlySet<RunnerEndpoint>>,
	ownerTabId: number,
	source: "view" | "runner",
	message: unknown,
): void {
	if (source === "view") {
		runners.get(ownerTabId)?.postMessage(message);
		return;
	}
	for (const view of views.get(ownerTabId) ?? []) view.postMessage(message);
}
