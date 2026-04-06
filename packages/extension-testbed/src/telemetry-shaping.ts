/**
 * Reduce Aspire OTLP JSON responses for MCP / LLM consumption.
 * Full fidelity remains in the Aspire dashboard and in raw API responses.
 */

import type { TelemetryApiResponse } from "./aspire-client.js";

const DEFAULT_TRUNC = 2000;
const DEFAULT_ATTR_TRUNC = 500;

/** Truncate a string for display; note dropped length. */
export function truncStr(value: unknown, maxLen = DEFAULT_TRUNC): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	return s.length > maxLen ? `${s.slice(0, maxLen)}…[+${s.length - maxLen}]` : s;
}

function unwrapOtlpValue(v: unknown): string | number | boolean | null {
	if (v === null || v === undefined) return null;
	if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
	const o = v as Record<string, unknown>;
	if ("stringValue" in o && typeof o.stringValue === "string") return o.stringValue;
	if ("intValue" in o) return typeof o.intValue === "string" ? Number(o.intValue) : Number(o.intValue);
	if ("doubleValue" in o && typeof o.doubleValue === "number") return o.doubleValue;
	if ("boolValue" in o && typeof o.boolValue === "boolean") return o.boolValue;
	return truncStr(v, 200);
}

export interface FlatSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	durationMs: number;
	statusCode?: number;
	attributes: Record<string, string | number | boolean | null>;
	events: Array<{ name: string; timeUnixNano: string; attributes: Record<string, string | number | boolean | null> }>;
}

function nanoBigint(s: string | undefined): bigint {
	if (!s) return 0n;
	try {
		return BigInt(s);
	} catch {
		return 0n;
	}
}

function durationMs(start: string, end: string): number {
	const d = nanoBigint(end) - nanoBigint(start);
	return Number(d / 1_000_000n);
}

function parseAttributes(attrs: unknown, attrMaxLen: number): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	if (!Array.isArray(attrs)) return out;
	for (const a of attrs) {
		const row = a as { key?: string; value?: unknown };
		if (!row.key) continue;
		const raw = unwrapOtlpValue(row.value);
		if (raw === null) out[row.key] = null;
		else if (typeof raw === "string") out[row.key] = truncStr(raw, attrMaxLen);
		else out[row.key] = raw;
	}
	return out;
}

function parseEvents(
	events: unknown,
	attrMaxLen: number,
): Array<{ name: string; timeUnixNano: string; attributes: Record<string, string | number | boolean | null> }> {
	if (!Array.isArray(events)) return [];
	return events.map((e) => {
		const ev = e as { name?: string; timeUnixNano?: string; attributes?: unknown };
		return {
			name: ev.name ?? "",
			timeUnixNano: ev.timeUnixNano ?? "0",
			attributes: parseAttributes(ev.attributes, attrMaxLen),
		};
	});
}

/** Walk Aspire `data` object (resourceSpans[]) and collect every span. */
export function flattenSpansFromTelemetryData(data: unknown): FlatSpan[] {
	const out: FlatSpan[] = [];
	const root = data as { resourceSpans?: unknown[] } | null;
	if (!root?.resourceSpans) return out;

	for (const rs of root.resourceSpans) {
		const block = rs as { scopeSpans?: unknown[] };
		if (!block.scopeSpans) continue;
		for (const ss of block.scopeSpans) {
			const scope = ss as { spans?: unknown[] };
			if (!scope.spans) continue;
			for (const sp of scope.spans) {
				const s = sp as {
					traceId?: string;
					spanId?: string;
					parentSpanId?: string;
					name?: string;
					startTimeUnixNano?: string;
					endTimeUnixNano?: string;
					attributes?: unknown;
					events?: unknown;
					status?: { code?: number; message?: string };
				};
				const start = s.startTimeUnixNano ?? "0";
				const end = s.endTimeUnixNano ?? start;
				out.push({
					traceId: s.traceId ?? "",
					spanId: s.spanId ?? "",
					parentSpanId: s.parentSpanId,
					name: s.name ?? "",
					startTimeUnixNano: start,
					endTimeUnixNano: end,
					durationMs: durationMs(start, end),
					statusCode: s.status?.code,
					attributes: parseAttributes(s.attributes, DEFAULT_ATTR_TRUNC),
					events: parseEvents(s.events, DEFAULT_ATTR_TRUNC),
				});
			}
		}
	}
	return out;
}

export function uniqueTraceIds(spans: FlatSpan[]): string[] {
	const set = new Set<string>();
	for (const s of spans) {
		if (s.traceId) set.add(s.traceId);
	}
	return [...set];
}

/** Spans with no parent in this trace set (for roots relative to slice). */
export function rootSpanNames(spans: FlatSpan[]): string[] {
	const ids = new Set(spans.map((s) => s.spanId));
	const roots = spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId));
	const names = [...new Set(roots.map((s) => s.name).filter(Boolean))];
	return names;
}

export type TelemetryListEndpoint = "spans" | "traces";

export interface TelemetryListSummary {
	totalCount: number;
	returnedCount: number;
	/** Aspire: spans list counts spans; traces list counts traces (not spans). */
	count_semantics: "aspire_spans" | "aspire_traces";
	trace_ids: string[];
	root_span_names: string[];
	span_name_samples: string[];
	/** Set when API reports rows but OTLP could not be parsed (unexpected shape or empty spans). */
	parse_warning?: string;
}

function describeOtlpDataShape(data: unknown): "resourceSpans" | "nullish" | "no_resourceSpans" {
	if (data === null || data === undefined) return "nullish";
	if (typeof data !== "object") return "no_resourceSpans";
	const rs = (data as { resourceSpans?: unknown }).resourceSpans;
	return Array.isArray(rs) ? "resourceSpans" : "no_resourceSpans";
}

export interface SummarizeTelemetryListOptions {
	/** Which Aspire list endpoint produced `resp` (affects count_semantics and warnings). */
	listEndpoint: TelemetryListEndpoint;
}

/** Summarize a spans or traces list response without returning full OTLP `data`. */
export function summarizeTelemetryListResponse(
	resp: TelemetryApiResponse,
	opts: SummarizeTelemetryListOptions,
): TelemetryListSummary {
	const spans = flattenSpansFromTelemetryData(resp.data);
	const trace_ids = uniqueTraceIds(spans);
	const root_span_names = rootSpanNames(spans);
	const span_name_samples = [...new Set(spans.map((s) => s.name).filter(Boolean))].slice(0, 15);
	const shape = describeOtlpDataShape(resp.data);
	const count_semantics = opts.listEndpoint === "traces" ? "aspire_traces" : "aspire_spans";

	let parse_warning: string | undefined;
	const countsNonZero = resp.totalCount > 0 || resp.returnedCount > 0;
	if (spans.length === 0 && countsNonZero) {
		const path = `/api/telemetry/${opts.listEndpoint}`;
		if (shape === "nullish") {
			parse_warning = `${path} returned totalCount/returnedCount > 0 but data is null; cannot extract trace_ids.`;
		} else if (shape === "no_resourceSpans") {
			parse_warning = `Expected OTLP JSON with data.resourceSpans (Aspire ${path} normally uses ConvertSpansToOtlpJson). Got a different shape; trace_ids and span samples are empty.`;
		} else {
			parse_warning =
				"data.resourceSpans is present but no spans were parsed; OTLP JSON may use fields this client does not read, or scopes are empty.";
		}
	}

	return {
		totalCount: resp.totalCount,
		returnedCount: resp.returnedCount,
		count_semantics,
		trace_ids,
		root_span_names,
		span_name_samples,
		...(parse_warning ? { parse_warning } : {}),
	};
}

export interface PiRunTelemetrySummary {
	aspire_endpoint: string;
	service_name: string;
	hint: string;
	spans: TelemetryListSummary | null;
	/** Same summary shape as spans; count_semantics is aspire_traces. */
	traces_list: TelemetryListSummary | null;
	logs: { totalCount: number; returnedCount: number; trace_ids_in_sample: string[] } | null;
}

function logTraceIdsSample(resp: TelemetryApiResponse, max = 8): string[] {
	const data = resp.data as { resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: unknown[] }> }> };
	const ids = new Set<string>();
	const logs = data?.resourceLogs;
	if (!logs) return [];
	for (const rl of logs) {
		for (const sl of rl.scopeLogs ?? []) {
			for (const rec of sl.logRecords ?? []) {
				const r = rec as { traceId?: string };
				if (r.traceId) ids.add(r.traceId);
				if (ids.size >= max) return [...ids];
			}
		}
	}
	return [...ids];
}

/** Build the small object returned from pi_test_extension when telemetry_level is summary. */
export function buildPiRunTelemetrySummary(
	aspireEndpoint: string,
	serviceName: string,
	spans: TelemetryApiResponse | null,
	traces: TelemetryApiResponse | null,
	logs: TelemetryApiResponse | null,
): PiRunTelemetrySummary {
	return {
		aspire_endpoint: aspireEndpoint,
		service_name: serviceName,
		hint: `Full OTLP is in the Aspire dashboard (${aspireEndpoint}). Use aspire_get_trace(trace_id, ...) or aspire_get_telemetry with response_shape for more detail.`,
		spans: spans ? summarizeTelemetryListResponse(spans, { listEndpoint: "spans" }) : null,
		traces_list: traces ? summarizeTelemetryListResponse(traces, { listEndpoint: "traces" }) : null,
		logs: logs
			? {
					totalCount: logs.totalCount,
					returnedCount: logs.returnedCount,
					trace_ids_in_sample: logTraceIdsSample(logs),
				}
			: null,
	};
}

export type TraceDetailMode = "counts_only" | "span_tree" | "span_page" | "raw_capped";

export interface ShapeTraceOptions {
	detail: TraceDetailMode;
	offset?: number;
	limit?: number;
	maxAttrLen?: number;
	maxResponseChars?: number;
}

export interface ShapedTraceResult {
	detail: TraceDetailMode;
	trace_id: string;
	span_count?: number;
	returned_spans?: number;
	spans?: Array<{
		spanId: string;
		parentSpanId?: string;
		name: string;
		durationMs: number;
		statusCode?: number;
		attributes?: Record<string, string | number | boolean | null>;
		events?: Array<{ name: string; attributes: Record<string, string | number | boolean | null> }>;
	}>;
	warning?: string;
	raw_truncated?: string;
}

/** Project a single-trace OTLP payload for MCP responses. */
export function shapeTraceData(data: unknown, traceId: string, opts: ShapeTraceOptions): ShapedTraceResult {
	const maxAttr = opts.maxAttrLen ?? DEFAULT_ATTR_TRUNC;
	const offset = opts.offset ?? 0;
	const limit = opts.limit ?? 40;
	const maxChars = opts.maxResponseChars ?? 120_000;

	const flat = flattenSpansFromTelemetryData(data);
	const inTrace = traceId ? flat.filter((s) => s.traceId === traceId) : flat;

	if (opts.detail === "counts_only") {
		return {
			detail: "counts_only",
			trace_id: traceId,
			span_count: inTrace.length,
		};
	}

	if (opts.detail === "span_page") {
		const slice = inTrace.slice(offset, offset + limit);
		return {
			detail: "span_page",
			trace_id: traceId,
			span_count: inTrace.length,
			returned_spans: slice.length,
			spans: slice.map((s) => ({
				spanId: s.spanId,
				parentSpanId: s.parentSpanId,
				name: s.name,
				durationMs: s.durationMs,
				statusCode: s.statusCode,
				attributes: retruncateAttributes(s.attributes, maxAttr),
				events: s.events.map((e) => ({
					name: e.name,
					attributes: retruncateAttributes(e.attributes, maxAttr),
				})),
			})),
			warning:
				offset + slice.length < inTrace.length
					? `More spans available: offset=${offset + slice.length}, total=${inTrace.length}`
					: undefined,
		};
	}

	if (opts.detail === "span_tree") {
		const buildCompact = (list: typeof inTrace) =>
			list.map((s) => ({
				spanId: s.spanId,
				parentSpanId: s.parentSpanId,
				name: s.name,
				durationMs: s.durationMs,
				statusCode: s.statusCode,
				attributes: retruncateAttributes(s.attributes, maxAttr),
				events: s.events.map((e) => ({
					name: e.name,
					attributes: retruncateAttributes(e.attributes, maxAttr),
				})),
			}));

		let slice = inTrace;
		let compact = buildCompact(slice);
		let payload = { trace_id: traceId, span_count: inTrace.length, spans: compact };
		let json = JSON.stringify(payload);
		let trimmed = false;
		while (json.length > maxChars && compact.length > 1) {
			slice = slice.slice(0, Math.max(1, Math.floor(slice.length * 0.7)));
			compact = buildCompact(slice);
			payload = { trace_id: traceId, span_count: inTrace.length, spans: compact };
			json = JSON.stringify(payload);
			trimmed = true;
		}
		return {
			detail: "span_tree",
			trace_id: traceId,
			span_count: inTrace.length,
			returned_spans: compact.length,
			spans: compact,
			warning: trimmed
				? `Trimmed to ${compact.length} spans to stay under ${maxChars} chars; use span_page with offset/limit.`
				: undefined,
		};
	}

	// raw_capped
	const raw = JSON.stringify(data);
	let raw_truncated = raw;
	let warning: string | undefined;
	if (raw.length > maxChars) {
		raw_truncated = `${raw.slice(0, maxChars)}…[+${raw.length - maxChars}]`;
		warning = `Raw OTLP JSON truncated at ${maxChars} characters. View full trace in Aspire UI.`;
	}
	return {
		detail: "raw_capped",
		trace_id: traceId,
		warning,
		raw_truncated,
	};
}

function retruncateAttributes(
	attrs: Record<string, string | number | boolean | null>,
	maxLen: number,
): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	for (const [k, v] of Object.entries(attrs)) {
		if (typeof v === "string") out[k] = truncStr(v, maxLen);
		else out[k] = v;
	}
	return out;
}

/** Summarize logs response: counts + short body samples. */
export function summarizeLogsResponse(resp: TelemetryApiResponse, bodyMax = 200): Record<string, unknown> {
	const data = resp.data as { resourceLogs?: unknown[] };
	const samples: string[] = [];
	const traceIds = new Set<string>();

	function walk(records: unknown[]) {
		for (const rec of records) {
			const r = rec as { body?: { stringValue?: string }; traceId?: string };
			if (r.traceId) traceIds.add(r.traceId);
			const body = r.body?.stringValue;
			if (body && samples.length < 5) samples.push(truncStr(body, bodyMax));
		}
	}

	for (const rl of data?.resourceLogs ?? []) {
		const block = rl as { scopeLogs?: Array<{ logRecords?: unknown[] }> };
		for (const sl of block.scopeLogs ?? []) {
			walk(sl.logRecords ?? []);
		}
	}

	return {
		totalCount: resp.totalCount,
		returnedCount: resp.returnedCount,
		trace_ids: [...traceIds].slice(0, 20),
		body_samples: samples,
	};
}
