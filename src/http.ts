import dotenv from "dotenv";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "./server.js";

dotenv.config({ quiet: true });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const token = process.env.MCP_AUTH_TOKEN;
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 1_000_000) throw new Error("MCP request body exceeds 1 MB.");
    chunks.push(part);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function handlePost(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const body = await jsonBody(request);
  const header = request.headers["mcp-session-id"];
  const sessionId = Array.isArray(header) ? header[0] : header;
  let transport = sessionId ? sessions.get(sessionId) : undefined;

  if (!transport && !sessionId && isInitializeRequest(body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => { sessions.set(id, transport!); },
    });
    await createServer().connect(transport);
  }
  if (!transport) return sendError(response, 400, "A valid MCP session ID is required.");
  await transport.handleRequest(request, response, body);
}

async function handleExisting(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const header = request.headers["mcp-session-id"];
  const sessionId = Array.isArray(header) ? header[0] : header;
  const transport = sessionId ? sessions.get(sessionId) : undefined;
  if (!transport) return sendError(response, 400, "A valid MCP session ID is required.");
  await transport.handleRequest(request, response);
  if (request.method === "DELETE" && sessionId) sessions.delete(sessionId);
}

createHttpServer(async (request, response) => {
  if (request.url?.split("?")[0] !== "/mcp") return sendError(response, 404, "MCP endpoint is /mcp");
  if (token && request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(401, { "www-authenticate": "Bearer" }).end("Unauthorized");
    return;
  }
  try {
    if (request.method === "POST") await handlePost(request, response);
    else if (request.method === "GET" || request.method === "DELETE") await handleExisting(request, response);
    else sendError(response, 405, "Method not allowed.");
  } catch (error) {
    console.error("MCP HTTP request failed", error);
    if (!response.headersSent) sendError(response, 500, "Internal MCP server error.");
  }
}).listen(port, host, () => console.error(`Sitkul UAJY MCP listening at http://${host}:${port}/mcp`));
