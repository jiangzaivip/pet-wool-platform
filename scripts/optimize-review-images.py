#!/usr/bin/env python3
"""Generate WebP variants of the review photos kept in frontend/public/assets.

The originals are 1200x1600 phone photos, about 200KB each, and the storefront
ships 9.5MB of them. Browsers that support WebP download roughly a fifth of
that. The originals are kept on disk so the site still renders if a variant is
missing, and so a re-encode never loses data.

Idempotent: a file whose WebP already exists and is newer than the source is
skipped, so this is safe to run on every deploy.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
REVIEWS_DIR = REPO_ROOT / "frontend" / "public" / "assets" / "reviews"
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".JPG", ".JPEG", ".PNG"}


def encode(source: Path, target: Path, quality: int, max_width: int) -> None:
    # Pillow is used rather than the cwebp binary: it is already a dependency of
    # the check tooling, so the script works on a deploy host that has no
    # libwebp tools installed. Re-encoding drops EXIF, and phone photos carry the
    # customer's home GPS coordinates in there.
    with Image.open(source) as image:
        image = image.convert("RGB")
        if image.width > max_width:
            height = round(image.height * max_width / image.width)
            image = image.resize((max_width, height), Image.LANCZOS)
        image.save(target, "WEBP", quality=quality, method=6)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quality", type=int, default=72)
    parser.add_argument("--max-width", type=int, default=1400)
    parser.add_argument("--force", action="store_true", help="re-encode even if up to date")
    args = parser.parse_args()

    if not REVIEWS_DIR.is_dir():
        print(f"no review assets at {REVIEWS_DIR}")
        return 0

    sources = sorted(p for p in REVIEWS_DIR.rglob("*") if p.suffix in IMAGE_SUFFIXES)
    results = []
    before = 0
    after = 0
    for source in sources:
        target = source.with_suffix(".webp")
        before += source.stat().st_size
        if target.exists() and not args.force and target.stat().st_mtime >= source.stat().st_mtime:
            after += target.stat().st_size
            results.append({"source": str(source.relative_to(REPO_ROOT)), "status": "cached",
                            "webp_bytes": target.stat().st_size})
            continue
        encode(source, target, args.quality, args.max_width)
        after += target.stat().st_size
        results.append({
            "source": str(source.relative_to(REPO_ROOT)),
            "status": "encoded",
            "source_bytes": source.stat().st_size,
            "webp_bytes": target.stat().st_size,
        })

    encoded = sum(1 for r in results if r["status"] == "encoded")
    print(json.dumps({
        "quality": args.quality,
        "max_width": args.max_width,
        "files": len(results),
        "encoded": encoded,
        "cached": len(results) - encoded,
        "source_bytes": before,
        "webp_bytes": after,
        "saved_percent": round((1 - after / before) * 100, 1) if before else 0,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
