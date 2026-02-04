import asyncio
import os
import json
import logging
from notebooklm_client import NotebookLMClient

logging.basicConfig(level=logging.INFO)

async def main():
    print("Initializing NotebookLM Client...")
    # headless=False to allow manual login if needed, though client logic should handle existing tokens
    client = NotebookLMClient(headless=False)
    
    try:
        await client.start()
        
        video_url = "https://www.youtube.com/watch?v=Kg2Ux47hwg4"
        print(f"Getting summary for: {video_url}")
        
        summary = await client.get_summary_for_video(video_url)
        
        print("\n=== SUMMARY ===\n")
        print(summary)
        print("\n===============\n")

    except Exception as e:
        print(f"Error: {e}")
    finally:
        # await client.stop()
        pass

if __name__ == "__main__":
    asyncio.run(main())
