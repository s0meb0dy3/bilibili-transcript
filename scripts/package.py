"""Build an unpacked-extension ZIP using only Python's standard library."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import json

root = Path(__file__).resolve().parents[1]
source = root / "extension"
manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
output = root / "artifacts" / f"bilibili-transcript-{manifest['version']}.zip"
output.parent.mkdir(exist_ok=True)

files = [
    file for file in sorted(source.rglob("*"))
    if file.is_file()
    and file.suffix in {".js", ".json", ".html", ".css", ".png"}
    and not any(part.startswith(".") for part in file.relative_to(source).parts)
]

with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for file in files:
        archive.write(file, Path("bilibili-transcript") / file.relative_to(source))

with ZipFile(output) as archive:
    assert archive.testzip() is None
    assert "bilibili-transcript/manifest.json" in archive.namelist()

print(f"Packaged {len(files)} extension files: {output.relative_to(root)}")
