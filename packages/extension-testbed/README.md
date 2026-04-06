# @pi-mono/extension-testbed

MCP server and helpers to run the **pi coding agent** against a TypeScript extension while exporting **OpenTelemetry traces** to the **Aspire Dashboard**, then query telemetry through MCP without sending megabytes of OTLP JSON to the LLM.

## Components

- **`otel-bridge.ts`** — Pi extension: maps agent/turn/tool lifecycle to OTLP spans (HTTP exporter to `OTLP_ENDPOINT/v1/traces`).
- **`pi-runner.ts`** — Spawns `pi --print --mode json` with `otel-bridge` + extension under test; collects JSONL events.
- **`aspire-client.ts`** — REST client for Aspire’s telemetry API (`/api/telemetry/...`).
- **`mcp-server.ts`** — MCP tools: `aspire_status`, `aspire_get_telemetry`, `aspire_get_trace`, `pi_test_extension`, `pi_get_events`.
- **`telemetry-shaping.ts`** — Summaries, span trees, pagination, and character caps for MCP responses.

## Environment (pi subprocess)

Set automatically by `pi_test_extension` (via `pi-runner`):

| Variable | Purpose |
|----------|---------|
| `OTLP_ENDPOINT` | Aspire OTLP HTTP base URL (e.g. `http://localhost:18890`) |
| `PI_OTEL_SERVICE_NAME` | `service.name` / Aspire resource filter (default `pi-agent-test-<uuid>`) |
| `PI_RUN_ID` | Correlation attribute on spans |

## MCP tools

### `pi_test_extension`

Runs pi with the given extension and prompt. **`telemetry_level`** (default **`summary`**):

- **`none`** — No Aspire queries after the run.
- **`summary`** — Trace IDs, counts, root span samples, hints (small JSON).
- **`full`** — Raw OTLP-style responses for spans, logs, and traces (large).

`capture_telemetry: false` is equivalent to `telemetry_level=none`.

### `pi_get_events`

Paginated slices of the pi JSON event stream for a `run_id`. Includes `telemetry_index` when available.

### `aspire_get_telemetry`

Query `resources` | `spans` | `traces` | `logs`. Use **`response_shape=summary`** for list endpoints to avoid huge payloads. Summaries include **`count_semantics`**: Aspire’s **spans** list counts spans; **traces** list counts traces (each response still uses OTLP `data.resourceSpans` with span rows). If counts are non-zero but **`trace_ids`** is empty, check **`parse_warning`** for an OTLP shape mismatch.

### `aspire_get_trace`

Fetch a single trace by ID: **`counts_only`**, **`span_tree`** (size-capped), **`span_page`** (`offset`/`limit`), or **`raw_capped`**.

## Pi package (skills)

Install as a pi package to load the skill from `skills/` (see `package.json` `pi` manifest). Invoke with `/skill:extension-testbed` (or the folder name pi discovers).

## Aspire reference

Telemetry HTTP API (paths, auth, limits):  
https://github.com/microsoft/aspire/blob/main/docs/specs/dashboard-http-api.md

## Build

```bash
cd packages/extension-testbed && npm run build
```

Start MCP (see `src/start-mcp.ts` / your IDE MCP config).
