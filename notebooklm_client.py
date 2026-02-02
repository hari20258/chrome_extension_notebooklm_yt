import asyncio
import json
import random
import re
import time
import os
import logging
import base64
from typing import Optional, Dict, Any, List
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

    async def generate_infographic(self, video_url: str) -> str:
        if not self.session_tokens["at"]:
            await self.start()

        # --- CACHE CHECK ---
        cache_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache.json")
        cache = {}
        if os.path.exists(cache_file):
            try:
                with open(cache_file, "r") as f:
                    cache = json.load(f)
            except Exception as e:
                logger.warning(f"Failed to load cache: {e}")

        if video_url in cache:
            notebook_id = cache[video_url]
            logger.info(f"[NotebookLM] ⚡ Cache Hit! Reusing notebook: {notebook_id}")
            # We skip creation and source addition, just poll this notebook.
            return await self.poll_for_artifacts(notebook_id)

        # 1. Create Notebook
        logger.info("[NotebookLM] Creating Notebook...")
        create_payload = ["", None, None, [2], [1, None, None, None, None, None, None, None, None, None, [1]]]
        create_res = await self._execute_rpc(RPC_CREATE_NOTEBOOK, create_payload)
        
        inner_create = json.loads(create_res[0][2])
        notebook_id = inner_create[2]
        logger.info(f"[NotebookLM] Notebook Created: {notebook_id}")
        
        # Save state for recovery & cache
        try:
            # Update Last Run
            state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "last_run.json")
            with open(state_file, "w") as f:
                json.dump({"last_notebook_id": notebook_id, "timestamp": time.time()}, f)
            
            # Update Cache
            cache[video_url] = notebook_id
            with open(cache_file, "w") as f:
                json.dump(cache, f)
                
        except Exception as e:
            logger.warning(f"Failed to save state/cache: {e}")

        # 2. Add Source
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

        # 3. Wait 
        logger.info("[NotebookLM] ⏳ Waiting 10s for transcript processing...")
        await asyncio.sleep(10)

        # 4. Trigger Generation
        logger.info("[NotebookLM] 🚀 Triggering Generation...")
        trigger_payload = [[2], notebook_id, [None, None, 7, [[[source_id]]], None, None, None, None, None, None, None, None, None, None, [[None, None, None, 1, 2]]]]
        await self._execute_rpc(RPC_GENERATE_INFOGRAPHIC, trigger_payload)
        
        # 5. Poll
        return await self.poll_for_artifacts(notebook_id)

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
