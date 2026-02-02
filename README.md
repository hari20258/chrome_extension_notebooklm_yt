# NotebookLM Infographic MCP Server

This project allows Claude Desktop to interact with **Google NotebookLM** to automatically generate and retrieve infographics from YouTube videos. It functions as a Model Context Protocol (MCP) server, bridging the gap between Claude's interface and Google's internal APIs.

## 🛠️ How It Works

The system operates as a **headless browser automation agent** (using Playwright) wrapped in an **MCP Server**.

1.  **User Request**: You ask Claude to "Generate an infographic for [YouTube URL]".
2.  **MCP Server (`server.py`)**: Receives the tool call and delegates it to the `NotebookLMClient`.
3.  **Automation Client (`notebooklm_client.py`)**:
    *   Launches a headless Chrome instance with persistent user data (cookies).
    *   Navigates to NotebookLM and acquires session tokens (`at`, `bl`, `fsid`).
    *   **RPC Execution**: Instead of clicking buttons, it reverse-engineered Google's internal RPC (Remote Procedure Call) endpoints (`batchexecute`) to programmatically create notebooks, add sources, and trigger generation.
4.  **Polling**: The client polls the "List Artifacts" RPC until the specific "Infographic" artifact appears.
5.  **Retrieval**: The tool downloads the generated image and returns it directly to Claude.

---

## 🏗️ System Architecture

*   **`server.py`**: The entry point. Uses `FastMCP` to expose two tools:
    *   `generate_infographic(video_url)`: The main driver.
    *   `fetch_infographic(notebook_id)`: Helper to retrieve an image if the initial generation timed out or failed.
*   **`notebooklm_client.py`**: A robust wrapper around Playwright.
    *   Handles Google Authentication (via `user_data` directory).
    *   Manages the complex RPC payload structures required to talk to NotebookLM.
    *   Handles authenticated file downloads.

---

## 🐛 The Debugging Journey & Solutions

Getting the infographic to actually render in Claude was a significant engineering challenge involving three major hurdles.

### 1. The Authentication Wall
*   **Problem**: Initially, we tried descending the image URL using the standard Python `requests` library.
*   **Symptom**: The download would return a 200 OK, but the content was a Google Login HTML page (hidden redirect), not an image.
*   **Reason**: The image URLs (`lh3.googleusercontent.com/...`) require specific session cookies to access. `requests` does not share the browser's authenticated state.
*   **Fix**: We switched to using the **Playwright Browser Context**. This allows us to "borrow" the active session cookies from the headless browser window.

### 2. The CORS Trap
*   **Problem**: We tried to download the image using JavaScript execution inside the page (`page.evaluate(fetch(url))`).
*   **Symptom**: `TypeError: Failed to fetch`.
*   **Reason**: **CORS (Cross-Origin Resource Sharing)**. The script running on `notebooklm.google.com` is not allowed to fetch data from `googleusercontent.com` via XHR/Fetch due to browser security policies.
*   **Fix**: We switched to **Playwright's APIRequestContext** (`context.request.get()`). This interacts with the network layer *outside* the page's sandbox but *inside* the browser's cookie jar. It bypasses CORS completely while maintaining authentication.

### 3. The "Silent Crash" (Payload Size)
*   **Problem**: After fixing the download, the tool would run successfully, but Claude would show a generic "Tool execution failed" or "Disconnected" error.
*   **Symptom**: The server logs showed the image was downloaded and encoded... and then silence.
*   **Reason**: The original images from NotebookLM are massive (approx. **10MB** PNGs). This exceeded the payload size limits for the MCP connection or triggered timeouts in Claude's processing.
*   **Fix**: We implemented an optimization pipeline in `server.py`:
    1.  **Resize**: Any image wider than 1024px is resized (using High-Quality Lanczos resampling).
    2.  **Compress**: The image is converted from PNG to **JPEG** (Quality 85).
    *   **Result**: Payload reduced from ~10MB to **~300KB**.

## 🔐 Authentication Workflow

Since NotebookLM does not have a public API, this tool relies on **browser cookies**.

### What happens if I am not logged in?
1.  **Server Check**: When you make a request, the server launches a **headless** browser.
2.  **Redirect Detection**: If Google redirects to a login page (`accounts.google.com`), the server detects this.
3.  **Error**: Since the server is headless (invisible), it cannot let you type your password. It will fail and return an error:
    > *"Authentication required. Please run with headless=False first to login."*

### How to Authenticate (First Time Setup)
To fix this, we provided a dedicated script: `setup_auth.py`.

1.  Stop the MCP server.
2.  Run the setup script:
    ```bash
    python3 setup_auth.py
    ```
3.  **Manual Login**: A visible Chrome window will open. Log in to your Google Account manually.
4.  **Token Capture**: Once you reach the NotebookLM dashboard, the script captures the session cookies and saves them to the `user_data/` directory.
5.  **Restart**: Close the window and restart the MCP server. The server now has the "key" (cookies) to work headlessly.

## ✅ Final Solution
The robust pipeline is now:
`RPC Trigger` -> `Poll Loop` -> `Playwright API Download (Auth+CORS safe)` -> `Pillow Resize/Compress` -> `Base64 Return`.
