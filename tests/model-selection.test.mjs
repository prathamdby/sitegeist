import assert from "node:assert/strict";
import test from "node:test";
import { filterModels, fuzzyScore } from "../src/pi/model-search.ts";
import { getModel, getModels, ModelConfiguration } from "../src/pi/models.ts";
import { applyModelSelection, resolveInitialModel, selectionRequiredModel } from "../src/pi/selection.ts";

test("subsequence search removes whitespace, ranks contiguous matches and retains provider filtering", () => {
	assert.equal(fuzzyScore("g p t 5 4", "gpt-5.4"), 2);
	assert.equal(fuzzyScore("not-present", "gpt-5.4"), undefined);
	const models = [...getModels("anthropic"), ...getModels("openai")];
	const current = getModel("anthropic", "claude-sonnet-4-5");
	assert.equal(filterModels(models, current, "", false, false)[0], current);
	const matches = filterModels(models, current, "gpt54", false, false);
	assert.deepEqual(
		matches.map((model) => model.id),
		["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro", "gpt-4o-2024-05-13"],
	);
	assert.ok(
		filterModels(models, current, "op ai", false, false)
			.slice(0, getModels("openai").length)
			.every((model) => model.provider === "openai"),
	);
	assert.ok(
		filterModels(models, current, "", true, true).every((model) => model.reasoning && model.input.includes("image")),
	);
	const fixtures = [
		{ ...current, id: "plain", reasoning: false, input: ["text"] },
		{ ...current, id: "vision", reasoning: false, input: ["text", "image"] },
		{ ...current, id: "thinking", reasoning: true, input: ["text"] },
		{ ...current, id: "both", reasoning: true, input: ["text", "image"] },
	];
	assert.deepEqual(
		filterModels(fixtures, null, "", true, false).map((model) => model.id),
		["both", "thinking"],
	);
	assert.deepEqual(
		filterModels(fixtures, null, "", false, true).map((model) => model.id),
		["both", "vision"],
	);
	assert.deepEqual(
		filterModels(fixtures, null, "", true, true).map((model) => model.id),
		["both"],
	);
});

test("saved selections remain authoritative; absent selections use defaults without switching removed routes", async () => {
	const configuration = new ModelConfiguration(async () => []);
	const saved = { ...getModel("openai", "gpt-4o-mini"), baseUrl: "https://stale.invalid" };
	assert.equal(
		await resolveInitialModel(configuration, saved, true, ["anthropic"]),
		getModel("openai", "gpt-4o-mini"),
	);
	assert.equal(
		await resolveInitialModel(configuration, null, false, ["opencode"]),
		getModel("opencode", "claude-opus-4-6"),
	);
	assert.equal(
		await resolveInitialModel(configuration, { provider: "google-gemini-cli", id: "old" }, true, ["anthropic"]),
		selectionRequiredModel,
	);
	assert.equal(
		await resolveInitialModel(configuration, { provider: "openai", id: "missing" }, true, ["anthropic"]),
		selectionRequiredModel,
	);
	assert.equal(await resolveInitialModel(configuration, null, false, []), selectionRequiredModel);
});

test("model selection refreshes immediately while saved selection waits for persistence", async () => {
	const events = [];
	let finish;
	const model = getModel("openai", "gpt-4o-mini");
	const pending = applyModelSelection(
		model,
		{
			setModel: (value) => {
				assert.equal(value, model);
				events.push("agent");
			},
		},
		{
			set: (key, value) => {
				assert.equal(key, "lastUsedModel");
				assert.equal(value, model);
				events.push("save");
				return new Promise((resolve) => {
					finish = resolve;
				});
			},
		},
		() => events.push("composer"),
	);
	assert.deepEqual(events, ["agent", "composer", "save"]);
	finish();
	await pending;
});
