"""THE HELIPAD IN BLENDER (2026-11-01, you: "ok lets build an helipad" — the last building without its damaged and ruin
states; the code one, rtsAlgeria buildHelipadV2, was only charred when it fell). What an Aurès post's hélisurface was:
a levelled patch of RAMMED EARTH graded into a low platform, its edges rolling down into the ground, its centre scoured
paler by the rotors; the edge picked out in WHITEWASHED STONES a pace apart, a few out of line; corner cairns and their
stakes; the path's stones toward the post; the WINDSOCK's mast on its footing, guyed; the FUEL POINT off the right side
(drums on pallets, a hand pump, jerrycans, spares under a tarp, a stretcher, the extinguisher on its stake); the RADIO
CORNER off the back-left corner (the set on a crate, its whip). Grit blown out by the rotors; wheel chocks.

The game keeps what the code piece carried (algSangar loadHelipad copies its data): the lime H and circle PAINTED on
(rtsPaint, along this very surface — the platform here IS the old one's, the same formula and seed, so the paint lies on
it), the windsock's cloth (algWind, on this mast's top), the cloth-simulated sandbag walls in their slots, the signal
panels (stencils), the deck height the helicopters land at, the construction's site dressing.

    INTACT    as above
    DAMAGED   two shells on the deck's outer ring (clear of the H): craters, their rims thrown up, the earth scorched round
              them; the edge stones scattered; two drums knocked over and one holed, the tarp blown off its crates
    RUIN      shelled and burnt: craters across the deck (the H gone — the game hides its paint), the earth scorched;
              the fuel point burnt out (charred drums thrown about, the pallets burnt), the windsock's mast down, its
              guys loose; the radio set smashed, the edge stones everywhere

  BUILD ORDER (COLOR_0, the old piece's): the graded earth (slopes, the deck, its centre), the grit, the corner cairns,
  the edge stones round all four sides, the path, (the paint: the game's, 0.64 → 0.88), the mast raised, its guys, the
  fuel point piece by piece, the chocks.

Kit metres (the game ×1.3); the front at -Z; the deck 15 m (D 7.5).

  node tools/blenderKit.mjs helipad [--quick]

Writes helipad.glb (HeliHelipad_<State>; its far level made by tools/lod — autoLod).
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit
from bkit import B, srgb, dust, flat
import drystone
from drystone import tag
import milprops
import props

D, TOP, FALL, SEED = 7.5, 0.16, 2.2, 23   # (rtsAlgeria buildHelipadV2: the deck's half side, its top, the slopes' run, the seed)

def hAt0(x, z):
    """The old piece's platform, to the letter (its paint is laid on this surface): flat inside, a little unevenness,
    rolling down past the deck's wandering edge."""
    a = math.atan2(z, x); wob = 0.28 * math.sin(3 * a + SEED) + 0.18 * math.sin(7 * a - SEED * 2)
    e = max(abs(x), abs(z)) - D - wob
    k = 0.0 if e <= 0 else min(1.0, e / FALL)
    s = k * k * (3 - 2 * k)
    lump = 0.025 * math.sin(x * 1.7 + SEED) * math.sin(z * 1.3 - SEED) + 0.015 * math.sin(x * 4.1 + z * 3.3)
    return (TOP + lump) * (1 - s) - 0.06 * s

# THE CRATERS per state (x, z, radius, depth): the damaged one's on the deck's outer ring and off it — clear of the paint
# (the H and its circle, r < 5.2: their paint lies on the surface as it was); the ruin's across the deck (its paint hidden)
CRATERS = {"intact": [], "damaged": [(5.9, -4.6, 1.3, 0.38), (-6.4, 5.4, 1.1, 0.32)],
           "ruin": [(5.9, -4.6, 1.3, 0.38), (-6.4, 5.4, 1.1, 0.32), (0.6, -0.8, 1.6, 0.45), (-3.6, -4.2, 1.2, 0.34), (3.4, 4.1, 1.0, 0.3)]}

def hAt(x, z, state):
    y = hAt0(x, z); inBowl = False
    for cx, cz, r, dep in CRATERS[state]:
        d = math.hypot(x - cx, z - cz) / r
        if d < 1.0: y -= dep * (1 - d * d) ** 1.5; inBowl = True       # the bowl
        elif d < 1.7: y += dep * 0.32 * math.sin((d - 1.0) / 0.7 * math.pi)   # its rim, thrown up
    # (its floor 3 cm over the ground the game levels under the pad: deeper, the map's own ground showed through as a
    # bright flat disc — the game, 2026-11-01)
    return max(y, 0.03) if inBowl else y

def scorch(x, z, state):
    """0..1: how burnt the ground is here (the craters' blast, the ruin's fire)."""
    k = 0.0
    for cx, cz, r, dep in CRATERS[state]:
        k = max(k, 1.0 - math.hypot(x - cx, z - cz) / (r * 2.2))
    if state == "ruin":
        k = max(k, 0.7 - math.hypot(x - (D + 2.9), z - 1.4) / 6.0)   # (the fuel point's fire)
    return k

def earthPad(nb):
    """THE PLATFORM'S EARTH, one material (2026-11-01: per-cell materials read as stair steps — the scoured centre's
    circle, the craters' scorch): the graded slopes' loose soil → the rammed deck (its vertices' "deck") → the centre
    scoured pale by the rotors ("scour") → charred round the shells ("scorch"); each a per-vertex value, smooth."""
    attr = lambda n: (lambda a: (setattr(a, "attribute_name", n), a.outputs["Fac"])[1])(nb.N.new("ShaderNodeAttribute"))
    tone = lambda base, light: nb.mix(nb.noise(1.1, 4), srgb(base), srgb(light))
    c = nb.mix(attr("deck"), tone(0x8e7454, 0xa08462), tone(0xa88c66, 0xb89c74))
    c = nb.mix(attr("scour"), c, tone(0xc2a882, 0xd0b892))
    c = nb.mix(nb.mr(nb.noise(5.0, 5), 0.55, 0.7), c, nb.scale(c, 0.88))                       # clods, darker
    c = dust(nb, c, 0.3, 0.5)
    k = nb.math("MULTIPLY", attr("scorch"), nb.mr(nb.noise(2.5, 4), 0.3, 0.7, 0.6, 1.25))
    return nb.mix(nb.math("MINIMUM", k, 1.0), c, nb.mix(nb.noise(3.0, 5), srgb(0x231d18), srgb(0x463a2e)))
def lime(nb):   # the whitewash on the stones: chalky, flaking to the grey stone under it
    c = nb.mix(nb.noise(3.0, 4), srgb(0xe8e4d8), srgb(0xd2ccbc))
    return nb.mix(nb.mr(nb.noise(9.0, 5), 0.62, 0.72), c, srgb(0x9a9284))
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update(props.PROP_MATS)
MATDEF.update({
    # (the names start "earth": the game lays its soil photo over them — algGroundBlend earthDetail)
    "earthPad": (1.0, earthPad),
    "hpLime": (0.9, lime), "hpStone": (0.95, flat(srgb(0xb8a88a), 0.3)), "hpConcrete": (0.95, flat(srgb(0xa49e90), 0.3)),
    "hpWhite": (0.6, flat(srgb(0xdcd8cc), 0.2)), "hpSteel": (0.5, milprops._steel(0x3a3c38, 0.35)), "hpOlive": (0.6, milprops._steel(0x4a523a, 0.25)),
    "hpRubber": (0.9, flat(srgb(0x1a1a18), 0.0)), "hpRed": (0.7, flat(srgb(0x8a1e18), 0.2)),
    "hpTimber": (0.85, milprops.timberMat(0x8a7a5c)), "hpPallet": (0.85, milprops.timberMat(0x9a8a6a)), "hpCanvas": (0.95, lambda nb: dust(nb, nb.mix(nb.noise(1.4, 4), srgb(0x6c6a4c), srgb(0x7c7a58)), 0.5, 0.7)),
    "hpRope": (0.9, flat(srgb(0x9a8e70), 0.0)), "hpChar": (0.95, charred),
    "drumOlive": (0.6, props.drum_paint(0x4d5536, 0.4)), "drumSteel": (0.5, props.steel_paint(0x6a6a66, 0.3)),
})
LOW = lambda: drystone.LOW
G = "h"

def make(K, t):
    return lambda n, bm, m: tag(K.obj(n, bm, m, G, smooth=True), t)
def rod(K, nm, a, b, r, mat, t, n=6):
    return tag(K.rod(nm, a, b, r, mat, G, n), t)
def box(K, nm, c, size, yaw, mat, t, w=0.008, tilt=0.0):
    """A box of full size (x, y, z), its foot at c, turned yaw about y (and tipped `tilt` about its x)."""
    cx, cy, cz = c; co, si = math.cos(yaw), math.sin(yaw); ct, st = math.cos(tilt), math.sin(tilt)
    bm = bmesh.new(); vs = []
    for sx in (-1, 1):
        for sy in (0, 1):
            for sz in (-1, 1):
                lx, ly, lz = sx * size[0] / 2, sy * size[1], sz * size[2] / 2
                ly, lz = ly * ct - lz * st, ly * st + lz * ct
                vs.append(bm.verts.new(B(cx + lx * co + lz * si, cy + ly, cz - lx * si + lz * co)))
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.bevel(K.obj(nm, bm, mat, G), w if not LOW() else 0), t)
def stoneAt(K, R, nm, x, z, s, t, state, mat="hpLime", lift=0.25):
    return tag(drystone.stone(K, nm, (x, hAt(x, z, state) + s * lift, z), (s * 1.3, s * 0.75, s), R, t, mat=mat, box=0.6), t)

def platform(K, state):
    """THE GRADED EARTH: one grid (finer than the old one's: the paint lies within a centimetre), one material; its
    vertices carry how much DECK (vs slope), how SCOURED (the rotors' pale centre) and how SCORCHED they are."""
    N = 60 if not LOW() else 30
    half = D + FALL; cell = 2 * half / N
    sm = lambda u: (lambda q: q * q * (3 - 2 * q))(max(0.0, min(1.0, u)))
    bm = bmesh.new(); vmap = {}
    L = {n: bm.verts.layers.float.new(n) for n in ("deck", "scour", "scorch")}
    def v(x, z):
        k = (round(x, 4), round(z, 4))
        if k not in vmap:
            q = bm.verts.new(B(x, hAt(x, z, state), z))
            a = math.atan2(z, x); wob = 0.28 * math.sin(3 * a + SEED) + 0.18 * math.sin(7 * a - SEED * 2)
            q[L["deck"]] = sm(1.0 - (max(abs(x), abs(z)) - D - wob) / 0.6)
            q[L["scour"]] = sm((5.6 - math.hypot(x, z)) / 1.2) * 0.9
            q[L["scorch"]] = sm(scorch(x, z, state) * 1.6)
            vmap[k] = q
        return vmap[k]
    for i in range(N):
        for j in range(N):
            x0, z0 = -half + i * cell, -half + j * cell; x1, z1 = x0 + cell, z0 + cell
            bm.faces.new((v(x0, z0), v(x0, z1), v(x1, z1), v(x1, z0)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    tag(K.obj("Ground", bm, "earthPad", G, smooth=True), 0.03)

def buildHelipad(K, name, spec, state, seed, far=False):
    R = random.Random(seed); dmg, ruin = state != "intact", state == "ruin"
    platform(K, state)
    # GRIT blown out by the rotors: small ochre stones toward the deck's edge (with the grading)
    for k in range(70 if not LOW() else 20):
        a = R.uniform(0, 2 * math.pi); r = 4.5 + math.sqrt(R.random()) * (D - 4.3)
        x, z = math.cos(a) * r, math.sin(a) * r
        if max(abs(x), abs(z)) > D - 0.3: continue
        stoneAt(K, R, f"Grit{k}", x, z, R.uniform(0.07, 0.13), 0.18 + 0.12 * k / 70, state, mat="hpStone", lift=0.15)
    # THE CORNER CAIRNS: three stones piled, a stake
    for c, (sx, sz) in enumerate(((-1, -1), (1, -1), (-1, 1), (1, 1))):
        cx, cz = sx * (D + 0.5), sz * (D + 0.5); y0 = hAt(cx, cz, state); t = 0.33 + 0.01 * c
        if ruin and c == 1:   # (one blown apart)
            for k in range(3): stoneAt(K, R, f"Cairn{c}_{k}", cx + R.uniform(-1.4, 1.4), cz + R.uniform(-1.4, 1.4), 0.2, t, state)
            continue
        for k in range(3):
            tag(drystone.stone(K, f"Cairn{c}_{k}", (cx + R.uniform(-0.15, 0.15), y0 + 0.1 + (0.2 if k == 2 else 0.0), cz + R.uniform(-0.15, 0.15)), (0.26, 0.15, 0.2), R, t, mat="hpLime", box=0.6), t)
        rod(K, f"Stake{c}", (cx, y0 - 0.1, cz), (cx + R.uniform(-0.05, 0.05), y0 + 1.0, cz + R.uniform(-0.05, 0.05)), 0.032, "hpTimber", t + 0.005, 5)
    # THE EDGE: whitewashed stones a pace apart, round all four sides at once, a few out of line (scattered by the shells)
    pitch = 1.1; n = round(2 * D / pitch); k = 0
    for i in range(n + 1):
        u = -D + i * 2 * D / n
        for x, z in ((u, -D), (u, D), (-D, u), (D, u)):
            if (i == 0 or i == n) and x != u: continue
            if R.random() < 0.05: continue
            off = (R.random() - 0.5) * 1.2 if R.random() < 0.08 else (R.random() - 0.5) * 0.12
            x2 = x + (off * 0.3 if abs(x) == D else off); z2 = z + (off * 0.3 if abs(z) == D else off)
            if dmg:   # (thrown out by a near shell — or by the ruin's anywhere)
                near = min([math.hypot(x2 - cx, z2 - cz) / r for cx, cz, r, d in CRATERS[state]] + [9])
                if near < 2.6 or (ruin and R.random() < 0.3):
                    a = R.uniform(0, 2 * math.pi); d = R.uniform(0.8, 2.5); x2 += math.cos(a) * d; z2 += math.sin(a) * d
            stoneAt(K, R, f"Edge{k}", x2, z2, R.uniform(0.17, 0.26), 0.36 + 0.26 * i / n, state); k += 1
    # THE PATH to the post (-x): a double row of whitewashed stones on the slope
    for i in range(3):
        for z in (-0.85, 0.85):
            if R.random() > 0.08: stoneAt(K, R, f"Path{i}{z}", -D - 0.5 - i * 0.8 + R.uniform(-0.07, 0.07), z + R.uniform(-0.06, 0.06), R.uniform(0.13, 0.18), 0.62 + 0.02 * i, state)
    # WHEEL CHOCKS by the H (gone in the ruin)
    if not ruin:
        for j, (x, z, a) in enumerate(((3.2, -1.8, 0.2), (3.5, -1.2, 0.3))):
            box(K, f"Chock{j}", (x, hAt(x, z, state) - 0.01, z), (0.22, 0.14, 0.35), a, "hpTimber", 0.97)
    mast(K, R, state)
    fuelPoint(K, R, state)
    radioCorner(K, R, state)
    bpy.context.view_layer.update()   # (the props placed by matrix: where they were placed, before any join)
    drystone.writeBuildOrder(K)

WX, WZ, MH = D + 1.6, D + 0.6, 5.5   # (the windsock's mast: buildHelipadV2's wx, wz, mH — the game's sock hangs at its top)
def mast(K, R, state):
    wy = hAt(WX, WZ, state)
    box(K, "MastFoot", (WX, wy - 0.1, WZ), (0.55, 0.3, 0.55), 0.0, "hpConcrete", 0.89, w=0.02)
    if state == "ruin":
        # (down: snapped at its foot, lying away from the deck; its guys slack on the ground)
        rod(K, "Mast", (WX, wy + 0.2, WZ), (WX + 1.2, wy + 0.12, WZ + 5.2), 0.055, "hpWhite", 0.89, 8)
        for g in range(3):
            a = g / 3 * 2 * math.pi + 0.4; gx, gz = WX + math.cos(a) * 2.2, WZ + math.sin(a) * 2.2
            rod(K, f"Guy{g}", (gx, 0.06, gz), (WX + 0.8 + g * 0.2, 0.06, WZ + 3.6), 0.009, "hpSteel", 0.91, 4)
            box(K, f"Peg{g}", (gx, -0.15, gz), (0.07, 0.3, 0.07), a, "hpSteel", 0.91, 0, 0.25)
        return
    rod(K, "Mast", (WX, wy + 0.1, WZ), (WX, MH, WZ), 0.055, "hpWhite", 0.89, 8)
    for g in range(3):
        a = g / 3 * 2 * math.pi + 0.4; gx, gz = WX + math.cos(a) * 2.2, WZ + math.sin(a) * 2.2
        rod(K, f"Guy{g}", (WX, MH - 1.1, WZ), (gx, 0.1, gz), 0.009, "hpSteel", 0.91, 4)
        box(K, f"Peg{g}", (gx, -0.15, gz), (0.07, 0.3, 0.07), a, "hpSteel", 0.91, 0, 0.25)

FX, FZ = D + 2.9, 1.4   # (the fuel point: buildHelipadV2's fx, fz — the game's sandbag slots are round it)
def fuelPoint(K, R, state):
    dmg, ruin = state != "intact", state == "ruin"
    t0 = 0.9
    for r in range(2):   # the pallets
        box(K, f"Pallet{r}", (FX - 0.3 + r * 1.3, 0.0, FZ), (1.25, 0.12, 2.5), 0.0, "hpChar" if ruin else "hpPallet", t0 + 0.005 * r)
    k = 0
    for r in range(2):   # the drums, four a pallet (most army olive)
        for j in range(4):
            x, z = FX - 0.6 + r * 1.3 + (j % 2) * 0.62, FZ - 0.95 + (j // 2) * 0.66
            t = t0 + 0.01 + 0.06 * k / 8
            if ruin:   # (burnt, thrown about by the fire's bursts: some upright, some on their sides)
                if R.random() < 0.45:
                    a = R.uniform(0, 2 * math.pi); d = R.uniform(1.5, 4.5)
                    props.place(props.drum(make(K, t), f"Drum{k}", "hpChar", "hpSteel", low=LOW(), burnt=True, seed=k, dent=0.5),
                                (x + math.cos(a) * d, 0.29, z + math.sin(a) * d), R.uniform(0, 6), math.pi / 2)
                else:
                    props.place(props.drum(make(K, t), f"Drum{k}", "hpChar", "hpSteel", low=LOW(), burnt=True, seed=k, dent=0.3), (x, 0.12, z), R.uniform(0, 6))
            elif dmg and k in (1, 6):   # (two knocked over off the pallet, dented)
                props.place(props.drum(make(K, t), f"Drum{k}", "drumOlive", "hpSteel", low=LOW(), seed=k, dent=0.6), (x + 0.9, 0.29, z + 0.4), R.uniform(0, 6), math.pi / 2)
            else:
                props.place(props.drum(make(K, t), f"Drum{k}", "drumOlive" if R.random() < 0.7 else "drumSteel", "hpSteel", low=LOW(), seed=k), (x, 0.12, z), R.uniform(0, 6))
            k += 1
    # two on their chocks
    for j in range(2):
        box(K, f"DrumChock{j}", (FX - 0.4 + j * 0.72, 0.0, FZ + 2.3), (0.14, 0.14, 1.1), 0.0, "hpChar" if ruin else "hpTimber", 0.95)
        if not ruin:
            props.place(props.drum(make(K, 0.95), f"DrumLying{j}", "drumOlive", "hpSteel", low=LOW(), seed=20 + j), (FX - 0.04 - 0.44, 0.44, FZ + 1.95 + j * 0.64 - 0.05), math.pi / 2, math.pi / 2)
    if not ruin:
        # the hand pump on the end drum, its hose down to the ground
        rod(K, "Pump", (FX - 0.29, 0.98, FZ - 0.95), (FX - 0.29, 1.4, FZ - 0.95), 0.05, "hpSteel", 0.96, 8)
        rod(K, "PumpArm", (FX - 0.29, 1.35, FZ - 0.95), (FX - 0.02, 1.52, FZ - 1.05), 0.016, "hpSteel", 0.96, 5)
        pts = [(FX - 0.29, 0.95, FZ - 0.95), (FX - 0.75, 0.4, FZ - 0.85), (FX - 1.1, 0.05, FZ - 0.7)] + \
              [(FX - 1.35 + math.cos(k * 0.6) * (0.4 - k * 0.012), 0.05 + k * 0.004, FZ - 0.6 + math.sin(k * 0.6) * (0.4 - k * 0.012)) for k in range(12)]
        for k in range(len(pts) - 1): rod(K, f"Hose{k}", pts[k], pts[k + 1], 0.028, "hpRubber", 0.96, 5)
        # jerrycans by the pallets
        for j in range(4):
            box(K, f"Jerry{j}", (FX - 1.25 + (j % 2) * 0.22, 0.0, FZ + 0.4 + (j // 2) * 0.4), (0.17, 0.46, 0.34), R.uniform(-0.2, 0.2), "hpOlive", 0.97, 0.01, 1.4 if j == 3 else 0.0)
    # SPARES under a tarp (blown off in the damaged; burnt with them in the ruin)
    cr = (FX + 0.4, 0.0, FZ - 2.4)
    box(K, "Spares", cr, (1.6, 0.7, 1.0), 0.0, "hpChar" if ruin else "hpTimber", 0.97, 0.015)
    if state == "intact":
        tarp(K, "Tarp", lambda u, v: (cr[0] - 0.9 + 1.8 * u, 0.72 + 0.06 * math.sin(math.pi * u) - 0.65 * max(0.0, abs(v - 0.5) * 2 - 0.55) / 0.45 * 0.9, cr[2] - 0.62 + 1.24 * v), 0.97)
    elif state == "damaged":
        tarp(K, "Tarp", lambda u, v: (cr[0] - 2.4 + 1.6 * u, 0.04 + 0.08 * math.sin(math.pi * v) * math.sin(math.pi * u), cr[2] + 0.6 + 1.1 * v), 0.97)
    # the stretcher leaning on the bags, the extinguisher on its stake
    if not ruin:
        for sx in (-1, 1): rod(K, f"Stretcher{sx}", (FX - 2.0, 0.0, FZ - 0.2 + sx * 0.27), (FX - 1.15, 1.25, FZ - 0.2 + sx * 0.27), 0.03, "hpTimber", 0.98, 5)
        tarp(K, "StretcherCanvas", lambda u, v: (FX - 1.9 + 0.68 * u, 0.15 + 0.98 * u, FZ - 0.45 + 0.5 * v), 0.98)
    sx, sz = D + 0.9, -D + 0.6
    rod(K, "ExtStake", (sx, -0.1, sz), (sx, 1.1 if not ruin else 0.5, sz), 0.033, "hpTimber", 0.98, 5)
    if not ruin: tag(K.cyl("Extinguisher", (sx, 0.64, sz - 0.12), 0.09, 0.42, "hpRed", G, 10), 0.98)

def tarp(K, nm, fn, t, nu=6, nv=4):
    """A canvas: fn(u, v) → game point; both faces (solidified)."""
    bm = bmesh.new()
    g = [[bm.verts.new(B(*fn(i / nu, j / nv))) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv): bm.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
    o = K.obj(nm, bm, "hpCanvas", G, smooth=True)
    so = o.modifiers.new("S", "SOLIDIFY"); so.thickness = 0.012; so.offset = 0.0
    return tag(o, t)

def radioCorner(K, R, state):
    """Off the deck's back-left corner, clear of the rotors (its L of sandbags: the game's): the set (an ANGRC-9's olive
    case) on a crate, its whip antenna, a jerrycan."""
    rx, rz = -D - 1.4, -D + 1.2; ry = hAt(rx, rz, state); ruin = state == "ruin"
    box(K, "RadioCrate", (rx + 0.15, ry - 0.02, rz - 0.3), (0.62, 0.44, 0.46), 0.12, "hpChar" if ruin else "hpTimber", 0.9)
    if ruin:   # (the set thrown off, smashed open)
        box(K, "Radio", (rx + 0.9, ry - 0.02, rz + 0.5), (0.44, 0.3, 0.26), 1.1, "hpChar", 0.9, 0.01, 0.3)
        return
    box(K, "Radio", (rx + 0.15, ry + 0.42, rz - 0.32), (0.44, 0.3, 0.26), 0.12, "hpOlive", 0.9)
    tip = (rx + 0.36, ry + 3.1, rz - 0.4) if state == "intact" else (rx + 1.2, ry + 2.4, rz + 0.3)
    rod(K, "Whip", (rx + 0.32, ry + 0.74, rz - 0.38), tip, 0.008, "hpSteel", 0.9, 4)
    box(K, "RadioJerry", (rx - 0.4, ry - 0.02, rz + 0.25), (0.17, 0.46, 0.34), 0.5, "hpOlive", 0.9)

TYPES = {"helipad": dict(builder=buildHelipad, autoLod=True, atlas=2048, aoDist=0.6, smoothAngle=45)}
exported = buildKit(TYPES, MATDEF, "helipad.glb", prefix="Heli", seed0=1957, colors=True)
