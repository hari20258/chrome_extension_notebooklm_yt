# 🕵️‍♂️ Reverse Engineering NotebookLM: The Journey

This project is a Chrome Extension that automates Google's NotebookLM to generate beautiful infographics from YouTube videos.

This document explains how I reverse-engineered the private API behind NotebookLM, deciphered the cryptic RPC protocol, and built a stable automation tool that works even in Incognito mode.

## ⚡ The Challenge

Google does not provide a public API for NotebookLM. To automate the "YouTube-to-Infographic" flow, I had to:
1.  Intercept the traffic between the browser and Google's servers.
2.  Decipher the `batchexecute` protocol (Google's internal RPC mechanism).
3.  Replay those requests programmatically from a Chrome Extension.

## 🛠 Phase 1: The Network Tab Investigation

I started by opening the Chrome DevTools Network Tab (`Cmd+Option+I` -> Network) while performing actions manually in NotebookLM.

### 1. Finding the Endpoint
I filtered for Fetch/XHR requests and noticed that almost every action (creating a notebook, adding a source) hit the same URL:
`https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute`

### 2. Identifying the Actions (RPC IDs)
The payload was a mess of nested arrays, but I noticed a query parameter `rpcids`. By clearing the logs and performing one action at a time, I mapped the IDs:

| Action | RPC ID | Discovery Process |
| :--- | :--- | :--- |
| **Create Notebook** | `CCqFvf` | Clicked "New Notebook" -> Saw request with this ID. |
| **Add Source** | `izAoDd` | Pasted a YouTube URL -> This ID appeared. |
| **Generate Infographic** | `R7cb6c` | Clicked the "Infographic" button -> This ID triggered. |
| **List Artifacts** | `gArtLc` | Watched for polling requests that returned the image URL. |

## 🔓 Phase 2: Cracking Authentication

Simply copying the `fetch` request didn't work because of missing tokens. I analyzed the request headers and body params:

### 1. The `f.req` Envelope
Google wraps the payload in a specific format:
```json
[[["RPC_ID", "[JSON_PAYLOAD]", null, "generic"]]]
```
I realized I had to stringify my payload *twice* to match this envelope.

### 2. The Hidden Tokens (`at` and `bl`)
Every request required two crucial parameters:
*   `at`: The XSRF token.
*   `bl`: The backend version/build label.

I searched the DOM (Elements tab) for these values and found them exposed in a global `window` object:

```javascript
// Found in the HTML source
window.WIZ_global_data = {
  "SNlM0e": "APEu...", // This is the 'at' token!
  "FdrFJe": "..."      // This is the 'f.sid' (session ID)
};
```
I wrote `token_extractor.js` to inject into the page, steal these values from `window`, and pass them to my extension.

## 🧩 Phase 3: Deciphering the Payloads

This was the hardest part. The payloads are "proto-json"—arrays of arrays with no keys.

**Example - Adding a Source:**
I diffed multiple requests to see what changed.

```javascript
// My Reverse Engineered Map:
[
  [
    [null, null, null, null, null, null, null, ["YOUTUBE_URL"], ...], // URL is at index 7
  ],
  "NOTEBOOK_ID", // The notebook ID goes here
  [2]
]
```
I had to write specific parsers to extract the Notebook ID (created in step 1) and the Source ID (returned in step 2) so I could chain them together.

## 🚧 Phase 4: Overcoming Challenges

### Handling "No Transcript" Errors
**Issue:** Google sometimes returns "Success" (HTTP 200) even if it rejects the video (e.g., no captions). This caused the script to poll forever.
**Fix:** I added a strict validation step. After adding a source, I regex-scan the response for a UUID.

```javascript
// If no UUID is found in the response, we know Google rejected it.
if (!uuidRegex.test(responseSourceId)) throw new Error("Video rejected");
```

### The SPA Routing Pitfall (The "Aha!" Moment)
**The Problem:** I could successfully create a notebook via RPC (getting a 200 OK and a valid ID), but when I navigated the browser to that ID, the notebook wouldn't load. The backend knew it existed, but the frontend didn't.
**The Reason:** NotebookLM is a complex Single Page Application (SPA). It maintains an in-memory store. A standard navigation or RPC call doesn't automatically "hydrate" this store.
**The Fix:**
❌ Don't rely solely on URL changes.
✅ Do trigger the internal router manually:

```javascript
window.history.pushState({}, "", `/notebook/${id}?addSource=true`);
window.dispatchEvent(new PopStateEvent("popstate"));
```
This forces the client-side router to wake up, fetch the context (`wXbhsf`), and hydrate the UI state.

### Incognito Mode & Image Cookies
**The Problem:** In Incognito, the generated infographic (hosted on `googleusercontent.com`) appeared broken in the YouTube overlay. This is because Chrome blocks third-party cookies, so the request for the image failed authentication.
**The Fix:** Internal Proxying. Instead of passing the Image URL to the UI, the extension's content script (which runs inside the NotebookLM origin) downloads the image using an authenticated fetch. It converts the blob to a Base64 string and passes the raw data to the YouTube overlay.
*(Note: This implementation is partial/in-progress)*

## ⚡ Final Automated Flow

1.  User Clicks "Infographic" on YouTube.
2.  Background Script spawns an off-screen "Ghost Window" of NotebookLM.
3.  Token Extractor grabs the `at` token.
4.  RPC `CCqFvf` creates a new notebook.
5.  SPA Navigation moves the Ghost Window to the new notebook context.
6.  RPC `izAoDd` adds the YouTube video as a source.
7.  RPC `R7cb6c` triggers generation (with retry logic).
8.  Polling Loop (`gArtLc`) waits for the image.
9.  Download & Convert fetches the image as Base64.
10. Cleanup closes the Window and displays the result on YouTube.

## 🎓 Key Takeaways

*   **Backend Success $\neq$ UI Success:** In modern SPAs, simply hitting the API endpoint is not enough. You must understand how the frontend router and state management system react to those changes.
*   **Internal APIs are Stable:** While undocumented, internal RPCs (like `batchexecute`) are often more stable than DOM structures because the backend relies on them.
