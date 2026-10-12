import assert from "node:assert/strict";
import test from "node:test";
import { colorForSession, isRestrictedPage, WorkSessionBook } from "../src/tasks/work-session.ts";

function fakeBackend() {
	let nextId = 10;
	let nextGroup = 1;
	const tabs = new Map([
		[1, { id: 1, windowId: 1, url: "https://owner.example", title: "Owner", active: true, groupId: -1 }],
		[2, { id: 2, windowId: 1, url: "https://user.example", title: "User", active: false, groupId: -1 }],
		[3, { id: 3, windowId: 1, url: "chrome://settings", title: "Settings", active: false, groupId: -1 }],
		[4, { id: 4, windowId: 1, url: "https://other.example", title: "Other", active: false, groupId: -1 }],
	]);
	const groups = new Map();
	const titles = new Map();
	const calls = { created: [], activated: [], focused: [], urls: [] };
	const backend = {
		async get(tabId) {
			const tab = tabs.get(tabId);
			if (!tab) throw new Error(`missing ${tabId}`);
			return { ...tab };
		},
		async createInactive(windowId, url) {
			const tab = { id: nextId++, windowId, url, title: "New", active: false, groupId: -1 };
			tabs.set(tab.id, tab);
			calls.created.push({ ...tab });
			return { ...tab };
		},
		async setUrl(tabId, url) {
			calls.urls.push({ tabId, url });
			tabs.get(tabId).url = url;
		},
		async activate(tabId) {
			calls.activated.push(tabId);
			for (const tab of tabs.values()) tab.active = tab.id === tabId;
		},
		async focusWindow(windowId) {
			calls.focused.push(windowId);
		},
		async group(tabId, windowId, groupId) {
			const id = groupId ?? nextGroup++;
			const members = groups.get(id) ?? [];
			if (!members.includes(tabId)) members.push(tabId);
			groups.set(id, members);
			if (!tabs.has(tabId)) {
				tabs.set(tabId, {
					id: tabId,
					windowId,
					url: "https://popup.example",
					title: "Popup",
					active: false,
					groupId: id,
				});
			}
			tabs.get(tabId).groupId = id;
			return id;
		},
		async retitle(groupId, title, color) {
			titles.set(groupId, { title, color });
		},
		async ungroup() {},
		async own() {},
		async activeInWindow(windowId) {
			return [...tabs.values()].find((tab) => tab.windowId === windowId && tab.active);
		},
	};
	return { backend, tabs, groups, calls };
}

test("a task tab is created inactive and stays inside its group", async () => {
	const { backend, calls, groups } = fakeBackend();
	const book = new WorkSessionBook(backend);
	const first = await book.open("session-a", 1, "https://one.example", false);
	assert.equal(first.active, false);
	assert.equal(calls.activated.length, 0);
	assert.equal(calls.focused.length, 0);
	assert.equal(calls.created.length, 1);
	assert.ok(groups.has(first.groupId));
	const again = await book.open("session-a", 1, "https://two.example", false);
	assert.equal(again.id, first.id);
	assert.deepEqual(calls.urls, []);
	const extra = await book.open("session-a", 1, "https://three.example", true);
	assert.notEqual(extra.id, first.id);
	const listed = await book.list("session-a");
	assert.deepEqual(
		listed.map((tab) => tab.id),
		[first.id, extra.id],
	);
	assert.equal(listed.find((tab) => tab.active)?.id, extra.id);
	assert.equal(
		listed.some((tab) => tab.id === 2),
		false,
	);
});

test("switching a task tab does not focus it unless reveal is set", async () => {
	const { backend, calls } = fakeBackend();
	const book = new WorkSessionBook(backend);
	const first = await book.open("session-a", 1, "https://one.example", false);
	const second = await book.open("session-a", 1, "https://two.example", true);
	await book.select("session-a", first.id, false);
	assert.deepEqual(calls.activated, []);
	assert.equal((await book.current("session-a")).id, first.id);
	await book.select("session-a", second.id, true);
	assert.deepEqual(calls.activated, [second.id]);
	assert.deepEqual(calls.focused, [1]);
	await assert.rejects(() => book.select("session-a", 2, false), /not in this task/);
});

test("a popup joins the group and focus returns only when the user was elsewhere", async () => {
	const { backend, calls } = fakeBackend();
	const book = new WorkSessionBook(backend);
	const opener = await book.open("session-a", 1, "https://one.example", false);
	book.noteActivation(1, 2);
	book.noteActivation(1, opener.id);
	assert.equal(await book.adoptPopup(opener.id, 40), true);
	assert.deepEqual(calls.activated, []);
	book.noteActivation(1, 4);
	assert.equal(await book.adoptPopup(opener.id, 41), true);
	assert.deepEqual(calls.activated, [4]);
	const listed = await book.list("session-a");
	assert.deepEqual(
		listed.map((tab) => tab.id),
		[opener.id, 40, 41],
	);
});

test("closing the owner promotes a remaining work tab", async () => {
	const { backend } = fakeBackend();
	const book = new WorkSessionBook(backend);
	const first = await book.open("session-a", 1, "https://one.example", false);
	const removed = book.removeTab(1);
	assert.equal(removed.promoted?.previousOwnerTabId, 1);
	assert.equal(removed.promoted?.session.ownerTabId, first.id);
	assert.equal(book.get("session-a")?.ownerTabId, first.id);
	book.removeTab(first.id);
	assert.equal(book.get("session-a"), undefined);
});

test("sharing rejects restricted pages and tabs owned by another task", async () => {
	const { backend, tabs } = fakeBackend();
	const book = new WorkSessionBook(backend);
	await book.open("session-a", 1, "https://one.example", false);
	tabs.get(2).active = true;
	tabs.get(1).active = false;
	await book.shareActive("session-b", 4);
	await assert.rejects(() => book.share("session-a", 1, tabs.get(2)), /another task/);
	await assert.rejects(() => book.share("session-a", 1, tabs.get(3)), /cannot be used/);
	assert.equal(isRestrictedPage("about:blank"), true);
	assert.equal(isRestrictedPage("https://example.com"), false);
	assert.equal(colorForSession("session-a"), colorForSession("session-a"));
});
