export interface TestbedConfig {
	/** Aspire Dashboard base URL for web UI and REST API */
	aspireEndpoint: string;
	/** Optional API key if Aspire is configured with API auth */
	aspireApiKey: string | undefined;
	/** OTLP HTTP endpoint for otel-bridge to export spans to */
	otlpEndpoint: string;
	/** Path to the pi binary */
	piBinaryPath: string;
	/** Default timeout in ms for a pi run */
	piTimeoutMs: number;
}

export function loadConfig(): TestbedConfig {
	return {
		aspireEndpoint: process.env.ASPIRE_ENDPOINT ?? "http://localhost:18888",
		aspireApiKey: process.env.ASPIRE_API_KEY,
		otlpEndpoint: process.env.OTLP_ENDPOINT ?? "http://localhost:18890",
		piBinaryPath: process.env.PI_BINARY_PATH ?? "pi",
		piTimeoutMs: Number.isFinite(Number(process.env.PI_TIMEOUT_MS)) ? Number(process.env.PI_TIMEOUT_MS) : 120000,
	};
}
