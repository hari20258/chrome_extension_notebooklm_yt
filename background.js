/*
 * Background Service Worker - CORS FIX EDITION
 * 1. Fetches Auth Tokens directly.
 * 2. Executes RPCs directly.
 * 3. Robost Base64 with Error Fallback.
 */

// --- CONFIGURATION ---
const BASE_URL = "https://notebooklm.google.com";
const RPC_ENDPOINT = `${BASE_URL}/_/LabsTailwindUi/data/batchexecute`;

// RPC IDs
const RPC = {
    CREATE_NOTEBOOK: "CCqFvf",
    ADD_SOURCE: "izAoDd",
    GENERATE_INFOGRAPHIC: "R7cb6c",
    LIST_ARTIFACTS: "gArtLc",
    DELETE_NOTEBOOK: "f61S6e"
};

// State
let sessionTokens = { at: null, bl: null, fsid: null };

// --- COOKIE SYNC TO MCP SERVER ---
const MCP_SERVER_URL = "http://localhost:3001";

async function extractAndSyncCookies() {
    try {
        // Get stored user token (if any)
        const storage = await chrome.storage.local.get(['user_token', 'server_url']);
        const userToken = storage.user_token || null;
        const serverUrl = storage.server_url || MCP_SERVER_URL;

        // Get cookies using multiple strategies to ensure we catch SID/HSID
        const d1 = await chrome.cookies.getAll({ domain: "google.com" });
        const d2 = await chrome.cookies.getAll({ domain: ".google.com" });
        const u1 = await chrome.cookies.getAll({ url: "https://notebooklm.google.com" });
        const u2 = await chrome.cookies.getAll({ url: "https://accounts.google.com" });

        // Explicitly check for SID/HSID on multiple variants (Common pitfall)
        const sid = await chrome.cookies.get({ url: "https://google.com", name: "SID" });
        const hsid = await chrome.cookies.get({ url: "https://google.com", name: "HSID" });
        const sid_www = await chrome.cookies.get({ url: "https://www.google.com", name: "SID" });
        const hsid_www = await chrome.cookies.get({ url: "https://www.google.com", name: "HSID" });

        const explicitCookies = [sid, hsid, sid_www, hsid_www].filter(c => c !== null);

        // Combine and deduplicate
        const allCookies = [...d1, ...d2, ...u1, ...u2, ...explicitCookies];
        const seen = new Set();
        const uniqueCookies = allCookies.filter(c => {
            const key = `${c.name}@${c.domain}@${c.path}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        console.log(`[Cookies] Extracted ${uniqueCookies.length} unique cookies`);

        // Send to MCP server (with user_token if set)
        const response = await fetch(`${serverUrl}/sync-cookies`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                cookies: uniqueCookies,
                user_token: userToken
            })
        });

        if (response.ok) {
            const result = await response.json();
            console.log("[Cookies] ✅ Synced cookies to MCP server", result);
            return { success: true, ...result };
        } else {
            console.warn("[Cookies] ⚠️ Server responded with:", response.status);
            return { success: false, error: `Server error: ${response.status}` };
        }
    } catch (e) {
        console.warn("[Cookies] Failed to sync (server may not be running):", e.message);
        return { success: false, error: e.message };
    }
}

// Sync on extension startup
chrome.runtime.onStartup.addListener(extractAndSyncCookies);
chrome.runtime.onInstalled.addListener(extractAndSyncCookies);

// --- SSE LISTENER (Server pushes re-auth events only when needed) ---
let authEventSource = null;
let isReauthInProgress = false;

async function connectAuthEvents() {
    try {
        const storage = await chrome.storage.local.get(['user_token', 'server_url']);
        const userToken = storage.user_token || '';
        const serverUrl = storage.server_url || MCP_SERVER_URL;

        const url = `${serverUrl}/auth-events?user_token=${encodeURIComponent(userToken)}`;

        // Close existing connection if any
        if (authEventSource) {
            authEventSource.close();
            authEventSource = null;
        }

        authEventSource = new EventSource(url);

        authEventSource.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'reauth' && !isReauthInProgress) {
                    console.log("[SSE] 🔴 Server says re-auth needed! Opening login tab...");
                    isReauthInProgress = true;
                    await handleReauth();
                    isReauthInProgress = false;
                } else if (data.type === 'connected') {
                    console.log("[SSE] ✅ Connected to server auth events for:", data.user_token);
                }
            } catch (e) {
                console.error("[SSE] Error parsing event:", e);
            }
        };

        authEventSource.onerror = (e) => {
            console.log("[SSE] Connection lost. Will auto-reconnect...");
            // EventSource auto-reconnects by default
        };

        console.log("[SSE] Connecting to", url);
    } catch (e) {
        console.log("[SSE] Failed to connect (server may not be running):", e.message);
    }
}

async function handleReauth() {
    try {
        // Show notification
        chrome.notifications.create('reauth', {
            type: 'basic',
            iconUrl: 'icon128.png',
            title: 'NotebookLM - Login Required',
            message: 'Your session expired. A login tab has been opened. Please log in to continue.',
            priority: 2
        });

        // Open NotebookLM in a new tab
        const tab = await chrome.tabs.create({ url: 'https://notebooklm.google.com', active: true });
        console.log("[SSE] Opened login tab:", tab.id);

        // Wait for the user to log in (poll tab URL every 3s, up to 5min)
        const MAX_WAIT = 300000;
        const POLL_INTERVAL = 3000;
        const start = Date.now();

        await new Promise((resolve) => {
            const check = setInterval(async () => {
                try {
                    const updatedTab = await chrome.tabs.get(tab.id);
                    const tabUrl = updatedTab.url || '';

                    // Login is complete when URL is on notebooklm (not accounts.google.com)
                    if (tabUrl.includes('notebooklm.google.com') && !tabUrl.includes('accounts.google.com')) {
                        console.log("[SSE] ✅ Login detected! URL:", tabUrl);
                        clearInterval(check);
                        resolve();
                    }

                    if (Date.now() - start > MAX_WAIT) {
                        console.log("[SSE] ⏰ Login timeout");
                        clearInterval(check);
                        resolve();
                    }
                } catch (e) {
                    // Tab was closed by user
                    console.log("[SSE] Tab was closed");
                    clearInterval(check);
                    resolve();
                }
            }, POLL_INTERVAL);
        });

        // Extract fresh cookies and sync
        console.log("[SSE] Extracting fresh cookies after login...");
        const result = await extractAndSyncCookies();
        console.log("[SSE] Cookie sync result:", result);

        // Close the login tab
        try { await chrome.tabs.remove(tab.id); } catch (e) { /* already closed */ }

        chrome.notifications.create('reauth-done', {
            type: 'basic',
            iconUrl: 'icon128.png',
            title: 'NotebookLM - Re-authenticated!',
            message: 'Cookies re-synced. Your request will now continue automatically.',
            priority: 1
        });

    } catch (e) {
        console.error("[SSE] Re-auth handling failed:", e);
        isReauthInProgress = false;
    }
}

// Connect on extension load (will auto-reconnect if server isn't running yet)
connectAuthEvents();


// Listen for refresh requests (on-demand when cookies go stale)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message.type === 'REFRESH_COOKIES') {
        console.log("[Cookies] 🔄 Server requested cookie refresh");
        extractAndSyncCookies().then((result) => sendResponse(result));
        return true; // Keep channel open for async response
    }
});

// Also allow internal messages to trigger refresh and set user token
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'REFRESH_COOKIES') {
        console.log("[Cookies] 🔄 Refresh requested");
        extractAndSyncCookies().then((result) => sendResponse(result));
        return true;
    }
    if (message.type === 'SET_USER_TOKEN') {
        console.log("[Cookies] 🔑 Setting user token:", message.token);
        chrome.storage.local.set({ user_token: message.token }, () => {
            sendResponse({ success: true });
        });
        return true;
    }
    if (message.type === 'SET_SERVER_URL') {
        console.log("[Cookies] 🌐 Setting server URL:", message.url);
        chrome.storage.local.set({ server_url: message.url }, () => {
            sendResponse({ success: true });
        });
        return true;
    }
    if (message.type === 'GET_SETTINGS') {
        chrome.storage.local.get(['user_token', 'server_url'], (result) => {
            sendResponse({
                user_token: result.user_token || '',
                server_url: result.server_url || MCP_SERVER_URL
            });
        });
        return true;
    }
});

// --- 1. TOKEN SCRAPER ---
async function refreshTokens() {
    console.log("[Headless] 🔄 Fetching new auth tokens...");
    try {
        const response = await fetch(BASE_URL, {
            method: "GET",
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        const html = await response.text();

        const atMatch = html.match(/"SNlM0e":"([^"]+)"/);
        const blMatch = html.match(/"(boq_labs-tailwind-[^"]+)"/);
        const fsidMatch = html.match(/"FdrFJe":"([^"]+)"/);

        if (!atMatch || !blMatch) throw new Error("Could not scrape tokens. User might be logged out.");

        sessionTokens = {
            at: atMatch[1],
            bl: blMatch[1],
            fsid: fsidMatch ? fsidMatch[1] : ""
        };
        console.log("[Headless] ✅ Tokens acquired:", sessionTokens.bl);
        return true;

    } catch (e) {
        console.error("[Headless] Token Error:", e);
        return false;
    }
}

// --- 2. RPC EXECUTOR ---
async function executeRPC(rpcId, payload) {
    if (!sessionTokens.at) await refreshTokens();

    const reqId = Math.floor(Math.random() * 100000) + 100000;
    const innerPayload = JSON.stringify(payload);
    const envelope = JSON.stringify([[[rpcId, innerPayload, null, "generic"]]]);

    const params = new URLSearchParams({
        "rpcids": rpcId,
        "source-path": "/",
        "bl": sessionTokens.bl,
        "f.sid": sessionTokens.fsid,
        "hl": "en",
        "rt": "c",
        "_reqid": reqId
    });

    const body = new URLSearchParams();
    body.append("f.req", envelope);
    body.append("at", sessionTokens.at);

    const response = await fetch(`${RPC_ENDPOINT}?${params.toString()}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Same-Domain": "1"
        },
        body: body,
        credentials: "include"
    });

    if (!response.ok) throw new Error(`RPC ${rpcId} failed: ${response.status}`);

    const text = await response.text();
    return parseRPCResponse(text);
}

function parseRPCResponse(text) {
    const lines = text.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[[')) {
            try {
                const json = JSON.parse(trimmed);
                if (json[0] && json[0][0] === 'wrb.fr') {
                    return json;
                }
            } catch (e) { }
        }
    }
    return null;
}

// --- 3. CORE LOGIC FLOW ---
async function runGenerationPipeline(youtubeTabId, videoUrl) {
    try {
        notifyUI(youtubeTabId, "Initializing (Headless Mode)...");

        // Step A: Refresh Tokens
        if (!await refreshTokens()) {
            notifyUI(youtubeTabId, "LOGIN_REQUIRED");
            return;
        }

        // Step B: Create Notebook
        notifyUI(youtubeTabId, "Creating Notebook...");
        const createPayload = ["", null, null, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
        const createRes = await executeRPC(RPC.CREATE_NOTEBOOK, createPayload);

        const innerCreate = JSON.parse(createRes[0][2]);
        const notebookId = innerCreate[2];
        console.log("[Headless] Notebook Created:", notebookId);

        // Step C: Add Source
        notifyUI(youtubeTabId, "Adding Source...");
        const sourcePayload = [[[null, null, null, null, null, null, null, [videoUrl], null, null, 1]], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
        const sourceRes = await executeRPC(RPC.ADD_SOURCE, sourcePayload);

        const innerSource = JSON.parse(sourceRes[0][2]);
        const sourceId = findSourceID(innerSource);

        if (!sourceId) throw new Error("Google rejected video (No Transcript?)");
        console.log("[Headless] Source Added:", sourceId);

        // Step D: Wait & Trigger
        notifyUI(youtubeTabId, "Processing Transcript (10s)...");
        console.log("[Headless] ⏳ Pausing 10s for transcript processing...");
        await new Promise(r => setTimeout(r, 10000));

        notifyUI(youtubeTabId, "Triggering Generation...");
        console.log("[Headless] 🚀 Triggering Generation RPC...");

        const triggerPayload = [[2], notebookId, [null, null, 7, [[[sourceId]]], null, null, null, null, null, null, null, null, null, null, [[null, null, null, 1, 2]]]];
        await executeRPC(RPC.GENERATE_INFOGRAPHIC, triggerPayload);
        console.log("[Headless] ✅ Trigger Sent.");

        // Step E: Poll
        notifyUI(youtubeTabId, "Generating Infographic...");
        await pollForArtifacts(youtubeTabId, notebookId, sourceId);

    } catch (e) {
        console.error("[Headless] Pipeline Failed:", e);
        notifyUI(youtubeTabId, "ERROR", { error: e.message });
    }
}

async function pollForArtifacts(tabId, notebookId, sourceId) {
    let attempts = 0;
    const maxAttempts = 30;

    const interval = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(interval);
            notifyUI(tabId, "ERROR", { error: "Timeout" });
            return;
        }

        try {
            console.log(`[Headless] Polling #${attempts}...`);

            const payload = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
            const response = await executeRPC(RPC.LIST_ARTIFACTS, payload);

            if (response && response[0] && typeof response[0][2] === 'string') {
                const innerData = JSON.parse(response[0][2]);
                const imageUrl = findImageUrl(innerData);

                if (imageUrl) {
                    console.log("[Headless] 📸 Image Found:", imageUrl);
                    clearInterval(interval);

                    // --- CHANGED: Fallback Logic ---
                    let finalImage = imageUrl;
                    try {
                        const base64 = await urlToBase64(imageUrl);
                        finalImage = base64;
                        console.log("[Headless] ✅ Base64 Conversion Success");
                    } catch (e) {
                        console.warn("[Headless] ⚠️ Base64 failed (CORS?), sending URL directly.", e);
                    }

                    notifyUI(tabId, "COMPLETED", { imageUrl: finalImage });

                    // Optional: Clean up notebook after success?
                    // executeRPC(RPC.DELETE_NOTEBOOK, ...);
                }
            }
        } catch (e) {
            console.warn("Poll failed, retrying...", e);
        }
    }, 20000);
}

// --- HELPERS ---
function notifyUI(tabId, status, payload = {}) {
    chrome.tabs.sendMessage(tabId, { type: 'UPDATE_STATUS', status, payload }).catch(() => { });
}

function findSourceID(obj) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof obj === 'string' && uuidRegex.test(obj)) return obj;
    if (Array.isArray(obj)) {
        for (let item of obj) {
            const found = findSourceID(item);
            if (found) return found;
        }
    }
    return null;
}

function findImageUrl(obj) {
    if (typeof obj === 'string' && (obj.includes('googleusercontent.com') || obj.startsWith('data:image/'))) return obj;
    if (Array.isArray(obj)) {
        for (let item of obj) {
            const res = findImageUrl(item);
            if (res) return res;
        }
    }
    return null;
}

async function urlToBase64(url) {
    // IMPORTANT: 'no-cors' mode would make the response opaque (unreadable), so we cannot use it to get data.
    // We MUST use standard fetch. The 'host_permissions' in manifest.json is what allows this to work.
    const res = await fetch(url);
    const blob = await res.blob();
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.readAsDataURL(blob);
    });
}

// --- ENTRY POINT ---
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.type === 'INIT_GENERATION') {
        runGenerationPipeline(sender.tab.id, msg.videoUrl);
    }
});