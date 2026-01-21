/*
 * YouTube content script - CORNER POPUP EDITION
 * Non-intrusive UI that stays out of the way.
 */

console.log("[NotebookLM] YouTube overlay script loaded");

(function () {
    if (window.hasInjectedNotebookLMOverlay) return;
    window.hasInjectedNotebookLMOverlay = true;

    let overlay = null;
    let generateBtn = null;
    let observer = null;

    const TARGET_SELECTORS = [
        '#top-level-buttons-computed',
        '#owner',
        '#above-the-fold',
        'ytd-watch-metadata'
    ];

    function createButton() {
        if (document.getElementById('notebooklm-gen-btn')) return;
        if (!location.pathname.startsWith('/watch') && !location.href.includes('/watch')) return;

        let container = null;
        for (const selector of TARGET_SELECTORS) {
            const el = document.querySelector(selector);
            if (el && el.isConnected) {
                container = el;
                break;
            }
        }

        if (!container) {
            if (document.readyState === 'complete') injectFloatingButton();
            return;
        }

        generateBtn = document.createElement('button');
        generateBtn.id = 'notebooklm-gen-btn';
        generateBtn.innerText = '✨ Infographic';

        // YouTube Native-ish styling
        Object.assign(generateBtn.style, {
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            color: '#fff',
            border: '1px solid rgba(255, 255, 255, 0.2)',
            padding: '0 16px',
            height: '36px',
            fontSize: '14px',
            fontWeight: '500',
            borderRadius: '18px',
            cursor: 'pointer',
            marginLeft: '8px',
            display: 'flex',
            alignItems: 'center',
            transition: 'background-color 0.2s'
        });

        generateBtn.onmouseover = () => generateBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
        generateBtn.onmouseout = () => generateBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';

        if (container.id === 'top-level-buttons-computed') {
            generateBtn.style.marginLeft = '8px';
            generateBtn.style.marginRight = '8px';
        }

        generateBtn.addEventListener('click', startGeneration);
        container.appendChild(generateBtn);
    }

    function injectFloatingButton() {
        if (document.getElementById('notebooklm-gen-btn')) return;

        generateBtn = document.createElement('button');
        generateBtn.id = 'notebooklm-gen-btn';
        generateBtn.innerText = '✨ Generate';

        Object.assign(generateBtn.style, {
            position: 'fixed',
            bottom: '20px',
            right: '20px',
            zIndex: '9999',
            padding: '10px 20px',
            backgroundColor: '#3ea6ff',
            color: 'white',
            border: 'none',
            borderRadius: '24px',
            fontWeight: 'bold',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
        });

        generateBtn.addEventListener('click', startGeneration);
        document.body.appendChild(generateBtn);
    }

    function startGeneration() {
        const videoUrl = window.location.href;
        try {
            chrome.runtime.sendMessage({ type: 'INIT_GENERATION', videoUrl: videoUrl });
            showOverlay();
            updateOverlay("Initializing...");
        } catch (error) {
            alert("Please refresh the page. Extension updated.");
        }
    }

    function showOverlay() {
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'notebooklm-overlay';

            // --- CORNER POPUP STYLING ---
            Object.assign(overlay.style, {
                position: 'fixed',
                bottom: '24px',
                right: '24px',
                width: '320px',             // Fixed small width
                backgroundColor: '#1f1f1f', // YouTube Dark Grey
                color: 'white',
                zIndex: '10000',
                borderRadius: '12px',
                boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
                border: '1px solid rgba(255,255,255,0.1)',
                fontFamily: 'Roboto, Arial, sans-serif',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                transition: 'opacity 0.3s ease'
            });

            // Header Bar
            overlay.innerHTML = `
                <div style="
                    padding: 12px 16px; 
                    background: rgba(255,255,255,0.05); 
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                ">
                    <span style="font-size: 14px; font-weight: 500; color: #aaa;">NotebookLM Generator</span>
                    <button id="nlm-close" style="background:none; border:none; color:#fff; font-size: 18px; cursor:pointer;">&times;</button>
                </div>
                
                <div id="nlm-content" style="padding: 20px; text-align: center;">
                    <h3 id="nlm-status" style="margin: 0 0 15px 0; font-size: 15px; font-weight: 400;">Initializing...</h3>
                    
                    <div class="nlm-loader" style="
                        border: 3px solid rgba(255,255,255,0.1); 
                        border-top: 3px solid #3ea6ff; 
                        border-radius: 50%; 
                        width: 24px; 
                        height: 24px; 
                        animation: spin 1s linear infinite;
                        margin: 0 auto;
                    "></div>
                    
                    <div id="nlm-preview" style="display:none; margin-top:15px;"></div>
                </div>
                <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
            `;

            document.body.appendChild(overlay);
            document.getElementById('nlm-close').addEventListener('click', () => overlay.style.display = 'none');
        }

        // Reset state on show
        overlay.style.display = 'flex';
        document.querySelector('.nlm-loader').style.display = 'block';
        document.getElementById('nlm-preview').style.display = 'none';
        document.getElementById('nlm-status').innerText = 'Initializing...';
    }

    function updateOverlay(text, payload) {
        if (!overlay) return;
        const statusEl = document.getElementById('nlm-status');
        statusEl.innerText = text;

        if (payload && payload.imageUrl) {
            const loader = document.querySelector('.nlm-loader');
            const preview = document.getElementById('nlm-preview');

            loader.style.display = 'none';
            preview.style.display = 'block';

            // Compact Success View
            preview.innerHTML = `
                <div style="
                    width: 100%; 
                    height: 180px; 
                    background-image: url('${payload.imageUrl}'); 
                    background-size: cover; 
                    background-position: top center;
                    border-radius: 8px;
                    margin-bottom: 12px;
                    border: 1px solid rgba(255,255,255,0.1);
                "></div>
                
                <a href="${payload.imageUrl}" target="_blank" style="
                    display: block;
                    width: 100%;
                    background: #3ea6ff; 
                    color: white; 
                    text-decoration: none; 
                    padding: 8px 0; 
                    border-radius: 18px; 
                    font-weight: 500; 
                    font-size: 13px;
                    text-align: center;
                ">View Full Infographic ↗</a>
            `;

            statusEl.innerText = "Generation Complete!";
            statusEl.style.color = "#4caf50"; // Green for success
        }
    }

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'UPDATE_STATUS') {
            if (message.status === 'COMPLETED') {
                updateOverlay("Generation Complete!", message.payload);
            } else if (message.status === 'ERROR') {
                updateOverlay("Error: " + (message.payload?.error || "Unknown"));
                document.querySelector('.nlm-loader').style.display = 'none';
            } else {
                updateOverlay(message.status);
            }
        }
    });

    function initObserver() {
        observer = new MutationObserver((mutations) => {
            if (location.pathname.startsWith('/watch')) {
                if (!document.getElementById('notebooklm-gen-btn')) createButton();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    initObserver();
    createButton();
    setTimeout(createButton, 3000);

})();