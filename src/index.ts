import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

dotenv.config({ quiet: true });
const server = createServer();
await server.connect(new StdioServerTransport());
