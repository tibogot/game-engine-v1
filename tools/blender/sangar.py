"""THE SANGAR IN BLENDER (2026-10-21, PIECES_INVENTORY.md "Sangar: REDO — the FLN's sandbags, very visible"): the
ALN's dry-stone firing position — a C of stones on a hillside, open at the back, a captured FM over its front lip.
Built as the men build it: field stones in battered courses round the C, two faces with rubble between, flat
capstones on top and a broad LIP stone at the front where the gun rests, dry juniper laid along the top so from
the air it is one more heap of stones. An ammunition box and a water jar inside, spare stones outside.

    INTACT    knee-to-chest high (1.05 m), 4-5 courses
    DAMAGED   shelled: a breach through the front-left, its stones tumbled outside, most of the brush gone
    RUIN      knocked down to a low ring, stones scattered all round, the jar in pieces

  BUILD ORDER  every part carries the moment it is laid (0..1) in a colour attribute exported as COLOR_0 (.r):
               the props first, then the courses one by one along the arc, the capstones, the lip, the brush.
               The game's construction material reveals them in that order (algSangar.js) — no stretching.

Real metres (the game ×1.3, as the kit); the front (the gun) at -Z, the open back at +Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/sangar.py -- <out dir> [--quick]

Writes <out>/sangar.glb (SangarSangar_Intact … _Ruin + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
import house
from house import buildKit
from bkit import B, srgb, dust, flat, wood

RAD, A0, A1 = 1.8, math.pi * 0.72, math.pi * 2.28    # the wall's centre line, the arc (open toward +z)
HGT, DEPTH, COURSES = 1.05, 0.62, 5
FRONT = math.pi * 1.5                                  # -z: the gun's side
LOW = False

SCAN = os.path.join(house.bkit.ROOT, "assets-src", "scans", "polyhaven", "rock_boulder_dry")
def scanImg(nb, file, sc, data=False):
    im = bpy.data.images.load(os.path.join(SCAN, file), check_existing=True)
    if data: im.colorspace_settings.name = "Non-Color"
    mp = nb.N.new("ShaderNodeMapping"); nb.L.new(nb.tc.outputs["Object"], mp.inputs["Vector"]); mp.inputs["Scale"].default_value = (sc, sc, sc)
    n = nb.N.new("ShaderNodeTexImage"); n.image = im; n.projection = "BOX"; n.projection_blend = 0.25
    nb.L.new(mp.outputs["Vector"], n.inputs["Vector"]); return n.outputs["Color"]
def stoneMat(tint, sc=1.6):
    """The scanned weathered limestone (Poly Haven CC0 rock_boulder_dry, 2k): its photo, every stone its own shade,
    lichen; its NORMAL map on the BSDF — what the normal bake reads."""
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
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "sgStone": (0.95, stoneMat(0xe0d6c2)), "sgCap": (0.95, stoneMat(0xeae2d0)),   # (a light hand on the scan's own pale limestone)
    "sgBrush": (0.95, brushMat), "sgJar": (0.9, flat(srgb(0xa8644a), 0.3)), "sgBox": (0.9, wood(0x7d7558)),
})

def tag(o, t):
    """The moment this part is laid (0..1), for the colour attribute written at the end."""
    if o is not None: o["t"] = float(t)
    return o

# THE STONES (2026-10-21, you: "the stones look very cheap, not AAA"). Tried first: whole scanned stones (Poly Haven
# CC0, tools/blender/scanStones.py) stacked in courses — their colours a patchwork (white quartz, pink, brown) and
# the stack a rubble pile, not a built wall. What reads: the TIDY courses, each stone a BLOCK of split limestone —
# a hull pushed toward a box (flat faces, chipped corners), its surface the scanned weathered limestone
# (rock_boulder_dry: colour, and its NORMAL map — the bake carries the relief into the game's normal atlas).
def stone(K, nm, c, size, R, t, mat="sgStone", yaw=None):
    """A split block: c its centre (game), size its half extents (along, up, across — `yaw` its long axis's turn,
    three.js rotation.y; random without one). The same random numbers at either level (far: fewer points)."""
    ry, tx, tz = R.uniform(0, 6.283), R.uniform(-0.08, 0.08), R.uniform(-0.08, 0.08)
    th = yaw if yaw is not None else ry
    ca, sa = math.cos(th), math.sin(th)
    N = 26
    pts = []
    for i in range(N):
        u = 1 - 2 * (i + 0.5) / N; v = i * 2.399963 + R.uniform(-0.25, 0.25)
        r = math.sqrt(max(0.0, 1 - u * u))
        q = [r * math.cos(v), u, r * math.sin(v)]
        q = [math.copysign(abs(x) ** 0.45, x) for x in q]                 # toward a box: flat faces, edges
        chip = R.random()
        k = R.uniform(0.86, 1.0) * (0.78 if chip < 0.18 else 1.0)          # a corner knocked off
        pts.append((q[0] * size[0] * k, q[1] * size[1] * R.uniform(0.9, 1.0), q[2] * size[2] * k))
    if LOW: pts = pts[::2]
    bm = bmesh.new()
    vs = []
    for lx, ly, lz in pts:
        ly += lx * tx + lz * tz
        # (local along / across turned by the yaw — three.js rotation.y)
        vs.append(bm.verts.new(B(c[0] + lx * ca + lz * sa, c[1] + ly, c[2] - lx * sa + lz * ca)))
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.obj(nm, bm, mat, "h"), t)

def arcPt(a, r): return (math.cos(a) * r, math.sin(a) * r)

# THE PROFILE (2026-10-21, seen in the game: "a neat stone well"): full height at the front where the gun rests,
# falling to about half toward the ends of the C — a heap raised where it is needed, not a drum.
def profile(a): return HGT * (0.5 + 0.5 * (0.5 + 0.5 * math.cos(a - FRONT)) ** 0.8)
NB = 72
def bin_(a): return max(0, min(NB - 1, int((a - A0) / (A1 - A0) * NB)))

def wall(K, R, state):
    """The courses round the C: an outer and an inner face of stones, staggered, battered in; capstones; the lip."""
    k = 0
    span = A1 - A0
    tops = [0.0] * NB                                                         # the height reached, by angle
    top = HGT if state != "ruin" else HGT * 0.32
    breach = (FRONT - 0.55, FRONT - 0.05)   # (angles) the damaged sangar's breach, front-left
    y, c = 0.0, 0
    while y < top - 0.06:
        ch = R.uniform(0.2, 0.28) * (1.0 if c == 0 else 0.92)   # (bigger stones, fewer of them: as a real one — and the triangles)
        d = DEPTH / 2 - (y / HGT) * 0.07                                       # the batter
        for face, rr in ((0, RAD + d * 0.62), (1, RAD - d * 0.62)):
            a = A0 + (0.06 if (c + face) % 2 else 0.0)
            while a < A1 - 0.03:
                w = R.uniform(0.3, 0.5) if R.random() < 0.8 else R.uniform(0.5, 0.66)
                da = w / rr
                am = min(a + da / 2, A1 - 0.03)
                jit = (R.uniform(-0.03, 0.03), R.uniform(0.55, 0.68), R.random(), R.uniform(-0.04, 0.04))
                a += da + R.uniform(0.0, 0.015) / rr
                gone = (state == "damaged" and breach[0] < am < breach[1] and c >= 1) or \
                       (state == "ruin" and c >= 1 and jit[2] < 0.55)
                if gone or y > profile(am) - 0.06: continue
                for b in range(bin_(am - da / 2), bin_(am + da / 2) + 1): tops[b] = max(tops[b], y + ch * 0.95)
                x, z = arcPt(am, rr + jit[3])
                # (along the arc: the stone's long axis on the tangent — rotation.y -(a + pi/2))
                t = 0.08 + 0.66 * (c + (am - A0) / span) / COURSES
                stone(K, f"S{k}", (x, y + ch / 2, z), (w * 0.55, ch * 0.62, d * jit[1]), R, t, yaw=-(am + math.pi / 2))
                k += 1
        y += ch * 0.9
        c += 1
    if state == "ruin": return
    # the capstones: flat stones across the top, the lip broad and level at the front (the gun rests on it)
    a = A0
    while a < A1 - 0.05:
        w = R.uniform(0.26, 0.38)
        am = a + w / RAD / 2
        a += w / RAD + 0.01
        r_ = R.random()
        if state == "damaged" and (breach[0] - 0.1 < am < breach[1] + 0.1 or r_ < 0.25): continue
        if abs(am - FRONT) < 0.32 or tops[bin_(am)] <= 0: continue           # (the lip's place)
        x, z = arcPt(am, RAD)
        stone(K, f"Cap{k}", (x, tops[bin_(am)] + 0.03, z), (w / 2, R.uniform(0.05, 0.08), DEPTH * 0.42), R, 0.76 + 0.1 * (am - A0) / span, "sgCap", yaw=-(am + math.pi / 2))
        k += 1
    x, z = arcPt(FRONT, RAD)
    stone(K, "Lip", (x, tops[bin_(FRONT)] + 0.04, z), (0.42, 0.07, DEPTH * 0.46), R, 0.88, "sgCap", yaw=-(FRONT + math.pi / 2))

def apron(K, R, state):
    """Rubble banked against the outer foot: small stones half in the ground — it sits IN the hillside."""
    span = A1 - A0
    for i in range(24):
        a = A0 + span * (i + R.random()) / 24
        r = RAD + DEPTH / 2 + R.uniform(0.08, 0.42)
        s = R.uniform(0.09, 0.17)
        drop = R.random()
        if state == "ruin" and drop < 0.5: continue
        x, z = arcPt(a, r)
        stone(K, f"Ap{i}", (x, -0.02, z), (s * 1.3, s * 0.6, s), R, 0.3 + 0.45 * (a - A0) / span)

def brush(K, R, state):
    """Dry juniper laid along the top: bundles of twigs, spread out from where they were cut."""
    angles = [A0 + 0.3, math.pi * 1.05, math.pi * 1.28, math.pi * 1.75, math.pi * 1.98, A1 - 0.3]
    for i, a in enumerate(angles):
        keep = R.random()
        n = 14 if not LOW else 6
        # (LAID along the top, nearly flat: stood up they read as antennae — 2026-10-21)
        twigs = [(R.choice((-1, 1)) * R.uniform(0.4, 1), R.uniform(0.02, 0.16), R.uniform(0.5, 1.0), R.uniform(-0.35, 0.35)) for _ in range(14)]
        if state == "ruin" or (state == "damaged" and keep < 0.65): continue
        bx, bz = arcPt(a, RAD + R.uniform(-0.1, 0.1))
        base = Vector((bx, profile(a) + 0.03, bz))   # (on the wall's top where it is: the profile falls toward the ends)
        tang = Vector((-math.sin(a), 0, math.cos(a)))
        for j, (s, up, L, side) in enumerate(twigs[:n]):
            d = (tang * s + Vector((0, up, 0)) + Vector((math.cos(a), 0, math.sin(a))) * side).normalized()
            tag(K.rod(f"Twig{i}_{j}", tuple(base), tuple(base + d * L), 0.016 if not LOW else 0.026, "sgBrush", "h", n=4 if not LOW else 3), 0.9 + 0.012 * i)

def props(K, R, state):
    # inside: the ammunition box and the water jar (brought first: t 0.04)
    if state != "ruin":
        o = K.box("Box", -0.25, 0.25, 0.0, 0.26, -0.14, 0.14, "sgBox", "h", 0.01)
        o.rotation_euler.z = 0.4; o.location = B(0.6, 0.0, 0.4)
        tag(o, 0.03)
        tag(K.cyl("Jar", (-0.7, 0.0, 0.7), 0.16, 0.38, "sgJar", "h", 12 if not LOW else 7, 0.1), 0.04)
    else:
        for i in range(3):   # its shards
            tag(K.box(f"Shard{i}", -0.07, 0.07, 0, 0.02, -0.05, 0.05, "sgJar", "h", 0), 0.0).location = B(-0.7 + R.uniform(-0.3, 0.3), 0.0, 0.7 + R.uniform(-0.3, 0.3))
    # spare stones outside (all states), tumbled ones in front of a breach, scattered ones round a ruin
    extra = {"intact": 4, "damaged": 12, "ruin": 22}[state]
    for i in range(extra):
        if state == "damaged" and i >= 4:
            a = FRONT - 0.3 + R.uniform(-0.35, 0.35); r = RAD + 0.55 + R.uniform(0, 1.0)
        elif state == "ruin":
            a = R.uniform(0, 6.283); r = RAD + R.uniform(0.5, 1.8)
        else:
            a = math.pi * (0.9 + R.uniform(0, 1.2)); r = RAD + 0.7 + R.uniform(0, 0.4)
        s = R.uniform(0.11, 0.2)
        x, z = arcPt(a, r)
        stone(K, f"F{i}", (x, s * 0.5, z), (s * 1.3, s * 0.7, s), R, 0.0)

def writeBuildOrder(K):
    """Each part's moment into a 'build' colour attribute (.r), the ACTIVE one — exported as COLOR_0."""
    for o in K.groups["h"]:
        if o.type != "MESH": continue
        m = o.data
        a = m.color_attributes.get("build") or m.color_attributes.new("build", "FLOAT_COLOR", "POINT")
        t = float(o.get("t", 0.0))
        for d in a.data: d.color = (t, 0.0, 0.0, 1.0)
        m.color_attributes.active_color = a

def buildSangar(K, name, spec, state, seed, far=False):
    global LOW
    LOW = far; K.low = far
    wall(K, random.Random(seed), state)
    apron(K, random.Random(seed + 7), state)
    brush(K, random.Random(seed + 1), state)
    props(K, random.Random(seed + 2), state)
    writeBuildOrder(K)
    LOW = False; K.low = False

farSangar = lambda K, name, spec, state, seed: buildSangar(K, name, spec, state, seed, far=True)
# (smoothAngle 45, no weighted normals: the split blocks' faces flat, their edges crisp — 80 made them pillows, the
# kit's 35 + weighted cut the old hulls into facets)
# (the scans' NORMALS baked too — normals=True — into a 2048 atlas: the relief the colour bake alone flattened)
TYPES = {"sangar": dict(builder=buildSangar, farBuilder=farSangar, atlas=2048, aoDist=0.25, smoothAngle=45, weighted=False, normals=True)}

exported = buildKit(TYPES, MATDEF, "sangar.glb", prefix="Sangar", seed0=1956, colors=True)

# previews from the front-left, high (as the RTS camera sees one facing it)
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1000, 700
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far") and "--farpreview" not in sys.argv: continue
    o.hide_render = False
    cd.lens = 40; cam.location = B(-3.5, 5.5, -6.5); cam.rotation_euler = (B(0, 0.5, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
