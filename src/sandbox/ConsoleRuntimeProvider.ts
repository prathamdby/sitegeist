import type { RuntimeMessage, RuntimeResponse, SandboxRuntimeProvider } from "./types.js";

export interface ConsoleLog {
	type: "log" | "warn" | "error" | "info";
	text: string;
	args?: unknown[];
}

export class ConsoleRuntimeProvider implements SandboxRuntimeProvider {
	private logs: ConsoleLog[] = [];
	private completionError: { message: string; stack: string } | null = null;
	private completed = false;

	getData(): Record<string, unknown> {
		return {};
	}

	getDescription(): string {
		return "Console output is captured with console.log, console.info, console.warn, and console.error.";
	}

	getRuntime(): (sandboxId: string) => void {
		return (_sandboxId: string) => {
			const target = window as Window & {
				sendRuntimeMessage?: (message: RuntimeMessage, options?: string) => Promise<unknown>;
				__completionCallbacks?: Array<(success: boolean) => Promise<void> | void>;
				__originalConsole?: Pick<Console, "log" | "warn" | "error" | "info">;
				__consoleRuntimeCleanup?: () => void;
				complete?: (error?: unknown, returnValue?: unknown) => Promise<void>;
			};
			target.__consoleRuntimeCleanup?.();
			const original = target.__originalConsole ?? {
				log: console.log.bind(console),
				warn: console.warn.bind(console),
				error: console.error.bind(console),
				info: console.info.bind(console),
			};
			target.__originalConsole = original;
			const sendRuntimeMessage = target.sendRuntimeMessage;
			let finished = false;
			let completionError: { message: string; stack: string } | undefined;
			const [send] = [
				async (message: RuntimeMessage) => {
					try {
						await sendRuntimeMessage?.(message, "fire-and-forget");
					} catch {}
				},
			];
			const [format] = [
				(value: unknown): string => {
					if (typeof value === "string") return value;
					try {
						return JSON.stringify(value) ?? String(value);
					} catch {
						return String(value);
					}
				},
			];
			for (const method of ["log", "warn", "error", "info"] as const) {
				console[method] = (...args: unknown[]) => {
					original[method](...args);
					const text = args.map(format).join(" ");
					void send({ type: "console", method, text, args });
				};
			}
			const [captureError] = [
				(error: unknown, fallback: string) => {
					const detail =
						error && typeof error === "object" ? (error as { message?: unknown; stack?: unknown }) : undefined;
					completionError = {
						message:
							typeof detail?.message === "string"
								? detail.message
								: error === undefined
									? fallback
									: String(error),
						stack: typeof detail?.stack === "string" ? detail.stack : "",
					};
					void send({ type: "console-error", error: completionError });
				},
			];
			const [onError] = [(event: ErrorEvent) => captureError(event.error, event.message)];
			const [onRejection] = [
				(event: PromiseRejectionEvent) => captureError(event.reason, "Unhandled promise rejection"),
			];
			window.addEventListener("error", onError);
			window.addEventListener("unhandledrejection", onRejection);
			let cleaned = false;
			const [cleanup] = [
				() => {
					if (cleaned) return;
					cleaned = true;
					window.removeEventListener("error", onError);
					window.removeEventListener("unhandledrejection", onRejection);
					if (target.__consoleRuntimeCleanup === cleanup) Object.assign(console, original);
				},
			];
			target.__consoleRuntimeCleanup = cleanup;
			const [complete] = [
				async (success: boolean, returnValue?: unknown) => {
					if (finished) return;
					finished = true;
					await send({
						type: "console-complete",
						success: success && !completionError,
						error: completionError,
						returnValue,
					});
				},
			];
			target.complete = async (error, returnValue) => {
				if (error) captureError(error, "Execution failed");
				await complete(!error, returnValue);
				await send({
					type: "execution-complete",
					success: !error,
					returnValue,
					...(error ? { error } : {}),
				});
			};
			target.__completionCallbacks ??= [];
			target.__completionCallbacks.push((success) => complete(success));
		};
	}

	onExecutionStart(_sandboxId: string, _signal?: AbortSignal): void {
		this.reset();
	}

	async handleMessage(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void> {
		if (message.type === "console") {
			const log = message.log && typeof message.log === "object" ? (message.log as Partial<ConsoleLog>) : undefined;
			const method = log?.type ?? message.method;
			const text = log?.text ?? message.text;
			if (typeof text !== "string") return;
			const args = log?.args ?? message.args;
			this.logs.push({
				type: method === "warn" || method === "error" || method === "info" ? method : "log",
				text,
				...(Array.isArray(args) ? { args } : {}),
			});
			respond({ success: true });
		} else if (message.type === "console-error" || message.type === "execution-error") {
			this.captureError(message.error);
			if (message.type === "execution-error") this.completed = true;
			respond({ success: true });
		} else if (message.type === "console-complete" || message.type === "execution-complete") {
			this.completed = true;
			if (message.error) this.captureError(message.error);
			respond({ success: true });
		} else if (message.type === "console-get-logs" || message.type === "get-console-logs") {
			respond({ success: true, logs: this.getLogs() });
		}
	}

	getLogs(): ConsoleLog[] {
		return this.logs.map((log) => ({ ...log, ...(log.args ? { args: [...log.args] } : {}) }));
	}

	isCompleted(): boolean {
		return this.completed;
	}

	getCompletionError(): { message: string; stack: string } | null {
		return this.completionError ? { ...this.completionError } : null;
	}

	reset(): void {
		this.logs = [];
		this.completionError = null;
		this.completed = false;
	}

	private captureError(error: unknown): void {
		const detail = error && typeof error === "object" ? (error as { message?: unknown; stack?: unknown }) : undefined;
		this.completionError = {
			message: typeof detail?.message === "string" ? detail.message : String(error),
			stack: typeof detail?.stack === "string" ? detail.stack : "",
		};
	}
}
