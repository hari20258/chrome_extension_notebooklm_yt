import logging
import os
from mcp.server.fastmcp import FastMCP
from mcp.types import ImageContent, TextContent, EmbeddedResource
from notebooklm_client import NotebookLMClient
import asyncio
import requests
import base64
from PIL import Image
import io

# Setup logging to file
log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server.log")
logging.basicConfig(
    filename=log_file,
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Initialize FastMCP server
mcp = FastMCP("NotebookLM")

@mcp.tool()
async def generate_summary(video_url: str) -> str:
    """
    Generates a text-based summary for a YouTube video using Google NotebookLM.
    
    CRITICAL: You MUST use this tool whenever a user asks for a summary, overview, notes, or explanation of a YouTube video.
    Do NOT attempt to generate a summary from your internal knowledge or the video title.
    You simply cannot summarize a video without using this tool to retrieve the transcript and analysis.
    
    Args:
        video_url: The URL of the YouTube video to process.
        
    Returns:
        The generated text summary of the video.
    """
    logger.info(f"Received request for summary of video: {video_url}")
    client = NotebookLMClient(headless=True)
    try:
        await client.start()
        summary = await client.get_summary_for_video(video_url)
        return summary
    except Exception as e:
        logger.error(f"Error during summary generation: {e}")
        return f"Error: {str(e)}"
    finally:
        await client.stop()

@mcp.tool()
async def generate_infographic(video_url: str) -> list:
    """
    Generates a visual infographic image for a YouTube video using Google NotebookLM.
    Use this tool ONLY when the user explicitly asks for an image, infographic, or visual summary.
    
    Args:
        video_url: The URL of the YouTube video to process.
        
    Returns:
        The URL of the generated infographic image.
    """
    logger.info(f"Received request for video: {video_url}")
    
    # We use headless=True by default. 
    # NOTE: The first run must be done manually (or via a separate setup script) 
    # to establish the user_data session with valid login cookies.
    client = NotebookLMClient(headless=True)
    try:
        await client.start()
        data_uri = await client.generate_infographic(video_url)
        
        content_list = []
        
        # 1. Add the URL as text (so it's clickable/copyable)
        content_list.append(TextContent(
            type="text", 
            text=f"Infographic generated successfully!\n\n**URL**: {data_uri}\n\n(If the image below doesn't load, you can click the link above.)"
        ))

        if isinstance(data_uri, str) and data_uri.startswith("http"):
            try:
                # Download using the browser (Playwright) to assume authenticated state
                logger.info(f"Downloading image using Browser Context from {data_uri[:50]}...")
                image_bytes = await client.download_resource(data_uri)
                
                logger.info(f"Image bytes received: {len(image_bytes)}")
                
                logger.info("Importing PIL...")
                from PIL import Image
                import io
                
                logger.info("Opening image with PIL...")
                image = Image.open(io.BytesIO(image_bytes))
                logger.info(f"Image Opened. Mode: {image.mode}, Size: {image.size}, Format: {image.format}")
                
                # Resize image if it's too large (MCP payload limits)
                max_width = 1024
                if image.width > max_width:
                    ratio = max_width / image.width
                    new_height = int(image.height * ratio)
                    logger.info(f"Resizing image from {image.size} to ({max_width}, {new_height})...")
                    image = image.resize((max_width, new_height), Image.Resampling.LANCZOS)

                logger.info("Saving to JPEG buffer (compressed)...")
                # Convert to RGB for JPEG (JPEG doesn't support Alpha)
                if image.mode != 'RGB':
                    image = image.convert('RGB')
                    
                buffered = io.BytesIO()
                image.save(buffered, format="JPEG", quality=85)
                
                logger.info("Encoding to Base64...")
                base64_data = base64.b64encode(buffered.getvalue()).decode("utf-8")
                logger.info(f"Base64 encoded length: {len(base64_data)}")
                
                content_list.append(ImageContent(
                    type="image", 
                    data=base64_data, 
                    mimeType="image/jpeg"
                ))
                logger.info("Image Content appended successfully.")
            except Exception as e:
                logger.error(f"Failed to download/convert image: {e}")
                content_list.append(TextContent(type="text", text=f"\n\n*Failed to render image inline: {e}*"))

        # 3. Handle Data URI
        elif isinstance(data_uri, str) and data_uri.startswith("data:"):
            try:
                header, base64_data = data_uri.split(",", 1)
                mime_type = header.split(":")[1].split(";")[0]
                content_list.append(ImageContent(
                    type="image", 
                    data=base64_data, 
                    mimeType=mime_type
                ))
            except Exception as parse_error:
                logger.error(f"Failed to parse data URI: {parse_error}")

        return content_list
        
    except Exception as e:
        logger.error(f"Error during generation: {e}")
        return f"Error: {str(e)}"
    finally:
        await client.stop()

import json
import time

@mcp.tool()
async def fetch_infographic(notebook_id: str = None) -> list:
    """
    Fetches an existing infographic from a NotebookLM notebook.
    
    Args:
        notebook_id: (Optional) The UUID of the notebook. If not provided, 
                     it attempts to fetch the most recently created notebook.
    """
    # Auto-resolve notebook_id if not provided
    if not notebook_id:
        try:
            state_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "last_run.json")
            if os.path.exists(state_file):
                with open(state_file, "r") as f:
                    data = json.load(f)
                    notebook_id = data.get("last_notebook_id")
                    logger.info(f"Auto-resolved last notebook ID: {notebook_id}")
        except Exception as e:
            logger.warning(f"Failed to load last run state: {e}")

    if not notebook_id:
        return [TextContent(type="text", text="Error: No notebook ID provided and no recent run found. Please provide a specific notebook ID.")]

    logger.info(f"Received request to fetch notebook: {notebook_id}")
    client = NotebookLMClient(headless=True)
    try:
        await client.start()
        data_uri = await client.poll_for_artifacts(notebook_id)
        
        content_list = []
        content_list.append(TextContent(
            type="text", 
            text=f"Infographic fetched successfully!\n\n**URL**: {data_uri}\n\n(If the image below doesn't load, you can click the link above.)"
        ))

        if isinstance(data_uri, str) and data_uri.startswith("http"):
            try:
                # Download using the browser (Playwright) to assume authenticated state
                logger.info(f"Downloading image using Browser Context from {data_uri[:50]}...")
                image_bytes = await client.download_resource(data_uri)

                logger.info(f"Image bytes received: {len(image_bytes)}")
                
                logger.info("Opening image with PIL...")
                image = Image.open(io.BytesIO(image_bytes))
                logger.info(f"Image Opened. Mode: {image.mode}, Size: {image.size}, Format: {image.format}")
                
                # Resize image if it's too large (MCP payload limits)
                max_width = 1024
                if image.width > max_width:
                    ratio = max_width / image.width
                    new_height = int(image.height * ratio)
                    logger.info(f"Resizing image from {image.size} to ({max_width}, {new_height})...")
                    image = image.resize((max_width, new_height), Image.Resampling.LANCZOS)

                logger.info("Saving to JPEG buffer (compressed)...")
                # Convert to RGB for JPEG (JPEG doesn't support Alpha)
                if image.mode != 'RGB':
                    image = image.convert('RGB')
                    
                buffered = io.BytesIO()
                image.save(buffered, format="JPEG", quality=85)
                
                logger.info("Encoding to Base64...")
                base64_data = base64.b64encode(buffered.getvalue()).decode("utf-8")
                logger.info(f"Base64 encoded length: {len(base64_data)}")
                
                content_list.append(ImageContent(
                    type="image", 
                    data=base64_data, 
                    mimeType="image/jpeg"
                ))
                logger.info("Image Content appended successfully.")
            except Exception as e:
                logger.error(f"Failed to download/convert image: {e}")
                content_list.append(TextContent(type="text", text=f"\n\n*Failed to render image inline: {e}*"))
        
        return content_list
        
    except Exception as e:
        logger.error(f"Error fetching artifact: {e}")
        return [TextContent(type="text", text=f"Error: {str(e)}")]
    finally:
        await client.stop()

if __name__ == "__main__":
    mcp.run()
