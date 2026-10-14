import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { getModels } from "../src/pi/models.ts";
import { isThrottle429, shouldRetryThrottle } from "../src/pi/retry-policy.ts";
import { createStreamFn } from "../src/pi/stream.ts";

const model = getModels("opencode-go").find((entry) => entry.id === "claude-haiku-5-5");
assert.ok(model);

const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(handler) {
	let calls = 0;
	globalThis.fetch = async (...args) => {
		calls += 1;
		return handler(calls, ...args);
	};
	return () => calls;
}

function jsonResponse(body, status) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function throttleResponse() {
	return jsonResponse(
		{ type: "error", error: { type: "rate_limit_error", message: "Rate limit reached, slow down" } },
		429,
	);
}

function quotaResponse() {
	return jsonResponse(
		{
			type: "error",
			error: {
				type: "GoUsageLimitError",
				message: "Monthly usage limit reached. Enable available balance to continue.",
			},
		},
		429,
	);
}

function serverErrorResponse() {
	return jsonResponse({ type: "error", error: { type: "api_error", message: "Internal server error" } }, 500);
}

function successResponse(modelId) {
	const events = [
		{
			type: "message_start",
			message: {
				id: "fixture-retry",
				role: "assistant",
				content: [],
				model: modelId,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

function requestOptions(extra = {}) {
	return { apiKey: "synthetic-fixture-key", maxRetries: 0, ...extra };
}

function requestContext() {
	return { messages: [{ role: "user", content: "Fixture", timestamp: 1 }] };
}

test("shouldRetryThrottle retries only a pre-start throttle", () => {
	const open = { started: false, retriesUsed: 0, maxRetries: 3, aborted: false };
	assert.equal(shouldRetryThrottle({ ...open, errorMessage: "429 rate_limit_error" }), true);
	assert.equal(shouldRetryThrottle({ ...open, started: true, errorMessage: "429 rate_limit_error" }), false);
	assert.equal(shouldRetryThrottle({ ...open, errorMessage: "429 GoUsageLimitError: quota exceeded" }), false);
	assert.equal(shouldRetryThrottle({ ...open, aborted: true, errorMessage: "429 rate_limit_error" }), false);
	assert.equal(shouldRetryThrottle({ ...open, retriesUsed: 3, errorMessage: "429 rate_limit_error" }), false);
	assert.equal(shouldRetryThrottle({ ...open }), false);
});

test("isThrottle429 matches throttles but never quota failures", () => {
	assert.equal(isThrottle429("429 rate_limit_error"), true);
	assert.equal(isThrottle429('429 {"type":"error"}'), true);
	assert.equal(isThrottle429("Rate limit exceeded: too many requests"), true);
	assert.equal(isThrottle429("500 Internal server error"), false);
	assert.equal(isThrottle429("400 invalid request"), false);
	assert.equal(isThrottle429("429 GoUsageLimitError: Monthly usage limit reached"), false);
	assert.equal(isThrottle429("429 FreeUsageLimitError: out of budget, billing quota exceeded"), false);
	assert.equal(isThrottle429("429 billing limit reached"), false);
	assert.equal(isThrottle429("429 subscription_sharing_usage_limit_exceeded"), false);
	assert.equal(isThrottle429("429 insufficient_quota"), false);
});

test("absent retry policy attempts a throttle once", async () => {
	const fetchCalls = stubFetch(async () => throttleResponse());
	const stream = createStreamFn(async () => undefined);
	const result = await (await stream(model, requestContext(), requestOptions())).result();
	assert.equal(result.stopReason, "error");
	assert.equal(fetchCalls(), 1);
	const undefinedPolicy = createStreamFn(
		async () => undefined,
		async () => undefined,
	);
	const secondCalls = stubFetch(async () => throttleResponse());
	const second = await (await undefinedPolicy(model, requestContext(), requestOptions())).result();
	assert.equal(second.stopReason, "error");
	assert.equal(secondCalls(), 1);
});

test("rate-limited requests retry then stream text", async () => {
	const fetchCalls = stubFetch(async (calls) => (calls < 3 ? throttleResponse() : successResponse(model.id)));
	const stream = createStreamFn(
		async () => undefined,
		async () => ({ maxRetries: 3, delayMs: 1 }),
	);
	const result = await (await stream(model, requestContext(), requestOptions())).result();
	assert.equal(result.stopReason, "stop", result.errorMessage ?? "");
	assert.deepEqual(
		result.content.filter((block) => block.type === "text").map((block) => block.text),
		["Hello"],
	);
	assert.equal(fetchCalls(), 3);
});

test("persistent throttling surfaces an error after maxRetries + 1 attempts", async () => {
	const fetchCalls = stubFetch(async () => throttleResponse());
	const stream = createStreamFn(
		async () => undefined,
		async () => ({ maxRetries: 2, delayMs: 1 }),
	);
	const result = await (await stream(model, requestContext(), requestOptions())).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /^429\b/);
	assert.equal(fetchCalls(), 3);
});

test("aborting during the retry delay stops without another request", async () => {
	const controller = new AbortController();
	const fetchCalls = stubFetch(async (calls) => {
		if (calls === 1) {
			setTimeout(() => controller.abort(), 5);
		}
		return throttleResponse();
	});
	const stream = createStreamFn(
		async () => undefined,
		async () => ({ maxRetries: 3, delayMs: 30000 }),
	);
	const result = await (await stream(model, requestContext(), requestOptions({ signal: controller.signal }))).result();
	assert.equal(result.stopReason, "aborted");
	assert.match(result.errorMessage ?? "", /abort/i);
	assert.equal(fetchCalls(), 1);
});

test("quota 429s pass through with a single attempt", async () => {
	const fetchCalls = stubFetch(async () => quotaResponse());
	const stream = createStreamFn(async () => undefined);
	const result = await (await stream(model, requestContext(), requestOptions())).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /GoUsageLimitError/);
	assert.equal(fetchCalls(), 1);
});

function startedThenThrottledResponse() {
	const start = {
		type: "message_start",
		message: {
			id: "fixture-started",
			role: "assistant",
			content: [],
			model: model.id,
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	};
	const body = `event: ${start.type}\ndata: ${JSON.stringify(start)}\n\nevent: error\ndata: 429 rate_limit_error\n\n`;
	return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

test("a throttle after the stream has started is not retried", async () => {
	const fetchCalls = stubFetch(async () => startedThenThrottledResponse());
	const stream = createStreamFn(
		async () => undefined,
		async () => ({ maxRetries: 3, delayMs: 1 }),
	);
	const result = await (await stream(model, requestContext(), requestOptions())).result();
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /^429\b/);
	assert.equal(fetchCalls(), 1);
});

test("server errors pass through with a single attempt", async () => {
	const fetchCalls = stubFetch(async () => serverErrorResponse());
	const stream = createStreamFn(
		async () => undefined,
		async () => ({ maxRetries: 3, delayMs: 1 }),
	);
	const result = await (await stream(model, requestContext(), requestOptions())).result();
	assert.equal(result.stopReason, "error");
	assert.equal(fetchCalls(), 1);
});
