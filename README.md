# NotebookLM Infographic Generator Extension

This Chrome Extension automates the creation of infographics from YouTube videos using Google's NotebookLM.

## Setup

1. **Install Dependencies** (for the build script):
   ```bash
   python3 -m venv venv
   source venv/bin/activate
   pip install pillow
   ```

2. **Build the Extension**:
   ```bash
   python3 build.py
   ```
   This will generate a `notebooklm_extension.zip` and the `icons/` folder.

3. **Install in Chrome**:
   - Open Chrome and go to `chrome://extensions/`
   - Enable **Developer mode** (top right).
   - Click **Load unpacked**.
   - Select this folder (or unzip the generated zip file).

## Usage

1. **Login**: Ensure you are logged into [NotebookLM](https://notebooklm.google.com/) and [YouTube](https://youtube.com/) in the same Chrome profile.
2. **Navigate**: Go to any YouTube video.
3. **Generate**: Click the **"Generate Infographic"** button (in the video metadata area).
4. **Wait**: An overlay will appear. The extension will automatically:
   - Create a new specific Notebook.
   - Add the video as a source.
   - Trigger infographic generation.
   - Display the result.

## Architecture

- **Manifest V3**: Uses modern service worker architecture.
- **RPC Interception**: `notebook_controller.js` runs in the NotebookLM context to sign requests with the correct XSRF tokens (`at` parameter).
- **Communication**: The background script acts as a bridge between the YouTube content script and the NotebookLM controller.

## Troubleshooting

- **"RPC Failed"**: Check the console logs. Google's internal RPC IDs (`wXbhsf`, etc.) may change over time. If they do, update the constants in `content/notebook_controller.js`.
- **Stuck on "Initializing"**: Ensure you have valid cookies for NotebookLM by opening it once manually.
