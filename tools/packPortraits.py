"""PACK THE HUD PORTRAITS — your ChatGPT sheets (2026-10-02) into two small
WebP atlases the HUD reads (games/alg-rts/ui/portraits.js).

  soldiers sheet  8 x 4 painted portraits (rows 1-2 French, 3-4 ALN)
  vehicles sheet  3 x 2 vehicle cards (Willys, GMC, half-track, AMX-13, EBR, Alouette)

The cells are FOUND, not assumed: the dark gutters between them are the
columns / rows whose mean brightness dips; each cell is then trimmed of its
own dark frame (a few px) and resized to one size. Output, one row per sheet
cell order (left to right, top to bottom):

  public/textures/ui/portraits_soldiers.webp   8 x 4 cells of 160 x 200
  public/textures/ui/portraits_vehicles.webp   3 x 2 cells of 240 x 270

  python tools/packPortraits.py <soldiers.png> <vehicles.png>
"""
import sys
from PIL import Image

OUT = "public/textures/ui/"


def gutters(px, w, h, axis):
    """Runs of LOW VARIANCE (flat dark gutter) along an axis, as (start, end)."""
    import statistics as st
    L = w if axis == 0 else h
    p = []
    for i in range(L):
        vals = [px[i, y] for y in range(0, h, 3)] if axis == 0 else [px[x, i] for x in range(0, w, 3)]
        p.append(st.pstdev(vals))
    m, res, s0 = st.median(p), [], None
    for i, v in enumerate(p):
        if v < 0.45 * m and s0 is None: s0 = i
        elif v >= 0.45 * m and s0 is not None: res.append((s0, i)); s0 = None
    if s0 is not None: res.append((s0, L))   # a gutter running off the edge
    return res


def cells(path, cols, rows, rows_override=None):
    im = Image.open(path).convert("RGB")
    g = im.convert("L")
    w, h = g.size
    px = g.load()
    def between(gs):
        return [(gs[i][1], gs[i + 1][0]) for i in range(len(gs) - 1)]
    xs = between(gutters(px, w, h, 0))
    ys = rows_override or between(gutters(px, w, h, 1))
    if len(xs) != cols or len(ys) != rows:
        raise SystemExit(f"{path}: found {len(xs)} x {len(ys)} cells, expected {cols} x {rows}: {xs} {ys}")
    print(f"{path}: cols {xs} rows {ys}")
    return [im.crop((x0 + 3, y0 + 3, x1 - 3, y1 - 3)) for (y0, y1) in ys for (x0, x1) in xs]


def pack(cs, cols, rows, cw, ch, name, q, contain=False):
    atlas = Image.new("RGB", (cols * cw, rows * ch))
    for i, c in enumerate(cs):
        # Cover the cell (crop the long side), centred a little high (faces).
        # contain (vehicles): the whole card, the rest of the cell the sheet's dark.
        s = (min if contain else max)(cw / c.width, ch / c.height)
        r = c.resize((round(c.width * s), round(c.height * s)), Image.LANCZOS)
        x0, y0 = (i % cols) * cw, (i // cols) * ch
        if contain:
            atlas.paste(c.resize((1, 1)).resize((cw, ch)), (x0, y0))
            atlas.paste(r, (x0 + (cw - r.width) // 2, y0 + (ch - r.height) // 2))
        else:
            ox, oy = (r.width - cw) // 2, int((r.height - ch) * 0.35)
            atlas.paste(r.crop((ox, oy, ox + cw, oy + ch)), (x0, y0))
    atlas.save(OUT + name, "WEBP", quality=q, method=6)
    print(f"  -> {OUT}{name} {atlas.size}")


soldiers, vehicles = sys.argv[1], sys.argv[2]
pack(cells(soldiers, 8, 4), 8, 4, 160, 200, "portraits_soldiers.webp", 82)
# The vehicles sheet's middle gutter is broken by the Alouette's rotor: its rows by hand.
pack(cells(vehicles, 3, 2, [(44, 537), (549, 1043)]), 3, 2, 240, 270, "portraits_vehicles.webp", 82, contain=True)
