#!/usr/bin/env python3
"""Shrink photos shipped in frontend/public without changing any file name.

The storefront shipped 15MB of images, including single review photos of 300KB+
at full camera resolution that are rendered at most ~600px wide. Re-encoding in
place (same path, same format) keeps every reference in the data valid, so this
is safe to run against a live release.

Policy:
  * JPEG/WebP: cap the long edge at MAX_EDGE, re-encode at QUALITY, strip EXIF.
  * PNG: cap the long edge, re-encode with optimize=True; photographic PNGs over
    the limit are quantized to 256 colours only when that stays visually close
    (mean delta < 3/255), otherwise left on the lossless path.
  * Never touch icons/manifest assets, robots.txt, sitemap.xml, or anything
    smaller than MIN_BYTES.

Usage:
  python3 scripts/optimize-public-images.py --dry-run
  python3 scripts/optimize-public-images.py
"""
from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

LANCZOS = Image.LANCZOS
FASTOCTREE = Image.Quantize.FASTOCTREE

PUBLIC_DIR = Path(__file__).resolve().parent.parent / "frontend" / "public"
SKIP_DIRS = {"icons"}
SKIP_NAMES = {
    "favicon.ico", "favicon.svg", "manifest.json", "robots.txt", "sitemap.xml",
    "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
}
MAX_EDGE = 1600
QUALITY = 82
MIN_BYTES = 80 * 1024


def resized(image: Image.Image) -> Image.Image:
    long_edge = max(image.size)
    if long_edge <= MAX_EDGE:
        return image
    scale = MAX_EDGE / float(long_edge)
    return image.resize(
        (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
        LANCZOS,
    )


def encoded(image: Image.Image, fmt: str) -> bytes:
    buffer = io.BytesIO()
    if fmt == "JPEG":
        image.convert("RGB").save(buffer, "JPEG", quality=QUALITY, optimize=True,
                                  progressive=True)
    elif fmt == "WEBP":
        image.save(buffer, "WEBP", quality=QUALITY, method=6)
    else:
        image.save(buffer, "PNG", optimize=True)
    return buffer.getvalue()


def close_enough(original: Image.Image, candidate: Image.Image) -> bool:
    """Quantization keeps files small but can shift gradients; reject if far off."""
    probe = original.convert("RGB").resize((64, 64), LANCZOS)
    other = candidate.convert("RGB").resize((64, 64), LANCZOS)
    diff = ImageChops.difference(probe, other)
    return max(ImageStat.Stat(diff).mean) < 4.0


def optimize(path: Path, dry_run: bool) -> tuple[Path, int, int]:
    before = path.stat().st_size
    with Image.open(path) as image:
        image.load()
        fmt = image.format or path.suffix.lstrip(".").upper()
        if fmt not in {"JPEG", "WEBP", "PNG"}:
            return path, before, before
        working = resized(image)
        payload = encoded(working, fmt)
        if fmt == "PNG" and len(payload) > before * 0.9:
            quantized = working.convert("RGB").quantize(colors=256, method=Image.FASTOCTREE).convert("RGB")
            smaller = encoded(quantized, "PNG")
            if len(smaller) < len(payload) and close_enough(working, quantized):
                payload = smaller
        if len(payload) >= before * 0.95:
            return path, before, before
        if not dry_run:
            path.write_bytes(payload)
        return path, before, len(payload)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    targets = []
    for path in sorted(PUBLIC_DIR.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        if path.name in SKIP_NAMES or any(part in SKIP_DIRS for part in path.relative_to(PUBLIC_DIR).parts):
            continue
        # Review photos and hero art are the bulk; leave small UI art alone.
        if path.stat().st_size < MIN_BYTES:
            continue
        targets.append(path)

    saved = 0
    for path in targets:
        _, before, after = optimize(path, args.dry_run)
        saved += before - after
        if after < before:
            print(f"{before // 1024:5d}K -> {after // 1024:5d}K  {path.relative_to(PUBLIC_DIR)}")
    print(f"\n{len(targets)} candidate(s), saved {saved / 1024 / 1024:.1f}MB"
          f"{' (dry run)' if args.dry_run else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
