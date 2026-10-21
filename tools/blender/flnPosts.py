"""THE FLN'S FIELD WORKS IN BLENDER (2026-10-21, the asset pass) — improvised, hidden, nothing like the French kit:

  REFUGE    the hidden casemate, a second base: a hummock of earth dug into, its mouth a short trench lined with dry
            stone to a door of rough logs under a lintel, a blanket hung across it (cloth); the hearth with its blackened
            pot, a firewood pile, grain sacks, the water jar. Its SCRUB is the engine's plants (algSangar refugePlantSpots,
            the same formula for the mound): from the air one more scrubby hummock.
  INFIRM    the infirmary under the scrub: crooked forked poles and rough beams under a PATCHWORK tarp — canvas,
            blankets, sacking sewn together (cloth) — straw pallets with blankets thrown over them (cloth), a stretcher,
            the dressings box, a jar, a hearth to boil water, a low dry-stone screen on the weather side.

    DAMAGED / RUIN   the refuge: the lintel snapped, earth spilled into the trench, the blanket torn down / the mouth
                     caved in; the infirmary: a front pole knocked away, the tarp down on the pallets / all of it down,
                     burnt.

  BUILD ORDER (COLOR_0): the refuge: the mound, the cheeks course by course, the posts, the lintel, the roof logs, the
  blanket, the stores; the infirmary: the screen, the poles, the beams, the tarp, the pallets, the rest.

The OLD pieces' frames (rtsAlgeria buildRefuge / buildFlnInfirmary — their footprints): kit metres (the game ×1.3);
the front at -Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/flnPosts.py -- <out dir> [--quick]

Writes <out>/flnposts.glb (Fln<Type>_<State> + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, noise as mnoise
import house
from house import buildKit
from bkit import B, gv, srgb, dust, flat
import drystone
from drystone import tag, stone
import milprops
import clothKit

def photo(path, tint, k=0.55, sc=3.0, top=0.6):
    def f(nb):
        c = nb.mix(k, srgb(tint), nb.img(path, sc), "MULTIPLY")
        c = nb.mix(nb.mr(nb.noise(1.2, 4), 0.45, 0.75), c, nb.scale(c, 1.2))
        return dust(nb, c, top, 0.9)
    return f
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
def ash(nb):
    return nb.mix(nb.mr(nb.noise(6.0, 4), 0.4, 0.7), srgb(0x2a2622), srgb(0x8a857c))
MATDEF = dict(house.MATDEF)
MATDEF.update(drystone.STONE_MATS)
MATDEF.update(milprops.MILPROP_MATS)
HES = "build/hessian_230/hessian_230_diff_1k.jpg"
MATDEF.update({
    "flEarth": (1.0, milprops.earthMat(0xc8ae88)), "flLog": (0.9, photo("build/bark_willow_02/bark_willow_02_diff_1k.jpg", 0x9a8a70, 0.8, 2.0)),
    "flWood": (0.85, milprops.timberMat(0x8e7c60)), "flCanvas": (0.95, photo(HES, 0x7c8460)), "flBlanketRed": (0.95, photo(HES, 0x8a4a38, 0.35)),
    "flBlanketGrey": (0.95, photo(HES, 0x7a766c, 0.35)), "flSacking": (0.95, photo(HES, 0xa08a68, 0.8, 2.2)), "flStraw": (0.95, photo(HES, 0xe0c88a, 0.9, 1.4)),
    "flClay": (0.9, flat(srgb(0xa8644a), 0.3)), "flPot": (0.6, milprops._steel(0x2a2622, 0.1)), "flChar": (0.95, charred), "flAsh": (0.95, ash),
    "flWhite": (0.9, flat(srgb(0xd4cfc2), 0.3)), "flSkin": (0.8, flat(srgb(0x6a4a32), 0.3)), "flRope": (0.9, flat(srgb(0x9a8e70), 0.0)),
})
def LOW(): return drystone.LOW

def rod(K, nm, a, b, r, mat, t, n=8):
    return tag(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(4, n // 2)), t)
def log(K, nm, a, b, r, mat, t, R, bend=0.04):
    """A rough branch: two segments, a crook in the middle."""
    a, b = Vector(a), Vector(b)
    m = (a + b) / 2 + Vector((R.uniform(-bend, bend), R.uniform(-bend, bend) * 0.5, R.uniform(-bend, bend)))
    rod(K, nm + "a", tuple(a), tuple(m), r, mat, t, 7)
    rod(K, nm + "b", tuple(m), tuple(b), r * 0.9, mat, t, 7)
def lathe(K, nm, at, prof, mat, t, n=14, thick=0.01):
    """A surface of revolution: prof [(radius, height)…] from the foot up; open at the top (a jar, a pot)."""
    if LOW(): n = max(6, n // 2)
    bm = bmesh.new()
    rings = [[bm.verts.new(B(at[0] + r * math.cos(2 * math.pi * i / n), at[1] + h, at[2] + r * math.sin(2 * math.pi * i / n))) for i in range(n)] for r, h in prof]
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n; bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(rings[0])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = K.obj(nm, bm, mat, "h", smooth=True)
    so = o.modifiers.new("S", "SOLIDIFY"); so.thickness = thick; so.offset = -1.0
    return tag(o, t)
def jar(K, nm, at, t, s=1.0, broken=False):
    prof = [(0.1 * s, 0), (0.17 * s, 0.1 * s), (0.2 * s, 0.24 * s), (0.17 * s, 0.38 * s), (0.08 * s, 0.46 * s), (0.07 * s, 0.52 * s), (0.09 * s, 0.55 * s)]
    if broken:   # its belly only, the rest in shards about
        lathe(K, nm, at, prof[:3], "flClay", t)
        R = random.Random(len(nm))
        for k in range(4):
            stone(K, f"{nm}Shard{k}", (at[0] + R.uniform(-0.4, 0.4), 0.02, at[2] + R.uniform(-0.4, 0.4)), (0.07, 0.02, 0.05), R, t, mat="flClay", box=0.6)
        return
    lathe(K, nm, at, prof, "flClay", t)
def sack(K, nm, at, t, R, mat="flSacking"):
    tag(K.lump(nm, (at[0], 0.16, at[2]), (0.3, 0.2, 0.22), mat, "h", seed=R.randint(0, 99), rough=0.18, sub=2 if not LOW() else 1), t)
def hearth(K, R, x, z, t, scattered=False):
    for k in range(3):
        a = k / 3 * 2 * math.pi + 0.4
        r = 0.28 if not scattered else R.uniform(0.4, 0.9)
        stone(K, f"Hearth{k}", (x + r * math.cos(a), 0.09, z + r * math.sin(a)), (0.13, 0.11, 0.1), R, t, box=0.7)
    tag(K.lump("Ash", (x, 0.0, z), (0.32, 0.03, 0.3), "flAsh", "h", seed=3, rough=0.2, sub=1), t)
    if not scattered:
        lathe(K, "Pot", (x, 0.12, z), [(0.1, 0), (0.15, 0.05), (0.16, 0.14), (0.14, 0.2)], "flPot", t, 12, 0.008)
    else:
        lathe(K, "Pot", (x + 0.7, 0.0, z - 0.3), [(0.1, 0), (0.15, 0.05), (0.16, 0.14), (0.14, 0.2)], "flPot", t, 12, 0.008)
def firewood(K, R, x, z, t, burnt=False):
    for k in range(6):
        y = 0.05 + (k // 3) * 0.09
        dz = (k % 3 - 1) * 0.1 + R.uniform(-0.02, 0.02)
        rod(K, f"Wood{k}", (x - 0.45, y, z + dz), (x + 0.45, y + R.uniform(-0.02, 0.02), z + dz + R.uniform(-0.08, 0.08)), 0.045, "flChar" if burnt else "flLog", t, 6)

# ── THE REFUGE ────────────────────────────────────────────────────────────────────────────────────────────────────
MOUND = (0.6, 3.4, 3.2, 1.75)         # its centre z, half width, half depth, height (the old piece's)
DOOR_Z, DOOR_W, LINTEL = -0.95, 0.62, 1.08
def moundBase(x, z):
    """The hummock's height without its noise (the game plants its scrub on this — algSangar refugePlantSpots)."""
    cz, hx, hz, h = MOUND
    q = 1 - (x / hx) ** 2 - ((z - cz) / hz) ** 2
    return h * max(0.0, q) ** 1.6     # (a bell: it runs out into the ground — ** 0.8 ended in a step at its rim)

def mound(K, R, state, t):
    nx, nz = (46, 40) if not LOW() else (18, 16)
    off = Vector((R.uniform(0, 40), R.uniform(0, 40), 0))
    cz, hx, hz, h = MOUND
    def y(x, z):
        v = moundBase(x, z)
        if v > 0: v += 0.07 * mnoise.noise(Vector((x * 1.1, z * 1.1, 0)) + off)
        inTrench = abs(x) < DOOR_W + 0.2 and z < DOOR_Z
        if state == "ruin":           # caved in: the earth slumped forward into the trench
            if abs(x) < 1.4 and z < DOOR_Z + 0.6: v = max(v * 0.85, 0.75 * max(0.0, 1 - (abs(x) / 1.4) ** 2) * max(0.0, 1 - (DOOR_Z - z) / 1.6))
            return v - 0.05
        if inTrench:
            v = 0.0
            if state == "damaged":    # earth spilled into it from the broken lintel
                v = 0.45 * max(0.0, 1 - (DOOR_Z - z) / 0.9) * max(0.0, 1 - (abs(x) / (DOOR_W + 0.2)) ** 2)
        elif abs(x) < DOOR_W + 0.2 and z < DOOR_Z + 0.35:
            v = max(v, LINTEL + 0.2)  # the earth over the lintel and the roof logs
        return v - 0.05
    bm = bmesh.new()
    g = [[bm.verts.new(B(-hx - 0.2 + (2 * hx + 0.4) * i / nx, 0, cz - hz - 0.2 + (2 * hz + 0.4) * j / nz)) for j in range(nz + 1)] for i in range(nx + 1)]
    for row in g:
        for v in row:
            p = v.co; gx, gz = p.x, -p.y            # (B: game z → -Blender y)
            p.z = max(-0.06, y(gx, gz))
    for i in range(nx):
        for j in range(nz):
            q = (g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1])
            if all(v.co.z < -0.04 for v in q): continue          # (beyond the hummock: under the ground, not drawn)
            bm.faces.new(q)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    return tag(K.obj("Mound", bm, "flEarth", "h", smooth=True), t)

def cheeks(K, R, state):
    """The trench's dry-stone lining, both sides, from its mouth back to the door, course by course."""
    k = 0
    for s in (-1, 1):
        x = s * (DOOR_W + 0.32)
        y, c = 0.0, 0
        while y < LINTEL - 0.08:
            ch = R.uniform(0.2, 0.26)
            z = -2.05
            while z < DOOR_Z - 0.05:
                w = R.uniform(0.3, 0.46)
                zm = min(z + w / 2, DOOR_Z - 0.1)
                z += w + 0.01
                fallen = (state == "damaged" and c >= 2 and R.random() < 0.5) or (state == "ruin" and c >= 1)
                if fallen:
                    if state == "damaged": stone(K, f"C{k}", (x * 0.6 + R.uniform(-0.2, 0.2), 0.1 + 0.45 * R.random(), zm - R.uniform(0.2, 0.9)), (w * 0.45, ch * 0.5, 0.2), R, 0.5)
                    k += 1; continue
                stone(K, f"C{k}", (x + R.uniform(-0.03, 0.03), y + ch / 2, zm), (0.22, ch * 0.6, w * 0.55), R, 0.08 + 0.4 * y / LINTEL, yaw=math.pi / 2)
                k += 1
            y += ch * 0.92; c += 1

def door(K, R, state):
    for s in (-1, 1):
        log(K, f"Post{s}", (s * DOOR_W, -0.05, DOOR_Z), (s * DOOR_W, LINTEL, DOOR_Z), 0.07, "flLog", 0.55, R, 0.02)
    if state == "intact":
        log(K, "Lintel", (-DOOR_W - 0.45, LINTEL + 0.08, DOOR_Z - 0.02), (DOOR_W + 0.45, LINTEL + 0.08, DOOR_Z + 0.02), 0.1, "flLog", 0.6, R, 0.03)
    elif state == "damaged":   # snapped in the middle, both halves sagging onto the spilled earth
        log(K, "LintelA", (-DOOR_W - 0.45, LINTEL + 0.08, DOOR_Z), (0.05, 0.55, DOOR_Z - 0.15), 0.1, "flLog", 0.6, R, 0.02)
        log(K, "LintelB", (DOOR_W + 0.45, LINTEL + 0.08, DOOR_Z), (-0.02, 0.5, DOOR_Z - 0.3), 0.1, "flChar", 0.6, R, 0.02)
    if state != "ruin":
        for k in range(5):   # the roof logs over the door, back into the mound
            x = -DOOR_W + k * DOOR_W / 2
            log(K, f"Roof{k}", (x, LINTEL + 0.2, DOOR_Z - 0.12), (x + R.uniform(-0.05, 0.05), LINTEL + 0.22, DOOR_Z + 0.5), 0.06, "flLog", 0.62, R, 0.02)
    # THE BLANKET across the door (clothKit): hung from the lintel, gathered, its folds to the ground; the damaged one
    # torn down in a heap; none in the ruin
    if state == "intact":
        rest = lambda u, v: (-DOOR_W + 0.08 + (2 * DOOR_W - 0.16) * u, 0.02 + (LINTEL - 0.05) * v, DOOR_Z - 0.1 + 0.05 * math.sin(u * 22) * v)
        clothKit.drape(K, "Blanket", rest, 16, 18, lambda u, v: "flBlanketRed", 0.7, pins=lambda u, v: v > 0.96,
                       colliders=[("box", (-DOOR_W, DOOR_W, 0.0, LINTEL, DOOR_Z - 0.04, DOOR_Z + 0.3))], frames=50, stiff=20.0, key="RefugeBlanket")
    elif state == "damaged":
        rest = lambda u, v: (-0.5 + 1.0 * u, 0.5, DOOR_Z - 0.9 + 0.8 * v)
        clothKit.drape(K, "Blanket", rest, 16, 14, lambda u, v: "flBlanketRed", 0.7,
                       colliders=[("box", (-0.4, 0.4, 0.0, 0.3, DOOR_Z - 0.6, DOOR_Z - 0.1))], frames=50, stiff=20.0, key="RefugeBlanketDown")
    else:
        log(K, "Lintel", (-1.2, 0.2, DOOR_Z - 0.9), (0.9, 0.85, DOOR_Z - 0.2), 0.1, "flChar", 0.6, R, 0.02)

def buildRefuge(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    mound(K, R, state, 0.02)
    cheeks(K, random.Random(seed + 1), state)
    door(K, random.Random(seed + 2), state)
    S2 = random.Random(seed + 3)
    hearth(K, S2, 1.7, -2.5, 0.85, scattered=state != "intact")
    firewood(K, S2, 2.5, -1.5, 0.86, burnt=state == "ruin")
    if state != "ruin":
        sack(K, "Sack0", (-1.55, 0, -1.75), 0.88, S2)
        sack(K, "Sack1", (-1.95, 0, -1.45), 0.88, S2)
        jar(K, "Jar", (-1.35, 0.0, -2.35), 0.9, broken=state == "damaged")
        tag(K.lump("Skin", (-2.2, 0.09, -2.0), (0.28, 0.1, 0.17), "flSkin", "h", seed=5, rough=0.25, sub=2 if not LOW() else 1), 0.9)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

# ── THE INFIRMARY ─────────────────────────────────────────────────────────────────────────────────────────────────
IW, ID = 4.4, 3.0
POLES = [(-IW / 2, -ID / 2, 1.9), (0.0, -ID / 2, 2.0), (IW / 2, -ID / 2, 1.9), (-IW / 2, ID / 2, 1.25), (0.0, ID / 2, 1.3), (IW / 2, ID / 2, 1.25)]
PALLETS = [(-1.2, 0.35), (0.9, 0.35)]

def frame(K, R, state):
    down = state == "damaged"
    for i, (x, z, h) in enumerate(POLES):
        if down and i == 0:          # knocked away: on the ground in front
            log(K, f"Pole{i}", (x - 0.3, 0.06, z - 0.4), (x + 1.4, 0.06, z - 1.2), 0.06, "flLog", 0.3, R)
            continue
        log(K, f"Pole{i}", (x, -0.05, z), (x + R.uniform(-0.06, 0.06), h, z), 0.065, "flLog", 0.3, R)
        if not LOW():   # the fork the beam sits in
            for s in (-1, 1): rod(K, f"Fork{i}{s}", (x, h - 0.12, z), (x + s * 0.12, h + 0.08, z + s * 0.03), 0.03, "flLog", 0.3, 5)
    for k, (zz, hh) in enumerate(((-ID / 2, 1.95), (ID / 2, 1.3))):
        if down and k == 0:          # the front beam down at its left end
            log(K, "Beam0", (-IW / 2 - 0.2, 0.15, -ID / 2 - 0.2), (IW / 2 + 0.3, 2.02, -ID / 2), 0.07, "flLog", 0.4, R, 0.02)
            continue
        log(K, f"Beam{k}", (-IW / 2 - 0.3, hh + 0.05, zz), (IW / 2 + 0.3, hh + 0.05, zz), 0.07, "flLog", 0.4, R, 0.02)

def tarp(K, state):
    """THE PATCHWORK TARP (clothKit): canvas, two blankets, sacking sewn together, thrown over the two beams and tied
    at the poles, its slack hanging between; the damaged one\x27s front-left corner down onto the pallet."""
    x0, x1, z0, z1 = -IW / 2 - 0.45, IW / 2 + 0.45, -ID / 2 - 0.35, ID / 2 + 0.35
    def rest(u, v):
        x, z = x0 + (x1 - x0) * u, z0 + (z1 - z0) * v
        y = 2.2 + (1.55 - 2.2) * v - 0.25 * math.sin(math.pi * u * 2) ** 2 * math.sin(math.pi * v)   # (over the beams: tied on top of them)
        return (x, y, z)
    def mats(u, v):
        if u < 0.36 and v > 0.45: return "flBlanketGrey"
        if 0.62 < u and v < 0.5: return "flBlanketRed"
        if 0.4 < u < 0.62 and v > 0.7: return "flSacking"
        return "flCanvas"
    def pins(u, v):
        x = x0 + (x1 - x0) * u
        atPole = any(abs(x - px) < 0.14 for px in (-IW / 2, 0.0, IW / 2))
        edge = (v < 0.12 and v > 0.06) or (v > 0.88 and v < 0.94)    # tied at the beams, its hem hanging free beyond
        if state == "damaged" and x < -0.5 and v < 0.5: return False
        return atPole and edge
    beams = [("rod", (-IW / 2 - 0.3, 2.0, -ID / 2), (IW / 2 + 0.3, 2.0, -ID / 2), 0.08), ("rod", (-IW / 2 - 0.3, 1.35, ID / 2), (IW / 2 + 0.3, 1.35, ID / 2), 0.08)]
    if state == "damaged":
        beams[0] = ("rod", (-IW / 2 - 0.2, 0.15, -ID / 2 - 0.2), (IW / 2 + 0.3, 2.02, -ID / 2), 0.08)
    if state == "ruin":
        cols = [("box", (x - 0.45, x + 0.45, 0.0, 0.14, z - 0.95, z + 0.95)) for x, z in PALLETS]
        clothKit.drape(K, "Tarp", lambda u, v: (x0 + (x1 - x0) * u, 1.2, z0 + (z1 - z0) * v), 40, 30, lambda u, v: "flChar" if mnoise.noise(Vector((u * 3, v * 3, 0.3))) > -0.25 else mats(u, v),
                       0.45, colliders=cols, frames=70, key="InfTarpRuin")
        return
    cols = beams + [("box", (x - 0.75, x + 0.75, 0.0, 0.3, z - 1.0, z + 1.0)) for x, z in PALLETS]   # (the pallets and their blankets)
    cols += [("rod", (x, 0, z), (x, h, z), 0.07) for i, (x, z, h) in enumerate(POLES) if not (state == "damaged" and i == 0)]
    clothKit.drape(K, "Tarp", rest, 40, 30, mats, 0.45, pins=pins, colliders=cols, frames=60, stiff=25.0, key=f"InfTarp{state}")

def pallets(K, R, state):
    for k, (x, z) in enumerate(PALLETS):
        burnt = state == "ruin"
        tag(K.box(f"Pallet{k}", x - 0.42, x + 0.42, 0.0, 0.12 if not burnt else 0.06, z - 0.93, z + 0.93, "flChar" if burnt else "flStraw", "h", 0.05), 0.6)   # (a mattress: a lump read as a canoe)
        if burnt: continue
        # a blanket thrown over it (clothKit): dropped onto the straw, falls over its edge
        # (wider than the straw and dropped from higher: it falls over its edges in folds — a narrow one lay flat as a board)
        rest = lambda u, v, x=x, z=z: (x - 0.75 + 1.5 * u, 0.7 + 0.15 * u, z - 0.75 + 1.65 * v)
        clothKit.drape(K, f"Blanket{k}", rest, 18, 20, lambda u, v, k=k: "flBlanketGrey" if k else "flBlanketRed", 0.65,
                       colliders=[("box", (x - 0.42, x + 0.42, 0.0, 0.12, z - 0.93, z + 0.93))], frames=70, stiff=12.0, key=f"InfBlanket{k}")

def screen(K, R, state):
    """The low dry-stone screen behind (the weather side), two courses."""
    k = 0
    for c in range(2):
        x = -IW / 2 - 0.4 + (0.2 if c % 2 else 0)
        while x < IW / 2 + 0.4:
            w = R.uniform(0.35, 0.5)
            if state == "ruin" and R.random() < 0.5:
                stone(K, f"S{k}", (x + R.uniform(-0.3, 0.3), 0.12, ID / 2 + 0.5 + R.uniform(0.3, 1.0)), (w * 0.45, 0.13, 0.2), R, 0.05)
            else:
                stone(K, f"S{k}", (x + w / 2, 0.15 + c * 0.27, ID / 2 + 0.55), (w * 0.52, 0.16, 0.22), R, 0.05 + 0.1 * c, yaw=0.0)
            x += w + 0.01; k += 1

def buildInfirm(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    screen(K, random.Random(seed + 1), state)
    if state != "ruin":
        frame(K, random.Random(seed + 2), state)
    else:
        for i, (x, z, h) in enumerate(POLES[:3]):
            log(K, f"Pole{i}", (x, 0.05, z - 0.3), (x + 1.2, 0.06, z - 1.6), 0.06, "flChar", 0.3, R)
    tarp(K, state)
    pallets(K, random.Random(seed + 3), state)
    S2 = random.Random(seed + 4)
    if state != "ruin":
        # the stretcher in front: two poles, the canvas
        for s in (-1, 1): rod(K, f"Str{s}", (-0.2 + s * 0.28, 0.06, -3.3), (-0.2 + s * 0.28, 0.06, -1.1), 0.035, "flLog", 0.8, 6)
        clothKit.drape(K, "StrCanvas", lambda u, v: (-0.45 + 0.5 * u, 0.12, -3.05 + 1.7 * v), 6, 12, lambda u, v: "flCanvas", 0.8,
                       pins=lambda u, v: u < 0.01 or u > 0.99, frames=30, stiff=30.0, key="InfStretcher")
        tag(K.box("Dressings", IW / 2 - 1.15, IW / 2 - 0.65, 0, 0.3, -1.18, -0.82, "flWood", "h", 0.01), 0.85)
        tag(K.box("Linen", IW / 2 - 1.1, IW / 2 - 0.7, 0.3, 0.34, -1.14, -0.86, "flWhite", "h", 0.01), 0.86)
        jar(K, "Jar", (IW / 2 - 0.2, 0.0, -1.2), 0.9, broken=state == "damaged")
    hearth(K, S2, IW / 2 + 0.3, -2.4, 0.88, scattered=state != "intact")
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farRefuge = lambda K, n, s, st, sd: buildRefuge(K, n, s, st, sd, far=True)
farInfirm = lambda K, n, s, st, sd: buildInfirm(K, n, s, st, sd, far=True)
TYPES = {"refuge": dict(builder=buildRefuge, farBuilder=farRefuge, atlas=2048, normalAtlas=1024, aoDist=0.5, smoothAngle=45, weighted=False, normals=True),
         "infirm": dict(builder=buildInfirm, farBuilder=farInfirm, atlas=2048, normalAtlas=1024, aoDist=0.4, smoothAngle=45, weighted=False, normals=True)}
exported = buildKit(TYPES, MATDEF, "flnposts.glb", prefix="Fln", seed0=1955, colors=True)

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
    cd.lens = 35; cam.location = B(4, 6, -9)
    cam.rotation_euler = (B(0, 0.8, -0.5) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
