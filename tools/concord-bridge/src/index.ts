#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeMcpServer } from "./server.js";

try {
  const bridge = createBridgeMcpServer();
  const transport = new StdioServerTransport();
  await bridge.mcp.connect(transport);
  process.stderr.write("Concord Bridge MCP Server listening on stdio\n");
} catch (err) {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
}
