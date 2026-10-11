export interface SandboxFile {
	fileName: string;
	content: string | Uint8Array;
	mimeType: string;
}

export interface SandboxResult {
	success: boolean;
	console: Array<{ type: string; text: string }>;
	files?: SandboxFile[];
	error?: { message: string; stack: string };
	returnValue?: unknown;
}

export interface RuntimeMessage {
	type: string;
	sandboxId?: string;
	messageId?: string;
	[key: string]: unknown;
}

export interface RuntimeResponse {
	success?: boolean;
	error?: string;
	[key: string]: unknown;
}

export interface SandboxRuntimeProvider {
	getData(): Record<string, unknown>;
	getRuntime(): (sandboxId: string) => void;
	getDescription(): string;
	handleMessage?(message: RuntimeMessage, respond: (response: RuntimeResponse) => void): Promise<void>;
	onExecutionStart?(sandboxId: string, signal?: AbortSignal): void;
	onExecutionEnd?(sandboxId: string): void;
}

export interface MessageConsumer {
	handleMessage(message: RuntimeMessage): Promise<void>;
}
