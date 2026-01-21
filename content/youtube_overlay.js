/*
 * YouTube content script
 * Injects UI overlay and handles user interaction
 */

console.log("[NotebookLM] YouTube overlay script loaded");

(function () {
    // Prevent multiple injections
    if (window.hasInjectedNotebookLMOverlay) return;
    window.hasInjectedNotebookLMOverlay = true;

    let overlay = null;
    let generateBtn = null;
    let observer = null;

    // Selectors to try, in order of preference
    const TARGET_SELECTORS = [
        '#top-level-buttons-computed', // The action bar (Like, Share, etc.)
        '#owner',                      // Near channel name/subscribe button
        '#above-the-fold',             // General top metadata area
        'ytd-watch-metadata'           // Fallback metadata container
    ];

    function createButton() {
        // If button exists, ensure it's attached; if attached, do nothing
        if (document.getElementById('notebooklm-gen-btn')) return;

        // Only inject on Watch pages
        if (!location.pathname.startsWith('/watch') && !location.href.includes('/watch')) return;

        // Try finding a valid container
        let container = null;
        for (const selector of TARGET_SELECTORS) {
            const el = document.querySelector(selector);
            // Ensure the element is actually visible and part of document
            if (el && el.isConnected) {
                container = el;
                // console.log(`NotebookLM: Found container ${selector}`);
                break;
            }
        }

        if (!container) {
            // If we are on a watch page but can't find a container, use fallback
            // But give the page a moment to load if it's fresh
            if (document.readyState === 'complete') {
                injectFloatingButton();
            }
            return;
        }

        generateBtn = document.createElement('button');
        generateBtn.id = 'notebooklm-gen-btn';
        generateBtn.innerText = 'Generate Infographic';
        generateBtn.className = 'notebooklm-style-btn';

        // Adjust style based on container
        if (container.id === 'top-level-buttons-computed') {
            // Make it look more like a chip if in the action bar
            generateBtn.style.height = '36px';
            generateBtn.style.borderRadius = '18px';
            generateBtn.style.marginLeft = '8px';
            generateBtn.style.marginRight = '8px';
        }

        generateBtn.addEventListener('click', startGeneration);
        container.appendChild(generateBtn);
        console.log("[NotebookLM] Button injected into container");
    }

    function injectFloatingButton() {
        if (document.getElementById('notebooklm-gen-btn')) return;

        console.log("[NotebookLM] Fallback to floating button");
        generateBtn = document.createElement('button');
        generateBtn.id = 'notebooklm-gen-btn';
        generateBtn.innerText = 'Generate Infographic';
        generateBtn.className = 'notebooklm-style-btn-floating'; // Class defined in styles.css

        // Fallback inline styles in case CSS fails to load or match
        generateBtn.style.position = 'fixed';
        generateBtn.style.bottom = '20px';
        generateBtn.style.right = '20px';
        generateBtn.style.zIndex = '9999';

        generateBtn.addEventListener('click', startGeneration);
        document.body.appendChild(generateBtn);
    }

    function startGeneration() {
        const videoUrl = window.location.href;
        console.log("[NotebookLM] Starting generation for", videoUrl);

        try {
            chrome.runtime.sendMessage({
                type: 'INIT_GENERATION',
                videoUrl: videoUrl
            });

            showOverlay();
            updateOverlay("Initializing...");
        } catch (error) {
            console.error("[NotebookLM] Message error:", error);
            if (error.message.includes("Extension context invalidated")) {
                alert("Please refresh this YouTube page.\n\nThe extension has been updated, so the current page script is stale.");
            } else {
                alert("Error initializing extension: " + error.message);
            }
        }
    }

    function showOverlay() {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'notebooklm-overlay';
            overlay.innerHTML = `
        <div class="notebooklm-overlay-content">
          <h3 id="nlm-status">Initializing...</h3>
          <div class="nlm-loader"></div>
          <div id="nlm-preview"></div>
          <button id="nlm-close">X</button>
        </div>
      `;
            document.body.appendChild(overlay);

            document.getElementById('nlm-close').addEventListener('click', () => {
                overlay.style.display = 'none';
            });
        }
        overlay.style.display = 'flex';
    }

    function updateOverlay(text, payload) {
        if (!overlay) return;
        const statusEl = document.getElementById('nlm-status');
        statusEl.innerText = text;

        if (payload && payload.imageUrl) {
            const preview = document.getElementById('nlm-preview');
            preview.innerHTML = `<img src="${payload.imageUrl}" alt="Infographic" style="max-width: 100%; max-height: 80vh;">`;
            document.querySelector('.nlm-loader').style.display = 'none';
        }
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'UPDATE_STATUS') {
            if (message.status === 'COMPLETED') {
                updateOverlay("Generation Complete!", message.payload);
            } else if (message.status === 'ERROR') {
                updateOverlay("Error: " + message.payload?.error || "Unknown Error");
            } else {
                updateOverlay(message.status);
            }
        }
    });

    // Handle SPA (Single Page Application) Navigation
    function initObserver() {
        // Watch for body changes. 
        // YouTube replaces large chunks of DOM on navigation.
        observer = new MutationObserver((mutations) => {
            // Debounce or check efficiently
            // We only care if the button is missing and we are on a watch page
            if (location.pathname.startsWith('/watch')) {
                if (!document.getElementById('notebooklm-gen-btn')) {
                    createButton();
                }
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    // Initial Run
    initObserver();
    // Try immediately
    createButton();
    // Retry once after a few seconds to catch slow loads
    setTimeout(createButton, 3000);

})();
