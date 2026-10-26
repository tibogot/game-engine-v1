"""DRY STONE, SHARED (2026-10-21): the split limestone of the stone pieces — the sangar (sangar.py), the arms cache
(armsCache.py), and the dechra, wells, field walls after them. One stone, one material, one build order, so every
stone piece of the game is the same stone.

  stone(...)       a SPLIT BLOCK: a hull of points pushed toward a box (flat faces, edges), a corner knocked off now
                   and then; it draws the same random numbers at either level (far: half the points), so near and
                   far grow alike
  stoneMat(tint)   the scanned weathered limestone (Poly Haven CC0 rock_boulder_dry, assets-src/scans/polyhaven/):
                   its photo box-projected, every stone its own shade, lichen; its NORMAL map on the BSDF (what the
                   piece's normal bake reads — spec normals=True)
  tag / writeBuildOrder   each part's moment (0..1) into a "build" colour attribute → COLOR_0: the game's construction
                   reveals them in that order (algSangar.js siteMaterial)
  LOW              the far level's switch (set by the piece's builder)
"""
import os, math
import bpy, bmesh
import house
from bkit import B, srgb, dust

LOW = False
SCAN = os.path.join(house.bkit.ROOT, "assets-src", "scans", "polyhaven", "rock_boulder_dry")

def scanImg(nb, file, sc, data=False):
    im = bpy.data.images.load(os.path.join(SCAN, file), check_existing=True)
    if data: im.colorspace_settings.name = "Non-Color"
    mp = nb.N.new("ShaderNodeMapping"); nb.L.new(nb.tc.outputs["Object"], mp.inputs["Vector"]); mp.inputs["Scale"].default_value = (sc, sc, sc)
    n = nb.N.new("ShaderNodeTexImage"); n.image = im; n.projection = "BOX"; n.projection_blend = 0.25
    nb.L.new(mp.outputs["Vector"], n.inputs["Vector"]); return n.outputs["Color"]

def stoneMat(tint, sc=1.6):
    def f(nb):
        c = scanImg(nb, "rock_boulder_dry_diff_2k.jpg", sc)
        c = nb.mix(1.0, c, srgb(tint), "MULTIPLY")
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.15))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(3.0, 5), 0.62, 0.72), 0.35), c, srgb(0x6f6a58))
        pb = next(n for n in nb.N if n.type == "BSDF_PRINCIPLED")
        nm = nb.N.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = 1.3
        nb.L.new(scanImg(nb, "rock_boulder_dry_nor_gl_2k.jpg", sc, data=True), nm.inputs["Color"])
        nb.L.new(nm.outputs["Normal"], pb.inputs["Normal"])
        return dust(nb, c, 0.6, 0.8)
    return f

def brushMat(nb):
    c = nb.mix(nb.noise(8.0, 4), srgb(0x6b5a44), srgb(0x55604a))              # dry juniper: brown wood, grey-green needles
    return nb.scale(c, nb.mr(nb.island(), 0, 1, 0.75, 1.2))

# the stone materials every stone piece shares (its MATDEF adds them)
STONE_MATS = {"sgStone": (0.95, stoneMat(0xe0d6c2)), "sgCap": (0.95, stoneMat(0xeae2d0)), "sgBrush": (0.95, brushMat)}

def tag(o, t):
    """The moment this part is laid (0..1), for the colour attribute written at the end."""
    if o is not None: o["t"] = float(t)
    return o

def stone(K, nm, c, size, R, t, mat="sgStone", yaw=None, box=0.45):
    """A split block: c its centre (game), size its half extents (along, up, across — `yaw` its long axis's turn,
    three.js rotation.y; random without one). `box`: how far toward a box (0.45 a split block; ~0.85 a weathered
    boulder, rounded)."""
    ry, tx, tz = R.uniform(0, 6.283), R.uniform(-0.08, 0.08), R.uniform(-0.08, 0.08)
    th = yaw if yaw is not None else ry
    ca, sa = math.cos(th), math.sin(th)
    N = 26
    pts = []
    for i in range(N):
        u = 1 - 2 * (i + 0.5) / N; v = i * 2.399963 + R.uniform(-0.25, 0.25)
        r = math.sqrt(max(0.0, 1 - u * u))
        q = [r * math.cos(v), u, r * math.sin(v)]
        q = [math.copysign(abs(x) ** box, x) for x in q]                  # toward a box: flat faces, edges
        chip = R.random()
        k = R.uniform(0.86, 1.0) * (0.78 if chip < 0.18 else 1.0)          # a corner knocked off
        pts.append((q[0] * size[0] * k, q[1] * size[1] * R.uniform(0.9, 1.0), q[2] * size[2] * k))
    if LOW: pts = pts[::2]
    bm = bmesh.new()
    vs = []
    for lx, ly, lz in pts:
        ly += lx * tx + lz * tz
        vs.append(bm.verts.new(B(c[0] + lx * ca + lz * sa, c[1] + ly, c[2] - lx * sa + lz * ca)))
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.obj(nm, bm, mat, "h"), t)

SURFACES = ("", "plaster", "stone", "wood", "metal", "concrete")
def surfaceClass(nm):
    """A face's SURFACE from its material's name (.b of the build colour, class / 8): the game tiles that surface's
    photo over it (algSangar surfaceMaterial — 2026-10-25, you: the post's texture "so cheap and not AAA rts at all")."""
    n = nm.split(".")[0].lower()
    raw = nm.split(".")[0]
    if n.startswith("render") or "plaster" in n or n.startswith("lime"): return 1
    if raw.startswith("earth") and len(raw) > 5 and raw[5].isupper(): return 1   # (the M'zab's earth renders: earthOchre…; "earth" alone is ground)
    if n == "terracewall": return 2
    if n in ("stone", "rubble") or "stone" in n or "masonry" in n: return 2
    if any(k in n for k in ("wood", "door", "shutter", "plank", "beam", "timber", "crate")): return 3
    if any(k in n for k in ("steel", "iron", "tank", "galv", "rust", "metal", "poroof")): return 4
    if any(k in n for k in ("concrete", "coping", "sill")): return 5
    return 0

def writeBuildOrder(K):
    """Each part's moment into a 'build' colour attribute (.r), the ACTIVE one — exported as COLOR_0. (.g: 1 on CLOTH
    — a part tagged o["cloth"] (clothKit): the game lays the burlap weave over it, nowhere else — 2026-10-22.) (.b: the
    face's SURFACE, surfaceClass / 8 — per face corner, 2026-10-25.)"""
    for o in K.groups["h"]:
        if o.type != "MESH": continue
        m = o.data
        old = m.color_attributes.get("build")
        if old is not None and old.domain != "CORNER": m.color_attributes.remove(old); old = None
        a = old or m.color_attributes.new("build", "FLOAT_COLOR", "CORNER")
        t, c = float(o.get("t", 0.0)), float(o.get("cloth", 0.0))
        for p in m.polygons:
            nm = m.materials[p.material_index].name if m.materials else ""
            # the WEAVE per face material: wool (a blanket) 0.5, canvas / linen 1 — the game picks the photo
            g = (0.5 if "Blanket" in nm else 1.0) if c > 0 else 0.0
            col = (t, g, surfaceClass(nm) / 8, 1.0)
            for li in p.loop_indices: a.data[li].color = col
        m.color_attributes.active_color = a

def setLow(K, far):
    """The far level's switch, for this module and the kit."""
    global LOW
    LOW = far; K.low = far
