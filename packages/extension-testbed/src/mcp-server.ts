import * as crypto from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AspireClient } from "./aspire-client.js";
import type { TestbedConfig } from "./config.js";
import { runPi } from "./pi-runner.js";

// Extract schemas as named constants to avoid tsgo type instantiation depth errors
const aspireStatusSchema = {};

const aspireTelemetrySchema = {
	type: z.enum(["resources", "spans", "traces", "logs"]).describe("Type of telemetry to query"),
	resource: z.string().optional().describe("Filter by resource/service name (e.g. the service_name from a test run)"),
	trace_id: z.string().optional().describe("Filter by specific trace ID (spans and logs only)"),
	has_error: z.boolean().optional().describe("Filter to only errored spans/traces"),
	severity: z
		.enum(["trace", "debug", "information", "warning", "error", "critical"])
		.optional()
		.describe("Filter logs by minimum severity"),
	limit: z.number().optional().describe("Max number of results (default: 200 for spans/logs, 100 for traces)"),
};

const piTestSchema = {
	prompt: z.string().describe("The prompt to send to pi (can be a slash command like /plan ...)"),
	extension_path: z.string().describe("Absolute path to the .ts extension file under test"),
	cwd: z.string().optional().describe("Working directory for pi (defaults to the extension file's directory)"),
	model: z.string().optional().describe("Optional model override, e.g. claude-haiku-4-5"),
	timeout_ms: z.number().optional().describe("Timeout in ms (default: 120000)"),
	capture_telemetry: z
		.boolean()
		.optional()
		.default(true)
		.describe("Whether to query Aspire for telemetry after the run"),
	service_name: z
		.string()
		.optional()
		.describe(
			"Aspire service name for this run (default: pi-agent-test-<runId>). Use a stable name to compare runs.",
		),
};

export function createMcpServer(config: TestbedConfig): McpServer {
	const aspireClient = new AspireClient({
		baseUrl: config.aspireEndpoint,
		apiKey: config.aspireApiKey,
	});

	/** In-memory store of full event arrays keyed by run_id */
	const runStore = new Map<string, object[]>();

	const server = new McpServer({
		name: "pi-extension-testbed",
		version: "0.1.0",
	});

	// ─── Tool: aspire_status ───────────────────────────────────────────────────

	server.tool(
		"aspire_status",
		"Check if the Aspire Dashboard is reachable and list known resources",
		aspireStatusSchema,
		async () => {
			const reachable = await aspireClient.isReachable();
			if (!reachable) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								reachable: false,
								endpoint: config.aspireEndpoint,
								error: "Cannot reach Aspire Dashboard. Start it with: docker run --rm -it -p 18888:18888 -p 18889:18889 -p 18890:18890 -e ASPIRE_DASHBOARD_API_ENABLED=true -e DASHBOARD__API__AUTHMODE=Unsecured -e DASHBOARD__OTLP__AUTHMODE=Unsecured -e DASHBOARD__UNSECUREDALLOWANONYMOUS=true mcr.microsoft.com/dotnet/aspire-dashboard:latest",
							}),
						},
					],
				};
			}

			let resources;
			try {
				resources = await aspireClient.getResources();
			} catch {
				resources = null;
			}

			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({ reachable: true, endpoint: config.aspireEndpoint, resources }),
					},
				],
			};
		},
	);

	// ─── Tool: aspire_get_telemetry ────────────────────────────────────────────

	// @ts-expect-error TS2589: MCP SDK generics exceed TypeScript's type instantiation depth limit
	server.tool(
		"aspire_get_telemetry",
		"Query Aspire Dashboard for telemetry data (spans, logs, traces, or resources). Use this to drill into a specific run after pi_test_extension.",
		aspireTelemetrySchema,
		async (input) => {
			try {
				let result;
				switch (input.type) {
					case "resources":
						result = await aspireClient.getResources();
						break;
					case "spans":
						result = await aspireClient.getSpans({
							resource: input.resource,
							traceId: input.trace_id,
							hasError: input.has_error,
							limit: input.limit,
						});
						break;
					case "logs":
						result = await aspireClient.getLogs({
							resource: input.resource,
							traceId: input.trace_id,
							severity: input.severity,
							limit: input.limit,
						});
						break;
					case "traces":
						result = await aspireClient.getTraces({
							resource: input.resource,
							hasError: input.has_error,
							limit: input.limit,
						});
						break;
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(result) }],
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
						},
					],
					isError: true,
				};
			}
		},
	);

	// ─── Tool: pi_test_extension ───────────────────────────────────────────────

	// @ts-expect-error TS2589: MCP SDK generics exceed TypeScript's type instantiation depth limit
	server.tool(
		"pi_test_extension",
		`Run a pi coding agent extension and observe the result via OpenTelemetry.
Starts pi in JSON mode with the given prompt and the extension under test.
Returns pi's JSON event stream plus Aspire telemetry (spans, logs, traces).
Use this in a loop to implement → test → observe → fix an extension.

Examples:
  prompt: "list the files in this directory"        (test a simple tool)
  prompt: "/plan say good morning at 8am every day" (test a slash command extension)`,
		piTestSchema,
		async (input) => {
			const runId = crypto.randomUUID();
			const serviceName = input.service_name ?? `pi-agent-test-${runId}`;

			const extensionPath = isAbsolute(input.extension_path)
				? input.extension_path
				: resolve(process.cwd(), input.extension_path);

			const cwd = input.cwd ?? dirname(extensionPath);

			const env: Record<string, string> = {
				OTLP_ENDPOINT: config.otlpEndpoint,
				PI_OTEL_SERVICE_NAME: serviceName,
				PI_RUN_ID: runId,
			};

			let runResult;
			try {
				runResult = await runPi({
					prompt: input.prompt,
					extensions: [extensionPath],
					env,
					cwd,
					timeoutMs: input.timeout_ms ?? config.piTimeoutMs,
					model: input.model,
					piBinaryPath: config.piBinaryPath,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								error: `Failed to run pi: ${err instanceof Error ? err.message : String(err)}`,
								run_id: runId,
								service_name: serviceName,
							}),
						},
					],
					isError: true,
				};
			}

			// Store events for paginated retrieval via pi_get_events.
			// Strip the `partial` field from message_update events — it's the full
			// accumulated text so far (O(n²) growth), whereas `delta` is the useful part.
			const storedEvents = runResult.events.map((e) => {
				const ev = e as Record<string, unknown>;
				if (ev.type === "message_update" && ev.assistantMessageEvent) {
					const { partial: _partial, ...deltaOnly } = ev.assistantMessageEvent as Record<string, unknown>;
					return { ...ev, assistantMessageEvent: deltaOnly };
				}
				return e;
			});
			runStore.set(runId, storedEvents);

			const result: Record<string, unknown> = {
				run_id: runId,
				service_name: serviceName,
				timed_out: runResult.timedOut,
				exit_code: runResult.exitCode,
				duration_ms: runResult.durationMs,
				event_count: runResult.events.length,
				...(runResult.stderr ? { stderr: runResult.stderr } : {}),
			};

			if (input.capture_telemetry) {
				// Wait for Aspire to receive the spans, then query
				const resource = await aspireClient.waitForResource(serviceName, { timeoutMs: 10000 });

				if (resource) {
					const filter = { resource: serviceName };
					const [spans, logs, traces] = await Promise.allSettled([
						aspireClient.getSpans(filter),
						aspireClient.getLogs(filter),
						aspireClient.getTraces(filter),
					]);

					result.telemetry = {
						spans: spans.status === "fulfilled" ? spans.value : null,
						logs: logs.status === "fulfilled" ? logs.value : null,
						traces: traces.status === "fulfilled" ? traces.value : null,
						aspire_url: config.aspireEndpoint,
					};
				} else {
					result.telemetry_warning =
						"Aspire resource not found within 10s. Is Aspire running? Check aspire_status().";
				}
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	// ─── Tool: pi_get_events ──────────────────────────────────────────────────

	// @ts-expect-error TS2589: MCP SDK generics exceed TypeScript's type instantiation depth limit
	server.tool(
		"pi_get_events",
		"Read raw events from a pi_test_extension run in paginated chunks. Use offset+limit to step through the full event stream without overflowing context.",
		{
			run_id: z.string().describe("The run_id returned by pi_test_extension"),
			offset: z.coerce.number().optional().default(0).describe("Start index (default: 0)"),
			limit: z.coerce.number().optional().default(50).describe("Max events to return (default: 50)"),
		},
		async (input) => {
			const events = runStore.get(input.run_id);
			if (!events) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: `No events found for run_id: ${input.run_id}` }),
						},
					],
					isError: true,
				};
			}
			const offset = input.offset ?? 0;
			const limit = input.limit ?? 50;
			const slice = events.slice(offset, offset + limit);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							run_id: input.run_id,
							offset,
							limit,
							returned: slice.length,
							total: events.length,
							has_more: offset + slice.length < events.length,
							events: slice,
						}),
					},
				],
			};
		},
	);

	return server;
}
