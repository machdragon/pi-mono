import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the otel-bridge extension in this package */
export const OTEL_BRIDGE_PATH = resolve(__dirname, "../src/otel-bridge.ts");

export interface PiRunOptions {
	prompt: string;
	/** Absolute path(s) to user extensions. otel-bridge is always prepended. */
	extensions: string[];
	/** Env vars to inject (OTLP_ENDPOINT, PI_OTEL_SERVICE_NAME, PI_RUN_ID) */
	env: Record<string, string>;
	/** Working directory for the pi subprocess */
	cwd?: string;
	/** Override default timeout */
	timeoutMs?: number;
	/** Optional model override */
	model?: string;
	/** Path to the pi binary */
	piBinaryPath?: string;
}

export interface PiRunResult {
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	/** Parsed JSON objects from pi's JSON-mode stdout */
	events: object[];
	stderr: string;
}

export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
	const {
		prompt,
		extensions,
		env,
		cwd,
		timeoutMs = 120000,
		model,
		piBinaryPath = "pi",
	} = options;

	// Build args: --mode json --no-extensions <prompt> [--model <model>] [--extension <path>] ...
	// --no-extensions prevents auto-discovery of user/project extensions so only the
	// explicitly passed otel-bridge + extension-under-test are loaded (avoids double-loading
	// otel-bridge when the testbed package is also installed as a user extension).
	const args: string[] = ["--mode", "json", "--no-extensions", prompt];
	if (model) {
		args.push("--model", model);
	}
	// otel-bridge first, then user extensions
	for (const ext of [OTEL_BRIDGE_PATH, ...extensions]) {
		args.push("--extension", ext);
	}

	const startTime = Date.now();
	const events: object[] = [];
	let stderr = "";
	let timedOut = false;
	let exitCode: number | null = null;
	let spawnError: Error | null = null;

	const controller = new AbortController();
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const child = spawn(piBinaryPath, args, {
		cwd,
		env: { ...process.env, ...env },
		signal: controller.signal,
	});

	// Read JSON event lines from stdout
	const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		try {
			events.push(JSON.parse(trimmed));
		} catch {
			// Non-JSON line — ignore (pi may emit a few non-JSON lines during startup)
		}
	});

	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});

	await new Promise<void>((resolve) => {
		child.on("close", (code) => {
			exitCode = code;
			clearTimeout(timer);
			resolve();
		});
		child.on("error", (err) => {
			spawnError = err;
			clearTimeout(timer);
			resolve();
		});
	});

	// Surface spawn errors (e.g. ENOENT for missing binary), but not the
	// expected ABORT_ERR that fires when we cancel due to timeout.
	if (spawnError && !timedOut) {
		throw spawnError;
	}

	// If we aborted due to timeout, try SIGKILL after 2s
	if (timedOut) {
		try {
			child.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 2000));
			child.kill("SIGKILL");
		} catch {
			// Process may have already exited
		}
	}

	return {
		exitCode,
		timedOut,
		durationMs: Date.now() - startTime,
		events,
		stderr,
	};
}
