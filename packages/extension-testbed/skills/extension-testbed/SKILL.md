# Pi extension testbed (Aspire + MCP)

Use this skill when driving the **pi-extension-testbed** MCP server to run pi with OpenTelemetry, inspect traces in **Aspire Dashboard**, and avoid blowing up the model context with huge OTLP JSON.

## Prerequisites

1. **Aspire Dashboard** reachable at the MCP server’s configured HTTP port (default frontend `18888`, OTLP HTTP `18890`). If `aspire_status` says unreachable, start the dashboard (see the docker one-liner in that tool’s error message).
2. **`pi`** on `PATH` (or configured `piBinaryPath` in testbed config) for `pi_test_extension`.

## Tool order (default workflow)

1. **`aspire_status`** — Confirm the dashboard and API are up; note `service.name` values if needed.
2. **`pi_test_extension`** — Run the extension under test. Defaults: `telemetry_level=summary` (small payload). You get `run_id`, `service_name`, `telemetry_summary` (trace IDs, counts, hints), and `telemetry_index`.
3. **`pi_get_events`** — Page through pi JSON-mode stdout with `offset` / `limit`. Prefer this over assuming the first tool returned all events.
4. **`aspire_get_trace`** — Drill into one trace: `detail=counts_only` → `span_tree` or `span_page` with `offset`/`limit` for large traces.
5. **`aspire_get_telemetry`** — List spans/logs/traces with filters. Use **`response_shape=summary`** unless you truly need raw OTLP.

## Rules for the model

- Do **not** set `telemetry_level=full` on `pi_test_extension` unless debugging; it embeds full OTLP and can exhaust context.
- After a run, use **`telemetry_summary.trace_ids`** (or `telemetry_index`) with **`aspire_get_trace`**, not a giant `aspire_get_telemetry` raw dump.
- For **full visual detail**, use the **Aspire UI** at `aspire_endpoint`; MCP returns **truncated** projections on purpose.
- Pi subprocess env for OTLP (set by the testbed, not by hand): `OTLP_ENDPOINT`, `PI_OTEL_SERVICE_NAME`, `PI_RUN_ID`.

## MCP tools (quick reference)

| Tool | Role |
|------|------|
| `aspire_status` | Health + resource list |
| `pi_test_extension` | Run pi + OTel export; summary by default |
| `pi_get_events` | Paginated pi stdout events |
| `aspire_get_trace` | One trace: counts, tree, page, or capped raw |
| `aspire_get_telemetry` | Query API; prefer `response_shape=summary` |

## Related docs

- Aspire Telemetry HTTP API: https://github.com/microsoft/aspire/blob/main/docs/specs/dashboard-http-api.md
- Package README: `packages/extension-testbed/README.md` in pi-mono
