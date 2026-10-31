#!/usr/bin/env node

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { registerSessionTools } from "./tools/session.js"
import { registerDeviceTools } from "./tools/device.js"
import { registerVisionTools } from "./tools/vision.js"
import { registerInputTools } from "./tools/input.js"
import { registerAppTools } from "./tools/apps.js"
import { registerClipboardTools } from "./tools/clipboard.js"
import { registerUiTools } from "./tools/ui.js"
import { registerShellTools } from "./tools/shell.js"
import { registerFileTools } from "./tools/files.js"
import { registerVideoTools } from "./tools/video.js"
import { registerAudioTools } from "./tools/audio.js"

const MAX_BODY_BYTES = 1024 * 1024

export function createServer(): McpServer {
  const server = new McpServer({
    name: "scrcpy-mcp",
    version: process.env.npm_package_version ?? "0.0.0",
  })

  registerSessionTools(server)
  registerDeviceTools(server)
  registerVisionTools(server)
  registerInputTools(server)
  registerAppTools(server)
  registerClipboardTools(server)
  registerUiTools(server)
  registerShellTools(server)
  registerFileTools(server)
  registerVideoTools(server)
  registerAudioTools(server)

  return server
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`)
    }
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  return text.length > 0 ? JSON.parse(text) : undefined
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = process.env.MCP_BEARER_TOKEN
  if (!token) return true
  return req.headers.authorization === `Bearer ${token}`
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
): Promise<void> {
  const server = createServer()
  // Stateless mode: every request gets its own transport and server instance.
  // Tool state (scrcpy sessions, recordings) lives in module scope, so it is
  // shared across requests even though the server object is not.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })

  res.on("close", () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

function startHttpServer(): void {
  const port = Number.parseInt(process.env.MCP_HTTP_PORT ?? "8812", 10)
  const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0"

  const httpServer = createHttpServer(async (req, res) => {
    const url = req.url ?? "/"

    if (req.method === "GET" && url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("ok")
      return
    }

    if (url !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" })
      res.end("not found")
      return
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain", allow: "POST" })
      res.end("method not allowed")
      return
    }

    if (!isAuthorized(req)) {
      res.writeHead(401, { "content-type": "text/plain", "www-authenticate": "Bearer" })
      res.end("unauthorized")
      return
    }

    try {
      const body = await readJsonBody(req)
      await handleMcpRequest(req, res, body)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" })
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message }, id: null }))
    }
  })

  httpServer.listen(port, host, () => {
    console.error(`[scrcpy-mcp] Streamable HTTP server on http://${host}:${port}/mcp`)
  })
}

async function main() {
  if ((process.env.MCP_TRANSPORT ?? "stdio").toLowerCase() === "http") {
    startHttpServer()
    return
  }

  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[scrcpy-mcp] Server running on stdio")
}

main().catch((err) => {
  console.error("[scrcpy-mcp] Fatal error:", err)
  process.exit(1)
})
