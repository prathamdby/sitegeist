import assert from "node:assert/strict";
import test from "node:test";
import {
	assertTabInScope,
	clearCurrentScope,
	filterTabsToScope,
	getCurrentScope,
	getEffectiveScope,
	getScopedActingTabId,
	isRestrictedUrl,
	isTabInScope,
	isTabScopeEnabled,
	isTabScopeEnabledSync,
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

test("restricted urls cover extension and internal pages", () => {
	assert.equal(isRestrictedUrl("chrome://extensions"), true);
	assert.equal(isRestrictedUrl("chrome-extension://abc/page.html"), true);
	assert.equal(isRestrictedUrl("about:blank"), true);
	assert.equal(isRestrictedUrl("https://example.com"), false);
	assert.equal(isRestrictedUrl(undefined), true);
});
