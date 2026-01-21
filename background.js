/*
 * Background Service Worker - PERSISTENT EDITION
 * Uses chrome.storage.local to survive Service Worker restarts.
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

  // 1. Open NotebookLM
  const notebookTab = await chrome.tabs.create({
    url: 'https://notebooklm.google.com/',
    active: false
  });

  // 2. Save Job to Storage (Persistent)
  await saveJob(notebookTab.id, {
    youtubeTabId: youtubeTabId,
    videoUrl: videoUrl,
    status: 'WAITING_FOR_CREATION'
  });

  // 3. Notify YouTube
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
  // Check if we are on the main list page (not inside a specific notebook yet)
  // We allow paths like "/" or "/u/0/" or empty
  const isDashboard = !urlObj.pathname.includes('/notebook/');

  if (job.status === 'WAITING_FOR_CREATION' && isDashboard) {
    console.log("[Background] ✅ Condition met. Sending CREATE command.");

    // Update status to prevent double-firing
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
    // We are inside the new notebook!
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
  // We need to use an async wrapper since getJob is async
  (async () => {
    const job = await getJob(notebookTabId);
    if (!job) return;

    if (status === 'NOTEBOOK_CREATED_ID') {
      const newId = payload.notebookId;
      const newUrl = `https://notebooklm.google.com/notebook/${newId}?addSource=true`;

      console.log(`[Background] Navigating to new notebook: ${newId}`);

      // Update Job State
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

    if (status === 'COMPLETED' || status === 'ERROR') {
      console.log("[Background] Job Finished. Cleaning up.");
      chrome.storage.local.remove(notebookTabId.toString());
    }
  })();
}

// Listeners
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Return true to indicate we might respond asynchronously (standard practice)

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
