import assert from "node:assert/strict";
import test from "node:test";
import {
	clearHostBinding,
	decideLock,
	parseHostTab,
	releaseLocksForOwner,
	retargetBindings,
	rewriteLockOwner,
	sidePanelPath,
} from "../src/panel/locks.ts";

test("panel path names the owner tab and the session once one exists", () => {
	assert.equal(sidePanelPath(12), "sidepanel.html?hostTab=12");
	assert.equal(sidePanelPath(12, "abc"), "sidepanel.html?hostTab=12&session=abc");
	assert.equal(sidePanelPath(12, null), "sidepanel.html?hostTab=12");
	assert.equal(parseHostTab("?hostTab=12&session=abc"), 12);
	assert.equal(parseHostTab(""), undefined);
	assert.equal(parseHostTab("?hostTab=0"), undefined);
	assert.equal(parseHostTab("?hostTab=nope"), undefined);
});

test("lock grants to a free session, the current owner, or a closed owner", () => {
	const locks = { a: 4, b: 9 };
	const open = new Set([4]);
	assert.deepEqual(decideLock(locks, open, "c", 7), { granted: true });
	assert.deepEqual(decideLock(locks, open, "a", 4), { granted: true });
	assert.deepEqual(decideLock(locks, open, "b", 7), { granted: true });
	assert.deepEqual(decideLock(locks, open, "a", 7), { granted: false, ownerTabId: 4 });
});

test("releasing an owner drops only that owner's sessions", () => {
	assert.deepEqual(releaseLocksForOwner({ a: 4, b: 9, c: 4 }, 4), { b: 9 });
});

test("a replaced tab id follows bindings and lock owners", () => {
	assert.deepEqual(rewriteLockOwner({ a: 4, b: 9 }, 4, 15), { a: 15, b: 9 });
	assert.deepEqual(
		retargetBindings(
			{
				4: { ownerTabId: 4, sessionId: "a", role: "host" },
				8: { ownerTabId: 4, sessionId: "a", role: "work" },
			},
			4,
			15,
		),
		{
			15: { ownerTabId: 15, sessionId: "a", role: "host" },
			8: { ownerTabId: 15, sessionId: "a", role: "work" },
		},
	);
});

test("clearing a host binding leaves work tabs for the previous task", () => {
	const bindings = {
		4: { ownerTabId: 4, sessionId: "a", role: "host" },
		8: { ownerTabId: 4, sessionId: "a", role: "work" },
	};
	assert.deepEqual(clearHostBinding(bindings, 4), {
		8: { ownerTabId: 4, sessionId: "a", role: "work" },
	});
	assert.equal(clearHostBinding(bindings, 8), bindings);
});
