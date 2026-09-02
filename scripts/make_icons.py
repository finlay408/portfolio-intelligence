"""
Turn one photo into every icon the home-screen install needs.

    python scripts/make_icons.py public/source-icon.jpg

iOS crops nothing for you: hand it a 3:4 photo and it squashes it. This takes a
square crop from the centre (or wherever `--focus` points), resizes to each size
Apple and Android ask for, and writes them into `public/` where Next.js serves
them at the root.

Re-run it whenever you want a different picture. Nothing else needs changing —
the metadata in `src/app/layout.tsx` already points at these filenames.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image

# Apple uses apple-touch-icon at 180; Android/PWA want 192 and 512; 32 is the
# browser tab favicon.
SIZES = {
    "apple-touch-icon.png": 180,
    "icon-192.png": 192,
    "icon-512.png": 512,
    "favicon-32.png": 32,
}


def square_crop(image: Image.Image, focus: str) -> Image.Image:
    """
    Crop to a centred square, biased vertically by `focus`.

    A portrait photo's subject is rarely in the exact middle — on a shot taken
    looking slightly down, `top` keeps the subject and drops the foreground.
    """
    width, height = image.size
    side = min(width, height)

    left = (width - side) // 2
    if height > width:
        top = {
            "top": 0,
            "centre": (height - side) // 2,
            "center": (height - side) // 2,
            "bottom": height - side,
        }[focus]
    else:
        top = (height - side) // 2

    return image.crop((left, top, left + side, top + side))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="the photo to use")
    parser.add_argument(
        "--focus",
        default="centre",
        choices=["top", "centre", "center", "bottom"],
        help="which part of a portrait photo to keep (default: centre)",
    )
    parser.add_argument("--out", default="public")
    args = parser.parse_args()

    source = Path(args.source)
    if not source.exists():
        print(f"error: {source} not found", file=sys.stderr)
        print("\nSave your photo into the project first, for example as", file=sys.stderr)
        print("  public/source-icon.jpg", file=sys.stderr)
        return 1

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    with Image.open(source) as image:
        # Phone photos carry an EXIF rotation flag that PIL ignores unless asked.
        from PIL import ImageOps

        image = ImageOps.exif_transpose(image).convert("RGB")
        print(f"source: {source.name}  {image.width}x{image.height}")

        cropped = square_crop(image, args.focus)
        print(f"cropped to {cropped.width}x{cropped.width} ({args.focus})")

        for filename, size in SIZES.items():
            # LANCZOS is the good downscaler; the default is visibly softer.
            resized = cropped.resize((size, size), Image.LANCZOS)
            target = out / filename
            resized.save(target, "PNG", optimize=True)
            print(f"  wrote {target}  {size}x{size}  ({target.stat().st_size // 1024} KB)")

        # A real .ico for older browsers and Windows pinning.
        ico = out / "favicon.ico"
        cropped.resize((64, 64), Image.LANCZOS).save(
            ico, sizes=[(16, 16), (32, 32), (48, 48), (64, 64)]
        )
        print(f"  wrote {ico}")

    print("\nDone. Commit and push, then re-add the site to your Home Screen.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
