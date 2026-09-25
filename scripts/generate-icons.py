#!/usr/bin/env python3
"""Regenerate the application icons from the vector artwork.

assets/icon.svg is the icon. assets/icon-small.svg is the same design drawn
for small sizes (48px and below, and the tray): a larger mark with fewer,
bolder lines, so it stays legible. Both are rendered with rsvg-convert
(librsvg) and the Windows icons are packed with Pillow.

Usage: python3 scripts/generate-icons.py
Requires rsvg-convert on PATH (Debian/Ubuntu: librsvg2-bin, macOS: brew
install librsvg) and Pillow 9.1 or newer.
"""

from __future__ import annotations

import io
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ARTWORK = ROOT / "assets" / "icon.svg"
SMALL_ARTWORK = ROOT / "assets" / "icon-small.svg"
# Sizes up to this one are drawn from the small artwork.
SMALL_MAX = 48
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def rasterize(artwork: Path, size: int) -> Image.Image:
    result = subprocess.run(
        ["rsvg-convert", "--width", str(size), "--height", str(size), "--format", "png", str(artwork)],
        capture_output=True,
        check=True,
    )
    return Image.open(io.BytesIO(result.stdout)).convert("RGBA")


def render(size: int) -> Image.Image:
    return rasterize(SMALL_ARTWORK if size <= SMALL_MAX else ARTWORK, size)


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)} ({image.width}x{image.height})")


def save_ico(path: Path) -> None:
    frames = {size: render(size) for size in ICO_SIZES}
    path.parent.mkdir(parents=True, exist_ok=True)
    largest = ICO_SIZES[-1]
    frames[largest].save(
        path,
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=[frames[s] for s in ICO_SIZES if s != largest],
    )
    print(f"wrote {path.relative_to(ROOT)} ({', '.join(map(str, ICO_SIZES))})")


def main() -> None:
    if shutil.which("rsvg-convert") is None:
        raise SystemExit("rsvg-convert not found; install librsvg (Debian/Ubuntu: librsvg2-bin, macOS: brew install librsvg)")

    # Packaging (electron-builder buildResources).
    save_png(render(1024), ROOT / "build" / "icon.png")
    save_ico(ROOT / "build" / "icon.ico")
    # Runtime: window icon, Windows tray icon and Linux tray icon.
    save_png(render(512), ROOT / "resources" / "icons" / "icon.png")
    save_ico(ROOT / "resources" / "icons" / "icon.ico")
    save_png(rasterize(SMALL_ARTWORK, 64), ROOT / "resources" / "icons" / "tray.png")
    # Shown inside the app.
    save_png(render(256), ROOT / "src" / "renderer" / "src" / "assets" / "icon.png")


if __name__ == "__main__":
    main()
