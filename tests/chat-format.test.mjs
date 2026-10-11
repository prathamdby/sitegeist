import assert from "node:assert/strict";
import test from "node:test";
import { formatCost, formatTokenCount, formatUsage } from "../src/chat/format.ts";

test("usage keeps the baseline token abbreviations and four-decimal currency", () => {
	for (const [count, expected] of [
		[0, "0"],
		[999, "999"],
		[1000, "1.0k"],
		[1234, "1.2k"],
		[10000, "10k"],
		[1234567, "1235k"],
	]) {
		assert.equal(formatTokenCount(count), expected);
	}
	assert.equal(formatCost(0.007362), "$0.0074");
	assert.equal(formatCost(0.00001), "$0.0000");
	const usage = {
		input: 1000,
		output: 999,
		cacheRead: 1,
		cacheWrite: 1,
		totalTokens: 2001,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	assert.equal(formatUsage(usage), "↑1.0k ↓999 R1 W1");
	assert.equal(formatUsage({ ...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "");
	assert.equal(
		formatUsage({
			...usage,
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { ...usage.cost, total: 0.00001 },
		}),
		"$0.0000",
	);
});
