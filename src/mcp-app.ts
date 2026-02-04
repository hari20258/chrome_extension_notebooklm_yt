
import { App } from "@modelcontextprotocol/ext-apps";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const viewerEl = document.getElementById("viewer")!;
const statusEl = document.getElementById("status")!;

const app = new App({ name: "NotebookLM Infographic", version: "1.0.0" });

// Check for transport configuration in URL
const urlParams = new URLSearchParams(window.location.search);
const transportType = urlParams.get("transport");
const serverUrl = urlParams.get("url") || "http://localhost:3000/sse";

// Establish communication with the host
if (transportType === "http") {
    console.log(`Connecting via StreamableHTTPClientTransport to ${serverUrl}...`);
    const transport = new StreamableHTTPClientTransport(new URL(serverUrl));
    app.connect(transport);
} else {
    // Default to PostMessage (Claude Desktop / Host)
    console.log("Connecting via default PostMessage (Host)...");
    app.connect();
}

// Handle the initial tool result pushed by the host
app.ontoolresult = (result) => {
    renderResult(result);
};

function renderResult(result: any) {
    if (!result || !result.content) return;

    // Look for Image content
    const imagePart = result.content.find((c: any) => c.type === "image");

    if (imagePart) {
        statusEl.style.display = 'none';
        viewerEl.innerHTML = '';

        const img = document.createElement('img');
        const src = `data:${imagePart.mimeType};base64,${imagePart.data}`;
        img.src = src;
        img.style.maxWidth = "100%";
        img.style.borderRadius = "8px";

        viewerEl.appendChild(img);
    } else {
        // Fallback for text
        const textPart = result.content.find((c: any) => c.type === "text");
        if (textPart) {
            statusEl.textContent = textPart.text;
        }
    }
}
