"""THE MIRADOR IN BLENDER (2026-10-21, the asset pass): the watchtower of every French post in Algeria — four raked
timber legs on concrete feet, X-braced in two bays, a ladder up the back to a hatch, a plank deck, a cabin of
weathered planks to waist height on corner posts, a corrugated roof pitched to the back, the searchlight and the
AA-52 on the front rail. Its sandbags are NOT here: the user's cloth-simulated parapet (sandbagWall.py layout
"mirador", public/models/alg/sandbagMirador.glb) stands on the deck in the game (algSangar.js).

    INTACT    as above
    DAMAGED   shot up and shelled: the roof's sheets torn off but one, a front brace snapped, planks blown out of the
              cabin, the searchlight down on the deck
    RUIN      collapsed: two legs snapped, the cabin down on the ground on its side, the roof sheets and timbers
              scattered, the ladder fallen

  BUILD ORDER (COLOR_0): the feet, the legs from the ground up, the braces bay by bay, the ladder, the deck, the
  posts, the planks, the roof, the light and the gun.

Real metres (the game ×1.3); the front (the searchlight) at -Z, the ladder at +Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/mirador.py -- <out dir> [--quick]

Writes <out>/mirador.glb (TowerMirador_Intact … _Ruin + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, Matrix, Euler
import house
from house import buildKit
from bkit import B, gv, srgb, dust, flat, wood
import drystone
from drystone import tag
import milprops

LS, HD, W = 2.6, 6.2, 3.0          # the legs' half spread at the foot, the deck's height, the cabin's width
TOP = W / 2 - 0.25                 # the legs' half spread at the deck

def galv(rust):
    def f(nb):
        c = nb.mix(nb.noise(1.1, 3), srgb(0x8f9493), srgb(0x6c7272))
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.1))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(7.0, 5), 0.55, 0.7), 0.6), c, srgb(0xb7b9b2))
        m = nb.mr(nb.noise(2.6, 6, 0.6, (9, 0.6, 9)), 0.7 - rust * 0.3, 0.78 - rust * 0.24)
        rc = nb.mix(nb.noise(16.0, 4), srgb(0x7e4b2e), srgb(0x4c2e1f))
        return dust(nb, nb.mix(m, c, rc), 0.9, 0.8)
    return f
def planks(tint):
    def f(nb):
        c = nb.mix(1.0, nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 0.7), srgb(tint), "MULTIPLY")
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.78, 1.15))
        return dust(nb, c, 1.2)
    return f
def steel(base):
    def f(nb):
        c = nb.mix(nb.noise(1.5, 4), srgb(base), tuple(v * 0.75 for v in srgb(base)))
        wear = nb.math("MULTIPLY", nb.mr(nb.point(), 0.52, 0.6), nb.noise(25.0, 3))
        return nb.mix(nb.math("MULTIPLY", wear, 1.4), c, srgb(0x6e5a48))
    return f
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "mrTimber": (0.9, planks(0x9c8a70)), "mrPlank": (0.9, planks(0xb8a68a)), "mrPlankDark": (0.9, planks(0x8c7c64)),
    "mrRoof": (0.6, galv(0.45)), "mrRoofRust": (0.8, galv(0.9)), "mrConcrete": (0.95, flat(srgb(0xa59c8c), 0.4)),
    "mrSteel": (0.55, steel(0x34372f)), "mrGlass": (0.2, flat(srgb(0xe8e4c8), 0.0)), "mrCharred": (0.95, charred),
})
MATDEF.update(milprops.MILPROP_MATS)   # (the shared searchlight and AA-52 — milprops.py)

LOW = lambda: drystone.LOW

def beam(K, nm, a, b, w, h, mat, t, roll=0.0):
    """A squared timber from a to b (game), w × h in section."""
    a, b = gv(*a), gv(*b)
    d = (b - a); L_ = d.length; d.normalize()
    up = gv(0, 1, 0) if abs(d.y) < 0.95 else gv(1, 0, 0)
    u = d.cross(up).normalized(); v = u.cross(d).normalized()
    if roll: u, v = u * math.cos(roll) + v * math.sin(roll), v * math.cos(roll) - u * math.sin(roll)
    bm = bmesh.new()
    vs = [bm.verts.new(B(*(a + d * s + u * (cu * w / 2) + v * (cv * h / 2)))) for s in (0, L_) for cu in (-1, 1) for cv in (-1, 1)]
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.bevel(K.obj(nm, bm, mat, "h"), 0.012 if not LOW() else 0, 2, 40), t)

def pole(K, nm, a, b, r, mat, t):
    return tag(K.rod(nm, a, b, r, mat, "h", n=8 if not LOW() else 5), t)

def corrugated(K, nm, o, aw, al, width, length, mat, t, pitch=0.1, depth=0.025):
    """A corrugated sheet: corner o, waves across aw, length along al (game vectors); thin, both faces."""
    o, aw, al = gv(*o), gv(*aw).normalized(), gv(*al).normalized()
    an = aw.cross(al).normalized()
    if an.y < 0: an = -an
    # (the FAR keeps the ribs as a zig-zag, two segments a wave — as the motor pool's: flat, its bake lost the ribs'
    # shading and the roof changed texture at the LOD switch, 2026-10-26)
    segs = 4 if not LOW() else 2
    phase = 0.0 if not LOW() else math.pi / 2
    N_ = max(2, round(width / pitch * segs))
    bm = bmesh.new(); rows = []
    for i in range(N_ + 1):
        w = width * i / N_
        off = depth / 2 * math.sin(2 * math.pi * w / pitch + phase)
        p = o + aw * w + an * off
        rows.append((bm.verts.new(B(*p)), bm.verts.new(B(*(p + al * length)))))
    for i in range(N_):
        bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
    ob = K.obj(nm, bm, mat, "h", smooth=True)
    so = ob.modifiers.new("S", "SOLIDIFY"); so.thickness = 0.004; so.offset = -1.0
    return tag(ob, t)

LEGS = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
def legAt(sx, sz, f): return (sx * (LS + (TOP - LS) * f), HD * f, sz * (LS + (TOP - LS) * f))

def tower(K, R, state, frame):
    """The legs, the braces and the ladder, in `frame` (a 4×4 game matrix: the ruin lies them down)."""
    broken = {"damaged": {(0, "a")}, "ruin": set()}.get(state, set())
    for i, (sx, sz) in enumerate(LEGS):
        tag(K.box(f"Foot{i}", sx * LS - 0.3, sx * LS + 0.3, -0.25, 0.25, sz * LS - 0.3, sz * LS + 0.3, "mrConcrete", "h", 0.02), 0.01)
        if state == "damaged" and i == 0:
            # the front-left leg SNAPPED by a shell near the foot: a splintered stump, the leg above hanging off it
            # (the tower leans onto that corner — leanAll)
            beam(K, f"Leg{i}", legAt(sx, sz, 0), legAt(sx, sz, 0.1), 0.2, 0.2, "mrCharred", 0.04)
            a, b = Vector(legAt(sx, sz, 0.14)), Vector(legAt(sx, sz, 1.0))
            beam(K, f"LegUp{i}", tuple(a + Vector((0.25, 0, 0.18))), tuple(b), 0.2, 0.2, "mrTimber", 0.05)
            continue
        if state == "ruin":
            # snapped: a stump standing (the rest lies about — ruinPile)
            beam(K, f"Leg{i}", legAt(sx, sz, 0), legAt(sx, sz, R.uniform(0.06, 0.2)), 0.2, 0.2, "mrTimber" if i % 2 else "mrCharred", 0.05)
            continue
        beam(K, f"Leg{i}", legAt(sx, sz, 0), legAt(sx, sz, 1.0), 0.2, 0.2, "mrTimber", 0.04 + 0.04 * i / 4)
    if state == "ruin": return
    for i in range(4):
        (ax, az), (bx, bz) = LEGS[i], LEGS[(i + 1) % 4]
        for bay, (f0, f1) in enumerate(((0.08, 0.5), (0.5, 0.92))):
            t = 0.16 + 0.12 * bay + 0.02 * i
            if not (i == 0 and bay == 0 and state == "damaged"):
                pole(K, f"BrA{i}{bay}", legAt(ax, az, f0), legAt(bx, bz, f1), 0.055, "mrTimber", t)
            else:   # snapped by a shell: half of it hanging
                pole(K, f"BrA{i}{bay}", legAt(ax, az, f0), tuple(Vector(legAt(ax, az, f0)).lerp(Vector(legAt(bx, bz, f1)), 0.45) + Vector((0, -0.25, 0.1))), 0.055, "mrTimber", t)
            # the crossing brace passes on the OUTSIDE of the first (no z-fight where they cross)
            out = Vector((ax + bx, 0, az + bz)).normalized() * 0.11
            pa, pb = Vector(legAt(bx, bz, f0)) + out, Vector(legAt(ax, az, f1)) + out
            pole(K, f"BrB{i}{bay}", tuple(pa), tuple(pb), 0.055, "mrTimber", t + 0.01)
        pole(K, f"Girt{i}", legAt(ax, az, 0.5), legAt(bx, bz, 0.5), 0.065, "mrTimber", 0.28)
    # the ladder up the back (+z) to the hatch
    z0, z1 = LS * 0.55 + 0.9, TOP - 0.05
    for sx in (-0.25, 0.25):
        beam(K, f"Rail{sx}", (sx, 0, z0), (sx, HD, z1), 0.07, 0.07, "mrTimber", 0.4)
    for k in range(1, 18 if not LOW() else 9):
        f = k / (18 if not LOW() else 9)
        beam(K, f"Rung{k}", (-0.25, HD * f, z0 + (z1 - z0) * f), (0.25, HD * f, z0 + (z1 - z0) * f), 0.04, 0.04, "mrTimber", 0.4 + 0.08 * f)

def cabin(K, R, state, M):
    """The deck, the posts, the plank walls, the roof, the light and the gun — placed by M (game 4×4: identity
    up on the tower; the ruin lays it on the ground)."""
    made = []
    def keep(o):
        if o is not None: made.append(o)
        return o
    y = HD
    # the deck: planks across
    n = 13 if not LOW() else 6
    for k in range(n):
        x = -(W + 0.4) / 2 + (k + 0.5) * (W + 0.4) / n
        keep(beam(K, f"Deck{k}", (x, y + 0.1, -(W + 0.4) / 2), (x, y + 0.1, (W + 0.4) / 2), (W + 0.4) / n - 0.01, 0.06, "mrPlank" if k % 3 else "mrPlankDark", 0.5))
    for sx in (-1, 1):   # its two bearers
        keep(beam(K, f"Bearer{sx}", (sx * TOP, y, -(W + 0.4) / 2), (sx * TOP, y, (W + 0.4) / 2), 0.16, 0.16, "mrTimber", 0.48))
    # the corner posts
    for i, (sx, sz) in enumerate(LEGS):
        if state == "damaged" and i == 1:
            keep(beam(K, f"Post{i}", (sx * W / 2, y + 0.13, sz * W / 2), (sx * W / 2 + 0.3, y + 1.4, sz * W / 2 - 0.2), 0.12, 0.12, "mrTimber", 0.6))
        else:
            keep(beam(K, f"Post{i}", (sx * W / 2, y + 0.13, sz * W / 2), (sx * W / 2, y + 2.45, sz * W / 2), 0.12, 0.12, "mrTimber", 0.6))
    # the plank walls: front and sides to waist height (horizontal boards), the back full height but for the hatch side
    def wall(nm, a, b, h0, h1, t, gone=()):
        a, b = gv(*a), gv(*b)
        k = 0
        hh = h0
        while hh < h1 - 0.02:
            bh = R.uniform(0.17, 0.22)
            if k not in gone:
                m_ = "mrPlank" if R.random() < 0.7 else "mrPlankDark"
                if state == "damaged" and R.random() < 0.3: m_ = "mrCharred"   # scorched by the hit
                keep(beam(K, f"{nm}{k}", tuple(a + gv(0, hh + bh / 2, 0)), tuple(b + gv(0, hh + bh / 2, 0)), 0.035, bh - 0.012, m_, t + 0.01 * k))
            hh += bh; k += 1
    g = W / 2 + 0.02
    wall("Front", (-g, y, -g), (g, y, -g), 0.13, 1.15, 0.64, gone=(2, 3) if state == "damaged" else ())
    wall("Left", (-g, y, -g), (-g, y, g), 0.13, 1.15, 0.64)
    wall("Right", (g, y, -g), (g, y, g), 0.13, 1.15, 0.64, gone=(1,) if state == "damaged" else ())
    wall("Back", (-g, y, g), (g * 0.2, y, g), 0.13, 2.3, 0.66)
    # the roof: sheets pitched to the back, on two purlins
    for sx in (-1, 1):
        keep(beam(K, f"Purlin{sx}", (sx * W / 2, y + 2.5, -W / 2 - 0.4), (sx * W / 2, y + 2.3, W / 2 + 0.4), 0.1, 0.1, "mrTimber", 0.8))
    sheets = [(-W / 2 - 0.45, 1.05), (-W / 2 + 0.55, 1.05), (-W / 2 + 1.55, 1.05), (-W / 2 + 2.55, 0.9)]
    for k, (x0, wd) in enumerate(sheets):
        if state == "damaged" and k == 2:
            # torn loose: hanging down off the front edge
            keep(corrugated(K, f"Sheet{k}", (x0, y + 2.5, -W / 2 - 0.45), (1, 0, 0), (0.05, -1, -0.35), wd, 1.9, "mrRoofRust", 0.84 + 0.02 * k))
            continue
        if state == "damaged" and k != 1: continue
        lift = 0.005 * k
        keep(corrugated(K, f"Sheet{k}", (x0, y + 2.56 + lift, -W / 2 - 0.45), (1, 0, 0), (0, -0.2 / (W + 0.9), 1), wd, W + 0.92, "mrRoof" if k % 2 == 0 else "mrRoofRust", 0.84 + 0.02 * k))
    # the searchlight and the gun on the front rail
    if state == "intact":
        # THE SEARCHLIGHT and THE AA-52 (2026-10-21 — you: "the gun and the projector look very cheap"): the shared
        # detailed props (milprops.py) — the light on its pedestal behind the front wall, its drum over the planks;
        # the gun on a pintle at the rail
        # (the searchlight and the gun are the separate "gear" piece — their own atlas: gear() below)
        beam(K, "Pintle", (-0.6, y + 0.13, -W / 2 + 0.3), (-0.6, y + 1.2, -W / 2 + 0.3), 0.06, 0.06, "mrSteel", 0.96)
    # placed by M
    for o in made:
        o.matrix_world = M @ o.matrix_world

def ruinPile(K, R):
    """The cabin down: its deck and walls on their side on the ground beside the stumps; timbers, sheets about."""
    M = Matrix.Translation(B(-1.2, 0.0, -2.2)) @ Matrix.Rotation(math.radians(-80), 4, "X") @ Matrix.Translation(B(0, -HD - 0.15, 0))
    cabin(K, R, "ruin", M)
    for k in range(7):   # timbers and legs down
        a = gv(R.uniform(-4, 4), 0.1, R.uniform(-4, 4)); d = gv(R.uniform(-1, 1), 0.05, R.uniform(-1, 1)).normalized()
        beam(K, f"Down{k}", tuple(a), tuple(a + d * R.uniform(1.5, 4.5)), 0.2 if k < 2 else 0.1, 0.2 if k < 2 else 0.1, "mrTimber" if k % 3 else "mrCharred", 0.1)
    for k in range(3):
        corrugated(K, f"DownSheet{k}", (R.uniform(-4, 3), 0.04 + 0.01 * k, R.uniform(-4, 3)), (math.cos(k * 2.1), 0.02, math.sin(k * 2.1)), (-math.sin(k * 2.1), 0, math.cos(k * 2.1)), 1.0, 2.2, "mrRoofRust", 0.1)

LEAN = math.radians(6.5)
def leanAll(K):
    """The damaged tower LEANS onto its snapped leg (game corner -x -z): every part turned about the horizontal line
    through the OPPOSITE foot, square to the diagonal — that foot stays, the snapped corner drops onto its stump. The
    feet and the stump (in the ground) stay where they are."""
    piv = B(LS, 0, LS)                        # the opposite foot (game +x +z)
    axis = (B(1, 0, -1) - B(0, 0, 0)).normalized()
    M = Matrix.Translation(piv) @ Matrix.Rotation(-LEAN, 4, axis) @ Matrix.Translation(-piv)
    for o in K.groups["h"]:
        if o.name.startswith("Foot") or o.name == "Leg0": continue
        o.matrix_world = M @ o.matrix_world

def buildGear(K, name, spec, state, seed, far=False):
    """THE GEAR (2026-10-21 — you: "the gun and the projector look very cheap"): the searchlight and the AA-52, the shared
    detailed props (milprops.py), their OWN piece with their own 1024 atlas — on the tower's 2048 they had a few texels
    each and read as blurred grey drums. In the tower's frame (the game adds it there); the mirador's last moment."""
    drystone.setLow(K, far)
    y = HD
    if state == "intact":
        milprops.searchlight(K, "Light", (0.75, y + 0.13, -W / 2 + 0.55), 0.0, 0.95, pedestal=1.45)
        milprops.aa52(K, "Gun", (-0.6, y + 1.26, -W / 2 + 0.3), 0.0, 0.96)
    elif state == "damaged":   # the searchlight knocked off its post, down on the deck (leaning with the tower)
        milprops.searchlight(K, "Light", (0.3, y + 0.13, 0.4), 2.3, 0.95, pedestal=0.42)
        leanAll(K)
    else:                      # thrown down beside the wreck
        milprops.searchlight(K, "Light", (2.6, 0.0, -2.8), 1.1, 0.95, pedestal=0.42)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

def buildMirador(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    tower(K, random.Random(seed + 1), state, None)
    if state == "ruin": ruinPile(K, random.Random(seed + 2))
    else: cabin(K, random.Random(seed + 2), state, Matrix.Identity(4))
    if state == "damaged": leanAll(K)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farMirador = lambda K, name, spec, state, seed: buildMirador(K, name, spec, state, seed, far=True)
farGear = lambda K, name, spec, state, seed: buildGear(K, name, spec, state, seed, far=True)
TYPES = {"mirador": dict(builder=buildMirador, farBuilder=farMirador, atlas=2048, aoDist=0.6, smoothAngle=40),
         "gear": dict(builder=buildGear, farBuilder=farGear, atlas=1024, aoDist=0.15, smoothAngle=40)}

exported = buildKit(TYPES, MATDEF, "mirador.glb", prefix="Tower", seed0=1958, colors=True)

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
    cd.lens = 35; cam.location = B(-7, 12, -13); cam.rotation_euler = (B(0, 4.0, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
