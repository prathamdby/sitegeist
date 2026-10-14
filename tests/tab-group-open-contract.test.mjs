import assert from "node:assert/strict";
import test from "node:test";
import { resolveGroupClick } from "../src/browser/group-open.ts";

const other = {
	toolNavigating: false,
	clickedSessionId: "other",
	currentSessionId: "mine",
	ownerAlive: true,
	boundTabId: 4,
	streaming: false,
};

test("resolveGroupClick ignores same-session, tool, and streaming clicks", () => {
	assert.deepEqual(resolveGroupClick({ ...other, clickedSessionId: "mine" }), { action: "ignore" });
	assert.deepEqual(resolveGroupClick({ ...other, clickedSessionId: undefined }), { action: "ignore" });
	assert.deepEqual(resolveGroupClick({ ...other, toolNavigating: true }), { action: "ignore" });
	assert.deepEqual(resolveGroupClick({ ...other, streaming: true, ownerAlive: false }), { action: "ignore" });
});

test("resolveGroupClick reveals a live owner and adopts a dead one", () => {
	assert.deepEqual(resolveGroupClick(other), { action: "reveal", boundTabId: 4 });
	assert.deepEqual(resolveGroupClick({ ...other, ownerAlive: false }), { action: "adopt", sessionId: "other" });
	assert.deepEqual(resolveGroupClick({ ...other, ownerAlive: true, boundTabId: undefined }), {
		action: "adopt",
		sessionId: "other",
	});
});
