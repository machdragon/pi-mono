#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const server = createMcpServer(config);
const transport = new StdioServerTransport();
await server.connect(transport);
