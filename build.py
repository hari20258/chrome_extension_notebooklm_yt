import os
import zipfile
import json
from PIL import Image, ImageDraw

def create_icons():
    if not os.path.exists('icons'):
        os.makedirs('icons')
    
    sizes = [16, 48, 128]
    for size in sizes:
        img = Image.new('RGB', (size, size), color = (26, 115, 232))
        d = ImageDraw.Draw(img)
        d.text((size//4, size//4), "N", fill=(255,255,255))
        img.save(f'icons/icon{size}.png')
    print("Generated placeholder icons.")

def zip_extension():
    zip_filename = 'notebooklm_extension.zip'
    with zipfile.ZipFile(zip_filename, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Walk the directory
        for root, dirs, files in os.walk('.'):
            for file in files:
                if file in ['build.py', 'requirements.txt', zip_filename, '.DS_Store']:
                    continue
                if 'venv' in root or '.git' in root or '__pycache__' in root:
                    continue
                
                path = os.path.join(root, file)
                zipf.write(path, path)
    print(f"Extension packed into {zip_filename}")

if __name__ == "__main__":
    print("Building NotebookLM Extension...")
    try:
        create_icons()
        zip_extension()
        print("Build Complete.")
    except Exception as e:
        print(f"Build failed: {e}")
        # If PIL is missing, warn user
        print("Note: Install 'pillow' to generate icons: pip install pillow")
