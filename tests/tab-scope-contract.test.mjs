import assert from "node:assert/strict";
import test from "node:test";
import {
	actingCandidates,
	assertTabInScope,
	chooseActingTabId,
	clearCurrentScope,
	filterTabsToScope,
	getCurrentScope,
	getEffectiveScope,
	getScopedActingTabId,
	isRestrictedUrl,
	isTabInScope,
	isTabScopeEnabled,
	isTabScopeEnabledSync,
	mayAcquireTabScope,
	mayReleaseTabScope,
	mayUpdateActingTab,
	setActingTab,
	setCurrentScope,
	setTabScopeEnabledForTests,
} from "../src/browser/session-tabs.ts";

test("tab scope flag defaults to off without chrome storage", async () => {
	setTabScopeEnabledForTests(undefined);
	assert.equal(await isTabScopeEnabled(), false);
});

test("tab scope flag override controls the gate", async () => {
	try {
		setTabScopeEnabledForTests(true);
		assert.equal(await isTabScopeEnabled(), true);
		setTabScopeEnabledForTests(false);
		assert.equal(await isTabScopeEnabled(), false);
	} finally {
		setTabScopeEnabledForTests(undefined);
	}
});

test("filterTabsToScope keeps only allowed tabs and drops id-less entries", () => {
	const tabs = [{ id: 1 }, { id: 2 }, { id: 3 }, {}, { id: 2 }];
	assert.deepEqual(filterTabsToScope(tabs, new Set([1, 2])), [{ id: 1 }, { id: 2 }, { id: 2 }]);
	assert.deepEqual(filterTabsToScope(tabs, [3]), [{ id: 3 }]);
	assert.deepEqual(filterTabsToScope(tabs, new Set()), []);
});

test("isTabInScope matches exact ids only", () => {
	assert.equal(isTabInScope(7, new Set([7])), true);
	assert.equal(isTabInScope(7, [7]), true);
	assert.equal(isTabInScope(8, new Set([7])), false);
});

test("assertTabInScope throws for foreign tabs before any focus change", () => {
	assertTabInScope(7, new Set([7]));
	assert.throws(() => assertTabInScope(8, new Set([7])), /outside the session tab group/);
});

test("current scope stores the session group and tracks the acting tab", () => {
	try {
		setTabScopeEnabledForTests(true);
		assert.equal(getCurrentScope(), undefined);
		setCurrentScope({ sessionId: "s1", tabIds: new Set([1, 2]), groupId: 9, boundTabId: 1, actingTabId: 1 });
		assert.deepEqual(getCurrentScope()?.tabIds, new Set([1, 2]));
		assert.equal(getScopedActingTabId(), 1);
		setActingTab(2);
		assert.equal(getScopedActingTabId(), 2);
		// Foreign ids are ignored, never adopted.
		setActingTab(99);
		assert.equal(getScopedActingTabId(), 2);
		clearCurrentScope();
		assert.equal(getCurrentScope(), undefined);
		assert.equal(getScopedActingTabId(), undefined);
	} finally {
		setTabScopeEnabledForTests(undefined);
		clearCurrentScope();
	}
});

test("effective scope prefers explicit tool scope over the session scope", () => {
	try {
		setTabScopeEnabledForTests(true);
		setCurrentScope({ tabIds: new Set([1]), groupId: 9, boundTabId: 1 });
		assert.deepEqual(getEffectiveScope(new Set([2]), 10), { tabIds: new Set([2]), groupId: 10 });
		assert.deepEqual(getEffectiveScope(undefined), { tabIds: new Set([1]), groupId: 9 });
		clearCurrentScope();
		assert.deepEqual(getEffectiveScope(undefined), {});
	} finally {
		setTabScopeEnabledForTests(undefined);
		clearCurrentScope();
	}
});

test("sync flag mirror follows the test override", () => {
	try {
		setTabScopeEnabledForTests(true);
		assert.equal(isTabScopeEnabledSync(), true);
		setTabScopeEnabledForTests(false);
		assert.equal(isTabScopeEnabledSync(), false);
	} finally {
		setTabScopeEnabledForTests(undefined);
	}
});

test("actingCandidates uses recorded ids only when no group is set", () => {
	assert.deepEqual(actingCandidates({ tabIds: [8] }, undefined), [8]);
	assert.deepEqual(actingCandidates({ tabIds: new Set([8]), groupId: undefined }, []), [8]);
	assert.deepEqual(actingCandidates({ groupId: 3, tabIds: [8] }, []), []);
	assert.deepEqual(actingCandidates({ groupId: 3, tabIds: [8] }, undefined), []);
	assert.deepEqual(actingCandidates({ groupId: 3, tabIds: [8] }, [4, 5]), [4, 5]);
	assert.equal(chooseActingTabId({ actingTabId: 99, boundTabId: 1 }, actingCandidates({ tabIds: [8] }, undefined)), 8);
	assert.notEqual(
		chooseActingTabId({ actingTabId: 99, boundTabId: 1 }, actingCandidates({ tabIds: [8] }, undefined)),
		99,
	);
	assert.equal(mayReleaseTabScope(4, 3, true), false);
});

test("chooseActingTabId prefers a live acting tab", () => {
	assert.equal(chooseActingTabId({ actingTabId: 2, boundTabId: 1 }, [1, 2, 3]), 2);
	assert.equal(chooseActingTabId({ actingTabId: 2, boundTabId: 1 }, new Set([3, 2])), 2);
});

test("chooseActingTabId adopts a sibling when the preferred id is absent", () => {
	assert.equal(chooseActingTabId({ actingTabId: 9, boundTabId: 1 }, [4, 5]), 4);
	assert.equal(chooseActingTabId({ boundTabId: 1 }, [4, 5]), 4);
	// The bound panel tab is skipped while another group member is live.
	assert.equal(chooseActingTabId({ actingTabId: 9, boundTabId: 1 }, [1, 4]), 4);
});

test("chooseActingTabId returns undefined when the group is empty", () => {
	assert.equal(chooseActingTabId({ actingTabId: 2, boundTabId: 1 }, []), undefined);
	assert.equal(chooseActingTabId({ actingTabId: 2, boundTabId: 1 }, new Set()), undefined);
});

test("chooseActingTabId never returns a foreign id or an unbound panel tab", () => {
	const chosen = chooseActingTabId({ actingTabId: 99, boundTabId: 7 }, [4, 5]);
	assert.equal(chosen, 4);
	assert.notEqual(chosen, 99);
	assert.notEqual(chosen, 7);
	assert.equal(chooseActingTabId({ actingTabId: 7, boundTabId: 7 }, [4]), 4);
	// The bound panel tab is allowed only when it is itself in the live group.
	assert.equal(chooseActingTabId({ actingTabId: 99, boundTabId: 7 }, [7]), 7);
});

test("tab scope acquire rejects a live foreign owner and a mismatched port", () => {
	assert.equal(mayAcquireTabScope(3, 3, undefined, false), true);
	assert.equal(mayAcquireTabScope(3, 9, undefined, false), false);
	assert.equal(mayAcquireTabScope(3, 3, 3, true), true);
	assert.equal(mayAcquireTabScope(4, 4, 3, true), false);
	assert.equal(mayAcquireTabScope(4, 4, 3, false), true);
	// A legacy window port cannot steal a live owner, even by claiming its tab id.
	assert.equal(mayAcquireTabScope(undefined, 3, 3, true), false);
	assert.equal(mayAcquireTabScope(undefined, 8, 3, true), false);
	assert.equal(mayAcquireTabScope(undefined, 8, 3, false), true);
	assert.equal(mayAcquireTabScope(undefined, 8, undefined, false), true);
});

test("tab scope release deletes only for the owner or a dead legacy binding", () => {
	assert.equal(mayReleaseTabScope(3, 3, true), true);
	assert.equal(mayReleaseTabScope(4, 3, true), false);
	assert.equal(mayReleaseTabScope(4, 3, false), false);
	assert.equal(mayReleaseTabScope(undefined, 3, true), false);
	assert.equal(mayReleaseTabScope(undefined, 3, false), true);
	assert.equal(mayReleaseTabScope(3, undefined, false), false);
});

test("acting tab updates stay inside the recorded group", () => {
	assert.equal(mayUpdateActingTab({ actingTabId: 2, groupId: 9 }, { id: 5, groupId: 9 }), true);
	assert.equal(mayUpdateActingTab({ actingTabId: 2, groupId: 9 }, { id: 5, groupId: 4 }), false);
	assert.equal(mayUpdateActingTab({ actingTabId: 2, groupId: 9 }, { id: 5 }), false);
	assert.equal(mayUpdateActingTab({ actingTabId: 2 }, { id: 2 }), true);
	assert.equal(mayUpdateActingTab({ actingTabId: 2 }, { id: 5 }), false);
	assert.equal(mayUpdateActingTab({ actingTabId: 2, groupId: 9 }, {}), false);
});

test("restricted urls cover extension and internal pages", () => {
	assert.equal(isRestrictedUrl("chrome://extensions"), true);
	assert.equal(isRestrictedUrl("chrome-extension://abc/page.html"), true);
	assert.equal(isRestrictedUrl("about:blank"), true);
	assert.equal(isRestrictedUrl("https://example.com"), false);
	assert.equal(isRestrictedUrl(undefined), true);
});
