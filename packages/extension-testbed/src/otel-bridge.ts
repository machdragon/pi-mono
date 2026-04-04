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

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
	trace,
	context,
	SpanStatusCode,
	type Span,
	type Context,
} from "@opentelemetry/api";

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
	const turnSpans = new Map<number, Span>();
	const toolSpans = new Map<string, Span>();

	pi.on("agent_start", async () => {
		agentSpan = tracer.startSpan("pi.agent", {
			attributes: {
				"pi.run_id": runId,
				"pi.service_name": serviceName,
			},
		});
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
		const { turnIndex } = event as { turnIndex: number };
		const span = turnSpans.get(turnIndex);
		if (span) {
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
					"pi.tool_args": JSON.stringify(args),
				},
			}),
		);
		toolSpans.set(toolCallId, toolSpan);
	});

	pi.on("tool_execution_end", async (event) => {
		const { toolCallId, isError } = event as {
			toolCallId: string;
			isError: boolean;
		};
		const span = toolSpans.get(toolCallId);
		if (span) {
			if (isError) {
				span.setStatus({ code: SpanStatusCode.ERROR });
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
