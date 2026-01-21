/*
 * Background Service Worker - AUTO CLOSE EDITION
 * 1. Persists job state.
 * 2. Detects Login.
 * 3. CLOSES TAB ON COMPLETION.
 */

// Helper to save job state
async function saveJob(tabId, jobData) {
  await chrome.storage.local.set({ [tabId]: jobData });
  console.log(`[Background] Job saved for Tab ${tabId}:`, jobData);
}

// Helper to get job state
async function getJob(tabId) {
  const data = await chrome.storage.local.get(tabId.toString());
  return data[tabId];
}

async function handleInitGeneration(youtubeTabId, videoUrl) {
  console.log("[Background] Starting new generation flow...");

  const notebookTab = await chrome.tabs.create({
    url: 'https://notebooklm.google.com/',
    active: false
  });

  await saveJob(notebookTab.id, {
    youtubeTabId: youtubeTabId,
    videoUrl: videoUrl,
    status: 'WAITING_FOR_CREATION'
  });

  chrome.tabs.sendMessage(youtubeTabId, {
    type: 'UPDATE_STATUS',
    status: 'Initializing... Opening NotebookLM'
  });
}

async function handleNotebookReady(notebookTabId, senderUrl) {
  console.log(`[Background] Received READY signal from Tab ${notebookTabId}`);

  const job = await getJob(notebookTabId);

  if (!job) {
    console.warn(`[Background] ⚠️ No active job found for Tab ${notebookTabId}. ignoring.`);
    return;
  }

  console.log(`[Background] Current Job Status: ${job.status}`);

  const urlObj = new URL(senderUrl);
  const isDashboard = !urlObj.pathname.includes('/notebook/');

  if (job.status === 'WAITING_FOR_CREATION' && isDashboard) {
    console.log("[Background] ✅ Condition met. Sending CREATE command.");

    job.status = 'CREATING';
    await saveJob(notebookTabId, job);

    chrome.tabs.sendMessage(notebookTabId, {
      type: 'CMD_CREATE_NOTEBOOK'
    });

    chrome.tabs.sendMessage(job.youtubeTabId, {
      type: 'UPDATE_STATUS',
      status: 'Creating specific notebook...'
    });
  }
  else if (senderUrl.includes('/notebook/') && job.status !== 'GENERATING') {
    console.log("[Background] ✅ Inside Notebook. Sending PROCESS command.");

    job.status = 'GENERATING';
    await saveJob(notebookTabId, job);

    chrome.tabs.sendMessage(notebookTabId, {
      type: 'CMD_PROCESS_VIDEO',
      videoUrl: job.videoUrl
    });

    chrome.tabs.sendMessage(job.youtubeTabId, {
      type: 'UPDATE_STATUS',
      status: 'Notebook Ready. Adding Source...'
    });
  }
}

function handleGenerationUpdate(notebookTabId, status, payload) {
  (async () => {
    const job = await getJob(notebookTabId);
    if (!job) return;

    if (status === 'NOTEBOOK_CREATED_ID') {
      const newId = payload.notebookId;
      const newUrl = `https://notebooklm.google.com/notebook/${newId}?addSource=true`;

      console.log(`[Background] Navigating to new notebook: ${newId}`);

      job.status = 'NAVIGATING';
      await saveJob(notebookTabId, job);

      chrome.tabs.update(notebookTabId, { url: newUrl });
      return;
    }

    // Forward to YouTube
    chrome.tabs.sendMessage(job.youtubeTabId, {
      type: 'UPDATE_STATUS',
      status: status,
      payload: payload
    });

    // --- 🔥 FIX 2: AUTO CLOSE TAB ---
    if (status === 'COMPLETED' || status === 'ERROR') {
      console.log("[Background] Job Finished. Closing Tab.");
      chrome.storage.local.remove(notebookTabId.toString());
      
      try {
          chrome.tabs.remove(notebookTabId);
      } catch (e) {
          console.log("Tab already closed.");
      }
    }
  })();
}

// Detect Login Redirects
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const job = await getJob(tabId);
    if (job) {
      if (changeInfo.url.includes('accounts.google.com') || changeInfo.url.includes('ServiceLogin')) {
        console.log(`[Background] Tab ${tabId} redirected to Login Page. Signaling UI.`);
        chrome.tabs.sendMessage(job.youtubeTabId, {
          type: 'UPDATE_STATUS',
          status: 'LOGIN_REQUIRED'
        });
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INIT_GENERATION') {
    handleInitGeneration(sender.tab.id, message.videoUrl);
  }
  else if (message.type === 'NOTEBOOK_READY') {
    handleNotebookReady(sender.tab.id, sender.tab.url);
  }
  else if (message.type === 'GENERATION_UPDATE') {
    handleGenerationUpdate(sender.tab.id, message.status, message.payload);
  }
  return true;
});