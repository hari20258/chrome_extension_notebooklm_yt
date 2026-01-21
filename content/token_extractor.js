/*
 * Token Extractor & RPC Proxy - FINAL FIX
 * 1. Scans for Version Info.
 * 2. Wraps payload in the CORRECT TRIPLE ARRAY structure.
 */
(function () {
    console.log("NotebookSpy: Proxy Loaded.");

    let cachedBL = null;
    let cachedFSID = null;
    let cachedToken = null;

    function scanContext() {
        try {
            if (window.WIZ_global_data) {
                cachedToken = window.WIZ_global_data.SNlM0e;
                cachedFSID = window.WIZ_global_data.FdrFJe;
            }
            const html = document.documentElement.innerHTML;
            const blMatch = html.match(/(boq_labs-tailwind-[a-zA-Z0-9_.-]+)/);
            if (blMatch) cachedBL = blMatch[0];

            if (cachedToken && cachedBL) {
                window.postMessage({ type: "EXTENSION_PROXY_READY" }, "*");
            }
        } catch (e) {
            console.error("Context Scan Error", e);
        }
    }

    window.addEventListener("message", async (event) => {
        if (event.source !== window || !event.data.type) return;
        if (event.data.type === "EXTENSION_CMD_EXECUTE") {
            const { rpcId, payload, reqId } = event.data;
            await executeRPC(rpcId, payload, reqId);
        }
    });

    async function executeRPC(rpcId, payload, reqId) {
        if (!cachedToken || !cachedBL) scanContext();

        const baseUrl = "https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute";
        const url = new URL(baseUrl);

        url.searchParams.append("rpcids", rpcId);
        url.searchParams.append("source-path", "/");
        url.searchParams.append("bl", cachedBL);
        url.searchParams.append("f.sid", cachedFSID || "");
        url.searchParams.append("hl", "en"); // Added language param from your log
        url.searchParams.append("rt", "c");
        url.searchParams.append("_reqid", reqId);

        const innerPayload = JSON.stringify(payload);

        // 🔥 THE FIX: TRIPLE ARRAY WRAPPER [[["ID", ...]]] 
        // Your log showed: [[["CCqFvf", ... ]]]
        const envelope = JSON.stringify([[[rpcId, innerPayload, null, "generic"]]]);

        const body = new URLSearchParams();
        body.append("f.req", envelope);
        body.append("at", cachedToken);

        try {
            console.log(`NotebookSpy: 🚀 Sending RPC ${rpcId}...`);
            const response = await fetch(url.toString(), {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "X-Same-Domain": "1"
                },
                body: body
            });

            if (!response.ok) {
                throw new Error(`Server responded with ${response.status}`);
            }

            const text = await response.text();

            window.postMessage({
                type: "EXTENSION_RPC_RESULT",
                status: "SUCCESS",
                data: text,
                rpcId: rpcId
            }, "*");

        } catch (err) {
            console.error("NotebookSpy Error:", err);
            window.postMessage({
                type: "EXTENSION_RPC_RESULT",
                status: "ERROR",
                error: err.toString(),
                rpcId: rpcId
            }, "*");
        }
    }

    scanContext();
    setTimeout(scanContext, 1000);
})();
