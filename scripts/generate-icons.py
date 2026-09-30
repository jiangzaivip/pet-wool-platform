#!/usr/bin/env python3
"""Generates the WoolBuddy app icons from code, so they can never drift.

Run from the repo root:
    python3 scripts/generate-icons.py

Outputs (all written to frontend/public/):
    favicon.svg           scalable master, referenced by every <link rel="icon">
    favicon.ico           legacy 16/32/48, served at /favicon.ico
    apple-touch-icon.png  180x180 for iOS home screen
    icon-192.png          PWA manifest 192
    icon-512.png          PWA manifest 512
    icon-maskable-512.png PWA maskable icon (safe-zone padded)

Why generated instead of committed by hand: the site served no favicon at all,
so every page load and every crawler hit logged a 404. A generated master keeps
the PNG sizes honest and makes the brand change one edit here.
"""
from __future__ import annotations

import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "frontend", "public")

# Brand palette lifted from frontend/public/assets/hero-studio.svg
CREAM = (246, 239, 226)
SAGE = (231, 239, 229)
SAND = (216, 201, 176)
FELT_LIGHT = (246, 215, 173)
FELT_MID = (182, 124, 81)
FELT_DARK = (90, 54, 36)
INK = (31, 47, 40)


def _lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def draw_mark(size: int, pad_ratio: float = 0.0, bleed: bool = False) -> Image.Image:
    """Renders the paw mark. `pad_ratio` shrinks the mark for maskable icons."""
    ss = size * 4  # supersample, then downscale for clean edges
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = ss / 2
    # Background: rounded square (or full bleed for maskable).
    if bleed:
        d.rectangle([0, 0, ss, ss], fill=CREAM + (255,))
    else:
        radius = ss * 0.22
        d.rounded_rectangle([0, 0, ss - 1, ss - 1], radius=radius, fill=CREAM + (255,))

    # Soft sage wash in the upper-left, matching the hero gradient.
    d.ellipse([-ss * 0.30, -ss * 0.34, ss * 0.72, ss * 0.44], fill=SAGE + (255,))

    cx, cy = r, ss * 0.60
    scale = (1.0 - pad_ratio * 2)
    mark_r = ss * 0.30 * scale

    # Paw pad: a rounded blob, not a circle, so it reads as felt rather than ink.
    pad_w, pad_h = mark_r * 1.72, mark_r * 1.42
    d.ellipse([cx - pad_w / 2, cy - pad_h / 2, cx + pad_w / 2, cy + pad_h / 2],
              fill=_lerp(FELT_MID, FELT_DARK, 0.25) + (255,))

    # Four toes arcing above the pad.
    toe_r = mark_r * 0.40
    spread = mark_r * 0.86
    lift = mark_r * 0.86
    for i, dx in enumerate((-1.32, -0.44, 0.44, 1.32)):
        jitter = (0.0, -0.10, -0.13, -0.06)[i] * mark_r
        tx = cx + dx * spread / 1.32
        ty = cy - lift + jitter
        # Outer toes sit slightly lighter, as if lit from the upper left.
        shade = 0.10 * abs(dx)
        d.ellipse([tx - toe_r, ty - toe_r, tx + toe_r, ty + toe_r],
                  fill=_lerp(FELT_LIGHT, FELT_MID, 0.30 + shade) + (255,))

    # A single felt fibre highlight for warmth.
    d.arc([cx - mark_r * 0.55, cy - mark_r * 0.60,
           cx + mark_r * 0.20, cy + mark_r * 0.10],
          start=200, end=310, fill=CREAM + (150,), width=int(ss * 0.012))

    if not bleed:
        # Hairline inner border keeps the mark crisp on dark browser tabs.
        d.rounded_rectangle([0, 0, ss - 1, ss - 1], radius=ss * 0.22,
                            outline=_lerp(SAND, INK, 0.15) + (110,),
                            width=max(1, int(ss * 0.006)))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(PUBLIC, exist_ok=True)

    # 32px is the smallest render a browser tab actually shows; below that the
    # four toes turn to mush, so the master SVG carries small sizes instead.
    pngs = {
        "apple-touch-icon.png": draw_mark(180),
        "icon-192.png": draw_mark(192),
        "icon-512.png": draw_mark(512),
        "icon-maskable-512.png": draw_mark(512, pad_ratio=0.14, bleed=True),
    }
    for name, im in pngs.items():
        im.save(os.path.join(PUBLIC, name), optimize=True)
        print(f"wrote {name} ({im.width}x{im.height})")

    ico = draw_mark(64)
    ico.save(os.path.join(PUBLIC, "favicon.ico"),
             sizes=[(16, 16), (32, 32), (48, 48)])
    print("wrote favicon.ico (16/32/48)")

    # SVG master: same geometry, resolution-independent, tiny on the wire.
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="WoolBuddy">
  <defs>
    <linearGradient id="pad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="rgb{_lerp(FELT_MID, FELT_DARK, 0.25)}"/>
      <stop offset="1" stop-color="rgb{FELT_DARK}"/>
    </linearGradient>
    <clipPath id="squircle"><rect width="512" height="512" rx="113" ry="113"/></clipPath>
  </defs>
  <g clip-path="url(#squircle)">
    <rect width="512" height="512" fill="rgb{CREAM}"/>
    <ellipse cx="166" cy="120" rx="230" ry="180" fill="rgb{SAGE}"/>
    <ellipse cx="256" cy="307" rx="83" ry="68" fill="url(#pad)"/>
    <g>
      <circle cx="130" cy="212" r="34" fill="rgb{_lerp(FELT_LIGHT, FELT_MID, 0.41)}"/>
      <circle cx="196" cy="181" r="34" fill="rgb{_lerp(FELT_LIGHT, FELT_MID, 0.35)}"/>
      <circle cx="316" cy="181" r="34" fill="rgb{_lerp(FELT_LIGHT, FELT_MID, 0.35)}"/>
      <circle cx="382" cy="212" r="34" fill="rgb{_lerp(FELT_LIGHT, FELT_MID, 0.41)}"/>
    </g>
    <path d="M212 288a52 52 0 0 0-30 44" fill="none" stroke="rgb{CREAM}" stroke-opacity=".6" stroke-width="7" stroke-linecap="round"/>
    <rect x="1" y="1" width="510" height="510" rx="113" fill="none" stroke="rgb{_lerp(SAND, INK, 0.15)}" stroke-opacity=".43" stroke-width="3"/>
  </g>
</svg>
'''
    with open(os.path.join(PUBLIC, "favicon.svg"), "w", encoding="utf-8") as fh:
        fh.write(svg)
    print("wrote favicon.svg")


if __name__ == "__main__":
    main()