#!/usr/bin/env python
"""
PACK BUILDING TEXTURES -- alg-rts's building photo materials (tools/fetchBuildingMaterials.mjs,
games/alg-rts/algMasonry.js), made light enough to ship. Re-runnable; prints what it did.

  * the ROUGHNESS maps go: the materials never load them (a constant roughness per surface) --
    a third of the download for nothing;
  * the COLOUR maps stay 1024 px, JPEG quality 85 (albedo takes lossy compression well);
  * the NORMAL maps go to 512 px, JPEG quality 95 (near-lossless: a normal map's artefacts are wrong
    surface directions, not blur). These photos tile every 1.5-2.5 m; from the RTS camera 512 px
    over 2 m is ~4 mm a texel -- and a quarter of the video memory of 1024.

  python tools/packBuildingTextures.py
"""
import os
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "textures", "build")
before = after = 0
for slug in sorted(os.listdir(ROOT)):
    d = os.path.join(ROOT, slug)
    if not os.path.isdir(d):
        continue
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        size0 = os.path.getsize(p)
        before += size0
        if "_rough_" in name:
            os.remove(p)
            print(f"  {name}: removed ({size0 // 1024} KB)")
            continue
        im = Image.open(p).convert("RGB")
        if "_nor_" in name:
            if im.width > 512:
                im = im.resize((512, 512), Image.LANCZOS)
            im.save(p, "JPEG", quality=95, subsampling=0, optimize=True)
        else:
            im.save(p, "JPEG", quality=85, optimize=True)
        size1 = os.path.getsize(p)
        after += size1
        print(f"  {name}: {size0 // 1024} KB -> {size1 // 1024} KB ({im.width} px)")
print(f"total {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB")
