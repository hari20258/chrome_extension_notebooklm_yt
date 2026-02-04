import asyncio
from notebooklm_client import NotebookLMClient

async def main():
    print("Starting browser for authentication...")
    print("Please log in to your Google account in the browser window that opens.")
    print("Once you are logged in and see the NotebookLM dashboard, close the browser.")
    
    # headless=False to allow user interaction
    client = NotebookLMClient(headless=False)
    try:
        await client.start()
        print("✅ Authentication successful! Tokens acquired.")
        print("You can now close the browser (if it's not already closed) and run the MCP server.")
        
        # Keep it open for a bit to let them see
        await asyncio.sleep(5)
        
    except Exception as e:
        print(f"❌ Error during setup: {e}")
    finally:
        await client.stop()

if __name__ == "__main__":
    asyncio.run(main())
