/**
 * otel-bridge — pi extension that maps pi lifecycle events to OpenTelemetry spans.
 *
 * Load alongside the extension under test:
 *   pi --mode json "prompt" --extension otel-bridge.ts --extension my-ext.ts
 *
 * Configuration via env vars (set by pi-runner.ts):
 *   OTLP_ENDPOINT         OTLP HTTP base URL, e.g. http://localhost:18890
 *   PI_OTEL_SERVICE_NAME  Aspire service name for this run
 *   PI_RUN_ID             Unique run ID for correlation
 *
 * IMPORTANT: Uses HTTP exporter, not gRPC. @grpc/grpc-js has native binaries
 * incompatible with jiti's TypeScript transpiler.
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Context, context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

/** Truncate a value to a readable string, noting how many chars were dropped. */
function trunc(value: unknown, maxLen = 2000): string {
	const s = typeof value === "string" ? value : JSON.stringify(value);
	return s.length > maxLen ? `${s.slice(0, maxLen)}…[+${s.length - maxLen}]` : s;
}

export default function otelBridge(pi: ExtensionAPI): void {
	const otlpEndpoint = process.env.OTLP_ENDPOINT ?? "http://localhost:18890";
	const serviceName = process.env.PI_OTEL_SERVICE_NAME ?? "pi-agent";
	const runId = process.env.PI_RUN_ID ?? Date.now().toString();

	const exporter = new OTLPTraceExporter({
		url: `${otlpEndpoint}/v1/traces`,
	});

	const provider = new NodeTracerProvider({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: serviceName,
			"pi.run_id": runId,
		}),
		spanProcessors: [new BatchSpanProcessor(exporter)],
	});
	provider.register();

	const tracer = trace.getTracer("pi-otel-bridge", "1.0.0");

	// State shared across event handlers
	let agentSpan: Span | null = null;
	let agentCtx: Context | null = null;
	let pendingPrompt: string | null = null;
	const turnSpans = new Map<number, Span>();
	const toolSpans = new Map<string, Span>();

	pi.on("before_agent_start", async (event) => {
		const { prompt } = event as { prompt: string };
		pendingPrompt = prompt;
	});

	pi.on("agent_start", async () => {
		agentSpan = tracer.startSpan("pi.agent", {
			attributes: {
				"pi.run_id": runId,
				"pi.service_name": serviceName,
				...(pendingPrompt != null ? { "pi.prompt": trunc(pendingPrompt) } : {}),
			},
		});
		pendingPrompt = null;
		agentCtx = trace.setSpan(context.active(), agentSpan);
	});

	pi.on("agent_end", async () => {
		agentSpan?.end();
		agentSpan = null;
		agentCtx = null;
		await provider.forceFlush();
	});

	pi.on("turn_start", async (event) => {
		const { turnIndex, timestamp } = event as { turnIndex: number; timestamp: number };
		const parentCtx = agentCtx ?? context.active();
		const turnSpan = context.with(parentCtx, () =>
			tracer.startSpan("pi.turn", {
				attributes: {
					"pi.turn_index": turnIndex,
					"pi.turn_timestamp": timestamp,
				},
			}),
		);
		turnSpans.set(turnIndex, turnSpan);
	});

	pi.on("turn_end", async (event) => {
		const { turnIndex, message, toolResults } = event as {
			turnIndex: number;
			message: unknown;
			toolResults: unknown[];
		};
		const span = turnSpans.get(turnIndex);
		if (span) {
			// Token usage + model info from the assistant message
			const msg = message as Record<string, unknown> ?? {};
			if (msg.role === "assistant") {
				const usage = msg.usage as Record<string, number> | undefined;
				if (usage) {
					if (usage.input != null) span.setAttribute("pi.turn.input_tokens", usage.input);
					if (usage.output != null) span.setAttribute("pi.turn.output_tokens", usage.output);
					if (usage.cacheRead != null) span.setAttribute("pi.turn.cache_read_tokens", usage.cacheRead);
					if (usage.cacheWrite != null) span.setAttribute("pi.turn.cache_write_tokens", usage.cacheWrite);
					if (usage.totalTokens != null) span.setAttribute("pi.turn.total_tokens", usage.totalTokens);
					const cost = (usage as unknown as { cost?: { total?: number } }).cost;
					if (cost?.total != null) span.setAttribute("pi.turn.cost_usd", cost.total);
				}
				if (msg.model) span.setAttribute("pi.turn.model", String(msg.model));
				if (msg.stopReason) span.setAttribute("pi.turn.stop_reason", String(msg.stopReason));

				// Record assistant text as a span event so it's readable in the dashboard
				const content = msg.content as Array<{ type: string; text?: string; thinking?: string }> | undefined;
				if (content) {
					const text = content
						.filter((c) => c.type === "text")
						.map((c) => c.text)
						.join("");
					if (text) span.addEvent("pi.assistant_text", { "pi.text": trunc(text) });

					const thinking = content
						.filter((c) => c.type === "thinking")
						.map((c) => c.thinking)
						.join("");
					if (thinking) span.addEvent("pi.thinking", { "pi.thinking": trunc(thinking) });
				}
			}

			span.setAttribute("pi.turn.tool_count", toolResults.length);
			span.end();
			turnSpans.delete(turnIndex);
		}
	});

	pi.on("tool_execution_start", async (event) => {
		const { toolCallId, toolName, args } = event as {
			toolCallId: string;
			toolName: string;
			args: unknown;
		};

		// Use the most recent open turn span as parent, falling back to agent span
		const latestTurnSpan = [...turnSpans.values()].at(-1);
		const parentCtx = latestTurnSpan
			? trace.setSpan(context.active(), latestTurnSpan)
			: (agentCtx ?? context.active());

		const toolSpan = context.with(parentCtx, () =>
			tracer.startSpan(`pi.tool.${toolName}`, {
				attributes: {
					"pi.tool_call_id": toolCallId,
					"pi.tool_name": toolName,
					"pi.tool_args": trunc(args),
				},
			}),
		);
		toolSpans.set(toolCallId, toolSpan);
	});

	pi.on("tool_execution_end", async (event) => {
		const { toolCallId, isError, result } = event as {
			toolCallId: string;
			isError: boolean;
			result: AgentToolResult<unknown>;
		};
		const span = toolSpans.get(toolCallId);
		if (span) {
			if (isError) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			// Record truncated result so the dashboard shows what the tool returned
			if (result?.content) {
				const text = (result.content as Array<{ type: string; text?: string }>)
					.filter((c) => c.type === "text")
					.map((c) => c.text)
					.join("");
				if (text) span.setAttribute("pi.tool.result", trunc(text, 1000));
			}
			span.end();
			toolSpans.delete(toolCallId);
		}
	});

	pi.on("session_shutdown", async () => {
		// Close any spans left open (e.g. if pi exits mid-turn)
		for (const span of toolSpans.values()) span.end();
		toolSpans.clear();
		for (const span of turnSpans.values()) span.end();
		turnSpans.clear();
		agentSpan?.end();
		agentSpan = null;
		await provider.forceFlush();
	});
}
