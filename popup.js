document.addEventListener('DOMContentLoaded', function () {
    const serverUrlInput = document.getElementById('serverUrl');
    const userTokenInput = document.getElementById('userToken');
    const syncBtn = document.getElementById('syncBtn');
    const statusDiv = document.getElementById('status');

    // Load saved settings
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, function (response) {
        if (response) {
            serverUrlInput.value = response.server_url || 'http://localhost:3001';
            userTokenInput.value = response.user_token || '';
        }
    });

    // Handle sync click
    syncBtn.addEventListener('click', function () {
        const serverUrl = serverUrlInput.value.trim();
        const userToken = userTokenInput.value.trim();

        if (!serverUrl) {
            showStatus('Please enter a Server URL', 'error');
            return;
        }

        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
        showStatus('Connecting...', 'info');

        // Save settings first
        chrome.runtime.sendMessage({ type: 'SET_SERVER_URL', url: serverUrl }, () => {
            chrome.runtime.sendMessage({ type: 'SET_USER_TOKEN', token: userToken }, () => {
                // Trigger sync
                chrome.runtime.sendMessage({ type: 'REFRESH_COOKIES' }, function (response) {
                    syncBtn.disabled = false;
                    syncBtn.textContent = 'Sync Cookies';

                    if (response && response.success) {
                        showStatus(`✅ Success! Synced ${response.count} cookies.`, 'success');
                    } else {
                        showStatus(`❌ Error: ${response?.error || 'Unknown error'}`, 'error');
                    }
                });
            });
        });
    });

    function showStatus(msg, type) {
        statusDiv.textContent = msg;
        statusDiv.className = type;
        statusDiv.style.display = 'block';
    }
});
