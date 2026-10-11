import type { Model } from "./models.js";

export function fuzzyScore(query: string, candidate: string): number | undefined {
	const needle = query.toLowerCase().replace(/\s/g, "");
	const haystack = candidate.toLowerCase().replace(/\s/g, "");
	if (!needle) return 0;
	let position = -1;
	let score = 0;
	for (const character of needle) {
		const next = haystack.indexOf(character, position + 1);
		if (next < 0) return undefined;
		if (position >= 0) score += next - position - 1;
		position = next;
	}
	return score;
}

export function filterModels(
	models: readonly Model[],
	current: Model | null,
	query: string,
	thinking: boolean,
	vision: boolean,
): Model[] {
	return models
		.filter((model) => (!thinking || model.reasoning) && (!vision || model.input.includes("image")))
		.map((model) => {
			return { model, score: fuzzyScore(query, `${model.provider} ${model.id} ${model.name}`) };
		})
		.filter((entry): entry is { model: Model; score: number } => entry.score !== undefined)
		.sort((left, right) => {
			const idOrder = left.model.id < right.model.id ? -1 : left.model.id > right.model.id ? 1 : 0;
			if (query.trim()) return left.score - right.score || idOrder;
			const leftCurrent = left.model.id === current?.id && left.model.provider === current?.provider;
			const rightCurrent = right.model.id === current?.id && right.model.provider === current?.provider;
			return (
				Number(rightCurrent) - Number(leftCurrent) ||
				left.model.provider.localeCompare(right.model.provider) ||
				idOrder
			);
		})
		.map(({ model }) => model);
}
