
// --- STDIO HYGIENE ---
// Redirect console.log to stderr to prevent breaking MCP JSON-RPC framing
console.log = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { NotebookLMClient } from "./notebooklm_client.js";
import sharp from "sharp";
import * as fs from 'fs';
import * as path from 'path';
import fsPromises from "node:fs/promises";
import { fileURLToPath } from 'url';
import express from "express";
import { WebSocketServer } from "ws";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocketServerTransport } from "./ws_transport.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- DEBUG LOGGING ---
const LOG_FILE = "/Users/harivishnus/Desktop/University/Internships/altrosyn/Chrome_extension/server.log";
function logToFile(msg: string) {
    const timestamp = new Date().toLocaleString();
    try {
        fs.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
    } catch (e) {
        // ignore
    }
}

// Redirect console.error (used by Client) to ALSO write to file
const originalConsoleError = console.error;
console.error = (...args: any[]) => {
    // Format args like console does
    const msg = args.map(a =>
        (typeof a === 'object') ? JSON.stringify(a) : String(a)
    ).join(" ");

    logToFile(msg);
    originalConsoleError(...args);
};

// Redirect console.log to console.error (std hygiene) + file
console.log = console.error;

logToFile("SERVER STARTING...");

const resourceUri = "ui://infographic/view.html";

// SINGLETON CLIENT
let notebookClient: NotebookLMClient | null = null;
async function getClient() {
    if (!notebookClient) {
        logToFile("Initializing Singleton NotebookLMClient...");
        notebookClient = new NotebookLMClient(process.env.NOTEBOOKLM_HEADLESS !== "false");
        try {
            await notebookClient.start();
            logToFile("NotebookLMClient started successfully.");
        } catch (e) {
            logToFile(`Failed to start client: ${e}`);
            // Ensure we close the browser so we don't lock the data directory
            try { await notebookClient.stop(); } catch (err) { }
            notebookClient = null; // Reset on failure
            throw e;
        }
    }
    return notebookClient;
}

// Helper for Zod validation errors
const wrapError = (msg: string) => ({
    content: [{ type: "text" as const, text: msg }],
    isError: true,
});

/**
 * Registers all tools and resources to the given McpServer instance.
 */
async function registerTools(server: McpServer) {
    // --- Register App Resource ---
    registerAppResource(server, resourceUri, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
        logToFile(`[MCP] Resource requested: ${resourceUri}`);
        try {
            const htmlPath = path.join(__dirname, "../dist/src/mcp-app.html");
            logToFile(`[MCP] Serving UI from: ${htmlPath}`);
            const html = await fsPromises.readFile(htmlPath, "utf-8");
            return {
                contents: [
                    { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
                ],
            };
        } catch (e) {
            logToFile(`Failed to read mcp-app.html: ${e}`);
            throw e;
        }
    });

    // --- Tool: generate_summary ---
    server.tool(
        "generate_summary",
        { video_url: z.string().url().describe("The URL of the YouTube video") },
        async ({ video_url }) => {
            logToFile(`[MCP] Request: Summary for ${video_url}`);
            try {
                const client = await getClient();
                const summary = await client.generateSummary(video_url);
                return { content: [{ type: "text", text: summary }] };
            } catch (e: any) {
                // AUTO-LOGIN HANDLER
                if (e.message.includes("Authentication required")) {
                    const loginClient = new NotebookLMClient(false);
                    try {
                        await loginClient.openLoginWindow();
                        try { await loginClient.stop(); } catch { }
                        const retryClient = await getClient();
                        const summary = await retryClient.generateSummary(video_url);
                        return { content: [{ type: "text", text: summary }] };
                    } catch (err: any) {
                        return { content: [{ type: "text", text: `⚠️ Login failed: ${err.message}` }] };
                    }
                }
                return wrapError(`Error generating summary: ${e.message}`);
            }
        }
    );

    // --- Tool: ask_question ---
    server.tool(
        "ask_question",
        {
            video_url: z.string().url().describe("The URL of the YouTube video"),
            question: z.string().describe("The question to ask")
        },
        async ({ video_url, question }) => {
            logToFile(`[MCP] Request: Question for ${video_url}: "${question}"`);
            try {
                const client = await getClient();
                const answer = await client.query(video_url, question);
                return { content: [{ type: "text", text: answer }] };
            } catch (e: any) {
                if (e.message.includes("Authentication required")) {
                    const loginClient = new NotebookLMClient(false);
                    try {
                        await loginClient.openLoginWindow();
                        try { await loginClient.stop(); } catch { }
                        const retryClient = await getClient();
                        const answer = await retryClient.query(video_url, question);
                        return { content: [{ type: "text", text: answer }] };
                    } catch (err: any) {
                        return { content: [{ type: "text", text: `⚠️ Login failed: ${err.message}` }] };
                    }
                }
                return wrapError(`Error asking question: ${e.message}`);
            }
        }
    );

    // --- Tool: generate_infographic (APP ENABLED) ---
    logToFile("Registering tool: generate_infographic");
    registerAppTool(
        server,
        "generate_infographic",
        {
            title: "Generate Infographic",
            description: "Generates a visual infographic for a YouTube video using NotebookLM.",
            inputSchema: z.object({
                video_url: z.string().describe("The URL of the YouTube video"),
            }) as any,
            _meta: { ui: { resourceUri } },
        },
        async ({ video_url }: { video_url: string }) => {
            logToFile(`[MCP] Request: Infographic for ${video_url}`);
            try {
                const client = await getClient();

                // Generate Infographic
                const dataUri = await client.generateInfographic(video_url);

                const responseContent: any[] = [
                    {
                        type: "text",
                        text: `Infographic generated successfully!\n\n**URL**: ${dataUri}`
                    }
                ];

                if (dataUri.startsWith("http")) {
                    try {
                        const imageBytes = await client.downloadResource(dataUri);
                        const processedBuffer = await sharp(imageBytes, { failOnError: false })
                            .resize({ width: 1024, withoutEnlargement: true })
                            .jpeg({ quality: 85 })
                            .toBuffer();

                        responseContent.push({
                            type: "image",
                            data: processedBuffer.toString('base64'),
                            mimeType: "image/jpeg"
                        });

                    } catch (err: any) {
                        logToFile(`Image processing failed (returning text-only): ${err.message}`);
                        responseContent.push({
                            type: "text",
                            text: `\n\n*(Image processing failed, but here is the link: ${dataUri})*`
                        });
                    }
                }
                return { content: responseContent };

            } catch (e: any) {
                logToFile(`Error generating infographic: ${e.message}`);
                return wrapError(`Error: ${e.message}`);
            }
        }
    );
}


// FIX: Graceful Shutdown Hooks
async function shutdown() {
    logToFile("Shutting down server...");
    if (notebookClient) {
        await notebookClient.stop();
        notebookClient = null;
    }
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// FIX: Do NOT exit on unhandled async errors
process.on('uncaughtException', (err) => {
    logToFile(`UNCAUGHT EXCEPTION: ${err.stack || err}`);
    console.error(`UNCAUGHT EXCEPTION: ${err}`);
});
process.on('unhandledRejection', (reason) => {
    logToFile(`UNHANDLED REJECTION: ${reason}`);
    console.error(`UNHANDLED REJECTION: ${reason}`);
});

async function main() {
    try {
        logToFile("Initializing Transports...");
        // SAFE SHARP CONFIG
        sharp.cache(false);
        sharp.concurrency(1);

        // 1. Start Stdio Server
        const stdioServer = new McpServer({
            name: "NotebookLM",
            version: "1.0.0",
        });
        await registerTools(stdioServer);
        // Stdio is default, so we connect immediately.
        // We use a separate server instance for Stdio vs HTTP to avoid transport conflicts on the same instance if they don't support multi-connection well, 
        // though McpServer logic is connection-agnostic usually. SAFE to share? 
        // Docs say: "The `server` object assumes ownership of the Transport... expecting it is the only user". 
        // So we MUST use separate McpServer instances for separate transports.
        const stdioTransport = new StdioServerTransport();
        await stdioServer.connect(stdioTransport);
        logToFile("NotebookLM MCP Server running on Stdio");


        // 2. Start HTTP & WebSocket Server
        const app = createMcpExpressApp({
            host: '0.0.0.0' // Listen on all interfaces
        });

        // Add a health check
        app.get("/health", (req, res) => {
            res.json({ status: "ok" });
        });

        const httpServer = app.listen(3000, '0.0.0.0', () => {
            logToFile("HTTP/WS Server listening on port 3000");
            console.error("HTTP/WS Server listening on port 3000");
        });

        // Serve Static Files for Browser Testing
        // Serve the dist directory so assets (js/css) can be loaded
        app.use("/static", express.static(path.join(__dirname, "../dist")));

        // Map the Resource URI path to the actual HTML file for direct browser access
        app.get("/ui/infographic/view.html", (req, res) => {
            const eventualPath = path.join(__dirname, "../dist/src/mcp-app.html");
            res.sendFile(eventualPath);
        });



        // Setup HTTP Server (SSE + POST)
        const httpServerMcp = new McpServer({
            name: "NotebookLM",
            version: "1.0.0",
        });
        await registerTools(httpServerMcp);

        const httpTransport = new StreamableHTTPServerTransport();
        await httpServerMcp.connect(httpTransport);

        app.get("/sse", async (req, res) => {
            logToFile("New SSE connection attempt");
            await httpTransport.handleRequest(req, res);
        });

        app.post("/messages", async (req, res) => {
            await httpTransport.handleRequest(req, res);
        });

        // Setup WebSocket
        const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
        wss.on("connection", async (ws) => {
            logToFile("New WebSocket connection");
            const wsServer = new McpServer({
                name: "NotebookLM",
                version: "1.0.0",
            });
            await registerTools(wsServer);
            const wsTransport = new WebSocketServerTransport(ws);
            await wsServer.connect(wsTransport);

            ws.on("close", () => {
                wsServer.close();
            });
        });

    } catch (e) {
        logToFile(`FATAL STARTUP ERROR: ${e}`);
        console.error(`FATAL STARTUP ERROR: ${e}`);
        process.exit(1);
    }
}

main();
