import * as crypto from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AspireClient, type AspireResource } from "./aspire-client.js";
import type { TestbedConfig } from "./config.js";
import { type PiRunResult, runPi } from "./pi-runner.js";
import {
	buildPiRunTelemetrySummary,
	shapeTraceData,
	summarizeLogsResponse,
	summarizeTelemetryListResponse,
	type TraceDetailMode,
} from "./telemetry-shaping.js";

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
	response_shape: z
		.enum(["raw", "summary"])
		.optional()
		.default("raw")
		.describe(
			"raw=full OTLP JSON; summary=compact counts, trace_ids, span name samples (for spans/traces/logs only)",
		),
};

const aspireGetTraceSchema = {
	trace_id: z.string().describe("Trace ID (hex string from telemetry summary or Aspire UI)"),
	detail: z
		.enum(["counts_only", "span_tree", "span_page", "raw_capped"])
		.describe(
			"counts_only=span count; span_tree=all spans compact (size-capped); span_page=paginated slice; raw_capped=truncated OTLP JSON",
		),
	offset: z.coerce.number().optional().default(0).describe("For span_page: start index"),
	limit: z.coerce.number().optional().default(40).describe("For span_page: max spans"),
	max_attr_len: z.coerce.number().optional().default(500).describe("Max characters per string attribute/event field"),
	max_response_chars: z.coerce
		.number()
		.optional()
		.default(120_000)
		.describe("Hard cap on serialized size for span_tree/raw_capped"),
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
		.describe("If false, skips Aspire queries (same as telemetry_level=none)."),
	telemetry_level: z
		.enum(["none", "summary", "full"])
		.optional()
		.default("summary")
		.describe(
			"none=no Aspire data; summary=trace ids, counts, hints only; full=raw OTLP spans/logs/traces in response (large).",
		),
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
	/** Correlation for drill-down after pi_test_extension */
	const runTelemetryIndex = new Map<string, { service_name: string; trace_ids: string[] }>();

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

			let resources: AspireResource[] | null;
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
		"Query Aspire Dashboard for telemetry. Prefer response_shape=summary for LLM context; use aspire_get_trace for a single trace with pagination.",
		aspireTelemetrySchema,
		async (input) => {
			try {
				const shape = input.response_shape ?? "raw";
				let result: unknown;

				switch (input.type) {
					case "resources":
						result = await aspireClient.getResources();
						break;
					case "spans": {
						const raw = await aspireClient.getSpans({
							resource: input.resource,
							traceId: input.trace_id,
							hasError: input.has_error,
							limit: input.limit,
						});
						result =
							shape === "summary"
								? {
										shape: "summary",
										...summarizeTelemetryListResponse(raw, { listEndpoint: "spans" }),
										aspire_endpoint: config.aspireEndpoint,
									}
								: raw;
						break;
					}
					case "logs": {
						const raw = await aspireClient.getLogs({
							resource: input.resource,
							traceId: input.trace_id,
							severity: input.severity,
							limit: input.limit,
						});
						result =
							shape === "summary"
								? { shape: "summary", ...summarizeLogsResponse(raw), aspire_endpoint: config.aspireEndpoint }
								: raw;
						break;
					}
					case "traces": {
						const raw = await aspireClient.getTraces({
							resource: input.resource,
							hasError: input.has_error,
							limit: input.limit,
						});
						result =
							shape === "summary"
								? {
										shape: "summary",
										...summarizeTelemetryListResponse(raw, { listEndpoint: "traces" }),
										aspire_endpoint: config.aspireEndpoint,
									}
								: raw;
						break;
					}
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

	// ─── Tool: aspire_get_trace ────────────────────────────────────────────────

	// @ts-expect-error TS2589: MCP SDK generics exceed TypeScript's type instantiation depth limit
	server.tool(
		"aspire_get_trace",
		"Fetch one trace by ID from Aspire with controlled detail. Use after pi_test_extension (see telemetry_summary.trace_ids) or aspire_get_telemetry summary. Full fidelity: Aspire dashboard UI.",
		aspireGetTraceSchema,
		async (input) => {
			try {
				const trace = await aspireClient.getTrace(input.trace_id);
				if (!trace) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `Trace not found: ${input.trace_id}`,
									hint: "Verify the ID matches Aspire (UI or telemetry summary). Trace IDs are hex strings.",
								}),
							},
						],
						isError: true,
					};
				}
				const detail = input.detail as TraceDetailMode;
				const shaped = shapeTraceData(trace.data, input.trace_id, {
					detail,
					offset: input.offset,
					limit: input.limit,
					maxAttrLen: input.max_attr_len,
					maxResponseChars: input.max_response_chars,
				});
				const payload =
					detail === "raw_capped"
						? {
								aspire_endpoint: config.aspireEndpoint,
								trace_id: input.trace_id,
								detail: shaped.detail,
								warning: shaped.warning,
								raw_otlp_truncated: shaped.raw_truncated,
							}
						: { aspire_endpoint: config.aspireEndpoint, ...shaped };
				return {
					content: [{ type: "text" as const, text: JSON.stringify(payload) }],
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
		`Run a pi coding agent extension with OpenTelemetry export to Aspire.
Default telemetry_level=summary (small JSON). Use pi_get_events for stdout JSONL chunks.
Drill into traces: aspire_get_trace(trace_id, detail=span_tree | span_page).
Use telemetry_level=full only when you need raw OTLP in the tool result.`,
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

			const telemetryLevel = input.capture_telemetry === false ? "none" : (input.telemetry_level ?? "summary");

			let runResult: PiRunResult;
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
				aspire_endpoint: config.aspireEndpoint,
				telemetry_level: telemetryLevel,
				hint: "Use pi_get_events(run_id) for stdout. For spans: aspire_get_trace or aspire_get_telemetry with response_shape=summary.",
				...(runResult.stderr ? { stderr: runResult.stderr } : {}),
			};

			if (telemetryLevel !== "none") {
				const resource = await aspireClient.waitForResource(serviceName, { timeoutMs: 10000 });

				if (resource) {
					const filterBase = { resource: serviceName };
					if (telemetryLevel === "summary") {
						const [spans, logs, traces] = await Promise.allSettled([
							aspireClient.getSpans({ ...filterBase, limit: 35 }),
							aspireClient.getLogs({ ...filterBase, limit: 15 }),
							aspireClient.getTraces({ ...filterBase, limit: 8 }),
						]);
						const spansV = spans.status === "fulfilled" ? spans.value : null;
						const logsV = logs.status === "fulfilled" ? logs.value : null;
						const tracesV = traces.status === "fulfilled" ? traces.value : null;
						const telemetrySummary = buildPiRunTelemetrySummary(
							config.aspireEndpoint,
							serviceName,
							spansV,
							tracesV,
							logsV,
						);
						result.telemetry_summary = telemetrySummary;
						const traceIds = [
							...new Set([
								...(telemetrySummary.spans?.trace_ids ?? []),
								...(telemetrySummary.traces_list?.trace_ids ?? []),
							]),
						];
						runTelemetryIndex.set(runId, { service_name: serviceName, trace_ids: traceIds });
					} else {
						const [spans, logs, traces] = await Promise.allSettled([
							aspireClient.getSpans(filterBase),
							aspireClient.getLogs(filterBase),
							aspireClient.getTraces(filterBase),
						]);
						result.telemetry = {
							spans: spans.status === "fulfilled" ? spans.value : null,
							logs: logs.status === "fulfilled" ? logs.value : null,
							traces: traces.status === "fulfilled" ? traces.value : null,
							aspire_url: config.aspireEndpoint,
						};
						const spansV = spans.status === "fulfilled" ? spans.value : null;
						const traceIds = spansV
							? summarizeTelemetryListResponse(spansV, { listEndpoint: "spans" }).trace_ids
							: [];
						runTelemetryIndex.set(runId, { service_name: serviceName, trace_ids: traceIds });
					}
				} else {
					result.telemetry_warning =
						"Aspire resource not found within 10s. Is Aspire running? Check aspire_status().";
				}
			}

			if (runTelemetryIndex.has(runId)) {
				result.telemetry_index = runTelemetryIndex.get(runId);
			}

			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
			};
		},
	);

	// ─── Tool: pi_get_events ──────────────────────────────────────────────────

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
			const idx = runTelemetryIndex.get(input.run_id);
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
							...(idx ? { telemetry_index: idx } : {}),
							events: slice,
						}),
					},
				],
			};
		},
	);

	return server;
}
