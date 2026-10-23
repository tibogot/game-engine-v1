"""THE FORTIFIED POINT IN BLENDER (2026-10-21, you: "except the sandbags everything looks too cheap"): the sappers'
horseshoe of sandbags in a held point — the user's cloth-simulated walls (sandbagFort.glb: a 5 m front at z -2.0 and two
3.2 m sides at (±3.05, -0.55) turned ±1.05 — the old piece's frame, kit metres) — and round them, now:

  EARTH     the spoil of the dig BANKED against the outside of each wall (a low mound along it, its foot spread)
  INSIDE    ammunition crates (one on another, rope handles), two jerrycans, the field telephone on its crate with
            the wire reel and the line running out under the bags, a shovel and a pick stuck in the bank, a rolled tarp

    INTACT    as above
    DAMAGED   a shell on the front: a bite out of the bank, the crates thrown, the reel knocked over
    RUIN      blown: the banks slumped, the stores burnt to black heaps

  BUILD ORDER (COLOR_0): the banks first (dug as the bags go up — the game lays the bags in between), the stores last.

Real metres (the game ×1.3 — the bags' frame is the kit's, so the same numbers); the front at -Z, open behind (+Z).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/fortPoint.py -- <out dir> [--quick]

Writes <out>/fortpoint.glb (FortPoint_Intact … + _Far) — then tools/optimizeGlb.mjs.
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
import props

# the walls (kit metres = the Blender piece's real metres): centre x, z, three.js yaw, length
WALLS = [(0.0, -2.0, 0.0, 5.0), (-3.05, -0.55, 1.05, 3.2), (3.05, -0.55, -1.05, 3.2)]
INNER = 0.14              # the bank's inner foot, under the bags (their inner face 0.15)
WALL_HALF = 0.12          # under the bags' outer face (one bag thick: 0.38 game, its sag to 0.23 out of the line)

def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
def crateMat(nb):
    """Olive-painted ammunition boxes: the paint over the plank grain, worn and dusty."""
    c = nb.mix(0.55, srgb(0x55583a), nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 0.9), "MULTIPLY")
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.85, 1.1)), 0.45)
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update(props.PROP_MATS)
MATDEF.update({
    "fpEarth": (1.0, milprops.earthMat(0x9c8a72)), "fpCrate": (0.8, crateMat), "fpBatten": (0.85, milprops.timberMat(0x8a7a5c)), "fpHandle": (0.85, milprops.timberMat(0x9a876a)),
    "fpJerry": (0.6, props.steel_paint(0x56603a, 0.3)), "fpSteel": (0.5, milprops._steel(0x3a3c38, 0.4)), "fpPhone": (0.6, milprops._steel(0x3b4130, 0.2)),
    "fpCanvas": (0.95, flat(srgb(0x5c5e3e), 0.3)), "fpRope": (0.9, flat(srgb(0x9a8a68), 0.0)), "fpWire": (0.8, flat(srgb(0x1b1b18), 0.0)),
    "fpChar": (0.95, charred),
})
LOW = lambda: drystone.LOW

def toWorld(cx, cz, yaw, lx, lz):
    c, s = math.cos(yaw), math.sin(yaw)
    return (cx + lx * c + lz * s, cz - lx * s + lz * c)

def bank(K, nm, cx, cz, yaw, length, R, state, bite=None):
    """A mound of spoil against the wall's OUTER face (local -z), along its length: its crest just outside the bags, a
    raised-cosine fall to a soft foot outside; inside it dips back to the ground UNDER the bags (no open edge when they
    are gone — the damaged / ruin states); `bite`: (local x, radius) scooped out (a shell)."""
    nu, nv = (24, 12) if not LOW() else (10, 6)
    off = Vector((R.uniform(0, 40), R.uniform(0, 40), 0))
    w, h = 1.15, 0.3 * (0.6 if state == "ruin" else 1.0)
    bm = bmesh.new(); grid = []
    for i in range(nu + 1):
        u = -length / 2 - 0.7 + (length + 1.4) * i / nu        # past the wall ends: the corners close
        end = min(1.0, (length / 2 + 0.7 - abs(u)) / 0.9); end = end * end * (3 - 2 * end)   # tapering past the wall's ends
        row = []
        for j in range(nv + 1):
            v = j / nv
            d = -INNER + (INNER + WALL_HALF + w) * v                             # out from the wall's line
            if d < WALL_HALF:
                k = min(1.0, max(0.0, (d + INNER) / (INNER + WALL_HALF))); k = k * k * (3 - 2 * k)
            else:
                k = 0.5 * (1 + math.cos(math.pi * min(1.0, (d - WALL_HALF) / w)))
            lz = -d
            y = -0.05 + h * end * k
            y += mnoise.noise(Vector((u * 1.3, v * 2, 0)) + off) * 0.035 * (1 - v)
            if bite and abs(u - bite[0]) < bite[1]: y -= 0.3 * (1 - abs(u - bite[0]) / bite[1]) * (1 - v * 0.5)
            x, z = toWorld(cx, cz, yaw, u, lz)
            row.append(bm.verts.new(B(x, max(-0.06, y) if v < 1 else -0.06, z)))
        grid.append(row)
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    return tag(K.obj(nm, bm, "fpEarth", "h", smooth=True), 0.02)

def box(K, nm, at, size, yaw, mat, t, tilt=0.0, w=0.008):
    x, y, z = size
    o = K.box(nm, -x / 2, x / 2, 0, y, -z / 2, z / 2, mat, "h", w)
    o.rotation_mode = "XYZ"; o.rotation_euler = (tilt, 0, yaw); o.location = B(*at)
    return tag(o, t)

def mkt(K, t):
    """props' make: a kit object, tagged with its moment in the construction."""
    return lambda n, bm, m: tag(K.obj(n, bm, m, "h", smooth=True), t)
def crate(K, nm, at, yaw, t, mat="fpCrate", tilt=0.0):
    """A stores crate — THE shared one (props.crate, 2026-10-23)."""
    props.place(props.crate(mkt(K, t), nm, mat, "fpChar" if mat == "fpChar" else "propRope", 0.62, 0.32, 0.4, LOW()), at, yaw, tilt)

def jerry(K, nm, at, yaw, t, tilt=0.0, mat="fpJerry"):
    """The jerrycan — THE shared one (props.jerry; built long along x: turned a quarter to stand as this kit's did)."""
    props.place(props.jerry(mkt(K, t), nm, mat, "fpChar" if mat == "fpChar" else "propFittings", LOW()), at, yaw + math.pi / 2, tilt)

def phone(K, R, at, t):
    """The field telephone on its crate, the wire reel beside, the line out under the front wall."""
    x, y, z = at
    crate(K, "PhoneCrate", (x, 0, z), 0.15, t)
    box(K, "Phone", (x, 0.32, z), (0.24, 0.13, 0.17), 0.15, "fpPhone", t)
    if not LOW():
        tag(K.rod("Handset", (x - 0.06, 0.47, z - 0.03), (x + 0.07, 0.47, z - 0.05), 0.018, "fpPhone", "h", n=6), t)
        tag(K.rod("Crank", (x + 0.12, 0.38, z + 0.02), (x + 0.17, 0.42, z + 0.02), 0.008, "fpSteel", "h", n=4), t)
    # the reel on its frame
    rx, rz = x + 0.65, z - 0.15
    for sx in (-0.11, 0.11):
        tag(K.rod(f"ReelSide{sx}", (rx + sx, 0.0, rz - 0.15), (rx + sx, 0.3, rz), 0.012, "fpSteel", "h", n=4), t)
        tag(K.rod(f"ReelSideB{sx}", (rx + sx, 0.0, rz + 0.15), (rx + sx, 0.3, rz), 0.012, "fpSteel", "h", n=4), t)
    tag(K.rod("Reel", (rx - 0.1, 0.3, rz), (rx + 0.1, 0.3, rz), 0.11, "fpWire", "h", n=12 if not LOW() else 6), t)
    if not LOW():   # the line out: across the floor, under the front wall
        pts = [(rx, 0.22, rz - 0.1), (rx - 0.2, 0.02, rz - 0.6), (rx - 0.4, 0.015, -1.4), (rx - 0.5, 0.015, -2.5)]
        for i in range(3): tag(K.rod(f"Line{i}", pts[i], pts[i + 1], 0.006, "fpWire", "h", n=3), t)

def bankY(d, h=0.3):
    """The bank's height d out from its wall's line (bank()'s profile, mid-length)."""
    k = 0.5 * (1 + math.cos(math.pi * min(1.0, max(0.0, d - WALL_HALF) / 1.15)))
    return -0.05 + h * k

def stuck(K, nm, wall, lx, d, lean, length, r, mat, t, depth=0.15):
    """A haft stuck in the bank of WALLS[wall] at (lx along it, d out), leaning `lean` rad back toward the wall,
    `depth` buried. Returns its foot and unit direction."""
    cx, cz, yaw, _ = WALLS[wall]
    fx, fz = toWorld(cx, cz, yaw, lx, -d)
    ox, oz = toWorld(0, 0, yaw, 0, 1)                                        # toward the wall (inward)
    dr = Vector((ox * math.sin(lean), math.cos(lean), oz * math.sin(lean)))
    foot = Vector((fx, bankY(d) - depth, fz))
    top = foot + dr * length
    tag(K.rod(nm, tuple(foot), tuple(top), r, mat, "h", n=6), t)
    return foot, dr

def plate(K, nm, c, up, side, hw, hh, th, mat, t):
    """A thin plate centred at c (three.js axes), its height along `up`, its width along `side`."""
    n = up.cross(side).normalized(); side = n.cross(up).normalized()
    bm = bmesh.new()
    for a in (-1, 1):
        for b in (-1, 1):
            for e in (-1, 1):
                p = c + side * (a * hw) + up * (b * hh) + n * (e * th)
                bm.verts.new(B(p.x, p.y, p.z))
    bmesh.ops.convex_hull(bm, input=list(bm.verts))
    return tag(K.obj(nm, bm, mat, "h"), t)

def tools(K, t):
    """A shovel stuck blade-down in the left bank and a pick beside it, a rolled tarp."""
    foot, dr = stuck(K, "ShovelHaft", 1, 0.7, 0.75, 0.3, 1.05, 0.017, "fpHandle", t, depth=-0.12)
    bl = foot - dr * 0.14                                                    # the blade below the haft, half buried
    sx, sz = toWorld(0, 0, WALLS[1][2], 1, 0)
    plate(K, "ShovelBlade", bl, dr, Vector((sx, 0, sz)), 0.11, 0.14, 0.008, "fpSteel", t)
    foot, dr = stuck(K, "PickHaft", 1, -0.4, 0.85, 0.45, 0.9, 0.018, "fpHandle", t, depth=0.0)
    hd = foot + dr * 0.12                                                    # the head across the haft, one point in the earth
    ax, az = toWorld(0, 0, WALLS[1][2], 1, 0)
    tag(K.rod("PickHead", (hd.x - ax * 0.26, hd.y - 0.08, hd.z - az * 0.26), (hd.x + ax * 0.26, hd.y + 0.04, hd.z + az * 0.26), 0.019, "fpSteel", "h", n=6), t)
    tag(K.rod("Tarp", (1.6, 0.11, 0.2), (1.6, 0.11, 1.0), 0.11, "fpCanvas", "h", n=10 if not LOW() else 6), t)

def buildFort(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    for k, (cx, cz, yaw, length) in enumerate(WALLS):
        bite = (0.4, 0.9) if state == "damaged" and k == 0 else None
        bank(K, f"Bank{k}", cx, cz, yaw, length, R, state, bite)
    if state == "ruin":
        for k in range(5):
            x, z = R.uniform(-1.6, 1.6), R.uniform(-1.4, 0.6)
            box(K, f"Burnt{k}", (x, 0.0, z), (R.uniform(0.3, 0.6), R.uniform(0.08, 0.16), R.uniform(0.2, 0.4)), R.uniform(0, 3), "fpChar", 0.9, R.uniform(-0.2, 0.2))
    elif state == "damaged":
        # thrown by the shell: flat on the ground at odd angles (a tilt about the base would float an edge), one burnt;
        # the jerrycan on its side (lifted by its half width)
        for k, (x, z) in enumerate(((0.0, 0.35), (0.9, 0.5), (1.3, -0.9))):
            crate(K, f"Crate{k}", (x, 0.0, z), R.uniform(0, 3), 0.9, mat="fpChar" if k == 2 else "fpCrate")
        jerry(K, "Jerry0", (1.6, 0.17, -0.2), 0.9, 0.92, tilt=math.pi / 2)
        phone(K, R, (-1.1, 0.0, -1.0), 0.94)
    else:
        crate(K, "Crate0", (0.8, 0.0, -1.1), 0.25, 0.86)
        crate(K, "Crate1", (0.85, 0.32, -1.1), 0.1, 0.88)
        crate(K, "Crate2", (1.5, 0.0, -0.95), -0.2, 0.88)
        jerry(K, "Jerry0", (2.0, 0.0, -0.7), -0.3, 0.9)
        jerry(K, "Jerry1", (2.2, 0.0, -0.45), -0.1, 0.9)
        phone(K, R, (-1.2, 0.0, -1.1), 0.92)
        tools(K, 0.95)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farFort = lambda K, n, s, st, sd: buildFort(K, n, s, st, sd, far=True)
TYPES = {"point": dict(builder=buildFort, farBuilder=farFort, atlas=2048, normalAtlas=1024, aoDist=0.4, smoothAngle=40, weighted=False, normals=True)}
exported = buildKit(TYPES, MATDEF, "fortpoint.glb", prefix="Fort", seed0=1964, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1000, 700
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cd.lens = 35; cam.location = B(-3, 6, -8); cam.rotation_euler = (B(0, 0.2, -0.8) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
