import assert from "node:assert/strict";
import { test } from "node:test";
import { ArtifactsState, artifactsParamsSchema } from "../src/artifacts/ArtifactsState.ts";

const text = (result) => result.content[0].text;

test("artifacts preserve public tool fields, first-match updates and rejected-operation state", () => {
	assert.deepEqual(artifactsParamsSchema.required, ["command", "filename"]);
	assert.deepEqual(artifactsParamsSchema.properties.command.enum, [
		"create",
		"update",
		"rewrite",
		"get",
		"delete",
		"logs",
	]);
	const state = new ArtifactsState();
	assert.equal(
		text(state.execute({ command: "get", filename: "missing.txt" })),
		"Error: File missing.txt not found. No files have been created yet.",
	);
	assert.equal(
		text(state.execute({ command: "create", filename: "notes.txt", content: "one one" })),
		"Created file notes.txt",
	);
	const createdAt = state.artifacts.get("notes.txt").createdAt;
	for (const params of [
		{ command: "create", filename: "notes.txt", content: "replace" },
		{ command: "update", filename: "notes.txt", old_str: "absent", new_str: "x" },
		{ command: "rewrite", filename: "missing.txt", content: "x" },
		{ command: "delete", filename: "missing.txt" },
	]) {
		assert.equal(state.execute(params).isError, true);
		assert.equal(state.artifacts.get("notes.txt").content, "one one");
	}
	assert.equal(
		text(state.execute({ command: "update", filename: "notes.txt", old_str: "one", new_str: "two" })),
		"Updated file notes.txt",
	);
	assert.equal(state.artifacts.get("notes.txt").content, "two one");
	assert.equal(state.artifacts.get("notes.txt").createdAt, createdAt);
	state.execute({ command: "update", filename: "notes.txt", old_str: "two", new_str: "$&/$`/$'/$$" });
	assert.equal(state.artifacts.get("notes.txt").content, "two// one/$ one");
	assert.equal(text(state.execute({ command: "rewrite", filename: "notes.txt", content: "new" })), "");
	assert.equal(text(state.execute({ command: "get", filename: "notes.txt" })), "new");
	assert.equal(text(state.execute({ command: "delete", filename: "notes.txt" })), "Deleted file notes.txt");
	assert.equal(state.artifacts.size, 0);
});

test("artifacts reconstruct chronological successful tool results and custom messages only", () => {
	const state = new ArtifactsState();
	const calls = [
		["create", { command: "create", filename: "notes.txt", content: "one one" }],
		["pending", { command: "create", filename: "pending.txt", content: "not completed" }],
		["error", { command: "rewrite", filename: "notes.txt", content: "bad" }],
		["legacy-error", { command: "create", filename: "bad.txt", content: "bad" }],
		["update", { command: "update", filename: "notes.txt", old_str: "one", new_str: "two" }],
	];
	const result = (id, isError = false, output = "success") => ({
		role: "toolResult",
		toolName: "artifacts",
		toolCallId: id,
		content: [{ type: "text", text: output }],
		isError,
		timestamp: 1,
	});
	const messages = [
		{
			role: "assistant",
			content: calls.map(([id, args]) => ({ type: "toolCall", id, name: "artifacts", arguments: args })),
		},
		result("create"),
		result("error", true),
		result("legacy-error", false, "Error: rejected"),
		result("update"),
		{
			role: "artifact",
			action: "update",
			filename: "snapshot.json",
			content: '{"value":42}',
			timestamp: "2026-10-11T00:00:00Z",
		},
		{
			role: "artifact",
			action: "create",
			filename: "removed.txt",
			content: "gone",
			timestamp: "2026-10-11T00:00:00Z",
		},
		{ role: "artifact", action: "delete", filename: "removed.txt", timestamp: "2026-10-11T00:01:00Z" },
		{
			role: "artifact",
			action: "create",
			filename: "__proto__",
			content: "prototype filename",
			timestamp: "2026-10-11T00:00:00Z",
		},
	];
	state.reconstruct(messages);
	assert.deepEqual(
		[...state.artifacts].map(([filename, artifact]) => [filename, artifact.content]),
		[
			["notes.txt", "two one"],
			["snapshot.json", '{"value":42}'],
			["__proto__", "prototype filename"],
		],
	);
	assert.equal(state.artifacts.get("snapshot.json").createdAt.toISOString(), "2026-10-11T00:00:00.000Z");
	state.reconstruct(messages);
	assert.equal(state.artifacts.size, 3);
	state.reconstruct([]);
	assert.equal(state.artifacts.size, 0);
});
