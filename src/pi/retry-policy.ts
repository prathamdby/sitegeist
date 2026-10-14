export interface RetryPolicy {
	maxRetries: number;
	delayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxRetries: 0, delayMs: 0 };

export const MAX_RETRY_POLICY_RETRIES = 10;
export const MAX_RETRY_POLICY_DELAY_MS = 30000;

export function clampRetryPolicy(policy: RetryPolicy): RetryPolicy {
	return {
		maxRetries: Number.isFinite(policy.maxRetries)
			? Math.min(MAX_RETRY_POLICY_RETRIES, Math.max(0, Math.floor(policy.maxRetries)))
			: DEFAULT_RETRY_POLICY.maxRetries,
		delayMs: Number.isFinite(policy.delayMs)
			? Math.min(MAX_RETRY_POLICY_DELAY_MS, Math.max(0, Math.floor(policy.delayMs)))
			: DEFAULT_RETRY_POLICY.delayMs,
	};
}

// Quota, billing, and subscription-limit failures surface as 429s but are never
// transient throttles. Keep in sync with NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN
// in @earendil-works/pi-ai retry.js.
const QUOTA_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;

const THROTTLE_429_PATTERN = /^429\b/;
const THROTTLE_RATE_LIMIT_PATTERN = /too many requests/i;

export function isThrottle429(message: string): boolean {
	if (QUOTA_ERROR_PATTERN.test(message)) {
		return false;
	}
	return THROTTLE_429_PATTERN.test(message) || THROTTLE_RATE_LIMIT_PATTERN.test(message);
}

export interface ThrottleRetryInput {
	started: boolean;
	errorMessage?: string;
	retriesUsed: number;
	maxRetries: number;
	aborted: boolean;
}

/** Retry only a throttle that arrived before the provider started the response. */
export function shouldRetryThrottle(input: ThrottleRetryInput): boolean {
	if (input.started || input.aborted || input.retriesUsed >= input.maxRetries) return false;
	return input.errorMessage !== undefined && isThrottle429(input.errorMessage);
}
