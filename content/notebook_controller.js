/*
 * NotebookLM Controller - PATIENT POLLING + UI UPDATES
 * 1. Triggers generation (R7cb6c)
 * 2. Polls (gArtLc) every 20s for result.
 * 3. Sends status updates to YouTube UI.
 */

const RPC_CREATE_NOTEBOOK = "CCqFvf";
const RPC_REFRESH_LIST = "ub2Bae";
const RPC_ADD_SOURCE = "izAoDd";
const RPC_GENERATE_INFOGRAPHIC = "R7cb6c";
const RPC_LIST_ARTIFACTS = "gArtLc"; 

let isProxyReady = false;

function init() {
    console.log("NotebookController: Waiting for Proxy...");
    // FEATURE: Initial Status
    chrome.runtime.sendMessage({ type: 'GENERATION_UPDATE', status: 'Initializing...' });
}

window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data.type === "EXTENSION_PROXY_READY") {
        if (!isProxyReady) {
            console.log("NotebookController: ✅ Proxy is Ready.");
            isProxyReady = true;
            chrome.runtime.sendMessage({ type: 'NOTEBOOK_READY' });
        }
    }
    // FEATURE: Login Check Handler
    else if (event.data.type === "EXTENSION_LOGIN_REQUIRED") {
        console.warn("NotebookController: User is not logged in.");
        chrome.runtime.sendMessage({
            type: 'GENERATION_UPDATE',
            status: 'LOGIN_REQUIRED',
            payload: {}
        });
    }
});

function callProxy(rpcId, payload) {
    return new Promise((resolve, reject) => {
        if (!isProxyReady) return reject("Proxy not ready");

        const reqId = Math.floor(Math.random() * 100000) + 100000;
        
        const listener = (event) => {
            if (event.source !== window) return;
            if (event.data.type === "EXTENSION_RPC_RESULT" && event.data.rpcId === rpcId) {
                window.removeEventListener("message", listener);
                
                if (event.data.status === "SUCCESS") {
                    const rawText = event.data.data;
                    try {
                        const lines = rawText.split('\n');
                        let parsedData = null;
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (trimmed.startsWith('[[')) {
                                try {
                                    const json = JSON.parse(trimmed);
                                    if (json[0] && json[0][0] === 'wrb.fr') {
                                        parsedData = json;
                                        break;
                                    }
                                } catch (e) {}
                            }
                        }
                        resolve(parsedData || []); 
                    } catch (e) {
                        reject("JSON Parse Error");
                    }
                } else {
                    reject(event.data.error);
                }
            }
        };

        window.addEventListener("message", listener);

        window.postMessage({
            type: "EXTENSION_CMD_EXECUTE",
            rpcId: rpcId,
            payload: payload,
            reqId: reqId
        }, "*");
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'CMD_CREATE_NOTEBOOK') {
        performCreation();
    } else if (msg.type === 'CMD_PROCESS_VIDEO') {
        startFlow(msg.videoUrl);
    }
});

async function performCreation() {
    try {
        // FEATURE: Status Update
        chrome.runtime.sendMessage({ type: 'GENERATION_UPDATE', status: 'Creating notebook...' });
        console.log("NotebookController: Creating new notebook...");
        
        const payload = ["", null, null, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
        const response = await callProxy(RPC_CREATE_NOTEBOOK, payload);
        
        if (!response || !response[0]) throw new Error("No response");
        const innerJsonString = response[0][2];
        const innerResponse = JSON.parse(innerJsonString);
        const id = innerResponse[2]; 

        console.log("NotebookController: ✅ Created ID:", id);
        await callProxy(RPC_REFRESH_LIST, [[2]]);

        chrome.runtime.sendMessage({
            type: 'GENERATION_UPDATE',
            status: 'NOTEBOOK_CREATED_ID',
            payload: { notebookId: id }
        });

    } catch (e) {
        console.error("Creation Failed", e);
        chrome.runtime.sendMessage({
            type: 'GENERATION_UPDATE',
            status: 'ERROR',
            payload: { error: e.toString() }
        });
    }
}

async function startFlow(videoUrl) {
    try {
        const match = location.pathname.match(/\/notebook\/([a-zA-Z0-9-]+)/);
        const notebookId = match ? match[1] : null;
        if (!notebookId) throw new Error("No Notebook ID found");

        // FEATURE: Status Update
        chrome.runtime.sendMessage({ type: 'GENERATION_UPDATE', status: 'Adding source...' });
        console.log("NotebookController: Adding source to", notebookId);
        
        const payload = [[[null, null, null, null, null, null, null, [videoUrl], null, null, 1]], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]];
        const response = await callProxy(RPC_ADD_SOURCE, payload);
        
        const innerResponse = JSON.parse(response[0][2]);
        const sourceId = findSourceID(innerResponse); 
        console.log("NotebookController: Source Added", sourceId);

        await generateInfographic(notebookId, sourceId);

    } catch (e) {
        console.error("Flow Failed", e);
    }
}

async function generateInfographic(notebookId, sourceId) {
    // FEATURE: Status Update for long wait
    chrome.runtime.sendMessage({ type: 'GENERATION_UPDATE', status: 'Generating infographic (this may take a few minutes)...' });

    // 1. TRIGGER GENERATION
    const triggerPayload = [
        [2], notebookId, 
        [null, null, 7, [[[sourceId]]], null, null, null, null, null, null, null, null, null, null, [[null, null, null, 1, 2]]]
    ];
    console.log("NotebookController: 🚀 Triggering Generation...");
    await callProxy(RPC_GENERATE_INFOGRAPHIC, triggerPayload);
    
    // 2. POLL FOR ARTIFACTS
    pollForArtifacts(notebookId);
}

async function pollForArtifacts(notebookId) {
    let attempts = 0;
    const maxAttempts = 30; // 30 * 20s = 10 minutes max

    const poll = setInterval(async () => {
        attempts++;
        if (attempts > maxAttempts) {
            clearInterval(poll);
            return;
        }

        try {
            console.log(`NotebookController: Polling Artifacts #${attempts}...`);
            
            const payload = [[2], notebookId, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"'];
            const response = await callProxy(RPC_LIST_ARTIFACTS, payload);
            
            if (response && response[0] && typeof response[0][2] === 'string') {
                try {
                    const innerData = JSON.parse(response[0][2]);
                    const imageUrl = findImageUrl(innerData);
                    
                    if (imageUrl) {
                        console.log("NotebookController: 📸 Found Image URL!", imageUrl);
                        clearInterval(poll);
                        chrome.runtime.sendMessage({
                            type: 'GENERATION_UPDATE',
                            status: 'COMPLETED',
                            payload: { imageUrl: imageUrl }
                        });
                        return;
                    }
                } catch(e) {
                    console.log("Could not parse inner artifact data, continuing...");
                }
            }
            console.log("NotebookController: No image found yet...");

        } catch (e) {
            console.error("Poll error (ignoring)", e);
        }
    }, 20000); // 20 Seconds Interval
}

function findSourceID(obj) {
    if (typeof obj === 'string' && obj.length > 10 && !obj.includes(' ')) return obj;
    if (Array.isArray(obj)) {
        for (let item of obj) {
            const found = findSourceID(item);
            if (found) return found;
        }
    }
    return null;
}

function findImageUrl(obj) {
    if (typeof obj === 'string') {
        if (obj.includes('googleusercontent.com') || obj.startsWith('data:image/')) {
            return obj;
        }
    }
    if (Array.isArray(obj)) {
        for (let item of obj) {
            const result = findImageUrl(item);
            if (result) return result;
        }
    }
    return null;
}

init();