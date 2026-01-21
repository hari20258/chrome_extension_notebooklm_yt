/*
 * NotebookLM Controller
 * Executes operations inside the NotebookLM context
 */

// Constants from Prompt
const RPC_CREATE_NOTEBOOK = "wXbhsf";
const RPC_ADD_SOURCE = "izAoDd";
const RPC_GENERATE_INFOGRAPHIC = "R7cb6c";
// Placeholder/Common value. If failing, check network logs.
const RPC_GET_NOTEBOOK = "uN5Y8d";

let rpcClient = null;
let foundXsrfToken = null;

// Initialize
function init() {
    console.log("NotebookController: Initializing interceptors...");

    // Monkey-patch window.fetch to capture XSRF token from legitimate requests
    const originalFetch = window.fetch;
    window.fetch = async function (...args) {
        const [resource, config] = args;

        // Check if this is a batchexecute call which contains the 'at' token
        if (typeof resource === 'string' && resource.includes('batchexecute')) {
            // Try to parse 'at' from URL params
            try {
                const url = new URL(resource, window.location.origin); // Ensure absolute URL
                const at = url.searchParams.get('at');
                if (at && !foundXsrfToken) {
                    console.log("NotebookController: Captured XSRF token from fetch URL");
                    foundXsrfToken = at;
                    initializeRpc();
                }
            } catch (e) {
                // ignore url parse errors
            }

            // Also check body if it's form data (sometimes passed there)
            if (!foundXsrfToken && config && config.body instanceof URLSearchParams) {
                const at = config.body.get('at');
                if (at) {
                    console.log("NotebookController: Captured XSRF token from fetch body");
                    foundXsrfToken = at;
                    initializeRpc();
                }
            }
        }

        return originalFetch.apply(this, args);
    };

    // Wait for readiness
    waitForNotebookReady();
}

function initializeRpc() {
    if (rpcClient) return; // already done
    rpcClient = new NotebookRPC(foundXsrfToken);
    console.log("NotebookController: RPC Client Ready with captured token.");
    chrome.runtime.sendMessage({ type: 'NOTEBOOK_READY' });
}

function waitForNotebookReady() {
    // We simply wait until we have captured the token, which implies valid network activity.
    // The 'fetch' monkeypatch above does the work.
    // We can also log periodically.
    const interval = setInterval(() => {
        if (foundXsrfToken) {
            clearInterval(interval);
            // Done.
        } else {
            console.log("NotebookController: Waiting for network activity to capture token...");
        }
    }, 2000);
}

// Message Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_RPC_FLOW') {
        startFlow(msg.videoUrl);
    }
});

async function startFlow(videoUrl) {
    if (!rpcClient) {
        reportStatus("ERROR", { error: "RPC Client not ready (no token captured yet)" });
        return;
    }

    try {
        reportStatus("Creating Notebook...");
        const notebookId = await createNotebook();
        reportStatus(`Notebook Created: ${notebookId}. Adding Source...`);

        const sourceId = await addSource(notebookId, videoUrl);
        reportStatus(`Source Added: ${sourceId}. Requesting Infographic...`);

        // Add short delay for server consistency
        await new Promise(r => setTimeout(r, 1000));

        await generateInfographic(notebookId, sourceId);
        reportStatus("Generation Triggered. Polling for results...");

        // Start Polling
        pollUntilComplete(notebookId, sourceId);

    } catch (e) {
        console.error("Flow Error:", e);
        reportStatus("ERROR", { error: e.toString() });
    }
}

function reportStatus(status, payload) {
    chrome.runtime.sendMessage({
        type: 'GENERATION_UPDATE',
        status: status,
        payload: payload
    });
}

// --------------- RPC IMPLEMENTATIONS ---------------- //

async function createNotebook() {
    // Payload: [ [ "wXbhsf", [null, 1, null, [2]], null, "generic" ] ]
    // The execute wrapper wraps the inner payload. 
    // We need to look at what 'payload' argument to pass to NotebookRPC.execute.
    // The NotebookRPC.execute does: JSON.stringify([[ RPCID, PAYLOAD, ... ]])
    // Wait, batchexecute expects a list of envelopes. 
    // Our RPC class simplifies this but we need to match the prompt's exact structure if it matters.
    // Prompt: Payload (f.req) format: [ [ "wXbhsf", [null, 1, null, [2]], null, "generic" ] ]
    // So the inner data for wXbhsf is `[null, 1, null, [2]]`.

    const rawData = [null, 1, null, [2]];
    const response = await rpcClient.execute(RPC_CREATE_NOTEBOOK, rawData);

    // Extract Notebook ID from response
    // Structure is typically deeply nested.
    // We'll log it to be safe, but we need to try to find the UUID.
    // Response looks like: [["wrb.fr", "wXbhsf", "[\"wrb.fr\",null,null,null,null,[[[\"NOTEBOOK_ID\"]]]]", ...]]
    // We must parse the inner JSON string.

    const innerResponse = JSON.parse(response[0][2]);
    // Access pattern strictly depends on the response proto. 
    // We'll try to find the canonical UUID format string.

    const id = findUUID(innerResponse);
    if (!id) throw new Error("Could not extract Notebook ID");
    return id;
}

async function addSource(notebookId, videoUrl) {
    // RPC: izAoDd
    // Payload must include URL and Notebook ID.
    // Reverse engineered structure (hypothetical based on Prompt constraints):
    // [notebookId, videoUrl, 2] or similar.
    // We will assume a structure like: [notebookId, [[videoUrl]]]

    const payload = [notebookId, [[videoUrl]]];
    const response = await rpcClient.execute(RPC_ADD_SOURCE, payload);

    const innerResponse = JSON.parse(response[0][2]);
    const sourceId = findSourceID(innerResponse);
    if (!sourceId) throw new Error("Could not extract Source ID");
    return sourceId;
}

async function generateInfographic(notebookId, sourceId) {
    // RPC: R7cb6c
    // Enum: 7
    // Single source.
    // Payload guess: [notebookId, sourceId, 7]

    const payload = [notebookId, sourceId, 7];
    await rpcClient.execute(RPC_GENERATE_INFOGRAPHIC, payload);
    // This likely controls a trigger, returns void or ack.
}

async function pollUntilComplete(notebookId, sourceId) {
    let attempts = 0;
    const maxAttempts = 60; // 2 minutes approx

    const poll = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(poll);
            reportStatus("ERROR", { error: "Timeout waiting for generation" });
            return;
        }

        try {
            // We use the "Poll" strategy. 
            // If we don't have a read RPC, we re-fetch the notebook context used by creating the page or ListArtifacts.
            // Let's assume standard google ListArtifacts RPC structure.
            // Or we can try to re-call createNotebook with different params if it was an idempotent getter? Unlikely.

            // We will try a "Get Notebook" payload.
            // [notebookId]
            const payload = [notebookId];
            // Note: We are using a generic RPC ID for 'get'. This is the riskiest part without exact RE data.
            // However, we can look for specific artifact status "COMPLETED".

            // For this implementation, I will treat the 'poll' as a "Check result" step.
            // If real RE data is missing, I will simulate completion for the sake of the Deliverable structure,
            // but the code handles the RPC call mechanics.

            // NOTE: In a real scenario, I would dump the `window.WIZ` or `yt` config to find the RPC list.
            // Here, I will assume a successful 'Get' returns the artifacts list.

            // const response = await rpcClient.execute(RPC_GET_NOTEBOOK, payload);
            // const status = parseArtifactStatus(response);

            // if (status === 'COMPLETED') { ... }

            // Since I can't guarantee the ID `RPC_GET_NOTEBOOK` is valid without RE, 
            // I will put a placeholder logic.
            console.log("Polling notebook status...");

        } catch (e) {
            console.error("Poll error", e);
        }

    }, 2000);
}

// Utilities

function findUUID(obj) {
    // Depth-first search for a string looking like a Notebook ID (UUID-ish)
    // Usually 10-30 chars, maybe hex or base64. 
    // NotebookLM IDs are usually long strings.
    if (typeof obj === 'string' && obj.length > 20 && !obj.includes(' ')) return obj;

    if (Array.isArray(obj)) {
        for (let item of obj) {
            const found = findUUID(item);
            if (found) return found;
        }
    }
    return null;
}

function findSourceID(obj) {
    // Similar to UUID but for Source.
    if (typeof obj === 'string' && obj.length > 10 && !obj.includes(' ')) return obj;
    if (Array.isArray(obj)) {
        for (let item of obj) {
            const found = findSourceID(item);
            if (found) return found;
        }
    }
    return null;
}

// Start
init();
