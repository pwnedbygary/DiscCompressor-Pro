#!/usr/bin/env python3
"""Regenerate the application icons from the original artwork.

The source artwork (assets/icon-source.png, 1024x1024) is the icon shown in the
project README and in the app's title bar in the README screenshots. It carries
a light gray frame and an image-generator watermark near its edges, so only the
centred 800x800 region that contains the disc, arrow and box (plus their
shadow) is used. That region is composited onto a clean rounded tile filled
with the artwork's own background colour, with a feathered edge so the seam is
invisible.

Usage: python3 scripts/generate-icons.py [--source PATH]
Requires Pillow 9.1 or newer.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat

ROOT = Path(__file__).resolve().parent.parent

# Region of the 1024x1024 source that contains the artwork but none of the
# frame (outer 41px) or the watermark (bottom-right corner, x/y >= 944).
CROP_BOX = (112, 112, 912, 912)
SOURCE_SIZE = 1024
# The artwork (including its soft shadows) comes no closer than 31 source
# pixels to the crop edges, so a 12px linear feather never touches it.
FEATHER_SOURCE_PX = 12
FRAME_COLOR = (206, 206, 206, 255)
SUPERSAMPLE = 4


def background_color(src: Image.Image) -> tuple[int, int, int, int]:
    r, g, b = ImageStat.Stat(src.crop((100, 100, 900, 250)).convert("RGB")).median
    return r, g, b, 255


def rounded_mask(size: int, box: tuple[int, int, int, int], radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
    return mask


def feathered_mask(size: int, feather: int) -> Image.Image:
    """Square mask that ramps linearly from 0 at the edge to 255 at `feather` px."""
    mask = Image.new("L", (size, size), 255)
    draw = ImageDraw.Draw(mask)
    for step in range(feather):
        draw.rectangle((step, step, size - 1 - step, size - 1 - step), outline=round(255 * step / feather))
    return mask


def render(src: Image.Image, size: int, tile_inset: float, content_scale: float) -> Image.Image:
    """Render one icon.

    tile_inset: margin around the rounded tile, as a fraction of the icon size.
    content_scale: size of the pasted artwork region relative to the source
    canvas; 1.0 reproduces the original proportions.
    """
    big = size * SUPERSAMPLE
    # Keep the tile edge and its border on whole output pixels so they stay crisp.
    inset = round(size * tile_inset) * SUPERSAMPLE
    border = max(1, round(size * 0.012)) * SUPERSAMPLE
    radius = round((big - 2 * inset) * 0.2)
    outer = (inset, inset, big - 1 - inset, big - 1 - inset)
    inner = (inset + border, inset + border, big - 1 - inset - border, big - 1 - inset - border)
    inner_radius = max(0, radius - border)

    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(outer, radius, fill=FRAME_COLOR)
    draw.rounded_rectangle(inner, inner_radius, fill=background_color(src))

    region_px = round(big * (CROP_BOX[2] - CROP_BOX[0]) / SOURCE_SIZE * content_scale)
    region = src.crop(CROP_BOX).resize((region_px, region_px), Image.Resampling.LANCZOS)
    offset = (big - region_px) // 2
    feather = max(2, round(FEATHER_SOURCE_PX * region_px / (CROP_BOX[2] - CROP_BOX[0])))
    # Never paint over the border: limit the paste to the tile's interior.
    interior = rounded_mask(big, inner, inner_radius).crop((offset, offset, offset + region_px, offset + region_px))
    canvas.paste(region, (offset, offset), ImageChops.darker(feathered_mask(region_px, feather), interior))

    return canvas.resize((size, size), Image.Resampling.BOX)


def render_for_size(src: Image.Image, size: int) -> Image.Image:
    # At 48px and below the artwork is enlarged within the tile so it stays legible.
    if size <= 48:
        return render(src, size, tile_inset=0.02, content_scale=1.18)
    return render(src, size, tile_inset=0.03, content_scale=1.0)


def save_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)} ({image.width}x{image.height})")


def save_ico(src: Image.Image, path: Path) -> None:
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = {size: render_for_size(src, size) for size in sizes}
    path.parent.mkdir(parents=True, exist_ok=True)
    frames[256].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=[frames[s] for s in sizes[:-1]])
    print(f"wrote {path.relative_to(ROOT)} ({', '.join(map(str, sizes))})")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", type=Path, default=ROOT / "assets" / "icon-source.png")
    args = parser.parse_args()

    src = Image.open(args.source).convert("RGBA")
    if src.size != (SOURCE_SIZE, SOURCE_SIZE):
        raise SystemExit(f"expected a {SOURCE_SIZE}x{SOURCE_SIZE} source image, got {src.size}")

    # Packaging (electron-builder buildResources).
    save_png(render_for_size(src, 1024), ROOT / "build" / "icon.png")
    save_ico(src, ROOT / "build" / "icon.ico")
    # Runtime: window icon, Windows tray icon and Linux tray icon.
    save_png(render_for_size(src, 512), ROOT / "resources" / "icons" / "icon.png")
    save_ico(src, ROOT / "resources" / "icons" / "icon.ico")
    save_png(render(src, 64, tile_inset=0.02, content_scale=1.18), ROOT / "resources" / "icons" / "tray.png")
    # Shown inside the app.
    save_png(render_for_size(src, 256), ROOT / "src" / "renderer" / "src" / "assets" / "icon.png")


if __name__ == "__main__":
    main()
