"""THE FIELD POSTS IN BLENDER (2026-10-21, the asset pass): what the engineers raise out on the map beside a point —

  FWDRADIO  THE FORWARD POST (algFieldWorks: groups within 30 m reinforce there): a radio post dug in at a point —
            the user's cloth-simulated horseshoe of sandbags (sandbagWall.py layout "radio", in the game) round a
            folding table with the set and its power box, the field telephone and the map case; the crank generator on
            its seat; a tarp on four poles over them, guyed; the sectional mast outside the bags with its ground-plane
            head and whip, guyed to stakes, its feed cable to the table; the tricolour on its pole at the entrance.
            (The old one was the US S-280 shelter of the Vietnam kit — wrong army, wrong war.)
  AIDTENT   THE AID STATION (its wounded within 20 m heal): the army's ridge tent in olive canvas, the front wall rolled
            up on its stretchers on trestles, the red cross on white on both slopes, guyed and pegged; outside a
            stretcher on trestles, the medical chest (its cross on the lid), water jerrycans, the washbasin on its
            stand, a folding chair, the Red Cross flag on its pole.

    INTACT / DAMAGED / RUIN    the radio post: the mast snapped and hanging, a tarp corner down, the table over / the mast
                               down, the tarp on the ground, the stores burnt; the tent: one end pole down, the roof
                               sloping to the ground, the chest thrown / the tent down flat on its contents, burnt.

  BUILD ORDER (COLOR_0): the radio post: the table and stores, the poles and tarp, the mast, the flag; the tent: the
  poles, the canvas, the ropes, the furniture.

Kit metres (the game ×1.3); the front at -Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/fieldPosts.py -- <out dir> [--quick]

Writes <out>/fieldposts.glb (Field<Type>_<State> + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, noise as mnoise
import house
from house import buildKit
from bkit import B, gv, srgb, dust, flat
import drystone
from drystone import tag
import milprops
import clothKit

def canvas(tint):
    def f(nb):
        c = nb.mix(nb.noise(1.4, 4), srgb(tint), tuple(v * 0.8 for v in srgb(tint)))
        c = nb.mix(nb.mr(nb.noise(6.0, 5), 0.55, 0.7), c, tuple(v * 1.15 for v in srgb(tint)))   # sun-bleached patches
        return dust(nb, c, 0.6, 0.8)
    return f
def canvasPhoto(tint, stains=True):
    """ARMY CANVAS (2026-10-21, you: the tent "looks even cheaper"): the woven hessian photo dyed (multiplied by the
    tint) at a fine scale — the weave up close; sun-bleached panels; water stains run down the slopes; dust at the foot."""
    def f(nb):
        c = nb.mix(0.55, srgb(tint), nb.img("build/hessian_230/hessian_230_diff_1k.jpg", 3.2), "MULTIPLY")   # (the weave at half: the photo is warm burlap)
        c = nb.mix(nb.mr(nb.noise(0.9, 4), 0.45, 0.75), c, nb.scale(c, 1.3))                  # bleached panels
        if stains:
            st = nb.mr(nb.noise(4.0, 5, 0.6, (5, 5, 0.6)), 0.58, 0.72)                          # streaks down the slope
            c = nb.mix(nb.math("MULTIPLY", st, 0.6), c, nb.scale(c, 0.62))
        return dust(nb, c, 0.45, 0.9)
    return f
def crossPanel(nb):
    """THE RED CROSS ON WHITE, from the decal's own "Panel" UVs (0..1): sharp in its own atlas; a little grime."""
    uvn = nb.N.new("ShaderNodeAttribute"); uvn.attribute_name = "panel"     # (clothKit._panel: not a UV layer — see there)
    sep = nb.N.new("ShaderNodeSeparateXYZ"); nb.L.new(uvn.outputs["Vector"], sep.inputs[0])
    dx = nb.math("ABSOLUTE", nb.math("SUBTRACT", sep.outputs["X"], 0.5))
    dy = nb.math("ABSOLUTE", nb.math("SUBTRACT", sep.outputs["Y"], 0.5))
    arm = lambda a, b: nb.math("MULTIPLY", nb.math("LESS_THAN", a, 0.36), nb.math("LESS_THAN", b, 0.115))
    red = nb.math("MAXIMUM", arm(dx, dy), arm(dy, dx))
    white = nb.mix(nb.mr(nb.noise(3.0, 4), 0.4, 0.7), srgb(0xe2ded2), srgb(0xc8c2b2))
    c = nb.mix(red, white, srgb(0xa3221c))
    edge = nb.math("MAXIMUM", dx, dy)                                                          # grime toward its border
    return nb.mix(nb.math("MULTIPLY", nb.mr(edge, 0.38, 0.5), 0.35), c, srgb(0x8a8270))
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update({
    "fpCanvas": (0.95, canvasPhoto(0x7c8460)), "fpSeam": (0.95, canvasPhoto(0x5c6248, False)), "fpCross": (0.9, crossPanel), "fpTarp": (0.95, canvas(0x5e6040)), "fpCanvasLight": (0.95, canvas(0x8a8462)),
    "fpWhite": (0.9, flat(srgb(0xd8d4c8), 0.3)), "fpRed": (0.8, flat(srgb(0x9a1c18), 0.3)), "fpBlue": (0.8, flat(srgb(0x1c2c6a), 0.3)),
    "fpPole": (0.85, milprops.timberMat(0x9a8a6a)), "fpCrate": (0.85, milprops.timberMat(0x6a6a4c)), "fpWood": (0.85, milprops.timberMat(0xa08c6c)),
    "fpOlive": (0.6, milprops._steel(0x4a523a, 0.25)), "fpSteel": (0.5, milprops._steel(0x3a3c38, 0.35)), "fpBlack": (0.6, milprops._steel(0x1e201c, 0.15)),
    "fpRope": (0.9, flat(srgb(0x9a8e70), 0.0)), "fpCable": (0.8, flat(srgb(0x161614), 0.0)), "fpChar": (0.95, charred),
    "fpEnamel": (0.4, flat(srgb(0xd8d8d0), 0.0)),
})
# THE CLOTH'S FOLDS AND STITCHES, baked (2026-10-22): curvature shading on every canvas / blanket, stitch rows on the seams
for _n in ['fpCanvas','fpTarp','fpCanvasLight']:
    _r, _f = MATDEF[_n]; MATDEF[_n] = (_r, (lambda f: lambda nb: milprops.foldShade(nb, f(nb)))(_f))
MATDEF["fpSeam"] = (MATDEF["fpSeam"][0], milprops.stitched(MATDEF["fpSeam"][1]))
LOW = lambda: drystone.LOW

def rod(K, nm, a, b, r, mat, t, n=8):
    return tag(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(4, n // 2)), t)
def box(K, nm, c, size, yaw, mat, t, w=0.008, y0=0.0):
    """A box of full size (x, y, z) standing at c (its foot), turned yaw about y."""
    cx, cy, cz = c
    co, si = math.cos(yaw), math.sin(yaw)
    bm = bmesh.new()
    vs = []
    for sx in (-1, 1):
        for sy in (0, 1):
            for sz in (-1, 1):
                lx, lz = sx * size[0] / 2, sz * size[2] / 2
                vs.append(bm.verts.new(B(cx + lx * co + lz * si, cy + sy * size[1], cz - lx * si + lz * co)))
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.bevel(K.obj(nm, bm, mat, "h"), w if not LOW() else 0), t)
def sheet(K, nm, fn, nu, nv, mat, t, thick=0.012):
    """A canvas surface: fn(u, v) → game point, u, v in 0..1; both faces (solidified)."""
    if LOW(): nu, nv = max(2, nu // 2), max(1, nv // 2)
    bm = bmesh.new()
    g = [[bm.verts.new(B(*fn(i / nu, j / nv))) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
    o = K.obj(nm, bm, mat, "h", smooth=True)
    so = o.modifiers.new("S", "SOLIDIFY"); so.thickness = thick; so.offset = 0.0
    return tag(o, t)
def peg(K, nm, at, frm, t):
    """A guy rope from `frm` to a peg driven at `at` (ground)."""
    rod(K, nm, frm, (at[0], 0.12, at[2]), 0.008, "fpRope", t, 4)
    if not LOW(): box(K, nm + "Peg", (at[0], -0.1, at[2]), (0.04, 0.24, 0.04), 0.3, "fpWood", t, 0)

# ── shared furniture ──────────────────────────────────────────────────────────────────────────────────────────────
def trestleStretcher(K, nm, x, z, yaw, t, mat="fpCanvasLight", h=0.6, on=True):
    """A stretcher (two poles, the canvas) on two X trestles, its length along yaw."""
    co, si = math.cos(yaw), math.sin(yaw)
    P = lambda lx, y, lz: (x + lx * co + lz * si, y, z - lx * si + lz * co)
    if on:
        for e in (-0.75, 0.75):   # the trestles: an X each side
            for s in (-1, 1):
                rod(K, f"{nm}Tr{e}{s}", P(e - 0.15 * s, 0, -0.3), P(e + 0.15 * s, h - 0.04, -0.3), 0.018, "fpWood", t, 5)
                rod(K, f"{nm}Tr{e}{s}b", P(e - 0.15 * s, 0, 0.3), P(e + 0.15 * s, h - 0.04, 0.3), 0.018, "fpWood", t, 5)
            rod(K, f"{nm}TrTop{e}", P(e, h - 0.03, -0.32), P(e, h - 0.03, 0.32), 0.022, "fpWood", t, 5)
    y = h if on else 0.06
    for s in (-1, 1):
        rod(K, f"{nm}Pole{s}", P(-1.15, y + 0.03, s * 0.28), P(1.15, y + 0.03, s * 0.28), 0.022, "fpWood", t, 6)
    sheet(K, f"{nm}Canvas", lambda u, v: P(-0.9 + 1.8 * u, y + 0.03 - 0.05 * math.sin(math.pi * v), -0.27 + 0.54 * v), 4, 3, mat, t, 0.01)

def jerry(K, nm, x, z, yaw, t, mat="fpOlive"):
    box(K, nm, (x, 0, z), (0.17, 0.47, 0.34), yaw, mat, t, 0.02)
    if not LOW():
        co, si = math.cos(yaw), math.sin(yaw)
        for k in (-0.07, 0.0, 0.07):
            p = (x + k * si, 0.47, z + k * co)
            rod(K, f"{nm}H{k}", p, (p[0], 0.52, p[2]), 0.011, mat, t, 4)

def flagPole(K, nm, x, z, h, panels, t, lean=0.0, lie=None, wave=0.05):
    """A pole and its flag: `panels` (mat, …) side by side from the pole, a slight wave; `lie` (yaw): down on the ground."""
    if lie is not None:
        co, si = math.cos(lie), math.sin(lie)
        rod(K, nm, (x, 0.03, z), (x + co * h, 0.03, z - si * h), 0.03, "fpPole", t, 6)
        for k, m in enumerate(panels):
            d0, d1 = h - 0.1 - k * 0.32, h - 0.1 - (k + 1) * 0.32
            box(K, f"{nm}F{k}", (x + co * (d0 + d1) / 2 + si * 0.35, 0.0, z - si * (d0 + d1) / 2 + co * 0.35), (0.32, 0.02, 0.62), lie, m, t, 0)
        return
    rod(K, nm, (x, 0, z), (x + lean, h, z), 0.03, "fpPole", t, 6)
    rod(K, nm + "Knob", (x + lean, h, z), (x + lean, h + 0.05, z), 0.04, "fpPole", t, 6)
    w = 0.3
    for k, m in enumerate(panels):
        def fn(u, v, k=k):
            dx = 0.04 + (k + u) * w
            return (x + lean + dx, h - 0.08 - 0.6 * v, z + wave * math.sin(dx * 5.0 + v))
        sheet(K, f"{nm}F{k}", fn, 3, 2, m, t, 0.008)

# ── THE FORWARD POST ──────────────────────────────────────────────────────────────────────────────────────────────
TARP = ((-1.35, -1.15, 1.95), (1.25, -1.15, 1.95), (1.25, 0.95, 1.5), (-1.35, 0.95, 1.5))   # its corners (x, z, top)
MAST = (-3.3, 0.5, 8.0)

def table(K, x, z, t, state):
    if state == "damaged":   # thrown over on its side, the set on the ground
        box(K, "TableTop", (x, 0.0, z - 0.1), (1.2, 0.6, 0.04), 0.0, "fpWood", t, 0.004)
        for sx in (-0.55, 0.55):
            rod(K, f"TableLeg{sx}", (x + sx, 0.3, z - 0.08), (x + sx, 0.3, z + 0.62), 0.02, "fpWood", t, 5)
        box(K, "Radio", (x + 0.3, 0, z - 0.75), (0.48, 0.3, 0.32), 0.7, "fpOlive", t, 0.006)
        return
    for sx in (-0.55, 0.55):
        for sz in (-0.25, 0.25):
            rod(K, f"TableLeg{sx}{sz}", (x + sx, 0, z + sz), (x + sx, 0.72, z + sz), 0.02, "fpWood", t, 5)
    box(K, "TableTop", (x, 0.72, z), (1.25, 0.04, 0.62), 0.0, "fpWood", t, 0.004)
    # the set: the transceiver (its front panel of dials and a darker face), the power box beside it
    box(K, "Radio", (x - 0.2, 0.76, z + 0.02), (0.48, 0.3, 0.32), 0.0, "fpOlive", t, 0.006)
    box(K, "RadioFace", (x - 0.2, 0.79, z - 0.155), (0.42, 0.24, 0.012), 0.0, "fpBlack", t, 0)
    if not LOW():
        for k in range(4):
            rod(K, f"Dial{k}", (x - 0.36 + k * 0.1, 0.92, z - 0.16), (x - 0.36 + k * 0.1, 0.92, z - 0.19), 0.022, "fpSteel", t, 8)
        rod(K, "Whip", (x - 0.02, 1.06, z + 0.1), (x + 0.05, 2.1, z + 0.18), 0.006, "fpBlack", t, 4)
        box(K, "Handset", (x + 0.12, 0.76, z - 0.12), (0.2, 0.05, 0.06), 0.3, "fpBlack", t, 0.01)
        box(K, "MapCase", (x + 0.35, 0.76, z + 0.05), (0.38, 0.03, 0.28), -0.2, "fpCanvasLight", t, 0.004)
    box(K, "PowerBox", (x + 0.38, 0.76, z + 0.16), (0.25, 0.2, 0.2), 0.0, "fpOlive", t, 0.006)

def generator(K, x, z, t, mat="fpOlive"):
    """The crank generator on its legs, the seat behind it."""
    for k in range(3):
        a = k / 3 * 2 * math.pi
        rod(K, f"GenLeg{k}", (x + 0.25 * math.cos(a), 0, z + 0.25 * math.sin(a)), (x, 0.55, z), 0.018, "fpSteel", t, 5)
    box(K, "Gen", (x, 0.55, z), (0.28, 0.3, 0.22), 0.0, mat, t, 0.01)
    if not LOW():
        for s in (-1, 1):
            rod(K, f"Crank{s}", (x + s * 0.14, 0.72, z), (x + s * 0.24, 0.72, z), 0.012, "fpSteel", t, 4)
            rod(K, f"CrankH{s}", (x + s * 0.24, 0.72, z), (x + s * 0.24, 0.62, z - 0.06), 0.014, "fpBlack", t, 4)
    for sz in (-0.12, 0.12):
        rod(K, f"SeatLeg{sz}", (x, 0, z + 0.55 + sz), (x, 0.42, z + 0.5), 0.016, "fpSteel", t, 4)
    box(K, "Seat", (x, 0.42, z + 0.5), (0.3, 0.04, 0.22), 0.0, "fpWood", t, 0.004)

def tarp(K, state, t):
    """The tarp by CLOTH (clothKit): tied at its four corners to the poles, its slack hanging in folds between; the
    damaged one torn loose at a corner, hanging down to the ground over the table; the ruin's down on the stores."""
    c = TARP
    def rest(u, v):
        a, b, cc, d = (Vector((x, h, z)) for x, z, h in c)
        p = (a.lerp(b, u)).lerp(d.lerp(cc, u), v)
        p.y -= 0.3 * math.sin(math.pi * u) * math.sin(math.pi * v)   # its slack: it hangs in folds between the poles
        return tuple(p)
    corner = lambda u, v: (u < 0.04 or u > 0.96) and (v < 0.05 or v > 0.95)
    if state == "ruin":   # down on the ground over the burnt stores
        cols = [("box", (-1.05, 0.25, 0.0, 0.08, -0.85, -0.15)), ("box", (-0.15, 0.35, 0.0, 0.3, -1.1, -0.7)), ("box", (0.85, 1.15, 0.0, 0.3, 0.05, 0.35)),
                ("box", (-0.85, -0.25, 0.0, 0.32, -0.05, 0.35)), ("box", (-1.75, -1.15, 0.0, 0.32, -0.45, 0.05))]
        clothKit.drape(K, "Tarp", lambda u, v: tuple(Vector(rest(u, v)) - Vector((0, 0.6, 0))), 30, 24, lambda u, v: "fpChar",
                       t, colliders=cols, frames=70, key="TarpRuin")
        return
    drop = state == "damaged"   # the front-right corner (u 1, v 0) torn loose
    pins = (lambda u, v: corner(u, v) and not (u > 0.5 and v < 0.5)) if drop else corner
    cols = [("rod", (x, 0, z), (x, h + 0.08, z), 0.035) for i, (x, z, h) in enumerate(c) if not (drop and i == 1)]
    if drop:   # the table over on its side, the set, the crates, the generator, the jerrycans under it
        cols += [("box", (-1.12, 0.12, 0.0, 0.62, -0.68, -0.6)), ("box", (-0.85, 0.35, 0.0, 0.32, 0.0, 0.32)), ("box", (0.8, 1.1, 0.0, 0.85, -0.12, 0.12)),
                 ("box", (1.15, 1.65, 0.0, 0.52, -1.15, -0.55))]
    clothKit.drape(K, "Tarp", rest, 30, 24, lambda u, v: "fpTarp", t, pins=pins, colliders=cols, frames=60, stiff=15.0, key=f"Tarp{state}")
    for i, (x, z, h) in enumerate(c):
        if drop and i == 1: continue
        rod(K, f"TarpPole{i}", (x, 0, z), (x, h + 0.08, z), 0.03, "fpPole", t, 6)
        out = Vector((x, 0, z)).normalized()
        peg(K, f"Guy{i}", (x + out.x * 1.5, 0, z + out.z * 1.5), (x, h + 0.05, z), t + 0.01)

def mast(K, state, t):
    mx, mz, mh = MAST
    rod(K, "MastFoot", (mx, 0, mz), (mx, 0.08, mz), 0.25, "fpWood", t, 8)
    if state == "ruin":   # down along the ground, away from the post
        rod(K, "Mast", (mx, 0.1, mz), (mx - mh * 0.9, 0.05, mz + mh * 0.3), 0.05, "fpSteel", t, 6)
        return
    top = mh if state != "damaged" else mh * 0.5
    rod(K, "Mast", (mx, 0.08, mz), (mx, top, mz), 0.05, "fpSteel", t, 6)
    if not LOW():
        for k, y in enumerate((0.25, 0.5, 0.75)):
            if y * mh < top: rod(K, f"MastJoint{k}", (mx, y * mh - 0.06, mz), (mx, y * mh + 0.06, mz), 0.07, "fpSteel", t, 6)
    if state == "damaged":   # snapped at half height: the top hanging down the side, its head near the ground
        rod(K, "MastTop", (mx, top, mz), (mx - 0.6, 0.6, mz - 0.9), 0.045, "fpSteel", t, 6)
    else:
        rod(K, "Whip", (mx, mh, mz), (mx, mh + 2.0, mz), 0.012, "fpSteel", t + 0.01, 4)
        for k in range(3):   # the ground plane's drooping radials
            a = k / 3 * 2 * math.pi + 0.3
            rod(K, f"Radial{k}", (mx, mh, mz), (mx + math.cos(a) * 1.4, mh - 0.9, mz + math.sin(a) * 1.4), 0.01, "fpSteel", t + 0.01, 4)
    for k in range(3):   # three guys from two heights to stakes
        a = k / 3 * 2 * math.pi + 1.0   # (no stake on the bags' ring, r 2.2)
        sx, sz = mx + math.cos(a) * 3.6, mz + math.sin(a) * 3.6
        for y in (0.45, 0.9):
            if y * mh <= top + 0.01:
                peg(K, f"MastGuy{k}{y}", (sx, 0, sz), (mx, y * mh, mz), t + 0.01)
    if not LOW():   # the feed cable to the set
        rod(K, "Feed0", (mx + 0.08, 0.1, mz), (-1.0, 0.03, 0.3), 0.012, "fpCable", t, 4)
        rod(K, "Feed1", (-1.0, 0.03, 0.3), (-0.5, 0.74, -0.55), 0.012, "fpCable", t, 4)

def buildRadio(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    stores = "fpChar" if state == "ruin" else "fpCrate"
    if state == "ruin":
        box(K, "TableTop", (-0.4, 0.0, -0.5), (1.25, 0.04, 0.62), 0.4, "fpChar", 0.2, 0.004)
        box(K, "Radio", (0.1, 0, -0.9), (0.48, 0.3, 0.32), 1.1, "fpChar", 0.2, 0.006)
        box(K, "Gen", (1.0, 0, 0.2), (0.28, 0.3, 0.22), 0.5, "fpChar", 0.2, 0.01)
    else:
        table(K, -0.5, -0.55, 0.15, state)
        generator(K, 0.95, 0.0, 0.2)
    box(K, "Crate0", (-0.55, 0, 0.15), (0.6, 0.32, 0.4), 0.2, stores, 0.1)
    box(K, "Crate1", (-1.45, 0, -0.2), (0.6, 0.32, 0.4), 1.4, stores, 0.1)
    if state != "ruin":
        jerry(K, "Jerry0", 1.3, -0.95, 0.4, 0.12)
        jerry(K, "Jerry1", 1.5, -0.75, 0.2, 0.12)
    tarp(K, state, 0.4)
    mast(K, state, 0.6)
    tri = ("fpBlue", "fpWhite", "fpRed")
    if state == "ruin": flagPole(K, "Flag", 1.6, 1.5, 3.4, tri, 0.9, lie=2.3)
    else: flagPole(K, "Flag", 1.15, 2.1, 3.4, tri, 0.9)   # (by the entrance, in the bags' gap)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

# ── THE AID STATION ───────────────────────────────────────────────────────────────────────────────────────────────
TL, TW, EAVE, RIDGE = 4.6, 3.2, 1.5, 2.6

def tentY(x, z, state):
    """The canvas's height over (x, z) — the roof's two slopes; the damaged tent\x27s +x end pole down."""
    y = EAVE + (RIDGE - EAVE) * (1 - abs(z) / (TW / 2))
    if state == "damaged":
        k = max(0.0, (x + 0.3) / (TL / 2 + 0.3))
        y = y * (1 - 0.8 * k * k)
    return y

def tent(K, R, state, t):
    hl, hw = TL / 2, TW / 2
    mat = "fpCanvas" if state != "ruin" else "fpChar"
    # stand-ins for the sim: the stretchers inside (on their trestles, or burnt on the ground)
    low = state == "ruin"
    beds = [("box", (-0.7 + 1.2 * k - 1.15, -0.7 + 1.2 * k + 1.15, 0.0, 0.14 if low else 0.66, z - 0.3, z + 0.3)) for k, z in enumerate((-0.6, 0.6))]
    if state == "ruin":   # THE CANVAS DOWN on its contents, over the one pole left leaning (clothKit), burnt
        pole = ((-hl, 0, 0), (-hl + 0.4, 1.6, 0.3))
        rod(K, "Pole0", pole[0], pole[1], 0.035, "fpPole", t, 6)
        clothKit.drape(K, "Canvas", lambda u, v: (-hl - 0.2 + (TL + 0.4) * u, 1.9, -hw - 0.5 + (TW + 1.0) * v), 46, 34,
                       lambda u, v: "fpChar", t,
                       colliders=beds + [("rod", pole[0], pole[1], 0.05), ("box", (1.25, 1.95, 0.0, 0.42, -3.2, -2.6))], frames=80, key="CanvasRuin")
        return
    # THE ROOF BY CLOTH (clothKit): one sheet from eave to eave over the ridge pole, tied at the ridge ends and at the
    # guys along both eaves; its slack sags between them. The red cross on white is the cloth's OWN faces.
    ridge0 = (-hl, tentY(-hl, 0, state) - 0.04, 0)
    ridge1 = (hl, tentY(hl, 0, state) - 0.04, 0)
    def rest(u, v):
        x, z = -hl - 0.1 + (TL + 0.2) * u, -(hw + 0.15) + 2 * (hw + 0.15) * v
        sag = 0.05 * math.sin(math.pi * ((x + hl) / (TL / 3))) ** 2
        return (x, tentY(x, z, state) - sag * abs(2 * v - 1), z)   # (slack toward the eaves, between the guys)
    xs = [-hl, -hl / 3, 0.0, hl / 3, hl]
    def pins(u, v):
        x = -hl - 0.1 + (TL + 0.2) * u
        near = lambda xs_: any(abs(x - q) < 0.12 for q in xs_)   # (the far level's coarser grid too)
        if state == "damaged":
            xs_ = [q for q in xs if q < hl / 2]
            if abs(v - 0.5) < 0.02: return abs(x + hl) < 0.12              # the ridge: its standing end only
            return (v < 0.02 or v > 0.98) and near(xs_)
        if abs(v - 0.5) < 0.02: return abs(abs(x) - hl) < 0.12
        return (v < 0.02 or v > 0.98) and near(xs)
    clothKit.drape(K, "Roof", rest, 48, 36, lambda u, v: mat, t, pins=pins, colliders=[("rod", ridge0, ridge1, 0.035)] + beds, frames=60, key=f"Roof{state}")
    # THE MAKING OF IT (2026-10-21, "looks even cheaper"): the stitched seams between the canvas widths, eave to eave,
    # the ridge's reinforcing strip — cut from the cloth (they follow it), a darker canvas; the valance hanging from
    # each eave, flared out at its foot. (The red cross is its own decal piece: "aidmark".)
    seamX = (-1.15, 0.0, 1.15)
    def seams(u, v, side=None):
        if side is not None: return (0.0, 0.0)                                # (a vertex: no panel UV wanted)
        x = -hl - 0.1 + (TL + 0.2) * u
        return (0.0, 0.0) if any(abs(x - q) < 0.045 for q in seamX) or abs(v - 0.5) < 0.03 else None
    clothKit.decal(K, "Seams", f"Roof{state}", 48, 36, seams, "fpSeam", t, lift=0.012, uv=False)
    for j, s in ((0, -1), (36, 1)):
        clothKit.hem(K, f"Valance{s}", f"Roof{state}", 48, 36, j, 0.24, (0, 0, s * 0.05), mat, t)
    # the back wall down to the ground; the front rolled up under the eave (both just under the roof's line)
    sheet(K, "WallBack", lambda u, v: (-hl + TL * u, v * (tentY(-hl + TL * u, hw, state) - 0.08), hw + 0.1 * (1 - v) ** 2), 12, 4, mat, t)
    rod(K, "Roll", (-hl, tentY(-hl, -hw, state) - 0.2, -hw - 0.02), (hl, tentY(hl, -hw, state) - 0.2, -hw - 0.02), 0.09, mat, t, 10)
    # the ends: the back end closed, the door end's flaps tied back
    def gable(x, u, v):
        z = -hw + TW * u
        return (x, v * (tentY(x, z, state) - 0.1), z)
    sheet(K, "EndBack", lambda u, v: gable(-hl, u, v), 6, 3, mat, t)
    if state == "intact":
        for s in (-1, 1):
            sheet(K, f"Flap{s}", lambda u, v, s=s: (hl + 0.25 * u, v * (tentY(hl, s * hw, state) - 0.1) * (1 - 0.3 * u) + 0.02, s * (hw - 0.65 * (1 - u))), 2, 3, mat, t)
    # the poles: the end uprights, the ridge (inside), the eave poles
    for x in (-hl, hl):
        top = tentY(x, 0, state)
        if state == "damaged" and x > 0:   # the end pole knocked flat
            rod(K, f"Upright{x}", (x + 0.2, 0.04, 0.0), (x + 1.8, 0.04, 0.6), 0.035, "fpPole", t, 6)
            continue
        rod(K, f"Upright{x}", (x, 0, 0), (x, top + 0.14, 0), 0.035, "fpPole", t, 6)
        rod(K, f"Spike{x}", (x, top + 0.14, 0), (x, top + 0.26, 0), 0.012, "fpSteel", t, 5)    # the pin through the ridge grommet
    rod(K, "Ridge", ridge0, ridge1, 0.03, "fpPole", t, 6)
    for x in (-hl, 0.0, hl):
        if state == "damaged" and x > 0: continue
        rod(K, f"Eave{x}", (x, 0, -hw), (x, tentY(x, -hw, state) - 0.12, -hw), 0.025, "fpPole", t, 6)
    # the guys and pegs along both sides and off the ends (from the tied points of the cloth)
    for s in (-1, 1):
        for x in (-hl, -hl / 3, hl / 3, hl):
            if state == "damaged" and x > hl / 2: continue
            peg(K, f"Guy{s}{x}", (x, 0, s * (hw + 1.0)), (x, tentY(x, s * (hw + 0.15), state), s * (hw + 0.15)), t + 0.02)
    for x in (-hl, hl):
        if state == "damaged" and x > 0: continue
        peg(K, f"GuyEnd{x}", (x + math.copysign(1.2, x), 0, 0), (x, tentY(x, 0, state) + 0.05, 0), t + 0.02)

def buildAid(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    tent(K, R, state, 0.25)
    burnt = state == "ruin"
    # inside: two stretchers on trestles along the tent, under the rolled front
    for k, z in enumerate((-0.6, 0.6)):
        trestleStretcher(K, f"In{k}", -0.7 + 1.2 * k, z, 0.0, 0.6, mat="fpChar" if burnt else "fpCanvasLight", on=not burnt)
    if not burnt:
        trestleStretcher(K, "Out", -0.9, -3.4, 0.1, 0.7, on=state == "intact")   # (out past the guys' pegs, z -2.6)
    # the medical chest, its red cross on the lid
    cx, cz, cy = (*CHEST[state], 0.0) if state != "ruin" else (1.6, -2.9, 0.0)
    box(K, "Chest", (cx, cy, cz), (0.7, 0.42, 0.45), 0.2, "fpChar" if burnt else "fpWood", 0.75, 0.01)
    if not burnt:
        jerry(K, "Water0", 2.1, -1.95, 0.3, 0.78, "fpWhite")
        jerry(K, "Water1", 2.3, -1.75, 0.1, 0.78, "fpWhite")
    if state == "intact":
        # the washbasin on its tripod, a folding chair
        bx, bz = -3.0, -2.6
        for k in range(3):
            a = k / 3 * 2 * math.pi
            rod(K, f"BasinLeg{k}", (bx + 0.25 * math.cos(a), 0, bz + 0.25 * math.sin(a)), (bx + 0.15 * math.cos(a), 0.8, bz + 0.15 * math.sin(a)), 0.012, "fpSteel", 0.8, 4)
        # an OPEN enamel bowl (a closed cylinder read as a stool): a surface of revolution, its rim rolled
        sheet(K, "Basin", lambda u, v: (bx + (0.04 + 0.18 * v) * math.cos(2 * math.pi * u), 0.78 + 0.09 * v * v, bz + (0.04 + 0.18 * v) * math.sin(2 * math.pi * u)), 14, 3, "fpEnamel", 0.8, 0.008)
        rod(K, "BasinFoot", (bx, 0.74, bz), (bx, 0.79, bz), 0.05, "fpEnamel", 0.8, 8)
        x, z = 0.2, -2.5
        for s in (-1, 1):
            rod(K, f"ChairA{s}", (x + s * 0.2, 0, z - 0.2), (x + s * 0.2, 0.75, z + 0.2), 0.015, "fpWood", 0.8, 4)
            rod(K, f"ChairB{s}", (x + s * 0.2, 0, z + 0.2), (x + s * 0.2, 0.44, z - 0.15), 0.015, "fpWood", 0.8, 4)
        box(K, "ChairSeat", (x, 0.43, z), (0.42, 0.02, 0.36), 0.0, "fpCanvasLight", 0.8, 0)
    cross = ("fpWhite", "fpWhite")
    if state == "ruin": flagPole(K, "Flag", 2.6, -0.6, 3.0, cross, 0.9, lie=0.4)
    else: flagPole(K, "Flag", 2.7, -1.8, 3.0, cross, 0.9, wave=0.0)   # (flat: its cross on both faces)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

CHEST = {"intact": (1.55, -2.35), "damaged": (1.6, -2.9)}
def buildMark(K, name, spec, state, seed, far=False):
    """THE RED CROSSES as DECALS (2026-10-21, you: "the red cross looks bad, why don't you use decals"): the white panel
    with its cross on each roof slope cut from the settled cloth (it follows the folds), on both faces of the flag, on
    the chest's lid — one small atlas of their own (sharp), the game draws them with a depth offset over the canvas;
    the ruin: a torn panel on the ground."""
    drystone.setLow(K, far)
    hl = TL / 2
    if state == "ruin":
        c, sn = math.cos(0.6), math.sin(0.6)
        P = lambda a, b: (2.2 + a * c - b * sn, 0.02, -2.4 + a * sn + b * c)
        clothKit.quad(K, "Scrap", [P(-0.45, -0.45), P(-0.45, 0.45), P(0.45, 0.45), P(0.45, -0.45)], "fpCross", 0.9)
    else:
        def panel(u, v, side=None):
            x = -hl - 0.1 + (TL + 0.2) * u
            if side is None:                                  # (a face's centre: in a panel? which slope)
                w = 2 * v if v < 0.5 else 2 * (1 - v); side = 0 if v < 0.5 else 1
                if not (abs(x) < 0.6 and 0.18 < w < 0.82): return None
            w = 2 * v if side == 0 else 2 * (1 - v)
            pu = (x + 0.6) / 1.2
            return (pu if side == 0 else 1 - pu, (w - 0.18) / 0.64, side)
        clothKit.decal(K, "RoofCross", f"Roof{state}", 48, 36, panel, "fpCross", 0.9, lift=0.02)
        # the flag (flat, its panels x 0.04..0.64 off the pole, 0.08..0.68 under its top), both faces
        x0, x1, y0, y1, z = 2.7 + 0.04, 2.7 + 0.64, 3.0 - 0.68, 3.0 - 0.08, -1.8
        clothKit.quad(K, "FlagFront", [(x0, y0, z + 0.01), (x1, y0, z + 0.01), (x1, y1, z + 0.01), (x0, y1, z + 0.01)], "fpCross", 0.95)
        clothKit.quad(K, "FlagBack", [(x1, y0, z - 0.01), (x0, y0, z - 0.01), (x0, y1, z - 0.01), (x1, y1, z - 0.01)], "fpCross", 0.95)
        # the chest's lid (0.42 up, turned 0.2)
        cx, cz = CHEST[state]; c, sn = math.cos(0.2), math.sin(0.2)
        P = lambda a, b: (cx + a * c + b * sn, 0.428, cz - a * sn + b * c)
        clothKit.quad(K, "ChestCross", [P(-0.17, -0.14), P(-0.17, 0.14), P(0.17, 0.14), P(0.17, -0.14)], "fpCross", 0.8)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farRadio = lambda K, n, s, st, sd: buildRadio(K, n, s, st, sd, far=True)
farMark = lambda K, n, s, st, sd: buildMark(K, n, s, st, sd, far=True)
farAid = lambda K, n, s, st, sd: buildAid(K, n, s, st, sd, far=True)
TYPES = {"fwdradio": dict(builder=buildRadio, farBuilder=farRadio, atlas=2048, normalAtlas=1024, aoDist=0.4, smoothAngle=40, weighted=False, normals=True),
         "aidtent": dict(builder=buildAid, farBuilder=farAid, atlas=2048, normalAtlas=1024, aoDist=0.4, smoothAngle=40, weighted=False, normals=True),
         "aidmark": dict(builder=buildMark, farBuilder=farMark, atlas=1024, islandMargin=0.02, aoDist=0.05, smoothAngle=60, weighted=False)}
exported = buildKit(TYPES, MATDEF, "fieldposts.glb", prefix="Field", seed0=1956, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1000, 750
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cd.lens = 35; cam.location = B(5, 7, -10)
    cam.rotation_euler = (B(-0.5, 1.2, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
