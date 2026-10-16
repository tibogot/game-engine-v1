"""THE STYLIZED LAB'S TERRAIN CLIFF TEXTURE (2026-10-09, you: "the mountain slope
shouldn't use that flat grey, it should use the same texture as the rock cliff —
that's how they blend"; then: "the far mountains are tiling, that repeat reads
really bad").

The cliff blocks (games/stylized-lab/stylizedRockMaterial.js) take only the
BRIGHTNESS of the layered-rock photo (cliff_side): stone colour x
mix(1, clamp(L / 0.32, 0.55, 1.45), detail). The terrain's paint layers take a
photo x a tint, and cliff_side is a warm red sandstone — so this bakes the
blocks' own formula into a copy of the photo: the same stone, the same
cracks, in the same blue-grey.

DE-TILED: the 1k photo repeated every 6 m shows its grid across a far slope.
The output is 2k and spans FOUR photo tiles a side; a periodic hex
(triangle) lattice gives each lattice vertex its own random offset into the
photo, and every pixel blends the three samples of its triangle (sharpened
barycentric weights) — the photo never repeats inside the 2k tile, and the
2k tile itself repeats every 24 m. No rotation (the photo's layers must stay
level on the triplanar walls), so the normal map takes the very same remap
and stays valid. Rough / AO the same.

  python tools/stylizedCliffTexture.py
writes public/textures/ground/cliff_stylized/cliff_stylized_{diff,nor_gl,rough,ao}_1k.jpg (2048 px)
"""
import os
import numpy as np
from PIL import Image

SRC = "public/textures/ground/cliff_side/cliff_side_{}_1k.jpg"
DST_DIR = "public/textures/ground/cliff_stylized"
DST = DST_DIR + "/cliff_stylized_{}_1k.jpg"

STONE = "#7f8a9c"   # stylizedRockMaterial.js ROCK_LOOK_DEFAULTS.top
DETAIL = 0.4        # ... .detail
OUT = 2048          # output size: REPEAT x the 1k photo
REPEAT = 4          # photo tiles per output tile, a side
CELLS = 8           # hex lattice cells across the output (periodic)
SHARP = 6.0         # blend sharpness (higher = narrower seams)
rng = np.random.default_rng(7)


def srgb_to_lin(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.round(np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055) * 255).astype(np.uint8)


def load(m):
    return np.asarray(Image.open(SRC.format(m)).convert("RGB")).astype(np.float32)


# ── the hex remap: for each output pixel, three source uvs and their weights ──
src_n = load("diff").shape[0]
ys, xs = np.mgrid[0:OUT, 0:OUT].astype(np.float32)
u = xs / OUT * CELLS
v = ys / OUT * CELLS
# skew to a triangle lattice
sq = 1.0 / np.sqrt(3.0)
gx = u - v * sq
gy = v * 2 * sq
bx, by = np.floor(gx), np.floor(gy)
fx, fy = gx - bx, gy - by
upper = (fx + fy) > 1.0
# triangle vertices (lattice coords) and barycentric weights
v0 = np.stack([np.where(upper, bx + 1, bx), np.where(upper, by + 1, by)], -1)
v1 = np.stack([np.where(upper, bx, bx), np.where(upper, by + 1, by + 1)], -1)
v2 = np.stack([np.where(upper, bx + 1, bx + 1), np.where(upper, by, by)], -1)
w0 = np.where(upper, fx + fy - 1, 1 - fx - fy)
w1 = np.where(upper, 1 - fx, fy)
w2 = np.where(upper, 1 - fy, fx)
# random offset per lattice vertex, PERIODIC so the output tiles
off = rng.random((CELLS * 2 + 2, CELLS * 2 + 2, 2)).astype(np.float32)


def offset_of(vv):
    i = np.mod(vv[..., 0].astype(np.int64), CELLS)
    j = np.mod(vv[..., 1].astype(np.int64), CELLS * 2)
    return off[i, j]


ws = [np.maximum(w, 0) ** SHARP for w in (w0, w1, w2)]
wsum = ws[0] + ws[1] + ws[2] + 1e-6
ws = [w / wsum for w in ws]
base_u = xs / OUT * REPEAT
base_v = ys / OUT * REPEAT
uvs = []
for vv in (v0, v1, v2):
    o = offset_of(vv)
    uvs.append(((base_u + o[..., 0] * 3.7) % 1.0, (base_v + o[..., 1] * 3.7) % 1.0))


def sample(img, uu, vv):
    """bilinear, wrapping"""
    n = img.shape[0]
    x = uu * n - 0.5
    y = vv * n - 0.5
    x0 = np.floor(x).astype(np.int64); y0 = np.floor(y).astype(np.int64)
    tx = (x - x0)[..., None]; ty = (y - y0)[..., None]
    x0 %= n; y0 %= n
    x1 = (x0 + 1) % n; y1 = (y0 + 1) % n
    a = img[y0, x0] * (1 - tx) + img[y0, x1] * tx
    b = img[y1, x0] * (1 - tx) + img[y1, x1] * tx
    return a * (1 - ty) + b * ty


def remap(img):
    acc = np.zeros((OUT, OUT, img.shape[2]), np.float32)
    for (uu, vv), w in zip(uvs, ws):
        acc += sample(img, uu, vv) * w[..., None]
    return acc


os.makedirs(DST_DIR, exist_ok=True)

# diffuse: the blocks' formula on the photo's luminance
lin = srgb_to_lin(remap(load("diff")))
lum = 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]
k = (1 - DETAIL) + DETAIL * np.clip(lum / 0.32, 0.55, 1.45)
stone = srgb_to_lin(np.array([int(STONE[i:i + 2], 16) for i in (1, 3, 5)], np.float32))
Image.fromarray(lin_to_srgb(stone[None, None, :] * k[..., None])).save(DST.format("diff"), quality=92)

# normal: the same remap (no rotation), renormalised
nrm = remap(load("nor_gl")) / 127.5 - 1.0
nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True) + 1e-6
Image.fromarray(np.clip((nrm + 1) * 127.5, 0, 255).astype(np.uint8)).save(DST.format("nor_gl"), quality=94)

for m in ("rough", "ao"):
    Image.fromarray(np.clip(remap(load(m)), 0, 255).astype(np.uint8)).save(DST.format(m), quality=92)
print("wrote", DST_DIR, OUT, "px,", REPEAT, "photo tiles a side")
