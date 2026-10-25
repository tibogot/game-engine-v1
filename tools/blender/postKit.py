"""THE FRENCH POST IN BLENDER (2026-10-22 — you: "should we do a better base in blender?" … "do the Blender post first,
as always in our lab, very optimised"): the bordj every valley had by 1957, the playable side's HQ — redone at the
whitewashed houses' standard (house.py's lime render over rubble, its stone, its wood), on the OLD piece's exact
layout (v3/render/objects/rtsFrenchPost.js buildFrenchPost, detail 2): the game reads its data — the gate and its
leaves, the tower guns' muzzles, the sandbag slots (the user's cloth-simulated bags go there), the flag's mount, the
footprint, the cover lines.

  WALLS     22 m square, 3.2 m: the rubble footing, the lime render (fallen off in patches), a heavy parapet with its
            coping and slits, buttresses stepping down the outer face, loopholes, the stone banquette inside
  TOWERS    two on the diagonal (5 m, 6.8 m): a stone talus, string course, corbelled parapet with slits, the
            AA-52 on its tripod on an ammunition-box step (milprops); the sandbag ring is the game's sim
  GATEHOUSE the arch (a real opening), pilasters, the threshold, a parapet and the bretèche over the arch
  BLOCKS    the barracks along the back wall, the command post on the left: real doors and windows (cut), shutters,
            the roof in use (water tank, stovepipes, the look-out's posts and tarp, washing line, the radio's crate),
            the ladder up from the yard
  YARD      the radio mast (a guyed lattice), the flag's plinth, the parade square's whitewashed stones, the vehicle
            shed (corrugated lean-to, drums, a tyre), the squad tent (cloth), the mortar (the post's pit), stores, a
            water tower
  WIRE      pickets and strands round it, crossed between the pickets

    DAMAGED   a breach in the right wall, the back tower's parapet shot away, the bretèche gone, the barracks' roof
              fallen in at one end, the mast's top bent, rubble at the walls' feet
    RUIN      the walls broken down to jagged stumps, the towers to their lower storey, the blocks roofless shells,
              the mast down across the yard, rubble everywhere

  BUILD ORDER (COLOR_0): the footing, the walls, the towers, the gate, the blocks, the mast, the yard, the wire.

Real metres (the game x1.3); the gate at -Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/postKit.py -- <out dir> [--quick]

Writes <out>/postkit.glb (BordjPost_<State> + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, Matrix
import props
import house
from house import buildKit, paintedWood
from bkit import B, gv, srgb, dust, flat, wood
import drystone
from drystone import tag
import milprops
import clothKit

L, H, T = 22.0, 3.2, 0.6
HL = L / 2
GATE_W = 3.4
TW, TH = 5.0, 6.8
GH, GW, GD = 5.4, GATE_W + 3.2, 1.4
GZ = -HL - 0.1
TOWERS = [(-HL + TW / 2 - 1.0, -HL + TW / 2 - 1.0), (HL - TW / 2 + 1.0, HL - TW / 2 + 1.0)]
BARRACKS = dict(x=1.5, z=HL - T - 3.4, w=14, d=6, h=3.3, side=-1, doors=2, windows=6, roof="barracks")
COMMAND = dict(x=-HL + T + 3.3, z=-0.4, w=6, d=8, h=3.6, side=1, doors=1, windows=2, roof="command")
MAST = (-HL + T + 2.0, 5.8, 14.0)

def galv(rust):
    def f(nb):
        c = nb.mix(nb.noise(1.1, 3), srgb(0x8f9493), srgb(0x6c7272))
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.1))
        m = nb.mr(nb.noise(2.6, 6, 0.6, (9, 0.6, 9)), 0.7 - rust * 0.3, 0.78 - rust * 0.24)
        rc = nb.mix(nb.noise(16.0, 4), srgb(0x7e4b2e), srgb(0x4c2e1f))
        return dust(nb, nb.mix(m, c, rc), 0.9, 0.8)
    return f
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
def limestoneRubble(nb):
    """The bordj's rubble footing, its render fallen off in patches — of LIMESTONE (2026-10-25: the houses' rubble, a
    mossy slate photo, baked sharp at last read as green camouflage; the game tiles these same blocks over it,
    algSangar SURFACE_DETAIL.stone)."""
    s = nb.mix(0.3, nb.img("build/seaworn_stone_tiles/seaworn_stone_tiles_diff_1k.jpg", 0.45), srgb(0xc9b797))
    r = nb.mix(0.6, nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.9), srgb(0xe0d8c8))
    c = nb.mix(nb.mr(nb.noise(3.0, 5, 0.6), 0.45, 0.55), s, r)
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.05)), 2.0, 1.2)
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update({
    "rubble": (0.95, limestoneRubble),
    "poSlit": (1.0, flat(srgb(0x15120e), 0.0)), "poCoping": (0.9, flat(srgb(0x8a8376), 0.6)), "poConcrete": (0.95, flat(srgb(0x8e877a), 0.4)),   # (darker: the outline the old post drew)
    "poShutter": (0.8, paintedWood(0x4e5638)), "poDoor": (0.8, paintedWood(0x5a4a32)), "poRoof": (0.7, galv(1.0)), "poTank": (0.6, milprops._steel(0x55603f, 0.3)),
    "poDrum": (0.6, props.drum_paint(0x4d5a3a, 0.35)), "poSteel": (0.5, milprops._steel(0x3a3c38, 0.35)), "poCanvas": (0.95, flat(srgb(0x6e6e4c), 0.4)),
    "poRope": (0.9, flat(srgb(0x9a8e70), 0.0)), "poChar": (0.95, charred), "poRubber": (0.8, flat(srgb(0x1c1c1a), 0.0)),
})
def LOW(): return drystone.LOW

# ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
def hull(K, nm, pts, mat, t, bev=0.0):
    bm = bmesh.new()
    vs = [bm.verts.new(B(*p)) for p in pts]
    bmesh.ops.convex_hull(bm, input=vs)
    o = K.obj(nm, bm, mat, "h")
    if bev and not LOW(): K.bevel(o, bev, 1, 40)
    return tag(o, t)
def box(K, nm, x0, x1, y0, y1, z0, z1, mat, t, bev=0.0):
    return hull(K, nm, [(x, y, z) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)], mat, t, bev)
def corrugated(K, nm, o, aw, al, width, length, mat, t, pitch=0.1, depth=0.025):
    """A corrugated sheet (mirador.py's): corner o, waves across aw, length along al (game vectors); thin, both faces."""
    o, aw, al = gv(*o), gv(*aw).normalized(), gv(*al).normalized()
    an = aw.cross(al).normalized()
    if an.y < 0: an = -an
    N_ = max(2, round(width / pitch * (4 if not LOW() else 1)))
    bm = bmesh.new(); rows = []
    for i in range(N_ + 1):
        w = width * i / N_
        off = depth / 2 * math.sin(2 * math.pi * w / pitch) if not LOW() else 0
        p = o + aw * w + an * off
        rows.append((bm.verts.new(B(*p)), bm.verts.new(B(*(p + al * length)))))
    for i in range(N_):
        bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
    ob = K.obj(nm, bm, mat, "h", smooth=True)
    so = ob.modifiers.new("S", "SOLIDIFY"); so.thickness = 0.004; so.offset = -1.0
    return tag(ob, t)
def rod(K, nm, a, b, r, mat, t, n=8):
    return tag(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(4, n // 2)), t)

class Run:
    """A wall run: local u along it (−len/2..len/2), v INTO the courtyard from the wall's centre line, y up —
    mapped to the world for one of the four sides."""
    def __init__(s, side):
        s.side = side
    def P(s, u, y, v):
        c = HL - T / 2
        if s.side == "front": return (u, y, -c + v)
        if s.side == "back": return (-u, y, c - v)
        if s.side == "left": return (-c + v, y, -u)
        return (c - v, y, u)
    def box(s, K, nm, u0, u1, y0, y1, v0, v1, mat, t, bev=0.0):
        return hull(K, nm, [s.P(u, y, v) for u in (u0, u1) for y in (y0, y1) for v in (v0, v1)], mat, t, bev)

# ── the walls ───────────────────────────────────────────────────────────────────────────────────────────────────
def walls(K, R, state):
    runs = [("front", [(-GATE_W / 2 - 0.5, GATE_W / 2 + 0.5)]), ("back", []), ("left", []), ("right", [])]
    LEN = L - T * 2 + 0.02
    for side, skip in runs:
        W = Run(side)
        if state == "damaged" and side == "right": skip = skip + [(1.8, 4.6)]          # a shell's breach
        segs, at = [], -LEN / 2
        for a, b in sorted(skip): segs.append((at, a)); at = b
        segs.append((at, LEN / 2))
        for si, (a, b) in enumerate(segs):
            if b - a < 0.1: continue
            t0 = 0.05 + 0.25 * ((a + LEN / 2) / LEN)
            if state == "ruin":
                # broken down to jagged stumps: pieces 1.5–2.6 m long, each its own height
                u = a
                while u < b - 0.05:
                    w = min(b - u, R.uniform(1.5, 2.6)); h = R.uniform(0.7, 2.4) if R.random() < 0.75 else R.uniform(2.4, 3.1)
                    W.box(K, f"Foot{side}{si}{u:.1f}", u, u + w, 0, min(1.0, h), -T / 2 - 0.04, T / 2 + 0.04, "rubble", t0)
                    if h > 1.0: W.box(K, f"Wall{side}{si}{u:.1f}", u + 0.02, u + w - 0.02, 0.98, h, -T / 2, T / 2, "renderPlain", t0 + 0.05)
                    u += w
                rubbleRun(K, R, W, a, b, f"{side}{si}")
                continue
            W.box(K, f"Foot{side}{si}", a, b, 0, 1.0, -T / 2 - 0.04, T / 2 + 0.04, "rubble", t0, 0.03)
            W.box(K, f"Wall{side}{si}", a, b, 0.98, H, -T / 2, T / 2, "renderPlain", t0 + 0.05, 0.02)
            W.box(K, f"Walk{side}{si}", a + 0.03, b - 0.03, 0, H - 1.25 - (0.03 if side in ("left", "right") else 0), T / 2, T / 2 + 1.0, "rubble", t0 + 0.04, 0.02)
            # the parapet and its coping (damaged: chipped in places)
            u = a
            while u < b - 0.05:
                w = min(b - u, 2.2)
                if not (state == "damaged" and R.random() < 0.18):
                    W.box(K, f"Par{side}{si}{u:.1f}", u, u + w, H - 0.01, H + 0.72, -T / 2, T / 2, "renderPlain", t0 + 0.08, 0.015)
                    W.box(K, f"Cope{side}{si}{u:.1f}", u - 0.01, u + w + 0.01, H + 0.72, H + 0.82, -T / 2 - 0.06, T / 2 + 0.06, "poCoping", t0 + 0.09, 0.01)
                u += w
            if not LOW():
                ns = max(1, round((b - a) / 1.6))
                for k in range(ns):
                    uc = a + (b - a) * (k + 0.5) / ns
                    W.box(K, f"Slit{side}{si}{k}", uc - 0.05, uc + 0.05, H + 0.11, H + 0.53, -T / 2 - 0.015, T / 2 + 0.015, "poSlit", t0 + 0.09)
                m = max(1, math.floor((b - a) / 2.5))
                for k in range(m):
                    uc = a + (b - a) * (k + 0.5) / m
                    W.box(K, f"Loop{side}{si}{k}", uc - 0.08, uc + 0.08, H - 1.0, H - 0.5, -T / 2 - 0.015, T / 2 + 0.015, "poSlit", t0 + 0.06)
            nb = math.floor((b - a) / 4.4)
            for k in range(1, nb + 1):
                bu = a + (b - a) * k / (nb + 1)
                W.box(K, f"ButA{side}{si}{k}", bu - 0.35, bu + 0.35, 0, 1.3, -T / 2 - 0.58, -T / 2 + 0.02, "rubble", t0 + 0.02, 0.03)
                W.box(K, f"ButB{side}{si}{k}", bu - 0.28, bu + 0.28, 1.25, H + 0.15, -T / 2 - 0.3, -T / 2 + 0.02, "renderPlain", t0 + 0.06, 0.02)
                W.box(K, f"ButC{side}{si}{k}", bu - 0.31, bu + 0.31, H + 0.15, H + 0.23, -T / 2 - 0.34, -T / 2 + 0.03, "poCoping", t0 + 0.07)
            if state == "damaged" and side == "right" and si == 1:
                rubbleRun(K, R, W, 1.6, 4.8, "breach", heap=True)
    # the corner piers
    for sx in (-1, 1):
        for sz in (-1, 1):
            x, z = sx * (HL - T / 2), sz * (HL - T / 2)
            top = H if state != "ruin" else R.uniform(1.2, 2.6)
            box(K, f"PierF{sx}{sz}", x - T / 2 - 0.02, x + T / 2 + 0.02, 0, 1.0, z - T / 2 - 0.02, z + T / 2 + 0.02, "rubble", 0.06, 0.03)
            box(K, f"Pier{sx}{sz}", x - T / 2, x + T / 2, 0.98, top, z - T / 2, z + T / 2, "renderPlain", 0.12, 0.02)

def rubbleRun(K, R, W, a, b, nm, heap=False):
    """Fallen stone and render at a wall's foot, both sides (a heap at a breach)."""
    n = max(2, int((b - a) / 0.8)) if not LOW() else 2
    for k in range(n):
        u = R.uniform(a, b); v = R.choice((-1, 1)) * R.uniform(0.5, 1.6)
        s = R.uniform(0.25, 0.55) * (1.6 if heap else 1.0)
        p = W.P(u, 0, v)
        tag(K.lump(f"Rub{nm}{k}", (p[0], s * 0.3, p[2]), (s, s * 0.55, s * 0.8), "rubble" if R.random() < 0.6 else "renderPlain", "h", seed=R.randint(0, 99), rough=0.35, sub=2 if not LOW() else 1), 0.3)

# ── the towers ──────────────────────────────────────────────────────────────────────────────────────────────────
def tower(K, R, x, z, idx, state):
    W2 = TW / 2
    sx, sz = (1 if x > 0 else -1), (1 if z > 0 else -1)
    top = TH if state != "ruin" else R.uniform(2.6, 3.6)
    # the talus (a stone skirt, sloped) and the body
    hull(K, f"Talus{idx}", [(x + a * (W2 + 0.55), 0, z + b * (W2 + 0.55)) for a in (-1, 1) for b in (-1, 1)] + [(x + a * (W2 + 0.02), 1.8, z + b * (W2 + 0.02)) for a in (-1, 1) for b in (-1, 1)], "rubble", 0.3 + idx * 0.05, 0.03)
    box(K, f"TBody{idx}", x - W2, x + W2, 1.78, top, z - W2, z + W2, "renderPlain", 0.33 + idx * 0.05, 0.02)
    if state == "ruin":
        for k in range(6 if not LOW() else 2):
            tag(K.lump(f"TRub{idx}{k}", (x + sx * R.uniform(2.5, 4.5), 0.3, z + sz * R.uniform(-2, 3)), (0.6, 0.35, 0.5), "rubble", "h", seed=k + idx * 9, rough=0.35, sub=1), 0.4)
        return
    box(K, f"TString{idx}", x - W2 - 0.12, x + W2 + 0.12, TH - 0.14, TH + 0.04, z - W2 - 0.12, z + W2 + 0.12, "poCoping", 0.36 + idx * 0.05, 0.01)
    box(K, f"TCorbel{idx}", x - W2 - 0.25, x + W2 + 0.25, TH - 0.05, TH + 0.17, z - W2 - 0.25, z + W2 + 0.25, "poConcrete", 0.37 + idx * 0.05, 0.01)
    box(K, f"TRoof{idx}", x - W2 + 0.2, x + W2 - 0.2, TH - 0.01, TH + 0.12, z - W2 + 0.2, z + W2 - 0.2, "poConcrete", 0.37 + idx * 0.05)
    PW, ph = TW + 0.4, 0.72
    for k, (dx, dz) in enumerate(((0, -1), (0, 1), (-1, 0), (1, 0))):
        if state == "damaged" and idx == 1 and k in (1, 3): continue                   # the back tower's parapet shot away
        side = dx != 0; ln = PW - 0.66 if side else PW
        px, pz = x + dx * (PW / 2 - 0.16), z + dz * (PW / 2 - 0.16)
        hx, hz = (0.16, ln / 2) if side else (ln / 2, 0.16)
        box(K, f"TPar{idx}{k}", px - hx, px + hx, TH + 0.17, TH + 0.17 + ph, pz - hz, pz + hz, "renderPlain", 0.4 + idx * 0.05, 0.015)
        box(K, f"TCope{idx}{k}", px - hx - 0.05, px + hx + 0.05, TH + 0.17 + ph, TH + 0.27 + ph, pz - hz - 0.05, pz + hz + 0.05, "poCoping", 0.41 + idx * 0.05)
        if not LOW():
            for o in (-1.2, 0.0, 1.2):
                ox, oz = (0, o) if side else (o, 0)
                box(K, f"TSlit{idx}{k}{o}", px + ox - (0.17 if side else 0.05), px + ox + (0.17 if side else 0.05), TH + 0.37, TH + 0.67, pz + oz - (0.05 if side else 0.17), pz + oz + (0.05 if side else 0.17), "poSlit", 0.41)
    if state == "damaged" and idx == 1:
        for k in range(4 if not LOW() else 1):
            tag(K.lump(f"TRub{idx}{k}", (x + sx * R.uniform(2.8, 4.2), 0.25, z + sz * R.uniform(-1.5, 2.5)), (0.45, 0.3, 0.4), "renderPlain", "h", seed=k, rough=0.35, sub=1), 0.45)
    # the loopholes, two storeys
    if not LOW():
        for k, (nx, nz) in enumerate(((0, -1), (0, 1), (-1, 0), (1, 0))):
            for y in (2.4, TH - 1.4):
                cx, cz = x + nx * (W2 + 0.0), z + nz * (W2 + 0.0)
                box(K, f"TLoop{idx}{k}{y}", cx - (0.04 if nx else 0.09), cx + (0.04 if nx else 0.09), y - 0.27, y + 0.27, cz - (0.09 if nx else 0.04), cz + (0.09 if nx else 0.04), "poSlit", 0.36)
    # THE AA-52 on its tall ANTI-AIRCRAFT tripod (2026-10-23, you: the tower gunners "not holding anything" — on its old
    # ammunition-box step the gun sat at a man's knees, where no hold fits): its axis at a STANDING man's shoulder
    # (1.42 m real, x1.3 in the game), the gunner behind it with the stock in his shoulder (algStructures CREWS.post)
    yaw = math.atan2(sx, sz)
    gx, gz = x + sx * 0.2, z + sz * 0.2
    if not (state == "damaged" and idx == 1):
        # (milprops: yaw 0 = toward −Z; the old gun pointed along +sx +sz — its atan2(sx, sz) as three.js rotation.y)
        milprops.aa52(K, f"Gun{idx}", (gx, TH + 1.42, gz), yaw + math.pi, 0.46, tripod=True, tripodDrop=1.42)

# ── the gatehouse ───────────────────────────────────────────────────────────────────────────────────────────────
def gatehouse(K, R, state):
    z0, z1 = GZ - 0.4, GZ - 0.4 + GD
    if state == "ruin":
        for sx in (-1, 1):   # the two piers, broken; the arch down
            x0, x1 = sorted((sx * (GATE_W / 2 + 0.03), sx * GW / 2))
            box(K, f"GPier{sx}", x0, x1, 0, R.uniform(2.0, 3.4), z0, z1, "renderPlain", 0.45, 0.02)
        for k in range(5 if not LOW() else 2):
            sx = R.choice((-1, 1))
            tag(K.lump(f"GRub{k}", (sx * R.uniform(2.2, 4.0), 0.3, z0 - R.uniform(0.3, 1.8)), (0.6, 0.4, 0.5), "renderPlain", "h", seed=k + 40, rough=0.35, sub=1), 0.46)
        return
    gh = box(K, "Gate", -GW / 2, GW / 2, 0, GH, z0, z1, "renderPlain", 0.45, 0.02)
    K.boolean(gh, K.arch(-GATE_W / 2, GATE_W / 2, -0.1, 2.7, z0 - 0.2, z1 + 0.2, "renderPlain"))
    for sx in (-1, 1):
        sw = (GW + 0.1 - GATE_W) / 2 - 0.03
        x0 = sx * (GATE_W / 2 + 0.03); x1 = x0 + sx * sw
        box(K, f"GFoot{sx}", min(x0, x1), max(x0, x1), 0, 1.04, z0 - 0.05, z1 + 0.05, "rubble", 0.44, 0.02)
        px = sx * (GATE_W / 2 + 0.55)
        box(K, f"Pilaster{sx}", px - 0.25, px + 0.25, 1.02, GH - 0.06, z0 - 0.18, z0 + 0.02, "renderPlain", 0.47, 0.015)
        box(K, f"GSlit{sx}", sx * (GW / 2 - 0.6) - 0.05, sx * (GW / 2 - 0.6) + 0.05, GH + 0.24, GH + 0.66, z0 - 0.015, z0 + 0.03, "poSlit", 0.48)
    box(K, "Threshold", -GATE_W / 2 + 0.02, GATE_W / 2 - 0.02, 0.0, 0.1, z0 - 0.03, z1 + 0.03, "poConcrete", 0.46)
    box(K, "GCorbelBand", -GW / 2 - 0.15, GW / 2 + 0.15, GH - 0.08, GH + 0.08, z0 - 0.15, z1 + 0.15, "poConcrete", 0.47)
    if state == "damaged":
        box(K, "GPar", -GW / 2, GW / 2 - 1.6, GH, GH + 0.9, z0 + 0.05, z1 - 0.05, "renderPlain", 0.48, 0.015)
        for k in range(3):
            tag(K.lump(f"GRub{k}", (R.uniform(1.5, 3.5), 0.25, z0 - R.uniform(0.4, 1.4)), (0.4, 0.25, 0.35), "renderPlain", "h", seed=k + 50, rough=0.35, sub=1), 0.48)
        return
    box(K, "GPar", -GW / 2, GW / 2, GH, GH + 0.9, z0 + 0.05, z1 - 0.05, "renderPlain", 0.48, 0.015)
    box(K, "GCope", -GW / 2 - 0.02, GW / 2 + 0.02, GH + 0.9, GH + 1.0, z0 + 0.04, z1 - 0.04, "poCoping", 0.49)
    bz = z0 - 0.32
    box(K, "Bretech", -0.9, 0.9, GH - 0.65, GH + 0.35, bz - 0.3, bz + 0.3, "renderPlain", 0.49, 0.015)
    for k, sx in enumerate((-1, 0, 1)):
        box(K, f"BCorbel{k}", sx * 0.75 - 0.08, sx * 0.75 + 0.08, GH - 0.95, GH - 0.65, bz - 0.21, bz + 0.29, "poConcrete", 0.49)
    box(K, "BSlit", -0.06, 0.06, GH - 0.29, GH + 0.09, bz - 0.315, bz - 0.27, "poSlit", 0.49)

# ── the blocks ──────────────────────────────────────────────────────────────────────────────────────────────────
def block(K, R, b, state, nm):
    x, z, w, d, h, side = b["x"], b["z"], b["w"], b["d"], b["h"], b["side"]
    t0 = 0.55 if nm == "Bar" else 0.6
    ruin = state == "ruin"
    top = h if not ruin else None
    box(K, f"{nm}Foot", x - w / 2 - 0.04, x + w / 2 + 0.04, 0, 0.6, z - d / 2 - 0.04, z + d / 2 + 0.04, "rubble", t0, 0.02)
    body = box(K, f"{nm}Body", x - w / 2, x + w / 2, 0.58, h, z - d / 2, z + d / 2, "renderPlain", t0 + 0.02, 0.02)
    # the openings, cut through the door face; a dark interior behind each
    fz = z + side * d / 2
    slots = b["doors"] + b["windows"]
    per = math.ceil(slots / max(1, b["doors"]))
    for k in range(slots):
        sxp = x - w / 2 + w * (k + 0.5) / slots
        isDoor = b["doors"] > 0 and k % per == per // 2
        if isDoor:
            K.boolean(body, K.cutter(sxp - 0.55, sxp + 0.55, 0.5, 2.25, fz - 0.5, fz + 0.5, "renderPlain"))
            box(K, f"{nm}DoorLeaf{k}", sxp - 0.55, sxp + 0.55, 0.6, 2.25, fz - side * 0.22, fz - side * 0.17, "poDoor", t0 + 0.05)
            box(K, f"{nm}Lintel{k}", sxp - 0.72, sxp + 0.72, 2.25, 2.42, fz - side * 0.02, fz + side * 0.07, "poConcrete", t0 + 0.05)
            box(K, f"{nm}Step{k}", sxp - 0.7, sxp + 0.7, 0.0, 0.3, fz, fz + side * 0.45, "poConcrete", t0 + 0.05)
        else:
            K.boolean(body, K.cutter(sxp - 0.45, sxp + 0.45, 1.2, 2.3, fz - 0.5, fz + 0.5, "renderPlain"))
            box(K, f"{nm}Dark{k}", sxp - 0.45, sxp + 0.45, 1.2, 2.3, fz - side * 0.3, fz - side * 0.26, "poSlit", t0 + 0.04)
            box(K, f"{nm}Sill{k}", sxp - 0.55, sxp + 0.55, 1.12, 1.22, fz - side * 0.02, fz + side * 0.1, "poConcrete", t0 + 0.04)
            if not ruin:
                for s in (-1, 1):
                    if R.random() < 0.12 or (state == "damaged" and R.random() < 0.4): continue
                    box(K, f"{nm}Shut{k}{s}", sxp + s * 0.66 - 0.18, sxp + s * 0.66 + 0.18, 1.2, 2.3, fz + side * 0.01, fz + side * 0.05, "poShutter", t0 + 0.06)
    if ruin:
        K.boolean(body, K.skyline(x - w / 2 - 1, x + w / 2 + 1, z - d / 2 - 1, z + d / 2 + 1, h * 0.55, h * 0.3, seed=len(nm) * 7, mat="rubble"))
        # hollowed: the roof gone, the floor inside heaped
        K.boolean(body, K.cutter(x - w / 2 + 0.35, x + w / 2 - 0.35, 0.65, h + 2, z - d / 2 + 0.35, z + d / 2 - 0.35, "rubble"))
        for k in range(5 if not LOW() else 2):
            tag(K.lump(f"{nm}Rub{k}", (x + R.uniform(-w / 2 + 1, w / 2 - 1), 0.6, z + R.uniform(-d / 2 + 1, d / 2 - 1)), (0.9, 0.5, 0.8), "rubble", "h", seed=k + 70, rough=0.35, sub=1), t0 + 0.1)
        tag(K.lump(f"{nm}Beam", (x, 0.9, z), (w * 0.3, 0.12, 0.15), "poChar", "h", seed=3, rough=0.1, sub=1), t0 + 0.1)
        return
    # the flat roof: its slab, the parapet (damaged barracks: fallen in at its right end)
    fallen = state == "damaged" and nm == "Bar"
    x1r = x + w / 2 + 0.15 - (4.0 if fallen else 0)
    box(K, f"{nm}Slab", x - w / 2 - 0.15, x1r, h, h + 0.2, z - d / 2 - 0.15, z + d / 2 + 0.15, "poConcrete", t0 + 0.08)
    if fallen:
        hull(K, f"{nm}SlabFall", [(x1r, h + 0.2, z - d / 2), (x1r, h, z - d / 2), (x + w / 2, 0.9, z - d / 2), (x + w / 2, 0.7, z - d / 2),
                                   (x1r, h + 0.2, z + d / 2), (x1r, h, z + d / 2), (x + w / 2, 0.9, z + d / 2), (x + w / 2, 0.7, z + d / 2)], "poConcrete", t0 + 0.08)
        K.boolean(body, K.breach((x + w / 2 - 1.8, h - 0.4, z + side * d / 2), (1.6, 1.0, 1.2), seed=5, mat="rubble"))
    for s in (-1, 1):
        box(K, f"{nm}ParZ{s}", x - w / 2 - 0.15, x1r if s == side or not fallen else x1r, h + 0.2, h + 0.6, z + s * (d / 2 + 0.05) - 0.1, z + s * (d / 2 + 0.05) + 0.1, "renderPlain", t0 + 0.09, 0.01)
    for s in ((-1,) if fallen else (-1, 1)):
        box(K, f"{nm}ParX{s}", x + s * (w / 2 + 0.02) - 0.1, x + s * (w / 2 + 0.02) + 0.1, h + 0.2, h + 0.57, z - d / 2 - 0.05 + 0.1, z + d / 2 + 0.05 - 0.1, "renderPlain", t0 + 0.09, 0.01)
    ry = h + 0.2
    # the roof in use
    ex = x + (w / 2 - 1.4) * (-1 if nm == "Bar" else 1)
    tag(K.cyl(f"{nm}Tank", (ex, ry + 0.6, z - d / 4), 0.6, 1.1, "poTank", "h", 16 if not LOW() else 8, w=0.01), t0 + 0.12)
    for a in (-1, 1):
        for c in (-1, 1): rod(K, f"{nm}TLeg{a}{c}", (ex + a * 0.42, ry, z - d / 4 + c * 0.42), (ex + a * 0.42, ry + 0.62, z - d / 4 + c * 0.42), 0.04, "poSteel", t0 + 0.12, 5)
    for k in (-1, 1):
        px, pz = x + k * w * 0.22, z + d * 0.18
        rod(K, f"{nm}Pipe{k}", (px, ry, pz), (px, ry + 1.3, pz), 0.08, "poSteel", t0 + 0.12, 8)
        tag(K.cyl(f"{nm}Cap{k}", (px, ry + 1.3, pz), 0.2, 0.16, "poSteel", "h", 8, r2=0.02, w=0), t0 + 0.12)
    if b["roof"] == "barracks":
        lx, lz = x - w / 2 + 1.6, z - side * (d / 2 - 1.4)
        for a in (-1, 1):
            for c in (-1, 1): rod(K, f"LookPost{a}{c}", (lx + a * 0.9, ry, lz + c * 0.9), (lx + a * 0.9, ry + 1.62, lz + c * 0.9), 0.04, "wood", t0 + 0.14, 6)
        clothKit.drape(K, "LookTarp", lambda u, v: (lx - 1.05 + 2.1 * u, ry + 1.75 + 0.05 * math.sin(u * 7), lz - 1.05 + 2.1 * v), 10, 10, lambda u, v: "poCanvas", t0 + 0.15,
                       pins=lambda u, v: (u < 0.08 or u > 0.92) and (v < 0.08 or v > 0.92), colliders=[("rod", (lx + a * 0.9, ry, lz + c * 0.9), (lx + a * 0.9, ry + 1.62, lz + c * 0.9), 0.05) for a in (-1, 1) for c in (-1, 1)],
                       frames=40, stiff=20.0, key="PostLookTarp")
        if not LOW():
            wx0, wx1, wz = x + 0.5, x + w / 2 - 2.6, z + d / 2 - 1.0
            for px in (wx0, wx1): rod(K, f"LinePole{px:.1f}", (px, ry, wz), (px, ry + 1.7, wz), 0.035, "wood", t0 + 0.15, 5)
            rod(K, "Line", (wx0, ry + 1.6, wz), (wx1, ry + 1.6, wz), 0.008, "poRope", t0 + 0.15, 4)
            for k in range(5):
                tt = (k + 0.7) / 6; big = k % 2 == 0
                px = wx0 + (wx1 - wx0) * tt
                box(K, f"Wash{k}", px - (0.5 if big else 0.25), px + (0.5 if big else 0.25), ry + 1.6 - (0.85 if big else 0.55), ry + 1.58, wz - 0.01, wz + 0.01, "poCanvas" if big else "cloth1", t0 + 0.16)
    else:
        box(K, "RadioCrate", x + w / 4 - 0.4, x + w / 4 + 0.4, ry, ry + 0.5, z + d / 4 - 0.3, z + d / 4 + 0.3, "poTank", t0 + 0.14, 0.01)
        box(K, "BattCrate", x - w / 4 - 0.3, x - w / 4 + 0.3, ry, ry + 0.4, z - d / 3 - 0.25, z - d / 3 + 0.25, "wood", t0 + 0.14, 0.01)
    # the ladder up from the yard
    lx2, lz2 = x + w / 2 - 0.7, z + side * (d / 2 + 0.25)
    for s in (-1, 1): rod(K, f"{nm}Rail{s}", (lx2 + s * 0.26, 0, lz2 + side * 0.3), (lx2 + s * 0.26, h + 0.9, lz2 - side * 0.05), 0.035, "wood", t0 + 0.1, 6)
    if not LOW():
        for k in range(1, 9):
            yy = k * (h + 0.6) / 9; zz = lz2 + side * 0.3 - side * 0.35 * yy / (h + 0.9)
            rod(K, f"{nm}Rung{k}", (lx2 - 0.26, yy, zz), (lx2 + 0.26, yy, zz), 0.022, "wood", t0 + 0.1, 5)

# ── the mast ────────────────────────────────────────────────────────────────────────────────────────────────────
def mast(K, R, state):
    mx, mz, mH = MAST
    legs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    if state == "ruin":   # down across the yard
        for i, (lx, lz) in enumerate(legs):
            rod(K, f"MLeg{i}", (mx + lx * 0.5, 0.1 + (lz + 1) * 0.2, mz + lz * 0.5), (mx + 9.5 + lx * 0.1, 0.1, mz - 6.0 + lz * 0.1), 0.045, "poSteel", 0.75, 6)
        return
    bend = state == "damaged"
    def legAt(lx, lz, y):
        f = y / mH; hh = 0.5 - 0.42 * f
        p = [mx + lx * hh, y, mz + lz * hh]
        if bend and y > mH * 0.72: p[0] += (y - mH * 0.72) * 0.35; p[1] = mH * 0.72 + (y - mH * 0.72) * 0.85
        return tuple(p)
    for i, (lx, lz) in enumerate(legs):
        prev = legAt(lx, lz, 0)
        for k in range(1, 8):
            cur = legAt(lx, lz, mH * k / 7)
            rod(K, f"MLeg{i}{k}", prev, cur, 0.045, "poSteel", 0.75, 6); prev = cur
    n = 7 if not LOW() else 3
    for k in range(1, n):
        y, y0 = mH * k / n, mH * (k - 1) / n
        for i in range(4):
            (ax, az), (bx, bz) = legs[i], legs[(i + 1) % 4]
            rod(K, f"MGirt{k}{i}", legAt(ax, az, y), legAt(bx, bz, y), 0.028, "poSteel", 0.76, 4)
            if not LOW(): rod(K, f"MBrace{k}{i}", legAt(ax, az, y0), legAt(bx, bz, y), 0.022, "poSteel", 0.76, 4)
    tip = legAt(0, 0, mH)
    rod(K, "MWhip", tip, (tip[0] + (0.6 if bend else 0), tip[1] + 4, tip[2]), 0.02, "poSteel", 0.77, 4)

# ── the yard ────────────────────────────────────────────────────────────────────────────────────────────────────
def drum(K, nm, x, z, t, lying=None, mat="poDrum"):
    """A 200 l drum standing at (x, z) — or lying (`lying`: its axis' yaw) — THE shared one (props.drum, 2026-10-23)."""
    burnt = mat == "poChar"
    parts = props.drum(lambda n, bm, m: tag(K.obj(n, bm, m, "h", smooth=True), t), nm, mat, "poSteel", LOW(), 0.35 if burnt else 0.0, sum(map(ord, nm)), burnt)
    if lying is None: M = Matrix.Translation(B(x, 0, z))
    else:
        ax = gv(math.sin(lying), 0, math.cos(lying)); a = gv(x, 0.294, z) - ax * 0.44
        M = Matrix.Translation(B(*a)) @ Vector((0, 0, 1)).rotation_difference(B(*ax)).to_matrix().to_4x4()
    for o in parts: o.matrix_world = M

def yard(K, R, state):
    ruin = state == "ruin"
    # the flag's plinth (the pole and flag are the game's live cloth: userData.flagMount)
    box(K, "Plinth", -0.8, 0.8, 0, 0.3, -3.3, -1.7, "poConcrete", 0.8, 0.02)
    # the parade square's whitewashed stones
    if not LOW():
        for k in range(28):
            tt, e, half = (k % 7) / 7, k // 7, 2.6
            px, pz = [(-half + tt * 2 * half, -half), (half, -half + tt * 2 * half), (half - tt * 2 * half, half), (-half, half - tt * 2 * half)][e]
            if ruin and R.random() < 0.5: continue
            box(K, f"Parade{k}", px - 0.15, px + 0.15, 0, 0.16, -2.5 + pz - 0.11, -2.5 + pz + 0.11, "renderPlain", 0.81)
    # drums and crates
    for k in range(6):
        if ruin and k % 2: drum(K, f"Drum{k}", 4.5 + (k % 3) * 0.65 + R.uniform(-0.5, 0.5), -6 + (k // 3) * 0.65 + 0.8, 0.85, lying=R.uniform(0, 3), mat="poChar")
        else: drum(K, f"Drum{k}", 4.5 + (k % 3) * 0.65, -6 + (k // 3) * 0.65, 0.85)
    for k in range(4):
        cx, cy = -4.5 + (k % 2) * 1.2, (k // 2) * 0.6
        if ruin and k >= 2: continue
        box(K, f"Crate{k}", cx - 0.55, cx + 0.55, cy, cy + 0.6, -5.85, -5.15, "poChar" if ruin else "poTank", 0.86, 0.01)
    # the water tower by the front-right corner
    wx, wz = HL - T - 2.2, -HL + T + 2.2
    if not ruin:
        tag(K.cyl("WTank", (wx, 1.7, wz), 1.1, 1.6, "poTank", "h", 18 if not LOW() else 8, w=0.01), 0.87)
        for a in (-1, 1):
            for c in (-1, 1): rod(K, f"WLeg{a}{c}", (wx + a * 0.8, 0, wz + c * 0.8), (wx + a * 0.8, 1.72, wz + c * 0.8), 0.06, "wood", 0.87, 6)
    # THE VEHICLE SHED against the right wall
    x0, x1, z0, z1, yHi, yLo = HL - T - 0.1, HL - T - 3.6, -4.6, 2.6, 3.0, 2.3
    if not ruin:
        for zz in (z0 + 0.1, (z0 + z1) / 2, z1 - 0.1): rod(K, f"ShedPost{zz:.1f}", (x1 + 0.1, 0, zz), (x1 + 0.1, yLo, zz), 0.07, "wood", 0.88, 6)
        box(K, "ShedBeam", x1 + 0.02, x1 + 0.18, yLo, yLo + 0.16, z0, z1, "wood", 0.88, 0.01)
        n = 4 if not LOW() else 1
        for k in range(n):
            za, zb = z0 - 0.15 + (z1 - z0 + 0.3) * k / n, z0 - 0.15 + (z1 - z0 + 0.3) * (k + 1) / n
            if state == "damaged" and k == 1: continue
            # a CORRUGATED sheet (its waves across the slope; a flat slab read as a board), each overlapping the next
            corrugated(K, f"ShedSheet{k}", (x1 - 0.15, yLo + 0.17, za), (0, 0, 1), (x0 - (x1 - 0.15), yHi - yLo - 0.17, 0), zb - za + 0.06, math.hypot(x0 - x1 + 0.15, yHi - yLo - 0.17), "poRoof", 0.89)
        for k in range(4): drum(K, f"ShedDrum{k}", HL - T - 0.6, z0 + 0.6 + k * 0.62, 0.9)
        n2 = 16 if not LOW() else 6
        tyre = [(HL - T - 1.6 + 0.36 * math.cos(2 * math.pi * k / n2), 0.13, z1 - 1.2 + 0.36 * math.sin(2 * math.pi * k / n2)) for k in range(n2)]
        for k in range(n2): rod(K, f"Tyre{k}", tyre[k], tyre[(k + 1) % n2], 0.12, "poRubber", 0.9, 6)
    # THE SQUAD TENT (cloth over its pole)
    tx, tz, tw = 3.2, -0.6, 3.6
    if not ruin:
        rod(K, "TentPole", (tx, 0, tz), (tx, 2.6, tz), 0.04, "wood", 0.9, 6)
        def rest(u, v):
            px, pz = tx - tw / 2 - 0.4 + (tw + 0.8) * u, tz - tw / 2 - 0.4 + (tw + 0.8) * v
            dd = max(abs(px - tx), abs(pz - tz))
            return (px, 2.7 - dd * 0.85, pz)
        corners = lambda u, v: ((u < 0.06 or u > 0.94) and (v < 0.06 or v > 0.94)) or (abs(u - 0.5) < 0.06 and abs(v - 0.5) < 0.06)
        clothKit.drape(K, "Tent", rest, 20, 20, lambda u, v: "poCanvas", 0.91, pins=corners, colliders=[("rod", (tx, 0, tz), (tx, 2.62, tz), 0.06)], frames=50, stiff=18.0, key="PostTent")
        for a in (-1, 1):
            for c in (-1, 1):
                cx, cz = tx + a * (tw / 2 + 0.4), tz + c * (tw / 2 + 0.4)
                rod(K, f"TentGuy{a}{c}", (cx, rest(0 if a < 0 else 1, 0 if c < 0 else 1)[1], cz), (cx + a * 0.7, 0.05, cz + c * 0.7), 0.008, "poRope", 0.91, 4)
    # the post's MORTAR in its pit (the ring is the game's sim)
    if not ruin: milprops.mortar81(K, "Mortar", 0.92, at=(-2.6, 0, 1.4), yaw=math.pi)
    else: tag(K.lump("MortarRub", (-2.6, 0.2, 1.4), (0.6, 0.25, 0.5), "poChar", "h", seed=8, rough=0.3, sub=1), 0.92)

def wire(K, R, state):
    wr = HL + 5.5
    runs = [((-wr, -wr), (-GATE_W - 3, -wr)), ((GATE_W + 3, -wr), (wr, -wr)), ((wr, -wr), (wr, wr)), ((wr, wr), (-wr, wr)), ((-wr, wr), (-wr, -wr))]
    for ri, ((x0, z0), (x1, z1)) in enumerate(runs):
        ln = math.hypot(x1 - x0, z1 - z0); n = max(1, round(ln / 3))
        for k in range(n + 1):
            tt = k / n
            if state == "ruin" and R.random() < 0.6: continue
            px, pz = x0 + (x1 - x0) * tt, z0 + (z1 - z0) * tt
            lean = R.uniform(-0.25, 0.25) if state != "intact" else R.uniform(-0.04, 0.04)
            rod(K, f"Pick{ri}{k}", (px, -0.05, pz), (px + lean, 1.3, pz + lean * 0.5), 0.04, "poSteel", 0.97, 4)
        if state == "ruin": continue
        for y in ((0.35, 0.75, 1.15) if not LOW() else (0.75,)):
            rod(K, f"Strand{ri}{y}", (x0, y, z0), (x1, y, z1), 0.012, "poSteel", 0.98, 3)
        if not LOW():
            for k in range(n):
                ax, az = x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n
                bx, bz = x0 + (x1 - x0) * (k + 1) / n, z0 + (z1 - z0) * (k + 1) / n
                rod(K, f"X{ri}{k}a", (ax, 0.12, az), (bx, 1.25, bz), 0.011, "poSteel", 0.98, 3)
                rod(K, f"X{ri}{k}b", (ax, 1.25, az), (bx, 0.12, bz), 0.011, "poSteel", 0.98, 3)

def buildPost(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    walls(K, random.Random(seed + 1), state)
    for i, (x, z) in enumerate(TOWERS): tower(K, random.Random(seed + 2 + i), x, z, i, state)
    gatehouse(K, random.Random(seed + 4), state)
    block(K, random.Random(seed + 5), BARRACKS, state, "Bar")
    block(K, random.Random(seed + 6), COMMAND, state, "Cmd")
    mast(K, random.Random(seed + 7), state)
    yard(K, random.Random(seed + 8), state)
    wire(K, random.Random(seed + 9), state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farPost = lambda K, n, s, st, sd: buildPost(K, n, s, st, sd, far=True)
TYPES = {"post": dict(builder=buildPost, farBuilder=farPost, atlas=4096, normalAtlas=2048, islandMargin=0.0005, aoDist=1.2, smoothAngle=35, weighted=True, normals=True)}
exported = buildKit(TYPES, MATDEF, "postkit.glb", prefix="Bordj", seed0=1957, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1400, 900
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cd.lens = 32; cam.location = B(-24, 30, -40)
    cam.rotation_euler = (B(0, 2.0, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
