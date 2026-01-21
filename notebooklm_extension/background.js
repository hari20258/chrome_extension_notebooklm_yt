/*
 * Background Service Worker
 * Orchestrates communication between YouTube and NotebookLM content scripts
 */

// Store state locally to map youtube tabs to their worker notebook tabs
let activeJobs = {}; // { youtubeTabId: { notebookTabId: number, videoUrl: string } }

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INIT_GENERATION') {
    handleInitGeneration(sender.tab.id, message.videoUrl);
  } else if (message.type === 'NOTEBOOK_READY') {
    handleNotebookReady(sender.tab.id);
  } else if (message.type === 'GENERATION_UPDATE') {
    handleGenerationUpdate(sender.tab.id, message.status, message.payload);
  }
});

async function handleInitGeneration(youtubeTabId, videoUrl) {
  // 1. Create a new tab for NotebookLM (hidden if possible, but usually needs to be active for some execution, let's keep it inactive but open)
  // Note: 'active: false' opens it in background.
  const notebookTab = await chrome.tabs.create({
    url: 'https://notebooklm.google.com/',
    active: false
  });

  // 2. Store job mapping
  activeJobs[notebookTab.id] = {
    youtubeTabId: youtubeTabId,
    videoUrl: videoUrl,
    status: 'STARTING'
  };

  // 3. Notify YouTube we started
  chrome.tabs.sendMessage(youtubeTabId, {
    type: 'UPDATE_STATUS',
    status: 'Initializing NotebookLM...'
  });
}

function handleNotebookReady(notebookTabId) {
  const job = activeJobs[notebookTabId];
  if (!job) return;

  // Send the START command to the NotebookLM tab
  chrome.tabs.sendMessage(notebookTabId, {
    type: 'START_RPC_FLOW',
    videoUrl: job.videoUrl
  });

  chrome.tabs.sendMessage(job.youtubeTabId, {
    type: 'UPDATE_STATUS',
    status: 'Connected to NotebookLM. Creating Notebook...'
  });
}

function handleGenerationUpdate(notebookTabId, status, payload) {
  const job = activeJobs[notebookTabId];
  if (!job) return;

  // Forward update to YouTube
  chrome.tabs.sendMessage(job.youtubeTabId, {
    type: 'UPDATE_STATUS',
    status: status,
    payload: payload
  });

  if (status === 'COMPLETED' || status === 'ERROR') {
    // Cleanup
    chrome.tabs.remove(notebookTabId);
    delete activeJobs[notebookTabId];
  }
}
