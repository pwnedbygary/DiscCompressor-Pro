#!/usr/bin/env python3
"""Regenerate the application icons from the vector artwork.

assets/icon.svg is the icon. assets/icon-small.svg is the same design drawn
for 48px and below and the tray, with a larger mark and fewer, bolder lines,
and assets/icon-16.svg draws it on the 16px pixel grid. They are rendered
with rsvg-convert (librsvg) and the Windows icons are packed with Pillow.

Usage: python3 scripts/generate-icons.py
Requires rsvg-convert on PATH (Debian/Ubuntu: librsvg2-bin, macOS: brew
install librsvg, Windows: MSYS2's mingw-w64-ucrt-x86_64-librsvg) and
Pillow 8.1 or newer.
"""

from __future__ import annotations

import io
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512]


def artwork(size: int) -> Path:
    if size <= 16:
        return ASSETS / "icon-16.svg"
    return ASSETS / ("icon-small.svg" if size <= 48 else "icon.svg")


def rasterize(svg: Path, size: int) -> Image.Image:
    # rsvg-convert's own error messages go to the terminal.
    result = subprocess.run(
        ["rsvg-convert", "--width", str(size), "--height", str(size), "--format", "png", str(svg)],
        stdout=subprocess.PIPE,
        check=True,
    )
    return Image.open(io.BytesIO(result.stdout)).convert("RGBA")


def render(size: int) -> Image.Image:
    return rasterize(artwork(size), size)


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
        raise SystemExit("rsvg-convert not found; install librsvg (see the top of this script)")

    # Packaging: the README and Windows icons, and the Linux icon set (electron-builder's linux.icon).
    save_png(render(1024), ROOT / "build" / "icon.png")
    save_ico(ROOT / "build" / "icon.ico")
    for size in LINUX_SIZES:
        save_png(render(size), ROOT / "build" / "icons" / f"{size}x{size}.png")
    # Runtime: window icon, Windows tray icon and Linux tray icon.
    save_png(render(512), ROOT / "resources" / "icons" / "icon.png")
    save_ico(ROOT / "resources" / "icons" / "icon.ico")
    save_png(rasterize(ASSETS / "icon-small.svg", 64), ROOT / "resources" / "icons" / "tray.png")
    # Shown inside the app: on the empty queue (96 CSS px) and in the header (32 CSS px).
    save_png(render(256), ROOT / "src" / "renderer" / "src" / "assets" / "icon.png")
    save_png(rasterize(ASSETS / "icon-small.svg", 64), ROOT / "src" / "renderer" / "src" / "assets" / "icon-small.png")


if __name__ == "__main__":
    main()
