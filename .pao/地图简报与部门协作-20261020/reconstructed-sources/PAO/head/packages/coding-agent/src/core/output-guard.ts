interface StdoutTakeoverState {
	rawStdoutWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	rawStderrWrite: (chunk: string, callback?: (error?: Error | null) => void) => boolean;
	originalStdoutWrite: typeof process.stdout.write;
}

interface SharedStdoutState {
	takeover?: StdoutTakeoverState;
	tail: Promise<void>;
}

// The bundled CLI and externally loaded extensions can import separate copies
// of this module. They must share both the original writer and its drain queue.
const stdoutStateKey = Symbol.for("pi.output-guard.stdout.v1");
const sharedGlobal = globalThis as typeof globalThis & { [stdoutStateKey]?: SharedStdoutState };
sharedGlobal[stdoutStateKey] ??= { tail: Promise.resolve() };
const sharedStdout = sharedGlobal[stdoutStateKey];

const RAW_STDOUT_RETRY_DELAY_MS = 10;

function getRawStdoutWrite(): StdoutTakeoverState["rawStdoutWrite"] {
	if (sharedStdout.takeover) {
		return sharedStdout.takeover.rawStdoutWrite;
	}
	return process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
}

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					getRawStdoutWrite()(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function takeOverStdout(): void {
	if (sharedStdout.takeover) {
		return;
	}

	const rawStdoutWrite = process.stdout.write.bind(process.stdout) as StdoutTakeoverState["rawStdoutWrite"];
	const rawStderrWrite = process.stderr.write.bind(process.stderr) as StdoutTakeoverState["rawStderrWrite"];
	const originalStdoutWrite = process.stdout.write;

	process.stdout.write = ((
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		if (typeof encodingOrCallback === "function") {
			return rawStderrWrite(String(chunk), encodingOrCallback);
		}
		return rawStderrWrite(String(chunk), callback);
	}) as typeof process.stdout.write;

	sharedStdout.takeover = {
		rawStdoutWrite,
		rawStderrWrite,
		originalStdoutWrite,
	};
}

export function restoreStdout(): void {
	if (!sharedStdout.takeover) {
		return;
	}

	process.stdout.write = sharedStdout.takeover.originalStdoutWrite;
	sharedStdout.takeover = undefined;
}

export function isStdoutTakenOver(): boolean {
	return sharedStdout.takeover !== undefined;
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	sharedStdout.tail = sharedStdout.tail.then(() => writeRawStdoutChunk(text));
	void sharedStdout.tail.catch(() => {
		process.exit(1);
	});
}

export async function waitForRawStdoutBackpressure(): Promise<void> {
	while (true) {
		const tail = sharedStdout.tail;
		await tail;
		if (tail === sharedStdout.tail) {
			return;
		}
	}
}

export async function flushRawStdout(): Promise<void> {
	await waitForRawStdoutBackpressure();
	await writeRawStdoutChunk("");
}
