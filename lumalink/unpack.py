import os
for filepath, content in files.items():
    os.makedirs(os.path.dirname(filepath) or ".", exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content.strip() + "\n")
print("Extracted:", list(files.keys()))
