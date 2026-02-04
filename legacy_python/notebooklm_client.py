import asyncio
import json
import random
import re
import time
import os
import logging
import base64
from typing import Optional, Dict, Any, List, Union
from playwright.async_api import async_playwright, Page, BrowserContext

logger = logging.getLogger(__name__)

# --- CONFIGURATION ---
BASE_URL = "https://notebooklm.google.com"
RPC_ENDPOINT = f"{BASE_URL}/_/LabsTailwindUi/data/batchexecute"

# RPC IDs
RPC_CREATE_NOTEBOOK = "CCqFvf"
RPC_ADD_SOURCE = "izAoDd"
RPC_GENERATE_INFOGRAPHIC = "R7cb6c"
RPC_LIST_ARTIFACTS = "gArtLc"
RPC_DELETE_NOTEBOOK = "f61S6e"
RPC_GENERATE_STREAMED = f"{BASE_URL}/_/LabsTailwindUi/data/google.internal.labs.tailwind.orchestration.v1.LabsTailwindOrchestrationService/GenerateFreeFormStreamed"

class NotebookLMClient:
    def __init__(self, headless: bool = True):
        self.headless = headless
        self.browser = None
        self.context = None
        self.page = None
        self.session_tokens = {"at": None, "bl": None, "fsid": None}
        self.cookies = []

    async def start(self):
        """Starts the browser and authenticates."""
        playwright = await async_playwright().start()
        # Use a persistent context to save login state
        base_dir = os.path.dirname(os.path.abspath(__file__))
        user_data_dir = os.path.join(base_dir, "user_data")
        self.context = await playwright.chromium.launch_persistent_context(
            user_data_dir,
            headless=self.headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--ignore-certificate-errors", 
                "--no-sandbox",
                "--disable-setuid-sandbox"
            ]
        )
        self.page = self.context.pages[0] if self.context.pages else await self.context.new_page()
        
        await self._refresh_tokens()

    async def stop(self):
        if self.context:
            await self.context.close()

    async def _refresh_tokens(self) -> bool:
        """Navigates to NotebookLM and scrapes tokens."""
        logger.info("[NotebookLM] 🔄 Navigating to scrape tokens...")
        await self.page.goto(BASE_URL)
        
        # simple check for login
        if "accounts.google.com" in self.page.url:
            logger.warning("[NotebookLM] ⚠️ Login required! Please log in within the opened browser window.")
            # If we are headless, we can't login easily.
            # Ideally, the user should run once headed to login.
            if self.headless:
                 raise Exception("Authentication required. Please run with headless=False first to login.")
            
            # Wait for user to login (wait until we are back on notebooklm)
            await self.page.wait_for_url("https://notebooklm.google.com/**", timeout=0) # wait indefinitely
            logger.info("[NotebookLM] Login detected.")

        content = await self.page.content()
        
        at_match = re.search(r'"SNlM0e":"([^"]+)"', content)
        bl_match = re.search(r'"(boq_labs-tailwind-[^"]+)"', content)
        fsid_match = re.search(r'"FdrFJe":"([^"]+)"', content)

        if not at_match or not bl_match:
            # Fallback: maybe we need to wait a bit more for SPA to load?
            await asyncio.sleep(2)
            content = await self.page.content()
            at_match = re.search(r'"SNlM0e":"([^"]+)"', content)
            bl_match = re.search(r'"(boq_labs-tailwind-[^"]+)"', content)
            fsid_match = re.search(r'"FdrFJe":"([^"]+)"', content)

        if not at_match or not bl_match:
             raise Exception("Could not find session tokens. Are you logged in?")

        self.session_tokens = {
            "at": at_match.group(1),
            "bl": bl_match.group(1),
            "fsid": fsid_match.group(1) if fsid_match else ""
        }
        
        # Get cookies for requests
        self.cookies = await self.context.cookies()
        logger.info(f"[NotebookLM] ✅ Tokens acquired. bl: {self.session_tokens['bl']}")
        return True

    async def _execute_rpc(self, rpc_id: str, payload: Any) -> Any:
        # We can use the page to evaluate fetch, which automatically handles cookies and CORS best.
        # This is more robust than trying to reconstruct the request in python requests/aiohttp
        # because of the specific Google auth/cookies intricacies.
        
        req_id = random.randint(100000, 200000)
        inner_payload = json.dumps(payload)
        envelope = json.dumps([[[rpc_id, inner_payload, None, "generic"]]])
        
        params = {
            "rpcids": rpc_id,
            "source-path": "/",
            "bl": self.session_tokens["bl"],
            "f.sid": self.session_tokens["fsid"],
            "hl": "en",
            "rt": "c",
            "_reqid": str(req_id)
        }
        
        # Construct query string manually to ensure order if needed, but dict is usually fine
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        url = f"{RPC_ENDPOINT}?{query_string}"

        # We need to send form data: f.req and at
        # We'll use page.evaluate to run fetch in the browser context
        
        js_code = """
        async ([url, envelope, at]) => {
            const body = new URLSearchParams();
            body.append("f.req", envelope);
            body.append("at", at);

            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "X-Same-Domain": "1"
                },
                body: body,
            });
            
            if (!response.ok) throw new Error("RPC Failed: " + response.status);
            return await response.text();
        }
        """
        
        try:
            response_text = await self.page.evaluate(js_code, [url, envelope, self.session_tokens["at"]])
            return self._parse_rpc_response(response_text)
        except Exception as e:
            logger.error(f"[NotebookLM] RPC {rpc_id} failed: {e}")
            raise

    def _parse_rpc_response(self, text: str):
        lines = text.split('\n')
        for line in lines:
            trimmed = line.strip()
            if trimmed.startswith('[['):
                try:
                    data = json.loads(trimmed)
                    if data and data[0] and data[0][0] == 'wrb.fr':
                        return data
                except:
                    pass
        return None

    async def _execute_streamed_rpc(self, f_req_payload: Any) -> bytes:
        """
        Executes the specialized GenerateFreeFormStreamed RPC.
        Returns the raw response bytes from the server.
        Uses APIRequestContext to ensure we get raw bytes (critical for length-prefixed parsing).
        """
        req_id = random.randint(100000, 200000)
        
        # We will assume f_req_payload passed here is the Python list/object 
        # and we json.dump it to string before sending.
        
        f_req_str = json.dumps(f_req_payload, separators=(',', ':'))
        # logger.info(f"[NotebookLM] Streamed RPC Payload (Python-side): {f_req_str}")
        
        params = {
            "bl": self.session_tokens["bl"],
            "f.sid": self.session_tokens["fsid"],
            "hl": "en",
            "_reqid": str(req_id),
            "rt": "c"
        }
        
        query_string = "&".join([f"{k}={v}" for k, v in params.items()])
        url = f"{RPC_GENERATE_STREAMED}?{query_string}"
        
        logger.info(f"[NotebookLM] Executing Streamed RPC to {url}")
        
        # Use Playwright's APIRequest context to fetch raw bytes
        # providing cookies from the browser context automatically.
        response = await self.page.context.request.post(
            url,
            form={
                "f.req": f_req_str,
                "at": self.session_tokens["at"]
            },
            headers={
                "X-Same-Domain": "1"
            },
            timeout=120000 # 2 minutes timeout for slow notebooklm generation
        )
            
        if not response.ok:
            raise Exception(f"Streamed RPC Failed: {response.status} {response.status_text}")
            
        return await response.body()

    def _parse_streamed_response(self, entry_buffer: bytes) -> str:
        """
        Parses the chunked streaming response using a robust 'JSON Miner' strategy.
        Instead of relying on fragile length prefixes (which can be misaligned due to 
        multibyte character counts or protocol quirks), this scans the buffer 
        for JSON arrays starting with '['.
        """
        full_text = ""
        
        # Decode the entire buffer, replacing errors to avoid crashes
        text_body = entry_buffer.decode('utf-8', errors='replace')
        
        # Remove XSSI guard if present
        if text_body.startswith(")]}'"):
            text_body = text_body[4:].strip()
            
        decoder = json.JSONDecoder()
        pos = 0
        n = len(text_body)
        
        while pos < n:
            # Skip whitespace
            while pos < n and text_body[pos] in ' \n\r\t':
                pos += 1
            if pos >= n:
                break
                
            # We expect NotebookLM payloads to be Arrays (list) -> start with '['
            if text_body[pos] != '[':
                # If not starting with '[', scan forward to find one
                next_bracket = text_body.find('[', pos)
                if next_bracket == -1:
                    break # No more arrays
                pos = next_bracket
            
            try:
                obj, end_pos = decoder.raw_decode(text_body, pos)
                
                # Successfully parsed a JSON object
                extracted = self._extract_wrb_text(obj)
                if extracted:
                     # CHANGE: Instead of appending (which captures intermediate "thought" updates),
                     # we OVERWRITE 'full_text'. The stream works by sending refining updates.
                     # The FINAL chunk will contain the full, final answer.
                     full_text = extracted.strip() + "\n"
              
                # Advance to the end of this object
                pos = end_pos
                
            except json.JSONDecodeError:
                # If parsing failed (e.g. incomplete, or false positive '['), 
                # skip this bracket and search for next
                pos += 1
                
        return full_text.strip()

    def _extract_wrb_text(self, node) -> str:
        """
        Recursively extracts text from 'wrb.fr' nodes, STRONGLY filtering for the Final Answer payload.
        Strategy:
        - Parses inner JSON strings.
        - Checks for RPC complexity (Structure: [Text, Citations, ...]).
        - Only extracts text if the payload structure matches the Final Answer profile.
        """
        results = []
        
        def walk(n, in_payload=False):
            if isinstance(n, list):
                # Check if it's a wrb.fr node: ["wrb.fr", null, "JSON"]
                if len(n) >= 3 and isinstance(n[0], str) and n[0] == "wrb.fr" and isinstance(n[2], str):
                    try:
                        # The payload is in index 2 (usually)
                        inner_json = n[2]
                        if inner_json.strip().startswith("["):
                            decoded = json.loads(inner_json)
                            # RPC Structure Check:
                            # Final Answer has citations/metadata, meaning length > 2
                            if isinstance(decoded, list) and len(decoded) > 2:
                                # Target Index 0 (Main Answer Block)
                                walk(decoded[0], in_payload=True)
                    except:
                        pass
                        
                elif in_payload:
                     # Anti-Transcript Heuristic:
                     # Source chunks look like [StartMs, EndMs, ["Text"]] -> [int, int, list]
                     # We MUST skip these to avoid leaking raw transcript into the summary.
                     if len(n) >= 2 and isinstance(n[0], int) and isinstance(n[1], int):
                         return # Skip source chunk
                     
                     if len(n) >= 3 and n[0] is None and isinstance(n[1], int) and isinstance(n[2], int):
                         return # Skip source chunk wrapper [null, start, end]

                     for c in n:
                         walk(c, in_payload)
                else:
                    for c in n:
                        walk(c, in_payload)
            
            elif isinstance(n, str) and in_payload:
                val = n.strip()
                # Filtering heuristic:
                # 1. Ignore UUIDs (Length 36).
                # 2. Ignore raw transcripts: Text segments in the summary are usually short paragraphs.
                #    If we see a massive block of text, it might be the source chunk leaking in.
                
                if val and len(val) != 36:
                     results.append(val)

        walk(node)
        return "\n".join(results)


    async def download_resource(self, url: str) -> bytes:
        """Downloads a resource (image) using the authenticated browser context."""
        logger.info(f"[NotebookLM] Downloading resource via Playwright API: {url[:50]}...")
        
        # Use Playwright's APIRequest context. 
        # This shares cookies with the browser but runs outside the page sandbox, avoiding CORS.
        if not self.context:
             await self.start()
             
        try:
            # We explicitly pass the referer to look legitimate
            response = await self.context.request.get(
                url, 
                headers={"Referer": "https://notebooklm.google.com/"}
            )
            
            if not response.ok:
                logger.error(f"[NotebookLM] Download failed: {response.status} {response.status_text}")
                # Try to log the body if it fails, might be a redirect or auth page
                try:
                    text = await response.text()
                    logger.error(f"Error Body: {text[:200]}")
                except:
                    pass
                raise Exception(f"Failed to download image: {response.status}")
                
            return await response.body()
            
        except Exception as e:
            logger.error(f"[NotebookLM] Browser download failed: {e}")
            raise

    def _find_source_id(self, obj: Any) -> Optional[str]:
        # UUID regex pattern
        uuid_pattern = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.IGNORECASE)
        
        if isinstance(obj, str):
            if uuid_pattern.match(obj):
                return obj
        
        if isinstance(obj, list):
            for item in obj:
                found = self._find_source_id(item)
                if found: return found
        return None

    def _find_image_url(self, obj: Any) -> Optional[str]:
        if isinstance(obj, str):
            if 'googleusercontent.com' in obj or obj.startswith('data:image/'):
                return obj
        
        if isinstance(obj, list):
            for item in obj:
                found = self._find_image_url(item)
                if found: return found
        return None

    async def prepare_notebook(self, video_url: str) -> tuple[str, str]:
        """
        Ensures a notebook exists for the given video URL.
        Checks cache first. If missing, creates notebook and adds source.
        Returns (notebook_id, source_id).
        """
        if not self.session_tokens["at"]:
            await self.start()

        base_dir = os.path.dirname(os.path.abspath(__file__))
        cache_file = os.path.join(base_dir, "cache.json")
        cache = {}
        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r") as f:
                    cache = json.load(f)
            except Exception as e:
                logger.warning(f"Failed to load cache: {e}")

        notebook_id = None
        source_id = None
        
        # New Cache Logic: Check if we have both notebook_id AND source_id
        if video_url in cache:
            entry = cache[video_url]
            if isinstance(entry, dict):
                notebook_id = entry.get("notebook_id")
                source_id = entry.get("source_id")
            else:
                # Legacy cache (just string ID)
                notebook_id = entry
            
            if notebook_id:
                logger.info(f"[NotebookLM] ⚡ Cache Hit! Reusing notebook: {notebook_id}")
        
        if not notebook_id:
            # 1. Create Notebook
            logger.info("[NotebookLM] Creating Notebook...")
            create_payload = ["", None, None, [2], [1, None, None, None, None, None, None, None, None, None, [1]]]
            create_res = await self._execute_rpc(RPC_CREATE_NOTEBOOK, create_payload)
            
            inner_create = json.loads(create_res[0][2])
            notebook_id = inner_create[2]
            logger.info(f"[NotebookLM] Notebook Created: {notebook_id}")
            
            # Save state for recovery & cache (partial)
            try:
                state_file = os.path.join(base_dir, "last_run.json")
                with open(state_file, "w") as f:
                    json.dump({"last_notebook_id": notebook_id, "timestamp": time.time()}, f)
            except Exception as e:
                logger.warning(f"Failed to save last_run: {e}")

        # 2. Add Source (ONLY if we don't have a source_id yet)
        if not source_id:
            logger.info(f"[NotebookLM] Adding Source: {video_url}...")
            source_payload = [[[None, None, None, None, None, None, None, [video_url], None, None, 1]], notebook_id, [2], [1, None, None, None, None, None, None, None, None, None, [1]]]
            source_res = await self._execute_rpc(RPC_ADD_SOURCE, source_payload)
            
            if not source_res or not source_res[0] or len(source_res[0]) < 3:
                logger.error(f"[NotebookLM] Invalid Add Source Response: {source_res}")
                raise Exception("Failed to add source: Invalid RPC response")

            raw_inner = source_res[0][2]
            if raw_inner is None:
                 logger.error(f"[NotebookLM] Add Source Inner Payload is None. Full Res: {source_res}")
                 raise Exception("Failed to add source: Google returned no data (Video might be rejected)")

            inner_source = json.loads(raw_inner)
            source_id = self._find_source_id(inner_source)
            
            if not source_id:
                raise Exception("Failed to add source. Google rejected the video (No transcript?).")
            
            logger.info(f"[NotebookLM] Source Added: {source_id}")
            
            # Update Cache with both IDs
            cache[video_url] = {"notebook_id": notebook_id, "source_id": source_id}
            try:
                with open(cache_file, "w") as f:
                    json.dump(cache, f)
            except Exception as e:
                logger.warning(f"Failed to save cache: {e}")
        else:
             logger.info(f"[NotebookLM] ⚡ Using Cached Source ID: {source_id}")

        return notebook_id, source_id

    async def generate_infographic(self, video_url: str) -> str:
        """
        Generating an infographic involves:
        1. Creating a new notebook (or reusing one).
        2. Adding the YouTube video source.
        3. Polling for the automatically generated 'summary' (infographic).
        """
        notebook_id, source_id = await self.prepare_notebook(video_url)

        # 3. Wait (Just in case, mostly for new sources)
        # We can optimize this to only wait if it was a new notebook, but safe to wait a bit.
        logger.info("[NotebookLM] ⏳ Waiting 5s for transcript processing...")
        await asyncio.sleep(5)

        # 4. Trigger Generation
        logger.info("[NotebookLM] 🚀 Triggering Infographic Generation...")
        trigger_payload = [[2], notebook_id, [None, None, 7, [[[source_id]]], None, None, None, None, None, None, None, None, None, None, [[None, None, None, 1, 2]]]]
        await self._execute_rpc(RPC_GENERATE_INFOGRAPHIC, trigger_payload)
        
        # 5. Poll
        return await self.poll_for_artifacts(notebook_id)
        
    async def get_summary_for_video(self, video_url: str) -> str:
        """
        High-level method: Checks cache, ensures notebook exists, and generates summary.
        """
        notebook_id, source_id = await self.prepare_notebook(video_url)
        
        # Wait a bit if it was just added? prepare_notebook handles logic.
        # But if we just created/added it, we might need a wait.
        # If cached, we might be fine immediately.
        # For safety, let's wait 5s always, or longer if new.
        # Simple heuristic:
        logger.info("[NotebookLM] ⏳ Waiting 30s before requesting summary (indexing)...")
        await asyncio.sleep(30)
        
        return await self.generate_summary(notebook_id, source_id)

    async def poll_for_artifacts(self, notebook_id: str) -> str:
        logger.info("[NotebookLM] Polling for artifacts...")
        for i in range(30):
            try:
                payload = [[2], notebook_id, 'NOT artifact.status = "ARTIFACT_STATUS_SUGGESTED"']
                response = await self._execute_rpc(RPC_LIST_ARTIFACTS, payload)
                
                if response and response[0] and isinstance(response[0][2], str):
                    inner_data = json.loads(response[0][2])
                    image_url = self._find_image_url(inner_data)
                    
                    if image_url:
                        logger.info(f"[NotebookLM] 📸 Image Found: {image_url}")
                        return image_url
            except Exception as e:
                logger.warning(f"[NotebookLM] Poll error: {e}")
            
            await asyncio.sleep(10)
            logger.info(f"[NotebookLM] Poll attempt {i+1}/30...")
            
        raise Exception("Timeout waiting for artifact generation")

    async def generate_summary(self, notebook_id: str, source_id: str, prompt: str = "give me summary of the video") -> str:
        """
        Generates a summary for the given source (video) in the notebook.
        This uses the streamed endpoint but waits for the full text.
        """
        if not self.session_tokens["at"]:
            await self.start()
            
        logger.info(f"[NotebookLM] Generating summary for notebook {notebook_id}...")
        
        import uuid
        req_id = str(uuid.uuid4())

        # Inner payload structure (List)
        inner_req = [
            [[[source_id]]], # 3 brackets
            prompt,
            None,
            [2, None, [1], [1]], # Configs: Streaming enabled?
            None,            # Index 4: None for new conversation?
            None,
            None,
            notebook_id,     # Index 7: NOTEBOOK ID
            1
        ]
        
        # Outer payload: [null, "STRINGIFIED_INNER_REQ"]
        # Reverting user suggestion: Trying NO wrapper as Step 252 (200 OK) used.
        f_req = [
            None,
            json.dumps(inner_req, separators=(',', ':'))
        ]
        
        # DEBUG
        f_req_str = json.dumps(f_req, separators=(',', ':'))
        # logger.info(f"DEBUG PAYLOAD: {f_req_str}")
        
        # Execute RPC and get raw text
        raw_response = await self._execute_streamed_rpc(f_req)
        # logger.info(f"Raw Response: {raw_response}")
        
        # Parse text
        summary = self._parse_streamed_response(raw_response)
        
        if not summary:
            logger.warning("[NotebookLM] Summary generation returned empty text.")
            return "Failed to generate summary."
            
        logger.info("[NotebookLM] Summary generated successfully.")
        return summary

# Example Usage
if __name__ == "__main__":
    async def main():
        # Set headless=False to login manually once
        client = NotebookLMClient(headless=False)
        try:
            await client.start()
            # Replace with a real video URL to test
            # img = await client.generate_infographic("https://www.youtube.com/watch?v=YOUR_VIDEO_ID")
            # print("Final Image:", img)
        finally:
            # await client.stop() # Keep open to see result if testing
            pass
            
    # asyncio.run(main())
