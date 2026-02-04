/**
 * NotebookLM MCP Server
 * 
 * Supports both Stdio and HTTP transports.
 * - Stdio: For programmatic clients or legacy integrations
 * - HTTP: For Claude Desktop via Connectors (use cloudflared tunnel)
 * 
 * Usage:
 *   Stdio mode:  node dist/server.js --stdio
 *   HTTP mode:   node dist/server.js (default, uses port 3001)
 * 
 * For Claude Desktop with MCP Apps UI:
 *   1. Run: node dist/server.js
 *   2. Run: npx cloudflared tunnel --url http://localhost:3001
 *   3. Add the generated URL as a Custom Connector in Claude Settings > Connectors
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
    registerAppTool,
    registerAppResource,
    RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import * as fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from 'url';
import { z } from "zod";
import { NotebookLMClient } from "./notebooklm_client.js";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIGURATION ---
const LOG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../server.log');
const HTTP_PORT = Number(process.env.PORT) || 3001;

// --- State Management ---
interface ActiveNotebook {
    notebookId: string;
    url: string;
    title?: string;
    lastUsedAt: number;
    sourceIds?: string[];
}

let activeNotebooks: ActiveNotebook[] = [];

function setActiveNotebook(url: string, notebookId: string, title?: string, sourceIds?: string[]) {
    // Remove if exists to re-add at top
    activeNotebooks = activeNotebooks.filter(n => n.url !== url);

    activeNotebooks.unshift({
        notebookId,
        url,
        title,
        lastUsedAt: Date.now(),
        sourceIds
    });

    // Keep last 5
    if (activeNotebooks.length > 5) activeNotebooks.pop();
    logToFile(`[Session] Active notebook set: ${url} (${notebookId})`);
}

function getActiveNotebook(): ActiveNotebook | null {
    return activeNotebooks.length > 0 ? activeNotebooks[0] : null;
}

// --- Async Job Queue for Infographic Generation ---
interface InfographicJob {
    id: string;
    videoUrl: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    imageUrl?: string;
    viewerUrl?: string;
    imageData?: string; // base64
    error?: string;
    createdAt: number;
    completedAt?: number;
}

const infographicJobs = new Map<string, InfographicJob>();

function generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

// Cleanup old jobs (older than 10 minutes)
function cleanupOldJobs() {
    const TEN_MINUTES = 10 * 60 * 1000;
    const now = Date.now();
    for (const [id, job] of infographicJobs.entries()) {
        if (now - job.createdAt > TEN_MINUTES) {
            infographicJobs.delete(id);
            logToFile(`[Jobs] Cleaned up old job: ${id}`);
        }
    }
}

// --- DEBUG LOGGING ---
function logToFile(msg: string) {
    const timestamp = new Date().toLocaleString();
    try {
        fsSync.appendFileSync(LOG_FILE, `[${timestamp}] ${msg}\n`);
    } catch { }
    console.error(`[${timestamp}] ${msg}`);
}

// --- Singleton Client ---
let clientInstance: NotebookLMClient | null = null;
async function getClient(): Promise<NotebookLMClient> {
    if (!clientInstance) {
        logToFile("Initializing Singleton NotebookLMClient...");
        const headlessEnv = process.env.NOTEBOOKLM_HEADLESS;
        const headless = headlessEnv === undefined ? true : headlessEnv === "true";
        clientInstance = new NotebookLMClient(headless);
        await clientInstance.start();
        logToFile("NotebookLMClient started successfully.");
    }
    return clientInstance;
}

// --- Resource URI ---
const resourceUri = "ui://infographic/view.html";

// --- Tool & Resource Registration ---
// --- Tool & Resource Registration ---
function registerTools(server: McpServer) {
    // Register AppResource (serves bundled HTML for MCP App UI)
    registerAppResource(
        server,
        resourceUri,
        resourceUri,
        { mimeType: RESOURCE_MIME_TYPE },
        async () => {
            logToFile(`[MCP] Resource requested: ${resourceUri}`);
            try {
                const htmlPath = path.join(__dirname, "../dist/src/mcp-app.html");
                logToFile(`[MCP] Serving UI from: ${htmlPath}`);
                const html = await fs.readFile(htmlPath, "utf-8");
                return {
                    contents: [
                        { uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html },
                    ],
                };
            } catch (e) {
                logToFile(`Failed to read mcp-app.html: ${e}`);
                throw e;
            }
        }
    );

    // --- Helper for wrapping errors ---
    const wrapError = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

    // --- Tool: generate_summary (MCP App Enabled) ---
    logToFile("Registering tool: generate_summary");
    registerAppTool(
        server,
        "generate_summary",
        {
            title: "Generate Summary",
            description: "Generates a comprehensive summary of a YouTube video or NotebookLM notebook content. Side-effect: Sets this as the active notebook.",
            inputSchema: z.object({
                url: z.string().url().optional().describe("The URL of the YouTube video OR a direct NotebookLM link. Optional if an active notebook exists in the session.")
            }) as any,
            _meta: { ui: { resourceUri } },
        },
        async (args: any) => {
            const targetUrl = args.url;
            logToFile(`[MCP] Request: Summary for ${targetUrl}`);
            let notebookId: string = "unknown";
            try {
                const client = await getClient();
                const summary = await client.generateSummary(targetUrl!);

                // Update Session State
                notebookId = client._parseNotebookUrl(targetUrl!) || "unknown";
                setActiveNotebook(targetUrl!, notebookId);

                return {
                    content: [{ type: "text" as const, text: `📝 **Summary Generated**\n\n${summary}` }],
                    meta: { source: targetUrl, notebookId }
                };
            } catch (e: any) {
                // AUTO-LOGIN HANDLER
                if (e.message.includes("Authentication required")) {
                    logToFile("Authentication required. Attempting auto-login...");
                    const loginClient = new NotebookLMClient(false);
                    try {
                        await loginClient.openLoginWindow();
                        try { await loginClient.stop(); } catch { }

                        // Force refresh client instance
                        clientInstance = null;
                        const retryClient = await getClient();
                        const summary = await retryClient.generateSummary(targetUrl!);

                        // Update Session State on retry
                        notebookId = retryClient._parseNotebookUrl(targetUrl!) || "unknown";
                        setActiveNotebook(targetUrl!, notebookId);

                        return {
                            content: [{ type: "text" as const, text: `📝 **Summary Generated**\n\n${summary}` }],
                            meta: { source: targetUrl, notebookId }
                        };
                    } catch (err: any) {
                        return { content: [{ type: "text" as const, text: `⚠️ Login failed: ${err.message}` }] };
                    }
                }
                logToFile(`Error: ${e.message}`);
                return wrapError(`Error generating summary: ${e.message}`);
            }
        }
    );

    // --- Tool: get_active_notebook ---
    logToFile("Registering tool: get_active_notebook");
    server.tool(
        "get_active_notebook",
        "Returns the most recently used notebook in this session. Use this to resolve references like 'that notebook' or 'it'.",
        {},
        async () => {
            const nb = getActiveNotebook();
            return {
                content: [{ type: "text" as const, text: JSON.stringify(nb, null, 2) }],
                meta: { activeNotebook: nb }
            };
        }
    );

    // --- Tool: list_sources (MCP App Enabled) ---
    logToFile("Registering tool: list_sources");
    registerAppTool(
        server,
        "list_sources",
        {
            title: "List Sources",
            description: "Lists all sources in a NotebookLM notebook. Returns source IDs, titles, types, and original URLs. Side-effect: Sets this as the active notebook.",
            inputSchema: z.object({
                url: z.string().url().describe("The URL of the NotebookLM notebook.")
            }) as any,
            _meta: { ui: { resourceUri } },
        },
        async (args: any) => {
            const url = args.url;
            logToFile(`[MCP] Request: List Sources for ${url}`);
            try {
                const client = await getClient();
                const sources = await client.listSources(url);

                // Update Session State
                const notebookId = client._parseNotebookUrl(url) || "unknown";
                setActiveNotebook(url, notebookId, undefined, sources.map(s => s.sourceId));

                // Format as markdown list for UI
                const sourceList = sources.map(s => `- **${s.title}** (${s.type})\n  Link: [Open](${s.originalUrl || '#'}) | ID: \`${s.sourceId}\``).join('\n\n');

                return {
                    content: [{ type: "text" as const, text: `📚 **Notebook Sources**\n\n${sourceList}` }],
                    meta: { count: sources.length, sources }
                };
            } catch (e: any) {
                return wrapError(`Error listing sources: ${e.message}`);
            }
        }
    );

    // --- Tool: ask_question (MCP App Enabled) ---
    logToFile("Registering tool: ask_question");
    registerAppTool(
        server,
        "ask_question",
        {
            title: "Ask Question",
            description: "Asks a question about the active video/notebook. USE THIS TOOL for any follow-up questions about the content, even if no URL is provided (it will use the active session). Do not answer from general knowledge if the user is asking about the video's topic.",
            inputSchema: z.object({
                url: z.string().url().optional().describe("The URL of the YouTube video OR a direct NotebookLM link. Optional if an active notebook exists in the session."),
                question: z.string().describe("The question to ask"),
                source_id: z.string().optional().describe("Optional: The specific Source ID to target (if known from list_sources).")
            }) as any,
            _meta: { ui: { resourceUri } },
        },
        async (args: any) => {
            const targetUrl = args.url;
            const question = args.question;
            const source_id = args.source_id;

            logToFile(`[MCP] Request: Question for ${targetUrl}: "${question}"`);
            try {
                const client = await getClient();
                const answer = await client.query(targetUrl!, question, source_id);

                // Update Session State
                const notebookId = client._parseNotebookUrl(targetUrl!) || "unknown";
                setActiveNotebook(targetUrl!, notebookId);

                return {
                    content: [{ type: "text" as const, text: `❓ **Question:** ${question}\n\n💡 **Answer:**\n${answer}` }],
                    meta: { sourceId: source_id || "auto", source: targetUrl, notebookId }
                };
            } catch (e: any) {
                if (e.message.includes("Authentication required")) {
                    logToFile("Authentication required. Attempting auto-login...");
                    const loginClient = new NotebookLMClient(false);
                    try {
                        await loginClient.openLoginWindow();
                        try { await loginClient.stop(); } catch { }

                        clientInstance = null;
                        const retryClient = await getClient();
                        const answer = await retryClient.query(targetUrl!, question, source_id);

                        // Update Session State on retry
                        const notebookId = retryClient._parseNotebookUrl(targetUrl!) || "unknown";
                        setActiveNotebook(targetUrl!, notebookId);

                        return {
                            content: [{ type: "text" as const, text: `❓ **Question:** ${question}\n\n💡 **Answer:**\n${answer}` }],
                            meta: { sourceId: source_id || "auto", source: targetUrl, notebookId }
                        };
                    } catch (err: any) {
                        return { content: [{ type: "text" as const, text: `⚠️ Login failed: ${err.message}` }] };
                    }
                }
                logToFile(`Error: ${e.message}`);
                return wrapError(`Error asking question: ${e.message}`);
            }
        }
    );

    // --- Tool: generate_infographic (ASYNC - Returns job ID immediately) ---
    logToFile("Registering tool: generate_infographic");
    server.tool(
        "generate_infographic",
        "Starts generating a visual infographic for a YouTube video (async). Returns a job_id immediately. Use 'check_infographic_status' with the job_id to get the result when ready. Generation typically takes 1-3 minutes.",
        {
            video_url: z.string().describe("The URL of the YouTube video"),
        },
        async (args) => {
            const video_url = args.video_url;
            logToFile(`[MCP] Request: Infographic for ${video_url}`);

            // Cleanup old jobs
            cleanupOldJobs();

            // Create job
            const jobId = generateJobId();
            const job: InfographicJob = {
                id: jobId,
                videoUrl: video_url,
                status: 'pending',
                createdAt: Date.now()
            };
            infographicJobs.set(jobId, job);
            logToFile(`[Jobs] Created job ${jobId} for ${video_url}`);

            // Start async processing (don't await!)
            (async () => {
                try {
                    job.status = 'processing';
                    logToFile(`[Jobs] Processing job ${jobId}...`);

                    const client = await getClient();

                    // Ensure browser is healthy before operations
                    await client.ensureBrowserReady();

                    const imageUrl = await client.generateInfographic(video_url);
                    logToFile(`[Jobs] Job ${jobId} got image URL: ${imageUrl}`);

                    // Store image info but don't mark complete yet
                    job.imageUrl = imageUrl;
                    job.viewerUrl = `http://localhost:${HTTP_PORT}/view?url=${encodeURIComponent(imageUrl)}`;

                    // Download and embed image BEFORE marking complete
                    try {
                        const imageBytes = await client.downloadResource(imageUrl);
                        const processedBuffer = await sharp(imageBytes, { failOnError: false })
                            .resize({ width: 1024, withoutEnlargement: true })
                            .jpeg({ quality: 85 })
                            .toBuffer();
                        job.imageData = processedBuffer.toString('base64');
                        logToFile(`[Jobs] Image downloaded for ${jobId} (${job.imageData.length} chars)`);
                    } catch (err: any) {
                        logToFile(`[Jobs] Image download failed for ${jobId}: ${err.message}`);
                    }

                    // NOW mark as completed (after image is ready)
                    job.status = 'completed';
                    job.completedAt = Date.now();
                    logToFile(`[Jobs] Job ${jobId} completed, hasImageData: ${!!job.imageData}`);
                } catch (e: any) {
                    logToFile(`[Jobs] Job ${jobId} failed: ${e.message}`);
                    job.status = 'failed';
                    job.error = e.message;
                    job.completedAt = Date.now();
                }
            })();

            // Return immediately with job ID
            return {
                content: [{
                    type: "text" as const,
                    text: `🚀 **Infographic generation started!**\n\n📋 **Job ID:** \`${jobId}\`\n\n⏳ Estimated time: 1-3 minutes\n\n**Next step:** Call \`check_infographic_status\` with job_id: "${jobId}" to get the result.`
                }]
            };
        },
    );

    // --- Tool: check_infographic_status (MCP App Enabled for image display) ---
    logToFile("Registering tool: check_infographic_status");
    registerAppTool(
        server,
        "check_infographic_status",
        {
            title: "Check Infographic Status",
            description: "Check the status of an infographic generation job. When complete, displays the image in the viewer.",
            inputSchema: z.object({
                job_id: z.string().describe("The job ID returned by generate_infographic")
            }) as any,
            _meta: { ui: { resourceUri } },
        },
        async (args: any) => {
            const job_id = args.job_id;
            logToFile(`[Jobs] Checking status for job: ${job_id}`);

            const job = infographicJobs.get(job_id);
            if (!job) {
                return { content: [{ type: "text" as const, text: `❌ Job not found: ${job_id}. Jobs expire after 10 minutes.` }], isError: true };
            }

            if (job.status === 'pending' || job.status === 'processing') {
                const elapsed = Math.round((Date.now() - job.createdAt) / 1000);
                return {
                    content: [{
                        type: "text" as const,
                        text: `⏳ **Job Status: ${job.status.toUpperCase()}**\n\n📋 Job ID: \`${job_id}\`\n🎬 Video: ${job.videoUrl}\n⏱️ Elapsed: ${elapsed}s\n\n*Check again in 15-30 seconds...*`
                    }]
                };
            }

            if (job.status === 'failed') {
                return { content: [{ type: "text" as const, text: `❌ Job failed: ${job.error}` }], isError: true };
            }

            // Completed! Return with image for MCP App viewer
            logToFile(`[Jobs] Returning completed job ${job_id}, hasImageData: ${!!job.imageData}, imageDataLength: ${job.imageData?.length || 0}`);

            const responseContent: any[] = [{
                type: "text" as const,
                text: `✅ **Infographic Ready!**\n\n🖼️ **[Open in Viewer](${job.viewerUrl})**\n\n📸 **[Direct Image](${job.imageUrl})**\n\n⏱️ Completed in ${Math.round((job.completedAt! - job.createdAt) / 1000)}s`
            }];

            // Add embedded image for MCP App viewer
            if (job.imageData) {
                responseContent.push({
                    type: "image" as const,
                    data: job.imageData,
                    mimeType: "image/jpeg"
                });
            }

            return { content: responseContent };
        }
    );

    logToFile("All tools registered.");
}

// --- HTTP Server Setup ---
function startHttpServer(server: McpServer) {
    const expressApp = express();

    // Middleware
    expressApp.use((req, res, next) => {
        logToFile(`[HTTP] ${req.method} ${req.url} - Headers: ${JSON.stringify(req.headers)}`);
        next();
    });

    expressApp.use(cors({
        origin: '*',
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Accept', 'Authorization'],
    }));
    expressApp.use(express.json({ limit: '10mb' }));

    // Store transports by session ID (supports both SSE and Streamable HTTP)
    const sessionTransports = new Map<string, SSEServerTransport | StreamableHTTPServerTransport>();

    // SSE Connection Endpoint
    // Clients connect here (GET) to start the session.
    // We support both /sse (standard) and /mcp (what user tried)
    const handleSseConnection = async (req: express.Request, res: express.Response) => {
        logToFile(`[HTTP] New SSE connection request: ${req.path}`);
        req.socket.setTimeout(0); // Disable socket timeout for SSE connection

        // Prevent buffering and caching at all layers (Cloudflare, Nginx, Browser)
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.setHeader("Content-Encoding", "none");

        // The client needs to know where to send messages (POST).
        // We tell it to send to /messages.
        const transport = new SSEServerTransport("/messages", res);

        logToFile(`[HTTP] Created transport with sessionId: ${transport.sessionId}`);
        sessionTransports.set(transport.sessionId, transport);

        // Heartbeat to keep connection alive (prevent Cloudflare/Proxy timeout)
        const heartbeatInterval = setInterval(() => {
            if (res.writableEnded) {
                clearInterval(heartbeatInterval);
                return;
            }
            res.write(": keepalive\n\n");
            logToFile(`[HTTP] Sent heartbeat for session: ${transport.sessionId}`);
        }, 15000); // 15 seconds

        transport.onclose = () => {
            logToFile(`[HTTP] SSE connection closed: ${transport.sessionId}`);
            clearInterval(heartbeatInterval);
            sessionTransports.delete(transport.sessionId);
        };

        (transport as any).onerror = (error: any) => {
            logToFile(`[HTTP] SSE Transport Error (session: ${transport.sessionId}): ${error?.message || String(error)}`);
        };

        req.on("close", () => {
            logToFile(`[HTTP] Express Request 'close' event (Client disconnected?) for session: ${transport.sessionId}`);
        });

        req.on("error", (err) => {
            logToFile(`[HTTP] Express Request 'error' event: ${err.message}`);
        });

        try {
            await server.connect(transport);
            logToFile(`[HTTP] server.connect() completed for session: ${transport.sessionId}`);
        } catch (error) {
            logToFile(`[HTTP] Error processing SSE connection: ${error}`);
        }
    };

    expressApp.get("/sse", handleSseConnection);

    //=========================================================================
    // STREAMABLE HTTP TRANSPORT (Protocol Version 2025-06-18)
    // ChatGPT Connectors prefer this newer transport.
    //=========================================================================
    expressApp.all("/mcp", async (req, res) => {
        logToFile(`[HTTP] ${req.method} /mcp received`);

        try {
            // Check for existing session ID
            const sessionId = req.headers['mcp-session-id'] as string | undefined;
            let transport: StreamableHTTPServerTransport | undefined;

            if (sessionId && sessionTransports.has(sessionId)) {
                const existingTransport = sessionTransports.get(sessionId);
                if (existingTransport instanceof StreamableHTTPServerTransport) {
                    transport = existingTransport;
                } else {
                    // Session exists but uses a different transport protocol (SSE)
                    res.status(400).json({
                        jsonrpc: '2.0',
                        error: { code: -32000, message: 'Session uses a different transport protocol' },
                        id: null
                    });
                    return;
                }
            } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
                // New session initialization
                logToFile(`[HTTP] Initializing new Streamable HTTP session...`);
                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => crypto.randomUUID(),
                    onsessioninitialized: (newSessionId) => {
                        logToFile(`[HTTP] Streamable HTTP session initialized: ${newSessionId}`);
                        sessionTransports.set(newSessionId, transport!);
                    }
                });

                transport.onclose = () => {
                    const sid = transport!.sessionId;
                    if (sid && sessionTransports.has(sid)) {
                        logToFile(`[HTTP] Streamable HTTP session closed: ${sid}`);
                        sessionTransports.delete(sid);
                    }
                };

                // Connect to MCP server
                await server.connect(transport);
            } else if (!sessionId) {
                // No session and not an initialize request
                res.status(400).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Missing session ID or not an initialize request' },
                    id: null
                });
                return;
            }

            if (!transport) {
                res.status(404).json({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Session not found' },
                    id: null
                });
                return;
            }

            // Handle the request using Streamable HTTP transport
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            logToFile(`[HTTP] Error handling /mcp: ${error}`);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: '2.0',
                    error: { code: -32603, message: 'Internal server error' },
                    id: null
                });
            }
        }
    });

    //=========================================================================
    // DEPRECATED HTTP+SSE TRANSPORT (Protocol Version 2024-11-05)
    // POST /messages endpoint for backwards compatibility
    //=========================================================================
    expressApp.post("/messages", async (req, res) => {
        const sessionId = req.query.sessionId as string;
        logToFile(`[HTTP] POST /messages (session: ${sessionId})`);

        const transport = sessionTransports.get(sessionId);
        if (!transport || !(transport instanceof SSEServerTransport)) {
            logToFile(`[HTTP] Session not found or wrong type: ${sessionId}`);
            res.status(404).send("Session not found");
            return;
        }

        // Pass req.body to fix known SDK parsing issue
        await transport.handlePostMessage(req, res, req.body);
    });

    // Serve static files from public directory (go up 2 levels from dist/src/)
    const publicPath = path.resolve(__dirname, '../../public');
    expressApp.use('/public', express.static(publicPath));

    // Infographic Viewer endpoint - redirect to static HTML
    expressApp.get("/view", (req, res) => {
        const imageUrl = req.query.url as string;
        if (!imageUrl) {
            res.status(400).send("Missing 'url' query parameter");
            return;
        }

        logToFile(`[HTTP] Serving infographic view for: ${imageUrl.substring(0, 50)}...`);

        // Serve the HTML file
        const htmlPath = path.join(publicPath, 'infographic-viewer.html');
        logToFile(`[HTTP] Serving file from: ${htmlPath}`);
        res.sendFile(htmlPath);
    });

    // Health check endpoint
    expressApp.get("/health", (_req, res) => {
        res.json({ status: "ok", mode: "http", port: HTTP_PORT });
    });

    // Root info endpoint (Supports SSE auto-discovery)
    expressApp.get("/", async (req, res) => {
        const accept = req.headers.accept || "";
        if (accept.includes("text/event-stream")) {
            logToFile(`[HTTP] Root request with Accept: text/event-stream -> Handling as SSE`);
            await handleSseConnection(req, res);
            return;
        }

        res.json({
            name: "NotebookLM MCP Server",
            version: "1.0.0",
            endpoints: {
                mcp: "POST /mcp",
                view: "GET /view?url=<image_url>",
                health: "GET /health",
            },
            instructions: "Use cloudflared to create a tunnel: npx cloudflared tunnel --url http://localhost:" + HTTP_PORT,
        });
    });

    expressApp.listen(HTTP_PORT, () => {
        logToFile(`HTTP/WS Server listening on port ${HTTP_PORT}`);
    });
}

// --- Stdio Server Setup ---
async function startStdioServer(server: McpServer) {
    // In stdio mode, redirect console.log to stderr to keep stdout clean for MCP
    console.log = console.error;

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logToFile("NotebookLM MCP Server running on Stdio");
}

// --- Main Entry Point ---
async function main() {
    const useStdio = process.argv.includes("--stdio");

    logToFile("SERVER STARTING...");
    logToFile("Initializing Transports...");



    const server = new McpServer({
        name: "NotebookLM",
        version: "1.0.0",
    });

    registerTools(server);

    // Always start HTTP server (provides dual support and serves UI assets)
    startHttpServer(server);

    if (useStdio) {
        await startStdioServer(server);
    }
}

main().catch((e) => {
    logToFile(`FATAL ERROR: ${e}`);
    console.error(`FATAL ERROR: ${e}`);
    process.exit(1);
});
