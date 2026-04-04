export interface AspireResource {
	name: string;
	instanceId?: string;
	displayName?: string;
	hasLogs: boolean;
	hasTraces: boolean;
	hasMetrics: boolean;
}

export interface TelemetryApiResponse {
	/** OTLP JSON format: ResourceSpans[] or ResourceLogs[] depending on query type */
	data: unknown;
	totalCount: number;
	returnedCount: number;
}

export interface SpanFilter {
	resource?: string | string[];
	traceId?: string;
	hasError?: boolean;
	limit?: number;
}

export interface LogFilter {
	resource?: string | string[];
	traceId?: string;
	severity?: "trace" | "debug" | "information" | "warning" | "error" | "critical";
	limit?: number;
}

export interface TraceFilter {
	resource?: string | string[];
	hasError?: boolean;
	limit?: number;
}

export class AspireClient {
	private baseUrl: string;
	private headers: Record<string, string>;

	constructor(config: { baseUrl: string; apiKey?: string }) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.headers = {
			Accept: "application/json",
			...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
		};
	}

	async isReachable(): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/api/telemetry/resources`, {
				headers: this.headers,
				signal: AbortSignal.timeout(5000),
			});
			return res.ok;
		} catch {
			return false;
		}
	}

	async getResources(): Promise<AspireResource[]> {
		const res = await fetch(`${this.baseUrl}/api/telemetry/resources`, {
			headers: this.headers,
		});
		if (!res.ok) throw new Error(`Aspire /api/telemetry/resources returned ${res.status}`);
		return res.json() as Promise<AspireResource[]>;
	}

	async getSpans(filter?: SpanFilter): Promise<TelemetryApiResponse> {
		const params = new URLSearchParams();
		if (filter?.resource) {
			const resources = Array.isArray(filter.resource) ? filter.resource : [filter.resource];
			for (const r of resources) params.append("resource[]", r);
		}
		if (filter?.traceId) params.set("traceId", filter.traceId);
		if (filter?.hasError !== undefined) params.set("hasError", String(filter.hasError));
		if (filter?.limit !== undefined) params.set("limit", String(filter.limit));

		const url = `${this.baseUrl}/api/telemetry/spans${params.size > 0 ? `?${params}` : ""}`;
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) throw new Error(`Aspire /api/telemetry/spans returned ${res.status}`);
		return res.json() as Promise<TelemetryApiResponse>;
	}

	async getLogs(filter?: LogFilter): Promise<TelemetryApiResponse> {
		const params = new URLSearchParams();
		if (filter?.resource) {
			const resources = Array.isArray(filter.resource) ? filter.resource : [filter.resource];
			for (const r of resources) params.append("resource[]", r);
		}
		if (filter?.traceId) params.set("traceId", filter.traceId);
		if (filter?.severity) params.set("severity", filter.severity);
		if (filter?.limit !== undefined) params.set("limit", String(filter.limit));

		const url = `${this.baseUrl}/api/telemetry/logs${params.size > 0 ? `?${params}` : ""}`;
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) throw new Error(`Aspire /api/telemetry/logs returned ${res.status}`);
		return res.json() as Promise<TelemetryApiResponse>;
	}

	async getTraces(filter?: TraceFilter): Promise<TelemetryApiResponse> {
		const params = new URLSearchParams();
		if (filter?.resource) {
			const resources = Array.isArray(filter.resource) ? filter.resource : [filter.resource];
			for (const r of resources) params.append("resource[]", r);
		}
		if (filter?.hasError !== undefined) params.set("hasError", String(filter.hasError));
		if (filter?.limit !== undefined) params.set("limit", String(filter.limit));

		const url = `${this.baseUrl}/api/telemetry/traces${params.size > 0 ? `?${params}` : ""}`;
		const res = await fetch(url, { headers: this.headers });
		if (!res.ok) throw new Error(`Aspire /api/telemetry/traces returned ${res.status}`);
		return res.json() as Promise<TelemetryApiResponse>;
	}

	async getTrace(traceId: string): Promise<TelemetryApiResponse | null> {
		const res = await fetch(`${this.baseUrl}/api/telemetry/traces/${traceId}`, {
			headers: this.headers,
		});
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`Aspire /api/telemetry/traces/${traceId} returned ${res.status}`);
		return res.json() as Promise<TelemetryApiResponse>;
	}

	/**
	 * Polls /api/telemetry/resources until a resource with the given name appears.
	 * Used after a pi run to confirm spans have arrived in Aspire before querying.
	 */
	async waitForResource(
		name: string,
		opts?: { timeoutMs?: number; pollIntervalMs?: number },
	): Promise<AspireResource | null> {
		const timeoutMs = opts?.timeoutMs ?? 10000;
		const pollIntervalMs = opts?.pollIntervalMs ?? 500;
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			try {
				const resources = await this.getResources();
				const found = resources.find((r) => r.name === name);
				if (found) return found;
			} catch {
				// Aspire may not be ready yet
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
		return null;
	}
}
