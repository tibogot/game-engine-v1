#!/usr/bin/env python
"""
GAME TEXTURE PACKER — the car game's own textures, compressed once, here.

── WHY A SCRIPT AND NOT A WEB TOOL ──────────────────────────────────────────
A browser converter is a step somebody has to remember. This is re-runnable,
reviewable, and prints what it did, so adding a texture later is one command
rather than a chore that gets skipped.

Python because Pillow is already installed and `sharp` is not — this needs no
new dependency at all.

── WHAT IT DOES, AND WHY EACH PART MATTERS ──────────────────────────────────

  8-BIT, ALWAYS. The diamond plate's normal map ships as 16-bit RGB, which is
  why it is 5.25 MB. The browser decodes 16-bit PNG down to 8 bits before
  three ever sees it, so every one of those extra bits is paid for over the
  network and then thrown away on upload. Forcing 8 bits costs nothing that
  reaches the screen.

  ORM PACKING. Roughness and metalness are single-channel maps shipped as
  three separate greyscale files. Packed into one RGB texture — AO in R,
  roughness in G, metalness in B, the glTF convention — they become one file
  AND one sampler, because three reads `.g` for roughness and `.b` for
  metalness and can be handed the same texture for both. This project already
  runs near WebGPU's 16-sampler ceiling, so bindings are a budget too.

  QUALITY PER ROLE. Albedo tolerates lossy compression; a NORMAL MAP does not.
  Its artefacts are not blur, they are wrong surface directions, and they read
  as shading noise across the whole object. Normals get near-lossless, colour
  gets ordinary lossy, and packed masks sit between.

Usage:  python tools/packTextures.py [--dry]
"""
import os
import sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "textures", "pbr_materials")
# The car game's OWN folder: only what this game ships, already compressed, so
# v3's originals stay untouched until the editor gets its own pass.
OUT = os.path.join(ROOT, "public", "textures", "modular-road")

# role: (quality, lossless)
#
# MEASURED, not assumed. The diamond plate is all hard edges, and lossy WebP
# rings at hard edges — so the error barely responds to bitrate:
#
#   normal  q92 -> 0.26 MB, worst pixel 55/255      orm  q88 -> 0.24 MB, worst 76
#           q97 -> 0.40 MB, worst pixel 50/255           q96 -> 0.39 MB, worst 67
#           lossless -> 1.62 MB, worst 0                 lossless -> 1.14 MB, worst 0
#
# A worst-case of 55/255 on a NORMAL map is not blur, it is a wrong surface
# direction, and on a metal plate the player drives over at close range that
# reads as shimmer. 76/255 on metalness is worse: it is a near-binary mask, so
# ringing shows as speckle. Paying 2.3 MB to make both exact is the right trade
# against a boot that started at 119 MB.
#
# Albedo is different — colour hides its own errors, and q85 measures at a mean
# of 1.5/255. It stays lossy.
#
# When the terrain mode ships this all wants to be KTX2/UASTC instead, which is
# compressed on the GPU as well as on the wire. Not worth the toolchain for one
# material; very much worth it for twenty-eight.
QUALITY = {
    "albedo": (85, False),
    "normal": (100, True),
    "orm":    (100, True),
}

JOBS = [
    {
        "name": "diamond_plate",
        "albedo": "DiamondPlate-1K/DiamondPlate001_1K-PNG_Color.png",
        "normal": "DiamondPlate-1K/DiamondPlate001_1K-PNG_NormalGL.png",
        # AO is absent for this material, so R is left white — the shader does
        # not read it, and a channel that means nothing should look like it.
        "orm": {
            "ao": None,
            "rough": "DiamondPlate-1K/DiamondPlate001_1K-PNG_Roughness.png",
            "metal": "DiamondPlate-1K/DiamondPlate001_1K-PNG_Metalness.png",
        },
    },
]


def mb(path):
    return os.path.getsize(path) / 1048576.0


def open_8bit(rel):
    """Open and force 8 bits per channel. See the note on 16-bit above."""
    im = Image.open(os.path.join(SRC, rel))
    depth = im.mode
    if im.mode in ("I;16", "I;16B", "I", "I;16L"):
        im = im.point(lambda v: v * (255.0 / 65535.0)).convert("L")
    elif im.mode == "RGB;16" or (im.mode == "RGB" and im.getextrema()[0][1] > 255):
        im = im.convert("RGB")
    return im, depth


def to_grey(rel):
    im, depth = open_8bit(rel)
    return im.convert("L"), depth


def main():
    dry = "--dry" in sys.argv
    if not dry:
        os.makedirs(OUT, exist_ok=True)
    before = after = 0.0
    files_before = files_after = 0

    for job in JOBS:
        name = job["name"]
        folder = os.path.join(OUT, name)
        if not dry:
            os.makedirs(folder, exist_ok=True)
        print(f"\n{name}")

        for role in ("albedo", "normal"):
            rel = job[role]
            src = os.path.join(SRC, rel)
            im, depth = open_8bit(rel)
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            # A 16-bit RGB normal opens as RGB already but carries 16-bit data
            # in some encoders; a round-trip through 8-bit bytes settles it.
            if role == "normal":
                im = im.convert("RGB")
            q, lossless = QUALITY[role]
            dst = os.path.join(folder, f"{role}.webp")
            sb = mb(src)
            before += sb
            files_before += 1
            if not dry:
                im.save(dst, "WEBP", quality=q, lossless=lossless, method=6)
                sa = mb(dst)
            else:
                sa = 0
            after += sa
            files_after += 1
            print(f"  {role:7} {depth:>6} {im.size[0]}x{im.size[1]}  "
                  f"{sb:6.2f} MB -> {sa:5.2f} MB")

        # ORM: one file, one sampler, three channels.
        o = job["orm"]
        rough, dr = to_grey(o["rough"])
        metal, dm = to_grey(o["metal"])
        ao = to_grey(o["ao"])[0] if o["ao"] else Image.new("L", rough.size, 255)
        sb = mb(os.path.join(SRC, o["rough"])) + mb(os.path.join(SRC, o["metal"]))
        if o["ao"]:
            sb += mb(os.path.join(SRC, o["ao"]))
        before += sb
        files_before += 3 if o["ao"] else 2
        orm = Image.merge("RGB", (ao, rough, metal))
        q, lossless = QUALITY["orm"]
        dst = os.path.join(folder, "orm.webp")
        sa = 0
        if not dry:
            orm.save(dst, "WEBP", quality=q, lossless=lossless, method=6)
            sa = mb(dst)
        after += sa
        files_after += 1
        print(f"  {'orm':7} {'8-bit':>6} {orm.size[0]}x{orm.size[1]}  "
              f"{sb:6.2f} MB -> {sa:5.2f} MB   (rough {dr}, metal {dm})")

    print(f"\n{files_before} files, {before:.2f} MB  ->  "
          f"{files_after} files, {after:.2f} MB"
          + ("" if before == 0 else f"   ({before / max(after, 1e-9):.1f}x smaller)"))
    if dry:
        print("(dry run — nothing written)")


if __name__ == "__main__":
    main()
