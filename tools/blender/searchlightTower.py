"""THE SEARCHLIGHT TOWER IN BLENDER (2026-10-21, the asset pass): the post's night eye — a steel lattice on concrete
feet, raked, X-braced in three bays of flat bar, a plank deck on steel bearers with a rail and toe boards, a ladder
up the back in its safety cage; on the deck the 60 cm searchlight's pedestal (milprops), its HEAD a piece of its own
(type "lamp") the game sweeps (algSearchlight: yaw then pitch about the trunnions). At the foot the generator under a
corrugated lean-to, its exhaust through the roof, fuel drums, the cable up the front-right leg. Its sandbags are NOT
here: the user's cloth-simulated wall (sandbagWall.py layout "slshed") in front of the shed, in the game.

    INTACT    as above
    DAMAGED   shot up: a brace snapped and hanging, the front rail gone, a roof sheet torn off the shed and lying by
              it, a drum knocked over, the generator burnt
    RUIN      down: stumps on their feet, the lattice above lying on the ground where it fell, the deck thrown flat
              beside it, the shed flattened, drums about

  BUILD ORDER (COLOR_0): the feet, the lattice bay by bay (legs, then that bay's braces), the ladder, the deck, the
  rail, the pedestal, the shed, the generator, the drums.

The OLD piece's frame (rtsAlgeria buildSearchlightTower — its footprint, its lamp's place): kit metres (the game
×1.3); the front (the lens) at -Z, the ladder at +Z, the shed at +X.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/searchlightTower.py -- <out dir> [--quick]

Writes <out>/sltower.glb (Light<Type>_<State> + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, Matrix
import house
from house import buildKit
from bkit import B, gv, srgb, dust, flat
import drystone
from drystone import tag
import milprops
import props

FB, FT, H = 1.7, 0.75, 9.0            # the legs' half spread at the foot, at the top; the deck's height
P = FT + 0.55                         # the deck's half size
DECK = H + 0.08                       # the deck's top
BAYS = (0.0, 0.36, 0.68, 1.0)
LEGS = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
LAMP = (0.0, -0.35)                   # the pedestal on the deck (the old lamp's pivot x, z)
PED = 0.95                            # the trunnions above the deck
SHED = (FB + 1.8, -0.6)               # the generator shed's centre (the old one's)

def legAt(sx, sz, f): return (sx * (FB + (FT - FB) * f), H * f, sz * (FB + (FT - FB) * f))

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
def drum(nb):
    c = nb.mix(nb.noise(2.0, 4), srgb(0x4d5a3a), srgb(0x3a4430))
    return dust(nb, nb.mix(nb.mr(nb.noise(14.0, 4), 0.6, 0.7), c, srgb(0x6e4630)), 0.8)
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update({
    "stSteel": (0.55, milprops._steel(0x484d40, 0.35)), "stSteelDark": (0.5, milprops._steel(0x30332c, 0.3)),
    "stPlank": (0.9, milprops.timberMat(0x9a9080)), "stConcrete": (0.95, flat(srgb(0xa59c8c), 0.4)),
    "stRoof": (0.6, galv(0.5)), "stDrum": (0.6, props.drum_paint(0x4d5a3a)), "stGen": (0.55, milprops._steel(0x55603f, 0.3)),
    "stChar": (0.95, charred), "stCable": (0.8, flat(srgb(0x161614), 0.0)), "stGrille": (0.6, milprops._steel(0x1e201c, 0.1)),
})
LOW = lambda: drystone.LOW

def beam(K, nm, a, b, w, h, mat, t, out=None):
    """A bar from a to b (game), w × h in section; `out` (a game vector) turns its w side to face it."""
    a, b = gv(*a), gv(*b)
    d = (b - a); L_ = d.length; d.normalize()
    up = gv(0, 1, 0) if abs(d.y) < 0.95 else gv(1, 0, 0)
    if out is not None: up = gv(*out)
    v = (up - d * up.dot(d)).normalized(); u = d.cross(v).normalized()
    bm = bmesh.new()
    vs = [bm.verts.new(B(*(a + d * s + u * (cu * w / 2) + v * (cv * h / 2)))) for s in (0, L_) for cu in (-1, 1) for cv in (-1, 1)]
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.bevel(K.obj(nm, bm, mat, "h"), 0.004 if not LOW() else 0, 1, 40), t)

def rod(K, nm, a, b, r, mat, t, n=8):
    return tag(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(4, n // 2)), t)

def corrugated(K, nm, o, aw, al, width, length, mat, t, pitch=0.1, depth=0.025):
    """A corrugated sheet: corner o, waves across aw, length along al (game vectors); thin, both faces."""
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

def drumAt(K, nm, x, z, t, lying=None, mat="stDrum"):
    """A 200 l drum standing at (x, z) — or lying (`lying`: its axis' yaw) — THE shared one (props.drum, 2026-10-23)."""
    burnt = mat == "stChar"
    parts = props.drum(lambda n, bm, m: tag(K.obj(n, bm, m, "h", smooth=True), t), nm, mat, "stSteelDark", LOW(), 0.35 if burnt else 0.0, sum(map(ord, nm)), burnt)
    if lying is None: M = Matrix.Translation(B(x, 0, z))
    else:
        ax = gv(math.sin(lying), 0, math.cos(lying)); a = gv(x, 0.294, z) - ax * 0.44
        M = Matrix.Translation(B(*a)) @ Vector((0, 0, 1)).rotation_difference(B(*ax)).to_matrix().to_4x4()
    for o in parts: o.matrix_world = M

def lattice(K, state, f0=0.0, skip=()):
    """The legs bay by bay, the girts, the X-braces of flat bar (the crossing one outside), from f0 up."""
    for bay in range(3):
        a, b = BAYS[bay], BAYS[bay + 1]
        if b <= f0: continue
        a = max(a, f0)
        t = 0.05 + 0.17 * bay
        for i, (sx, sz) in enumerate(LEGS):
            if state == "damaged" and i == 0 and bay == 0:   # kinked outward by a burst at its foot
                m = Vector(legAt(sx, sz, (a + b) * 0.45)) + Vector((sx, 0, sz)).normalized() * 0.2
                beam(K, f"Leg{i}_{bay}", legAt(sx, sz, a), tuple(m), 0.11, 0.11, "stSteel", t, out=(sx, 0, sz))
                beam(K, f"Leg{i}_{bay}b", tuple(m), legAt(sx, sz, b), 0.11, 0.11, "stSteel", t, out=(sx, 0, sz))
                continue
            beam(K, f"Leg{i}_{bay}", legAt(sx, sz, a), legAt(sx, sz, b), 0.11, 0.11, "stSteel", t, out=(sx, 0, sz))
        for i in range(4):
            (ax, az), (bx, bz) = LEGS[i], LEGS[(i + 1) % 4]
            n = Vector((ax + bx, 0, az + bz)).normalized()
            face = (n.x, 0, n.z)
            beam(K, f"Girt{i}_{bay}", legAt(ax, az, b), legAt(bx, bz, b), 0.07, 0.07, "stSteel", t + 0.05, out=face)
            if (i, bay) in skip: continue
            o1, o2 = n * 0.065, n * 0.08
            if state == "damaged" and i == 0 and bay == 0:   # snapped by a burst: half of it hanging off the leg
                p, q = Vector(legAt(ax, az, a)) + o1, Vector(legAt(bx, bz, b)) + o1
                beam(K, f"BrA{i}_{bay}", tuple(p), tuple(p.lerp(q, 0.42) + Vector((0, -0.5, 0)) + n * 0.15), 0.07, 0.01, "stSteel", t + 0.05, out=face)
            else:
                beam(K, f"BrA{i}_{bay}", tuple(Vector(legAt(ax, az, a)) + o1), tuple(Vector(legAt(bx, bz, b)) + o1), 0.07, 0.01, "stSteel", t + 0.05, out=face)
            beam(K, f"BrB{i}_{bay}", tuple(Vector(legAt(bx, bz, a)) + o2), tuple(Vector(legAt(ax, az, b)) + o2), 0.07, 0.01, "stSteel", t + 0.06, out=face)

def ladder(K):
    z0, z1 = FT + 0.95, P - 0.02                     # the foot behind the legs, the top at the deck's back edge
    zAt = lambda y: z0 + (z1 - z0) * min(1.0, y / (DECK + 1.0))
    for sx in (-0.22, 0.22):
        beam(K, f"LadRail{sx}", (sx, 0, z0), (sx, DECK + 1.0, z1), 0.06, 0.012, "stSteelDark", 0.55, out=(0, 0, 1))
    n = 30 if not LOW() else 10
    for k in range(1, n):
        y = DECK * k / n
        rod(K, f"Rung{k}", (-0.22, y, zAt(y)), (0.22, y, zAt(y)), 0.012, "stSteelDark", 0.55 + 0.1 * k / n, 5)
    if LOW(): return
    for k in range(8):   # the cage's hoops from 2.5 m, round the back
        y = 2.5 + k * 0.85; zc = zAt(y)
        pts = [(0.38 * math.cos(a), y, zc + 0.38 * math.sin(a)) for a in [i / 6 * math.pi for i in range(7)]]
        for i in range(6): rod(K, f"Hoop{k}_{i}", pts[i], pts[i + 1], 0.01, "stSteelDark", 0.62, 4)
    for k, a in enumerate((0.5, 1.57, 2.64)):
        rod(K, f"Strap{k}", (0.38 * math.cos(a), 2.5, zAt(2.5) + 0.38 * math.sin(a)), (0.38 * math.cos(a), 2.5 + 7 * 0.85, zAt(2.5 + 7 * 0.85) + 0.38 * math.sin(a)), 0.008, "stSteelDark", 0.63, 4)

def deck(K, R, state):
    for sx in (-1, 1):
        beam(K, f"Bearer{sx}", (sx * FT, H - 0.06, -P - 0.05), (sx * FT, H - 0.06, P + 0.05), 0.08, 0.12, "stSteelDark", 0.66)
    n = 11
    for k in range(n):   # planks across, a finger's gap between
        x0 = -P + 2 * P * k / n
        if state == "damaged" and k in (7, 8):          # blown out of the deck: one gone, one hanging off the front
            if k == 8:
                beam(K, f"Plank{k}", (x0 + 0.12, DECK - 0.04, -P + 0.05), (x0 + 0.2, DECK - 1.15, -P - 0.25), 0.2, 0.08, "stChar", 0.68, out=(0, 0, -1))
            continue
        tag(K.box(f"Plank{k}", x0 + 0.006, x0 + 2 * P / n - 0.006, H, DECK, -P, P, "stPlank", "h", 0.006), 0.68)
    # the hatch's opening at the back is the ladder's: the rail round the other three sides and the back's corners
    posts = [(-P, -P), (P, -P), (P, P), (-P, P), (0, -P), (P, 0), (-P, 0)]
    for i, (x, z) in enumerate(posts):
        if state == "damaged" and z == -P: continue          # the front rail shot away
        rod(K, f"Post{i}", (x, DECK, z), (x, DECK + 1.05, z), 0.022, "stSteel", 0.72, 6)
    sides = [((-P, -P), (P, -P)), ((P, -P), (P, P)), ((-P, P), (-P, -P)), ((P, P), (0.35, P)), ((-0.35, P), (-P, P))]
    for i, ((ax, az), (bx, bz)) in enumerate(sides):
        if state == "damaged" and i == 0: continue
        for k, y in enumerate((1.04, 0.55)):
            rod(K, f"Rail{i}_{k}", (ax, DECK + y, az), (bx, DECK + y, bz), 0.018, "stSteel", 0.74, 6)
        if i < 3:   # toe boards
            d = Vector((bx - ax, 0, bz - az)).normalized(); nrm = Vector((-d.z, 0, d.x))
            c = Vector(((ax + bx) / 2, 0, (az + bz) / 2))
            if nrm.dot(c) < 0: nrm = -nrm
            p, q = Vector((ax, DECK, az)) - nrm * 0.03, Vector((bx, DECK, bz)) - nrm * 0.03
            beam(K, f"Toe{i}", tuple(p + Vector((0, 0.07, 0))), tuple(q + Vector((0, 0.07, 0))), 0.025, 0.14, "stPlank", 0.75, out=(0, 1, 0))
    # the searchlight's pedestal (its head is the "lamp" piece), the switch box on the right post, the cable down
    milprops.searchlight(K, "Light", (LAMP[0], DECK, LAMP[1]), 0.0, 0.8, pedestal=PED, part="base")
    beam(K, "SwitchBox", (P - 0.02, DECK + 0.62, 0.05), (P - 0.02, DECK + 0.9, 0.05), 0.22, 0.12, "stGen", 0.8, out=(1, 0, 0))
    if not LOW():
        lx, ly, lz = legAt(1, -1, 1.0)
        pts = [(0.15, DECK + 0.03, LAMP[1] + 0.15), (P - 0.08, DECK + 0.03, 0.0), (P - 0.04, DECK + 0.62, 0.05)]
        for i in range(2): rod(K, f"CableDeck{i}", pts[i], pts[i + 1], 0.012, "stCable", 0.8, 5)
        # down the front-right leg (its outer face), across the ground to the shed
        o = Vector((1, 0, -1)).normalized() * 0.09
        a = Vector((lx, DECK - 0.15, lz)) + o; b = Vector(legAt(1, -1, 0.0)) + o + Vector((0, 0.06, 0))
        rod(K, "CableLeg", tuple(a), tuple(b), 0.013, "stCable", 0.8, 5)
        rod(K, "CableGround", tuple(b), (SHED[0] - 0.75, 0.02, SHED[1] - 0.2), 0.013, "stCable", 0.8, 5)

def shed(K, R, state):
    """The generator under a corrugated lean-to (open at the front for the air), its exhaust through the roof."""
    gx, gz = SHED
    hx, hz, hf, hb = 1.0, 0.75, 1.75, 1.45                  # half sizes, the roof's front and back heights
    if state != "ruin":
        for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            h = hf if sz < 0 else hb
            beam(K, f"ShedPost{i}", (gx + sx * hx, 0, gz + sz * hz), (gx + sx * hx, h, gz + sz * hz), 0.09, 0.09, "stPlank", 0.82)
        for sz in (-1, 1):
            h = hf if sz < 0 else hb
            beam(K, f"ShedPurlin{sz}", (gx - hx - 0.1, h + 0.045, gz + sz * hz), (gx + hx + 0.1, h + 0.045, gz + sz * hz), 0.07, 0.09, "stPlank", 0.83)
        # the roof: two sheets from the front down to the back (the damaged shed lost one: on the ground by it)
        for k in range(2):
            x0 = gx - hx - 0.1 + k * (hx + 0.1)
            if state == "damaged" and k == 1:
                corrugated(K, f"Roof{k}", (gx + hx + 0.35, 0.05, gz - hz), (0, 0.08, 1), (1, 0.12, 0.25), hz * 2 + 0.2, hx + 0.1, "stRoof", 0.86)
                continue
            corrugated(K, f"Roof{k}", (x0, hf + 0.095, gz - hz - 0.15), (1, 0, 0), (0, (hb - hf) / (2 * hz), 1), hx + 0.12, (2 * hz + 0.3) * 1.002, "stRoof", 0.86)
        # the back and the right side boarded
        for k in range(5):
            y = 0.1 + k * 0.27
            tag(K.box(f"Board{k}", gx - hx, gx + hx, y, y + 0.24, gz + hz - 0.03, gz + hz, "stPlank", "h", 0.005), 0.84)
    # (BUILD ORDER, 2026-10-26 — you: the shed's roof "building" looked wrong: the set was dropped into the finished shed,
    # its exhaust pushed up through the roof. Now the set goes in first (0.78-0.8), the shed over it, the exhaust last)
    gen = "stChar" if state != "intact" else "stGen"
    # the set on its skids: the engine block, the tank over it, the alternator, the radiator's grille at the front
    for sx in (-0.3, 0.3):
        beam(K, f"Skid{sx}", (gx - 0.7, 0.04, gz + sx), (gx + 0.7, 0.04, gz + sx), 0.08, 0.08, "stSteelDark", 0.78)
    tag(K.box("Engine", gx - 0.65, gx + 0.2, 0.08, 0.72, gz - 0.33, gz + 0.33, gen, "h", 0.02), 0.79)
    rod(K, "Alternator", (gx + 0.2, 0.42, gz), (gx + 0.62, 0.42, gz), 0.24, gen, 0.79, 14)
    rod(K, "Tank", (gx - 0.6, 0.92, gz), (gx + 0.15, 0.92, gz), 0.17, gen, 0.8, 12)
    tag(K.box("Grille", gx - 0.68, gx - 0.64, 0.14, 0.68, gz - 0.3, gz + 0.3, "stGrille", "h", 0.0), 0.79)
    if state != "ruin":
        rod(K, "Exhaust", (gx - 0.2, 0.72, gz + 0.1), (gx - 0.2, hf + 0.6, gz + 0.1), 0.045, "stSteelDark", 0.875, 8)
        rod(K, "ExhaustCap", (gx - 0.2, hf + 0.6, gz + 0.1), (gx - 0.2, hf + 0.68, gz + 0.1), 0.07, "stSteelDark", 0.875, 8)
    else:   # flattened: the roof down on the set and the ground, the posts thrown
        corrugated(K, "Roof0", (gx - hx, 0.05, gz - hz - 0.4), (1, 0.0, 0.05), (0.15, 0.62, 1), hx * 2, 2 * hz + 0.2, "stRoof", 0.86)
        for i in range(3):
            a = R.uniform(0, math.pi)
            beam(K, f"ShedPost{i}", (gx + R.uniform(-1.2, 1.2), 0.05, gz + R.uniform(-1.2, 1.2)), (gx + R.uniform(-1.2, 1.2) + math.cos(a) * 1.4, 0.05, gz + 1.2 + math.sin(a) * 0.4), 0.09, 0.09, "stChar", 0.83)
    # the drums behind
    for k in range(3):
        x, z = gx + 0.3 + k * 0.62, gz + 1.35
        if state == "damaged" and k == 2: drumAt(K, f"Drum{k}", x + 0.4, z + 0.3, 0.94, lying=1.2)
        elif state == "ruin": drumAt(K, f"Drum{k}", x + R.uniform(-0.8, 1.2), z + R.uniform(0.0, 1.0), 0.94, lying=R.uniform(0, 3), mat="stChar" if k == 1 else "stDrum")
        else: drumAt(K, f"Drum{k}", x, z, 0.94)

def fallen(K, R):
    """THE RUIN: stumps on the feet; the lattice above lying where it fell (to -x, away from the shed), the deck flat
    beside its top."""
    for i, (sx, sz) in enumerate(LEGS):
        beam(K, f"Stump{i}", legAt(sx, sz, 0), legAt(sx, sz, R.uniform(0.05, 0.13)), 0.11, 0.11, "stSteel" if i % 2 else "stChar", 0.05, out=(sx, 0, sz))
    before = set(o.name for o in K.groups["h"])
    lattice(K, "ruin", f0=0.18, skip={(1, 1), (3, 2), (0, 0)})
    new = [o for o in K.groups["h"] if o.name not in before]
    # down onto its -x face: turned about the z axis through the -x legs' break, then dropped onto the ground
    piv = B(-legAt(1, 1, 0.18)[0], H * 0.18, 0)
    M = Matrix.Translation(piv) @ Matrix.Rotation(math.pi / 2 + math.atan((FB - FT) / H) - math.radians(1.4), 4, B(0, 0, 1) - B(0, 0, 0)) @ Matrix.Translation(-piv)
    bpy.context.view_layer.update()
    for o in new: o.matrix_world = M @ o.matrix_world
    bpy.context.view_layer.update()
    lo = min((o.matrix_world @ Vector(c)).z for o in new for c in o.bound_box)
    for o in new: o.location.z -= lo + 0.03
    # the deck, thrown flat beside the top (clear of the lattice: it lies at |z| < 1.6)
    x0, zc = -H + 1.0, 3.1
    for k in range(6):
        tag(K.box(f"Plank{k}", x0 + k * 0.24, x0 + k * 0.24 + 0.22, -0.02, 0.06, zc - P + R.uniform(-0.2, 0.2), zc + P + R.uniform(-0.2, 0.2), "stPlank" if k % 3 else "stChar", "h", 0.006), 0.68)

def buildTower(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    for i, (sx, sz) in enumerate(LEGS):
        x, _, z = legAt(sx, sz, 0)
        tag(K.box(f"Foot{i}", x - 0.28, x + 0.28, -0.25, 0.22, z - 0.28, z + 0.28, "stConcrete", "h", 0.02), 0.01)
    if state == "ruin":
        fallen(K, R)
    else:
        lattice(K, state)
        ladder(K)
        deck(K, R, state)
    shed(K, R, state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

def buildLamp(K, name, spec, state, seed, far=False):
    """The searchlight's HEAD (the yoke and the drum), its origin on the trunnions' axis — the game turns it there."""
    drystone.setLow(K, far)
    milprops.searchlight(K, "Light", (0, -PED, 0), 0.0, 0.97, pedestal=PED, part="head")
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farTower = lambda K, n, s, st, sd: buildTower(K, n, s, st, sd, far=True)
farLamp = lambda K, n, s, st, sd: buildLamp(K, n, s, st, sd, far=True)
TYPES = {"sltower": dict(builder=buildTower, farBuilder=farTower, atlas=2048, normalAtlas=1024, aoDist=0.5, smoothAngle=40, weighted=False, normals=True),
         "lamp": dict(builder=buildLamp, farBuilder=farLamp, atlas=1024, aoDist=0.15, smoothAngle=40)}
exported = buildKit(TYPES, MATDEF, "sltower.glb", prefix="Light", seed0=1957, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 800, 1000
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    lamp = "Lamp" in o.name
    cd.lens = 35; cam.location = B(-1.5, 1.0, -2.5) if lamp else B(-9, 12, -15)
    cam.rotation_euler = ((B(0, 0, 0) if lamp else B(0.5, 4.0, 0)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
