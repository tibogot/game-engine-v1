"""MAKE THE BETOUM LEAF CLUSTERS — the foliage card atlas for the Atlas
pistachio (v3/render/foliage/betoumGeometry.js; you, 2026-10-02: "now it's time
to work on the foliage… the best way to make foliage for a dense tree").

What games do for a dense crown (SpeedTree, UE): textured LEAF CLUSTERS — a
twig carrying tens of leaves on one card — not single leaves, not a smooth
blob. The Atlas pistachio's leaves are COMPOUND: a stalk with 7-11 small
lance-shaped leaflets in pairs. So each cluster here is a short dark twig,
5-7 compound leaves fanning off it, each a stalk with paired leaflets, every
leaflet a real leaf PHOTO (Poly Haven island_tree_01 leaves, CC0), shrunk,
turned and shaded a little differently. Four variants in a 2x2 atlas so
neighbouring cards never repeat.

Out: public/textures/leaves/betoum_clusters.png, 1024², RGBA:
  rgb = a per-leaf SHADE (grey, ~0.55-1.0: the shader multiplies the type's
        leaf colours by it — foliageSystem `shade` cards), alpha = coverage.

   python tools/makeBetoumLeaves.py
"""
import io, math, os, random, urllib.request
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "textures", "leaves", "betoum_clusters.png")
BASE = "https://dl.polyhaven.org/file/ph-assets/Models/jpg/1k/island_tree_01/island_tree_01_leaves_{}_1k.jpg"
SS = 2                      # supersample
CELL = 512 * SS

def fetch(k):
    req = urllib.request.Request(BASE.format(k), headers={"User-Agent": "Mozilla/5.0"})
    return Image.open(io.BytesIO(urllib.request.urlopen(req).read()))

diff = fetch("diff").convert("L")
alpha = fetch("alpha").convert("L")

# Cut the leaf photos out of the atlas: its connected opaque blobs.
a = np.asarray(alpha) > 128
lab = np.zeros(a.shape, np.int32)
leaves = []
from collections import deque
nid = 0
for y in range(0, a.shape[0], 4):
    for x in range(0, a.shape[1], 4):
        if a[y, x] and lab[y, x] == 0:
            nid += 1
            q = deque([(y, x)]); lab[y, x] = nid
            x0 = x1 = x; y0 = y1 = y; n = 0
            while q:
                cy, cx = q.popleft(); n += 1
                x0, x1, y0, y1 = min(x0, cx), max(x1, cx), min(y0, cy), max(y1, cy)
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < a.shape[0] and 0 <= nx < a.shape[1] and a[ny, nx] and lab[ny, nx] == 0:
                        lab[ny, nx] = nid; q.append((ny, nx))
            if n > 3000:
                box = (x0, y0, x1 + 1, y1 + 1)
                leaves.append((diff.crop(box), alpha.crop(box)))
print("leaf photos:", len(leaves))

def leaflet(rng, length):
    """One leaflet: a leaf photo scaled to `length` px (tip up), RGBA shade."""
    g, m = leaves[rng.randrange(len(leaves))]
    w, h = g.size
    k = length / h
    g = g.resize((max(2, int(w * k * 0.8)), max(2, int(h * k))), Image.LANCZOS)
    m = m.resize(g.size, Image.LANCZOS)
    arr = np.asarray(g).astype(np.float32) / 255
    # Per-leaf shade, the photo's veins and blotches kept (mean ~0.55-0.8:
    # normalised to 0.72-1 it clipped to flat white).
    # (The mean over the LEAF only: the crop's dark background pulled it down
    # and every leaf scaled up past white.)
    inside = np.asarray(m) > 128
    mean = arr[inside].mean() if inside.any() else 0.5
    arr = np.clip(arr / max(mean, 1e-3) * (0.55 + rng.random() * 0.25), 0, 1)
    rgb = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8))
    return Image.merge("RGBA", (rgb, rgb, rgb, m))

def paste_rot(dst, img, cx, cy, ang_deg):
    """Paste `img` with its BASE (bottom centre) at (cx, cy), pointing at ang_deg."""
    w, h = img.size
    pad = Image.new("RGBA", (w, h * 2), (0, 0, 0, 0))
    pad.paste(img, (0, 0))                  # base now at the pad's centre
    r = pad.rotate(-ang_deg - 90, resample=Image.BICUBIC, expand=True)
    dst.alpha_composite(r, (int(cx - r.size[0] / 2), int(cy - r.size[1] / 2)))

def cluster(seed):
    rng = random.Random(seed)
    img = Image.new("RGBA", (CELL, CELL), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # The twig: from the bottom centre, up and slightly bent.
    pts = []
    x, y, ang = CELL * 0.5, CELL * 0.98, -90 + (rng.random() - 0.5) * 20
    for i in range(12):
        pts.append((x, y))
        ang += (rng.random() - 0.5) * 10
        x += math.cos(math.radians(ang)) * CELL * 0.055
        y += math.sin(math.radians(ang)) * CELL * 0.055
    d.line(pts, fill=(60, 60, 60, 255), width=int(5 * SS))
    # Compound leaves off the twig, alternate sides, fanning up and out.
    n = 7 + rng.randrange(3)
    for k in range(n):
        t = 0.2 + 0.8 * (k / (n - 1))
        px, py = pts[int(t * (len(pts) - 1))]
        side = 1 if k % 2 else -1
        la = -90 + side * (35 + rng.random() * 30) * (1 - t * 0.5)
        L = CELL * (0.32 + rng.random() * 0.12) * (1 - abs(t - 0.6) * 0.4)
        # The rachis.
        ex = px + math.cos(math.radians(la)) * L
        ey = py + math.sin(math.radians(la)) * L
        d.line([(px, py), (ex, ey)], fill=(70, 70, 70, 255), width=int(2 * SS))
        # Paired leaflets along it, a terminal one at the end.
        pairs = 3 + rng.randrange(3)
        for p in range(pairs):
            f = 0.25 + 0.75 * (p / pairs)
            qx, qy = px + (ex - px) * f, py + (ey - py) * f
            ll = CELL * (0.105 + rng.random() * 0.035) * (1 - f * 0.2)
            for s in (-1, 1):
                paste_rot(img, leaflet(rng, ll), qx, qy, la + s * (55 + rng.random() * 20))
        paste_rot(img, leaflet(rng, CELL * 0.11), ex, ey, la)
    return img

atlas = Image.new("RGBA", (CELL * 2, CELL * 2), (0, 0, 0, 0))
for i in range(4):
    atlas.alpha_composite(cluster(1000 + i * 37), ((i % 2) * CELL, (i // 2) * CELL))
atlas = atlas.resize((1024, 1024), Image.LANCZOS)
# Bleed the shade into transparent texels so mips don't pull dark fringes in.
# (Only INTO the transparent texels: a max filter over the leaves themselves
# flattened them to white.)
A = np.asarray(atlas).astype(np.float32)
alpha_ch = A[..., 3:4] / 255
rgb_pre = A[..., :3] * alpha_ch
box = lambda x: np.asarray(Image.fromarray(np.clip(x, 0, 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(4))).astype(np.float32)
num = np.stack([box(rgb_pre[..., c]) for c in range(3)], -1)
den = box(alpha_ch[..., 0] * 255)[..., None] / 255
bled = np.where(den > 1e-3, num / np.maximum(den, 1e-3), 140)
rgb = np.where(alpha_ch > 0.5, A[..., :3], bled)
out = Image.fromarray(np.concatenate([np.clip(rgb, 0, 255), A[..., 3:4]], -1).astype(np.uint8), "RGBA")
os.makedirs(os.path.dirname(OUT), exist_ok=True)
out.save(OUT, optimize=True)
print("wrote", OUT)
