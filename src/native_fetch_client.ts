/**
 * Native Fetch Client for NotebookLM
 * 
 * Uses cookies from Chrome extension instead of Playwright browser automation.
 * This eliminates the popup Chrome window.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Logging ---
const LOG_FILE = path.resolve(__dirname, "../server.log");
function logToFile(msg: string) {
    const timestamp = new Date().toLocaleString();
    const formattedMsg = `[${timestamp}] ${msg}`;
    try {
        fs.appendFileSync(LOG_FILE, formattedMsg + "\n");
    } catch { }
    process.stderr.write(formattedMsg + "\n");
}

// --- CONFIGURATION ---
const BASE_URL = "https://notebooklm.google.com";
const RPC_ENDPOINT = `${BASE_URL}/_/LabsTailwindUi/data/batchexecute`;
const RPC_GENERATE_STREAMED = `${BASE_URL}/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed`;

// RPC IDs
const RPC_CREATE_NOTEBOOK = "CCqFvf";
const RPC_ADD_SOURCE = "izAoDd";
const RPC_GENERATE_INFOGRAPHIC = "R7cb6c";
const RPC_LIST_ARTIFACTS = "gArtLc";
const RPC_DELETE_NOTEBOOK = "f61S6e";
const RPC_LOAD_NOTEBOOK = "rLM1Ne";

interface SessionTokens {
    at: string | null;
    bl: string | null;
    fsid: string | null;
}

interface ChromeCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    secure: boolean;
    httpOnly: boolean;
    expirationDate?: number;
}

export class NativeFetchClient {
    private cookies: ChromeCookie[] = [];
    private sessionTokens: SessionTokens = { at: null, bl: null, fsid: null };

    constructor(cookies: ChromeCookie[]) {
        this.cookies = cookies;
        logToFile(`[NativeFetch] Initialized with ${cookies.length} cookies`);
    }

    /**
     * Format cookies for fetch headers
     */
    private getCookieHeader(): string {
        return this.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    /**
     * Standard fetch with cookies
     */
    private async fetchWithCookies(url: string, options: RequestInit = {}): Promise<Response> {
        const headers = new Headers(options.headers || {});
        headers.set('Cookie', this.getCookieHeader());
        headers.set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

        return fetch(url, { ...options, headers });
    }

    async start(): Promise<void> {
        await this._refreshTokens();
    }

    async stop(): Promise<void> {
        // No-op for native client
    }

    async ensureBrowserReady(): Promise<void> {
        // Check if tokens are still valid, refresh if needed
        if (!this.sessionTokens.at) {
            await this._refreshTokens();
        }
    }

    async _refreshTokens(): Promise<boolean> {
        logToFile("[NativeFetch] 🔄 Fetching tokens...");

        const response = await this.fetchWithCookies(BASE_URL);
        const html = await response.text();

        // Check for login redirect
        if (response.url.includes("accounts.google.com")) {
            throw new Error("Authentication required. Please ensure you're logged into Google in the browser where the extension is installed.");
        }

        const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
        const blMatch = html.match(/"(boq_labs-tailwind-[^"]+)"/);
        const fsidMatch = html.match(/"FdrFJe":"([^"]+)"/);

        if (!atMatch || !blMatch) {
            throw new Error("Could not find session tokens. Are you logged in?");
        }

        this.sessionTokens = {
            at: atMatch[1],
            bl: blMatch[1],
            fsid: fsidMatch?.[1] || null
        };

        logToFile(`[NativeFetch] ✅ Tokens acquired. bl: ${this.sessionTokens.bl}`);
        return true;
    }

    _parseNotebookUrl(url: string): string | null {
        const match = url.match(/notebook\/([0-9a-fA-F-]{36})/);
        return match ? match[1] : null;
    }

    async listSources(url: string): Promise<any[]> {
        const notebookId = this._parseNotebookUrl(url) || url;
        logToFile(`[NativeFetch] Listing sources for: ${notebookId}...`);

        const payload = [notebookId, null, [2], null, 0];

        try {
            const response = await this._executeRpc(RPC_LOAD_NOTEBOOK, payload);

            if (response && response[0] && response[0][1] === RPC_LOAD_NOTEBOOK && typeof response[0][2] === 'string') {
                const innerJson = response[0][2];
                const data = JSON.parse(innerJson);
                const sourcesRaw = data[0]?.[1];

                if (Array.isArray(sourcesRaw)) {
                    const results = [];
                    for (const s of sourcesRaw) {
                        if (!Array.isArray(s)) continue;

                        const sourceId = Array.isArray(s[0]) ? s[0][0] : s[0];
                        const title = s[1];
                        let type = "unknown";
                        let originalUrl = null;

                        const meta = s[2];
                        if (meta && Array.isArray(meta)) {
                            const externalData = meta[5];
                            if (Array.isArray(externalData)) {
                                originalUrl = externalData[0];
                            }
                        }

                        if (originalUrl && typeof originalUrl === 'string') {
                            if (originalUrl.includes("youtube.com") || originalUrl.includes("youtu.be")) type = "youtube";
                            else if (originalUrl.startsWith("http")) type = "web";
                        }

                        if (!originalUrl && sourceId) type = "file_or_pasted";
                        results.push({ sourceId, title, type, originalUrl });
                    }

                    logToFile(`[NativeFetch] Found ${results.length} sources.`);
                    return results;
                }
            }
        } catch (e: any) {
            logToFile(`[NativeFetch] List Sources Failed: ${e.message}`);
        }

        return [];
    }

    async _fetchSourceId(notebookId: string): Promise<string> {
        const sources = await this.listSources(notebookId);
        if (sources.length > 0) {
            logToFile(`[NativeFetch] ✅ Using first source: ${sources[0].sourceId}`);
            return sources[0].sourceId;
        }
        throw new Error("No sources found in this notebook.");
    }

    async _executeRpc(rpcId: string, payload: any): Promise<any> {
        if (!this.sessionTokens.at) {
            await this._refreshTokens();
        }

        const reqId = Math.floor(Math.random() * 100000) + 100000;
        const innerPayload = JSON.stringify(payload);
        const envelope = JSON.stringify([[[rpcId, innerPayload, null, "generic"]]]);

        const params = new URLSearchParams({
            "rpcids": rpcId,
            "source-path": "/",
            "bl": this.sessionTokens.bl || "",
            "f.sid": this.sessionTokens.fsid || "",
            "hl": "en",
            "rt": "c",
            "_reqid": reqId.toString()
        });

        const body = new URLSearchParams();
        body.append("f.req", envelope);
        body.append("at", this.sessionTokens.at || "");

        const url = `${RPC_ENDPOINT}?${params.toString()}`;

        const response = await this.fetchWithCookies(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "X-Same-Domain": "1"
            },
            body: body.toString()
        });

        if (!response.ok) throw new Error(`RPC Failed: ${response.status}`);
        const text = await response.text();
        return this._parseRpcResponse(text);
    }

    _parseRpcResponse(text: string): any {
        const lines = text.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('[[')) {
                try {
                    const data = JSON.parse(trimmed);
                    if (data && data[0] && data[0][0] === 'wrb.fr') {
                        return data;
                    }
                } catch (e) { }
            }
        }
        return null;
    }

    async _executeStreamedRpc(fReqPayload: any): Promise<Buffer> {
        const reqId = Math.floor(Math.random() * 100000) + 100000;
        const fReqStr = JSON.stringify(fReqPayload);

        const params = new URLSearchParams({
            "bl": this.sessionTokens.bl || "",
            "f.sid": this.sessionTokens.fsid || "",
            "hl": "en",
            "_reqid": reqId.toString(),
            "rt": "c"
        });

        const url = `${RPC_GENERATE_STREAMED}?${params.toString()}`;

        const body = new URLSearchParams();
        body.append("f.req", fReqStr);
        body.append("at", this.sessionTokens.at || "");

        const response = await this.fetchWithCookies(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "X-Same-Domain": "1"
            },
            body: body.toString()
        });

        if (!response.ok) {
            throw new Error(`Streamed RPC Failed: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    _parseStreamedResponse(entryBuffer: Buffer): string {
        let fullText = "";
        let textBody = entryBuffer.toString('utf-8');

        if (textBody.startsWith(")]}'")) {
            textBody = textBody.substring(4).trim();
        }

        let pos = 0;
        const len = textBody.length;

        while (pos < len) {
            const startBracket = textBody.indexOf('[', pos);
            if (startBracket === -1) break;

            const endBracket = this._findBalancedEnd(textBody, startBracket);
            if (endBracket === -1) {
                pos = startBracket + 1;
                continue;
            }

            const jsonStr = textBody.substring(startBracket, endBracket + 1);
            try {
                const obj = JSON.parse(jsonStr);
                const extracted = this._extractWrbText(obj);
                if (extracted) {
                    fullText = extracted.trim() + "\n";
                }
            } catch (e) { }

            pos = endBracket + 1;
        }

        return fullText.trim();
    }

    _findBalancedEnd(str: string, start: number): number {
        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < str.length; i++) {
            const char = str[i];

            if (escape) { escape = false; continue; }
            if (char === '\\') { escape = true; continue; }
            if (char === '"') { inString = !inString; continue; }

            if (!inString) {
                if (char === '[') depth++;
                else if (char === ']') {
                    depth--;
                    if (depth === 0) return i;
                }
                else if (char === '{') depth++;
                else if (char === '}') depth--;
            }
        }
        return -1;
    }

    _extractWrbText(node: any): string {
        const results: string[] = [];

        const walk = (n: any, inPayload: boolean = false) => {
            if (Array.isArray(n)) {
                if (n.length >= 3 && n[0] === "wrb.fr" && typeof n[2] === 'string') {
                    try {
                        const innerJson = n[2];
                        if (innerJson.trim().startsWith("[")) {
                            const decoded = JSON.parse(innerJson);
                            if (Array.isArray(decoded) && decoded.length > 2) {
                                walk(decoded[0], true);
                            }
                        }
                    } catch (e) { }
                } else if (inPayload) {
                    if (n.length >= 2 && typeof n[0] === 'number' && typeof n[1] === 'number') return;
                    if (n.length >= 3 && n[0] === null && typeof n[1] === 'number' && typeof n[2] === 'number') return;
                    n.forEach(c => walk(c, inPayload));
                } else {
                    n.forEach(c => walk(c, inPayload));
                }
            } else if (typeof n === 'string' && inPayload) {
                const val = n.trim();
                if (val && val.length !== 36) {
                    results.push(val);
                }
            }
        };

        walk(node);
        return results.join("\n");
    }

    async downloadResource(url: string): Promise<Buffer> {
        logToFile(`[NativeFetch] Downloading resource: ${url.substring(0, 50)}...`);

        const response = await this.fetchWithCookies(url, {
            headers: { "Referer": "https://notebooklm.google.com/" }
        });

        if (!response.ok) {
            throw new Error(`Failed to download resource: ${response.status}`);
        }

        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    _findImageUrl(obj: any): string | null {
        if (typeof obj === 'string') {
            if (obj.includes('googleusercontent.com') || obj.startsWith('data:image/')) return obj;
        }
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = this._findImageUrl(item);
                if (found) return found;
            }
        }
        return null;
    }

    _findSourceId(obj: any): string | null {
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (typeof obj === 'string') {
            if (uuidRegex.test(obj)) return obj;
        }
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = this._findSourceId(item);
                if (found) return found;
            }
        }
        return null;
    }

    async prepareNotebook(url: string): Promise<{ notebookId: string, sourceId: string }> {
        if (!this.sessionTokens.at) await this._refreshTokens();

        const cacheFile = path.resolve(__dirname, "../cache.json");
        let cache: any = {};
        if (fs.existsSync(cacheFile)) {
            try {
                cache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
            } catch (e) { }
        }

        let notebookId: string | null = null;
        let sourceId: string | null = null;

        // Check if input is a direct Notebook URL
        const parsedNotebookId = this._parseNotebookUrl(url);
        if (parsedNotebookId) {
            notebookId = parsedNotebookId;
            logToFile(`[NativeFetch] Direct Notebook URL detected: ${notebookId}`);

            if (cache[url]) {
                sourceId = typeof cache[url] === 'object' ? (cache[url].sourceId || cache[url].source_id) : null;
            }

            if (!sourceId) {
                delete cache[url];
                logToFile("[NativeFetch] Source ID unknown. Fetching via RPC...");
                try {
                    sourceId = await this._fetchSourceId(notebookId);
                    cache[url] = { notebookId, sourceId };
                    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
                } catch (e) {
                    logToFile(`[NativeFetch] ❌ Failed to fetch source: ${e}`);
                    throw e;
                }
            } else {
                logToFile(`[NativeFetch] ⚡ Using Cached Source ID: ${sourceId}`);
            }

            return { notebookId, sourceId };
        }

        // YouTube URL logic
        if (cache[url]) {
            const entry = cache[url];
            if (typeof entry === 'object') {
                notebookId = entry.notebookId || entry.notebook_id;
                sourceId = entry.sourceId || entry.source_id;
            } else {
                notebookId = entry;
            }
            if (notebookId) logToFile(`[NativeFetch] ⚡ Cache Hit! Reusing notebook: ${notebookId}`);
        }

        if (!notebookId) {
            logToFile("[NativeFetch] Creating Notebook...");
            const createPayload = ["", null, null, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
            const createRes = await this._executeRpc(RPC_CREATE_NOTEBOOK, createPayload);
            const innerCreate = JSON.parse(createRes[0][2]);
            notebookId = innerCreate[2];
            logToFile(`[NativeFetch] Notebook Created: ${notebookId}`);
        }

        if (!sourceId) {
            logToFile(`[NativeFetch] Adding Source: ${url}...`);
            const sourcePayload = [[[null, null, null, null, null, null, null, [url], null, null, 1]], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
            const sourceRes = await this._executeRpc(RPC_ADD_SOURCE, sourcePayload);

            if (!sourceRes || !sourceRes[0]) throw new Error("Invalid Add Source Response");

            const rawInner = sourceRes[0][2];
            const innerSource = JSON.parse(rawInner);
            sourceId = this._findSourceId(innerSource);

            if (!sourceId) {
                throw new Error("Failed to add source (No ID found)");
            }

            logToFile(`[NativeFetch] Source Added: ${sourceId}`);
            cache[url] = { notebookId, sourceId };
            fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
        }

        return { notebookId: notebookId!, sourceId: sourceId! };
    }

    async pollForArtifacts(notebookId: string): Promise<string> {
        logToFile("[NativeFetch] Polling for artifacts...");
        for (let i = 0; i < 30; i++) {
            try {
                const payload = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
                const response = await this._executeRpc(RPC_LIST_ARTIFACTS, payload);
                if (response && response[0] && typeof response[0][2] === 'string') {
                    const innerData = JSON.parse(response[0][2]);
                    const imageUrl = this._findImageUrl(innerData);
                    if (imageUrl) {
                        logToFile(`[NativeFetch] 📸 Image Found: ${imageUrl}`);
                        return imageUrl;
                    }
                }
            } catch (e) { }
            await new Promise(r => setTimeout(r, 10000));
            logToFile(`[NativeFetch] Poll attempt ${i + 1}/30...`);
        }
        throw new Error("Timeout waiting for artifact creation");
    }

    async generateInfographic(videoUrl: string): Promise<string> {
        const { notebookId, sourceId } = await this.prepareNotebook(videoUrl);
        logToFile("[NativeFetch] ⏳ Waiting 5s...");
        await new Promise(r => setTimeout(r, 5000));

        logToFile("[NativeFetch] 🚀 Triggering Infographic...");
        const triggerPayload = [[2], notebookId, [null, null, 7, [[[sourceId]]], null, null, null, null, null, null, null, null, null, null, [[null, null, null, 1, 2]]]];
        await this._executeRpc(RPC_GENERATE_INFOGRAPHIC, triggerPayload);

        return await this.pollForArtifacts(notebookId);
    }

    async queryNotebook(notebookId: string, sourceId: string, prompt: string): Promise<string> {
        logToFile(`[NativeFetch] Query: "${prompt}" for notebook ${notebookId}...`);

        const innerReq = [
            [[[sourceId]]],
            prompt,
            null,
            [2, null, [1], [1]],
            null, null, null,
            notebookId,
            1
        ];

        const fReq = [
            null,
            JSON.stringify(innerReq)
        ];

        const rawResponse = await this._executeStreamedRpc(fReq);
        const summary = this._parseStreamedResponse(rawResponse);

        if (!summary) {
            console.warn("[NativeFetch] Query returned empty text.");
            return "Failed to generate answer.";
        }

        logToFile("[NativeFetch] Query successful.");
        return summary;
    }

    async query(url: string, question: string, specificSourceId?: string): Promise<string> {
        let { notebookId, sourceId } = await this.prepareNotebook(url);

        if (specificSourceId) {
            sourceId = specificSourceId;
            logToFile(`[NativeFetch] Override: Using specific source ID: ${sourceId}`);
        }

        logToFile(`[NativeFetch] Querying notebook ${notebookId} (source: ${sourceId})...`);
        return await this.queryNotebook(notebookId, sourceId, question);
    }

    async generateSummary(videoUrl: string): Promise<string> {
        const { notebookId, sourceId } = await this.prepareNotebook(videoUrl);

        logToFile("[NativeFetch] ⏳ Waiting 10s before requesting summary...");
        await new Promise(r => setTimeout(r, 10000));

        return await this.queryNotebook(notebookId, sourceId, "give me summary of the video");
    }
}
