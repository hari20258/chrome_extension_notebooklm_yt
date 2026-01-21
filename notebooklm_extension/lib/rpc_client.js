/*
 * RPC Client Helper
 * Handles the batchexecute protocol encryption/serialization
 */

class NotebookRPC {
    constructor(xsrfToken) {
        this.xsrfToken = xsrfToken;
        this.baseUrl = 'https://notebooklm.google.com/_/NotebookUi/data/batchexecute';
    }

    async execute(rpcId, payload) {
        // Construct the batchexecute payload
        // The format is: f.req=[[["RPC_ID","JSON_STRINGIFIED_PAYLOAD",null,"generic"]]]

        const rpcPayload = JSON.stringify([
            [
                rpcId,
                JSON.stringify(payload),
                null,
                "generic" // This method signature might vary, but 'generic' is standard for batchexecute
            ]
        ]);

        const body = new URLSearchParams();
        body.append('f.req', rpcPayload);
        body.append('at', this.xsrfToken);

        try {
            const response = await fetch(this.baseUrl + '?rpcids=' + rpcId + '&source-path=/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
                },
                body: body,
                credentials: 'include' // CRITICAL: Send cookies
            });

            if (!response.ok) {
                throw new Error(`RPC Failed: ${response.status}`);
            }

            const text = await response.text();
            return this.parseResponse(text);

        } catch (e) {
            console.error("RPC Error:", e);
            throw e;
        }
    }

    parseResponse(responseText) {
        // Response strictly starts with )]}'
        const cleaned = responseText.replace(/^\)\]\}\'\n/, '');
        const json = JSON.parse(cleaned);

        // batchexecute returns an array of arrays.
        // We look for the one matching our RPC ID or the data.
        // Usually: [[["wrb.fr","RPC_ID","JSON_RESPONSE", ...]]]
        // We want content inside JSON_RESPONSE.

        // Note: This parsing logic is generic; specific RPCs have different internal structures.
        // We return the raw parsed envelope.
        return json;
    }
}
