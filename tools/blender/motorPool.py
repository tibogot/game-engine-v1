"""THE MOTOR POOL IN BLENDER (2026-10-18, you: "see how far we could make a better looking AAA motor pool
... you don't have to get inspired by the old one, you have to make it the best"). A French army "parc
auto" of the late 1950s: a three-bay steel shed and the workshop block, built as the real things are. Run:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/motorPool.py -- public/models/alg --near     (then the same with --far)

  SHED      I-section columns on base plates and anchor bolts; a Howe truss on every column line (back-to-
            back angle chords, angle webs, gusset plates), knee braces; C purlins; the roof of real
            corrugated sheets (76 mm waves drawn 10 cm to read), lapped across and along the slope, never
            coplanar, each sheet its own age (galvanised, weathered, rusted through); the ridge cap, the
            verge flashings, the gutters and downpipes; the back wall and the gables clad on girts over a
            low rendered wall; the garage bay (the right one) closed by a partition and two hinged
            corrugated doors (DoorL / DoorR, their own objects, origin on the hinge); the "PARC AUTO" board
  WORKSHOP  whitewashed lime render over masonry walls (real thickness, rounded edges, the openings cut
            through), a grey plinth, a flat roof behind a parapet and its coping, the planked doors, a
            barred window with open shutters, a stove pipe, the lamp over the door, "ATELIER"
  APRON     the concrete slab with its joints, oil stains, tyre tracks and wind-blown sand; the
            inspection pit (steps, angle lips, a few planks over its end)
  PROPS     the chain-hoist gantry over an engine on its stand, the bench and vice and tool board, oil
            drums (one on a cradle, one with a hand pump), jerrycans, a tyre stack, crates, the fire point
  BAKE      colour (procedural + the repo's photo textures, box-projected) × ambient occlusion — the CoH read,
            no normal map; ONE atlas per level (one draw), the far one baked from the near (see LOW below)
Game coordinates: x along the shed, y up, FRONT at -Z (the open bays, the doors), metres as the game.
Writes <out>/motorPool.glb (the far level + the doors: the game's) and motorPoolNear.glb (the lab's close look);
previews in assets-src/refs/motorpool/. Then compress both (tools/optimizeGlb.mjs: KTX2, meshopt).
"""
import bpy, bmesh, sys, os, math, random
from mathutils import Vector
sys.path.insert(0, os.path.dirname(__file__))
from bkit import deconflict

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else os.path.join(ROOT, "public", "models", "alg"))
os.makedirs(out, exist_ok=True)
REFS = os.path.join(ROOT, "assets-src", "refs", "motorpool"); os.makedirs(REFS, exist_ok=True)
TEX = os.path.join(ROOT, "public", "textures")
QUICK = "--quick" in sys.argv          # (low bake sizes and samples: for checking the shapes)
# THE TWO VERSIONS (2026-10-18, you: "any asset we create should be very optimized, with LOD"): run TWICE —
#   --near   the full building, its parts joined into ONE object (Static) + the two doors, ONE 4096 atlas
#            (colour × AO) → assets-src/refs/motorpool/motorPool_near.blend
#   --far    the RTS-zoom version built from the same code with every detail switch down — zig-zag sheets
#            (two segments a wave), box sections, no purlins / girts / gussets / bolts / small clutter, fewer
#            sides — its 2048 atlas baked FROM the near one (selected → active), then the two GLBs: StaticFar
#            + DoorL + DoorR (the game's), StaticNear (the lab's)
LOW = "--far" in sys.argv
random.seed(1958)
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()

def B(x, y, z): return Vector((x, -z, y))           # game (x, y up, z) → Blender (z up; game -Z = Blender +Y)
def gv(*p): return Vector(p)

# ── Materials: procedural colour trees, baked ────────────────────────────────
def srgb(h): return tuple(((h >> s & 255) / 255) ** 2.2 for s in (16, 8, 0))
def sock(node, ident):
    for s in node.inputs:
        if s.identifier == ident: return s
    raise KeyError(ident)
def osock(node, ident):
    for s in node.outputs:
        if s.identifier == ident: return s
    raise KeyError(ident)

class NB:
    """A little node-building kit on one material: colours are (r,g,b) or sockets."""
    def __init__(s, m):
        s.nt = m.node_tree; s.N = s.nt.nodes; s.L = s.nt.links
        s.geo = s.N.new("ShaderNodeNewGeometry"); s.tc = s.N.new("ShaderNodeTexCoord")
        sep = s.N.new("ShaderNodeSeparateXYZ"); s.L.new(s.geo.outputs["Position"], sep.inputs[0])
        s.gx = sep.outputs["X"]; s.gy = sep.outputs["Z"]; s.gz = s.math("MULTIPLY", sep.outputs["Y"], -1.0)
    def put(s, v, inp):
        if isinstance(v, bpy.types.NodeSocket): s.L.new(v, inp)
        else: inp.default_value = (*v, 1.0) if isinstance(v, tuple) and len(v) == 3 and inp.type == "RGBA" else v
    def math(s, op, a, b=0.0):
        n = s.N.new("ShaderNodeMath"); n.operation = op; s.put(a, n.inputs[0]); s.put(b, n.inputs[1]); return n.outputs[0]
    def mr(s, v, a, b, c=0.0, d=1.0):
        n = s.N.new("ShaderNodeMapRange"); s.put(v, n.inputs["Value"])
        n.inputs["From Min"].default_value = a; n.inputs["From Max"].default_value = b
        n.inputs["To Min"].default_value = c; n.inputs["To Max"].default_value = d; return n.outputs["Result"]
    def noise(s, scale, detail=4.0, rough=0.55, stretch=(1, 1, 1), off=(0, 0, 0), out="Fac"):
        mp = s.N.new("ShaderNodeMapping"); s.L.new(s.geo.outputs["Position"], mp.inputs["Vector"])
        mp.inputs["Scale"].default_value = stretch; mp.inputs["Location"].default_value = off
        n = s.N.new("ShaderNodeTexNoise"); s.L.new(mp.outputs["Vector"], n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale; n.inputs["Detail"].default_value = detail; n.inputs["Roughness"].default_value = rough
        return n.outputs[out]
    def mix(s, f, a, b, blend="MIX"):
        n = s.N.new("ShaderNodeMix"); n.data_type = "RGBA"; n.blend_type = blend; n.clamp_factor = True
        s.put(f, sock(n, "Factor_Float")); s.put(a, sock(n, "A_Color")); s.put(b, sock(n, "B_Color"))
        return osock(n, "Result_Color")
    def scale(s, col, k):
        """col × k (k a number or socket)."""
        c = s.N.new("ShaderNodeCombineXYZ")
        for i in range(3): s.put(k, c.inputs[i])
        return s.mix(1.0, col, c.outputs[0], "MULTIPLY")
    def img(s, path, sc, blend=0.3):
        im = bpy.data.images.load(os.path.join(TEX, path), check_existing=True)
        mp = s.N.new("ShaderNodeMapping"); s.L.new(s.tc.outputs["Object"], mp.inputs["Vector"]); mp.inputs["Scale"].default_value = (sc, sc, sc)
        n = s.N.new("ShaderNodeTexImage"); n.image = im; n.projection = "BOX"; n.projection_blend = blend
        s.L.new(mp.outputs["Vector"], n.inputs["Vector"]); return n.outputs["Color"]
    def island(s): return s.geo.outputs["Random Per Island"]
    def point(s): return s.geo.outputs["Pointiness"]

DUST = srgb(0xa58b66)
def dust(nb, col, top=1.1, k=1.0):
    f = nb.math("MULTIPLY", nb.mr(nb.gy, 0.05, top, 0.75 * k, 0.06 * k), nb.noise(4.0, 6))
    return nb.mix(nb.math("MULTIPLY", f, 1.7), col, DUST)
def flat(rgb, top=1.1):
    return lambda nb: dust(nb, nb.mix(nb.noise(2.0, 3), rgb, tuple(c * 0.82 for c in rgb)), top)
def galv(rust, roof):
    def f(nb):
        c = nb.mix(nb.noise(1.1, 3), srgb(0x8f9493), srgb(0x6c7272))
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.1))                      # each sheet its own age
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(7.0, 5), 0.55, 0.7), 0.6), c, srgb(0xb7b9b2))   # white oxide
        st = nb.noise(2.6, 6, 0.6, (9, 0.6, 9) if roof else (9, 9, 0.55))                             # streaks down the slope / the wall
        m = nb.mr(st, 0.7 - rust * 0.3, 0.78 - rust * 0.24)
        foot = nb.mr(nb.math("ABSOLUTE", nb.gz), 3.7, 4.95, 0, rust) if roof else nb.mr(nb.gy, 1.0, 0.25, 0, 0.4 + rust * 0.6)
        m = nb.math("MAXIMUM", m, nb.math("MULTIPLY", foot, nb.mr(nb.noise(6.0, 6), 0.35, 0.6)))
        m = nb.math("MAXIMUM", m, nb.mr(nb.noise(1.6, 5, 0.6, (1, 1, 1), (3.3, 1.7, 0.4)), 0.72 - rust * 0.25, 0.76 - rust * 0.2))
        rc = nb.mix(nb.noise(16.0, 4), srgb(0x7e4b2e), srgb(0x4c2e1f))
        return dust(nb, nb.mix(m, c, rc), 0.9, 0.8)
    return f
def steel(base, rusty=0.3, top=0.55):
    def f(nb):
        c = nb.mix(nb.noise(1.5, 4), srgb(base), tuple(v * 0.75 for v in srgb(base)))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(5.0, 7), 0.7 - rusty * 0.12, 0.76 - rusty * 0.1), 0.9), c, srgb(0x6a3d22))
        wear = nb.math("MULTIPLY", nb.mr(nb.point(), 0.52, 0.6), nb.noise(25.0, 3))
        c = nb.mix(nb.math("MULTIPLY", wear, 1.6), c, srgb(0x6e5a48))
        return dust(nb, c, top, 0.8)
    return f
def concrete(nb):
    c = nb.img("pbr_materials/Concrete030_1K-JPG/Concrete030_1K-JPG_Color.jpg", 0.42)
    c = nb.mix(0.55, c, srgb(0xb8ab97), "MIX")
    c = nb.scale(c, nb.mr(nb.noise(0.5, 3), 0.3, 0.7, 0.86, 1.08))
    # joints every 4 m both ways (the slab's bays)
    def line(v):
        d = nb.math("ABSOLUTE", nb.math("SUBTRACT", nb.math("FRACT", nb.math("ADD", nb.math("DIVIDE", v, 4.0), 0.5)), 0.5))
        return nb.mr(d, 0.0016, 0.0045, 1, 0)
    j = nb.math("MULTIPLY", nb.math("MAXIMUM", line(nb.math("SUBTRACT", nb.gx, 0.5)), line(nb.math("ADD", nb.gz, 0.5))), nb.mr(nb.gy, 0.1, 0.14))
    c = nb.mix(nb.math("MULTIPLY", j, 0.8), c, srgb(0x3b352c))
    # under the shed: oil stains where the vehicles stand, and the tyre tracks in and out
    inside = nb.math("MULTIPLY", nb.mr(nb.math("ABSOLUTE", nb.gx), 7.8, 7.0), nb.mr(nb.gz, -6.0, -3.5))
    oil = nb.math("MULTIPLY", nb.mr(nb.noise(1.3, 6, 0.6), 0.6, 0.7), inside)
    c = nb.mix(nb.math("MULTIPLY", oil, 0.75), c, srgb(0x2b2721))
    trk = 0.0
    for bx in (-5.0, 0.0, 5.0):
        for s in (-0.78, 0.78):
            band = nb.mr(nb.math("ABSOLUTE", nb.math("SUBTRACT", nb.gx, bx + s)), 0.16, 0.1)
            trk = nb.math("MAXIMUM", trk, band)
    trk = nb.math("MULTIPLY", trk, nb.math("MULTIPLY", nb.mr(nb.gz, 4.0, 2.0), nb.mr(nb.noise(3.0, 5, 0.6, (5, 0.4, 5)), 0.35, 0.65)))
    c = nb.mix(nb.math("MULTIPLY", trk, 0.45), c, srgb(0x4a4136))
    # sand blown over the slab's edges and into the corners; the pit's grime
    edge = nb.math("MAXIMUM", nb.mr(nb.math("ABSOLUTE", nb.math("SUBTRACT", nb.gx, 2.8)), 10.6, 12.0), nb.math("MAXIMUM", nb.mr(nb.gz, -6.5, -8.2), nb.mr(nb.gz, 4.4, 5.6)))
    sand = nb.math("MULTIPLY", edge, nb.mr(nb.noise(2.2, 6, 0.6), 0.3, 0.6))
    sand = nb.math("MAXIMUM", sand, nb.mr(nb.noise(0.7, 6, 0.6, (1, 1, 1), (7.1, 2.2, 0)), 0.62, 0.78))
    c = nb.mix(nb.math("MULTIPLY", sand, 0.6), c, srgb(0xc6a77a))
    pit = nb.mr(nb.gy, 0.05, -0.6)
    return nb.mix(nb.math("MULTIPLY", pit, 0.65), c, srgb(0x37322b))
def render(nb):
    c = nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.55)
    c = nb.mix(0.5, c, srgb(0xeee5d4))
    c = nb.scale(c, nb.mr(nb.noise(0.8, 4), 0.3, 0.7, 0.9, 1.04))
    peel = nb.mr(nb.noise(2.6, 8, 0.65, (1, 1, 1), (1.3, 0, 4.4)), 0.69, 0.71)
    clay = nb.mix(0.35, nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.9), srgb(0xb59a76))
    c = nb.mix(peel, c, clay)
    band = nb.mr(nb.math("ADD", nb.gy, nb.math("MULTIPLY", nb.noise(9.0, 3), 0.05)), 1.0, 0.985)    # the grey plinth, brushed on
    c = nb.mix(band, c, nb.scale(nb.mix(0.6, c, srgb(0x857d70)), 0.8))
    streak = nb.math("MULTIPLY", nb.mr(nb.gy, 2.4, 3.9), nb.mr(nb.noise(3.2, 5, 0.6, (9, 9, 0.5)), 0.5, 0.68))
    c = nb.mix(nb.math("MULTIPLY", streak, 0.55), c, srgb(0x958e82))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.point(), 0.53, 0.6), 0.4), c, srgb(0xa69a86))
    return dust(nb, c, 1.7, 0.9)
def wood(tint=0xb0a38f):
    def f(nb):
        c = nb.mix(1.0, nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 0.7), srgb(tint), "MULTIPLY")
        return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.15)), 0.9)
    return f
def paintedWood(paint):
    def f(nb):
        w = nb.mix(1.0, nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 0.7), srgb(0xa59784), "MULTIPLY")
        p = nb.mix(nb.noise(3.0, 4), srgb(paint), tuple(v * 0.8 for v in srgb(paint)))
        peel = nb.math("MAXIMUM", nb.mr(nb.noise(5.0, 8, 0.65), 0.64, 0.67), nb.math("MULTIPLY", nb.mr(nb.point(), 0.53, 0.6), nb.noise(20.0, 3)))
        return dust(nb, nb.mix(peel, p, w), 1.2)
    return f

MATDEF = {
    "roofOld": (0.62, galv(0.45, True)), "roofRust": (0.8, galv(0.95, True)), "roofNew": (0.45, galv(0.12, True)),
    "wallOld": (0.62, galv(0.5, False)), "wallRust": (0.8, galv(0.9, False)), "wallNew": (0.5, galv(0.15, False)),
    "frame": (0.7, steel(0x4c5243, 0.4)), "darkSteel": (0.6, steel(0x2f312d, 0.3)), "engine": (0.55, steel(0x3d433c, 0.2)),
    "drumOlive": (0.7, steel(0x50553a, 0.5)), "drumBlue": (0.65, steel(0x2f4253, 0.45)), "drumRed": (0.7, steel(0x7a3424, 0.6)),
    "jerry": (0.7, steel(0x4f5536, 0.25)), "redPaint": (0.6, steel(0xa1281d, 0.3)), "doorPaint": (0.7, steel(0x56604f, 0.5)),
    "concrete": (0.92, concrete), "render": (0.95, render), "wood": (0.9, wood()), "woodDark": (0.9, wood(0x857767)),
    "shutter": (0.85, paintedWood(0x4e6b64)), "doorWood": (0.85, paintedWood(0x55654e)),
    "rubber": (0.95, flat(srgb(0x1f1e1c), 0.7)), "glass": (0.2, flat(srgb(0x1a1f22), 0.0)), "black": (0.8, flat(srgb(0x222220))),
    "signGreen": (0.8, flat(srgb(0x2e3a2c))), "signWhite": (0.8, flat(srgb(0xe2ddd0), 0.0)), "signRed": (0.7, flat(srgb(0xa4271e), 0.0)),
    "sand": (1.0, flat(srgb(0xc9ab7c))), "bulb": (0.3, flat(srgb(0xf2ead2), 0.0)),
}
MAT = {}
def M_(name):
    if name not in MAT:
        m = bpy.data.materials.new(name); m.use_nodes = True
        pb = m.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = MATDEF[name][0]
        m.node_tree.links.new(MATDEF[name][1](NB(m)), pb.inputs["Base Color"])
        MAT[name] = m
    return MAT[name]

# ── Geometry helpers (all points in game coordinates) ────────────────────────
GROUPS = {"shed": [], "workshop": [], "apron": [], "props": [], "doorL": [], "doorR": []}
def obj(name, bm, mat, group, smooth=False):
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(M_(mat))
    for p in o.data.polygons: p.use_smooth = smooth
    GROUPS[group].append(o)
    return o
def bevel(o, w=0.01, seg=2, angle=40):
    if w < 0.005 or LOW: return o                    # (a bevel under 5 mm never shows, even close: 2026-10-18, measured)
    b = o.modifiers.new("B", "BEVEL"); b.width = w; b.segments = seg; b.limit_method = "ANGLE"; b.angle_limit = math.radians(angle)
    return o
def box(name, x0, x1, y0, y1, z0, z1, mat, group, w=0.01):
    bm = bmesh.new()
    vs = [bm.verts.new(B(x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    bmesh.ops.convex_hull(bm, input=vs)
    return bevel(obj(name, bm, mat, group), w)
def frame_of(a, b, up):
    d = (b - a).normalized(); u = d.cross(up)
    if u.length < 1e-4: u = d.cross(gv(0, 0, 1) if abs(d.z) < 0.9 else gv(1, 0, 0))
    u.normalize(); v = u.cross(d).normalized()
    return d, u, v
def member(name, a, b, prof, mat, group, up=gv(0, 1, 0), w=0.004, smooth=False, off=(0.0, 0.0)):
    """Extrude a cross-section (u, v points: u across, v toward `up`) from a to b."""
    a, b = gv(*a), gv(*b); d, u, v = frame_of(a, b, gv(*up))
    if LOW:                                           # (far: the section's bounding box, flat-shaded)
        us_ = [q[0] for q in prof]; vs_ = [q[1] for q in prof]
        prof = [(min(us_), min(vs_)), (max(us_), min(vs_)), (max(us_), max(vs_)), (min(us_), max(vs_))]; smooth = False
    bm = bmesh.new()
    ring = lambda p: [bm.verts.new(B(*(p + u * (pu + off[0]) + v * (pv + off[1])))) for pu, pv in prof]
    r0, r1 = ring(a), ring(b); n = len(prof)
    for i in range(n):
        j = (i + 1) % n; bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(r0); bm.faces.new(list(reversed(r1)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bevel(obj(name, bm, mat, group, smooth), w, 1, 50)
def P_I(h, bf, tf, tw):
    h2, b2, t2 = h / 2, bf / 2, tw / 2
    return [(-b2, -h2), (b2, -h2), (b2, -h2 + tf), (t2, -h2 + tf), (t2, h2 - tf), (b2, h2 - tf), (b2, h2), (-b2, h2), (-b2, h2 - tf), (-t2, h2 - tf), (-t2, -h2 + tf), (-b2, -h2 + tf)]
def P_L(a, t, su=1, sv=1):
    pts = [(0, 0), (a, 0), (a, t), (t, t), (t, a), (0, a)]
    pts = [(su * x, sv * y) for x, y in pts]
    return pts if su * sv > 0 else list(reversed(pts))
def P_C(h, bf, t):
    h2 = h / 2
    return [(0, -h2), (bf, -h2), (bf, -h2 + t), (t, -h2 + t), (t, h2 - t), (bf, h2 - t), (bf, h2), (0, h2)]
def P_R(wu, hv): return [(-wu / 2, -hv / 2), (wu / 2, -hv / 2), (wu / 2, hv / 2), (-wu / 2, hv / 2)]
def P_O(r, n=12): return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)]
def rod(name, a, b, r, mat, group, n=10, up=(0, 1, 0)):
    return member(name, a, b, P_O(r, n), mat, group, up, 0, smooth=True)
def sheet(name, o, aw, al, an, width, length, mat, group, pitch=0.1, depth=0.028, segs=4, thick=0.0035, ribs_far=True):
    """A corrugated sheet: `o` its corner, waves across `aw`, `length` (a number or f(w)) along `al`,
    its face toward `an`; thickened behind it (toward -an)."""
    o, aw, al, an = gv(*o), gv(*aw).normalized(), gv(*al).normalized(), gv(*an).normalized()
    # (far: the ribs kept as a cheap zig-zag, two segments a wave, a flat underside behind — the roof AND
    # the walls since 2026-10-19: far is the game's only level now, and baked-in wall ribs read blurred at
    # the closest zoom; ribs_far=False flattens a sheet, the bake painting its ribs)
    phase = 0.0
    under = LOW and ribs_far and depth > 0
    if under: segs, phase, thick = 2, math.pi / 2, 0.0   # (no shell: a flat underside under it instead, 2 triangles)
    elif LOW: depth = 0
    N_ = max(2, round(width / pitch * segs)) if depth > 0 else (max(1, math.ceil(width / 0.9)) if callable(length) else 1)
    bm = bmesh.new(); rows = []
    for i in range(N_ + 1):
        w = width * i / N_
        off = depth / 2 * math.sin(2 * math.pi * w / pitch + phase) if depth > 0 else 0.0
        L = length(w) if callable(length) else length
        p = o + aw * w + an * off
        rows.append((bm.verts.new(B(*p)), bm.verts.new(B(*(p + al * L)))))
    for i in range(N_):
        f = bm.faces.new((rows[i][0], rows[i + 1][0], rows[i + 1][1], rows[i][1]))
    bm.normal_update(); bm.faces.ensure_lookup_table()
    want = B(*an) - B(0, 0, 0)
    if bm.faces[0].normal.dot(want) < 0:
        for f in bm.faces: f.normal_flip()
    ob = obj(name, bm, mat, group, smooth=depth > 0)
    if thick > 0:
        so = ob.modifiers.new("S", "SOLIDIFY"); so.thickness = thick; so.offset = -1.0; so.use_even_offset = True
    if under:
        sheet(name + "Under", tuple(o - an * (depth / 2 + 0.006)), tuple(aw), tuple(al), tuple(-an), width, length, mat, group, depth=0, thick=0.0)
    return ob
def text(name, body, at, size, mat, group, facing="-z", depth=0.004):
    cu = bpy.data.curves.new(name, "FONT"); cu.body = body; cu.size = size; cu.extrude = depth / 2
    cu.align_x = "CENTER"; cu.align_y = "CENTER"
    o = bpy.data.objects.new(name, cu); bpy.context.scene.collection.objects.link(o)
    o.location = B(*at)
    o.rotation_euler = (math.radians(90), 0, math.radians({"-z": 180, "-x": -90, "+x": 90}[facing]))
    o.data.materials.append(M_(mat)); GROUPS[group].append(o)
    return o
def cyl(name, c, r, h, mat, group, n=24, axis="y", w=0.006, r2=None):
    """A capped cylinder (cone with r2) standing on its base centre c along a game axis."""
    if LOW: n = max(6, n // 3)
    a = gv(*c); d = {"y": gv(0, 1, 0), "x": gv(1, 0, 0), "z": gv(0, 0, 1)}[axis] if isinstance(axis, str) else gv(*axis).normalized()
    bm = bmesh.new(); _, u, v = frame_of(a, a + d, gv(0, 0, 1) if abs(d.y) > 0.9 else gv(0, 1, 0))
    rb = [bm.verts.new(B(*(a + u * r * math.cos(t) + v * r * math.sin(t)))) for t in (2 * math.pi * i / n for i in range(n))]
    rr = r if r2 is None else r2
    rt = [bm.verts.new(B(*(a + d * h + u * rr * math.cos(t) + v * rr * math.sin(t)))) for t in (2 * math.pi * i / n for i in range(n))]
    for i in range(n):
        j = (i + 1) % n; bm.faces.new((rb[i], rb[j], rt[j], rt[i]))
    bm.faces.new(rb); bm.faces.new(list(reversed(rt)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = obj(name, bm, mat, group, smooth=True)
    return bevel(o, w, 2, 50)
def torus(name, c, R, r, mat, group, axis="y", n=28, m=10, sq=1.0):
    if LOW: n, m = max(8, n // 3), max(4, m // 2)
    bm = bmesh.new(); a = gv(*c); d = {"y": gv(0, 1, 0), "x": gv(1, 0, 0), "z": gv(0, 0, 1)}[axis]
    _, u, v = frame_of(a, a + d, gv(0, 0, 1) if abs(d.y) > 0.9 else gv(0, 1, 0))
    grid = []
    for i in range(n):
        t = 2 * math.pi * i / n; rad = u * math.cos(t) + v * math.sin(t); row = []
        for k in range(m):
            p = 2 * math.pi * k / m
            row.append(bm.verts.new(B(*(a + rad * (R + r * math.cos(p)) + d * (r * sq * math.sin(p))))))
        grid.append(row)
    for i in range(n):
        for k in range(m):
            bm.faces.new((grid[i][k], grid[(i + 1) % n][k], grid[(i + 1) % n][(k + 1) % m], grid[i][k + 1 - m if k + 1 == m else k + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj(name, bm, mat, group, smooth=True)
def boolean(o, cutter, op="DIFFERENCE"):
    md = o.modifiers.new("Bool", "BOOLEAN"); md.object = cutter; md.operation = op; md.solver = "EXACT"
    cutter.hide_render = True; cutter.display_type = "WIRE"
    return md
def cutter(x0, x1, y0, y1, z0, z1):
    bm = bmesh.new()
    vs = [bm.verts.new(B(x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    bmesh.ops.convex_hull(bm, input=vs)
    m = bpy.data.meshes.new("cut"); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new("cut", m); bpy.context.scene.collection.objects.link(o); CUTTERS.append(o)
    return o
CUTTERS = []

# ── The dimensions ───────────────────────────────────────────────────────────
F = 0.15                          # apron top
EH = 4.6                          # the trusses' bottom chord above the apron
X0, X1, Z0, Z1 = -7.5, 7.5, -4.5, 4.5
COLS = [-7.5, -2.5, 2.5, 7.5]
TD = 0.35                         # truss depth at the eave
T15 = math.tan(math.radians(15))
LL = math.sqrt(1 + T15 * T15)
YB = F + EH                       # bottom chord
def ytc(z): return YB + TD + (4.5 - abs(z)) * T15     # top chord's centre line
def slope(sz):
    """The slope's frame: E its eave point at z = sz·4.5 (on the top chord's line), l up the slope, n its normal."""
    l = gv(0, T15, -sz) / LL; n = gv(0, 1, sz * T15) / LL
    return gv(0, YB + TD, sz * 4.5), l, n
def on_slope(sz, x, t, h):
    E, l, n = slope(sz); return gv(x, E.y, E.z) + l * t + n * h
T_RIDGE = 4.5 * LL
H_PURLIN = 0.04                   # chord top, perpendicular to the slope
H_SHEET = 0.04 + 0.14 + 0.0155    # the sheets' mid-plane over the chord line

# ── THE APRON ────────────────────────────────────────────────────────────────
PIT = (-0.45, 0.45, -3.0, 2.6)    # x0, x1, z0, z1
slab = box("Slab", -9.2, 14.8, F - 0.25, F, -8.2, 5.6, "concrete", "apron", 0.035)
if slab.modifiers.get("B"): slab.modifiers.remove(slab.modifiers["B"])
boolean(slab, cutter(PIT[0], PIT[1], F - 1.5, F + 0.2, PIT[2], PIT[3]))
bevel(slab, 0.035, 2, 40)
pw = box("PitWalls", PIT[0] - 0.2, PIT[1] + 0.2, F - 1.35, F - 0.25, PIT[2] - 0.2, PIT[3] + 0.2, "concrete", "apron", 0)
boolean(pw, cutter(PIT[0], PIT[1], F - 1.31, F + 0.2, PIT[2], PIT[3]))
box("PitFloor", PIT[0] - 0.01, PIT[1] + 0.01, F - 1.33, F - 1.3, PIT[2] - 0.01, PIT[3] + 0.01, "concrete", "apron", 0)
for k in range(4):                                   # steps down at the back end
    box(f"Step{k}", PIT[0] + 0.005, PIT[1] - 0.005, F - 1.3, F - 0.29 - 0.25 * k, PIT[3] - 0.27 * (k + 1), PIT[3] - 0.27 * k + (0.02 if k == 0 else 0), "concrete", "apron", 0.012)
for s, x in ((-1, PIT[0]), (1, PIT[1])):             # the lips: angle irons along both edges
    member(f"PitLip{s}", (x, F, PIT[2] - 0.05), (x, F, PIT[3] + 0.05), P_L(0.06, 0.007, -s, -1), "darkSteel", "apron", (0, 1, 0), 0.002, off=(0, 0.002))
for k in range(6):                                   # a few planks over the pit's front end
    z = PIT[2] + 0.05 + k * 0.24 + random.uniform(-0.02, 0.02)
    if k == 4: continue
    b = box(f"Plank{k}", -0.62, 0.62, F + 0.004, F + 0.054, z, z + 0.21, "wood", "apron", 0.008)
    b.rotation_euler.z = random.uniform(-0.04, 0.04); b.location = B(random.uniform(-0.04, 0.04), 0, 0) - B(0, 0, 0)

# ── THE SHED: columns, trusses, purlins ──────────────────────────────────────
for x in COLS:
    for z in (Z0, Z1):
        box(f"Base{x}{z}", x - 0.21, x + 0.21, F, F + 0.025, z - 0.21, z + 0.21, "frame", "shed", 0.004)
        for bx in (-0.15, 0.15):
            for bz in (-0.15, 0.15):
                cyl(f"Nut{x}{z}{bx}{bz}", (x + bx, F + 0.025, z + bz), 0.022, 0.03, "darkSteel", "shed", 6, w=0.003)
        member(f"Col{x}{z}", (x, F + 0.025, z), (x, YB + TD + 0.06, z), P_I(0.24, 0.2, 0.014, 0.009), "frame", "shed", (0, 0, 1), 0.004)
        sz = 1 if z > 0 else -1
        member(f"Knee{x}{z}", (x, YB - 0.95, z - sz * 0.12), (x, YB - 0.04, z - sz * 0.95), P_L(0.06, 0.007), "frame", "shed", (1, 0, 0), 0.002, off=(-0.03, -0.03))
    # the truss: back-to-back angle chords, angle webs between them, gusset plates
    for g in (-1, 1):
        member(f"Bot{x}{g}", (x, YB, -4.62), (x, YB, 4.62), P_L(0.08, 0.008, g, 1), "frame", "shed", (0, 1, 0), 0.002, off=(g * 0.007, -0.04))
        for sz in (-1, 1):
            a = on_slope(sz, x, -0.14 * LL, 0); b = on_slope(sz, x, T_RIDGE, 0)
            n = slope(sz)[2]
            member(f"Top{x}{g}{sz}", a, b, P_L(0.08, 0.008, g, -1), "frame", "shed", tuple(n), 0.002, off=(g * 0.007, 0.04))
    joints = []
    for sz in (-1, 1):
        for zb, zt in ((1.5, 1.5), (3.0, 3.0)):
            joints.append((sz * zb, YB)); joints.append((sz * zt, ytc(sz * zt)))
            member(f"Vert{x}{sz}{zb}", (x, YB + 0.04, sz * zb), (x, ytc(sz * zb) - 0.04, sz * zb), P_L(0.05, 0.006), "frame", "shed", (0, 0, 1), 0.002, off=(-0.025, -0.025))
        member(f"Diag{x}{sz}a", (x, YB + 0.04, 0.0), (x, ytc(sz * 1.5) - 0.05, sz * 1.5), P_L(0.05, 0.006), "frame", "shed", (1, 0, 0), 0.002, off=(-0.025, -0.025))
        member(f"Diag{x}{sz}b", (x, YB + 0.04, sz * 1.5), (x, ytc(sz * 3.0) - 0.05, sz * 3.0), P_L(0.05, 0.006), "frame", "shed", (1, 0, 0), 0.002, off=(-0.025, -0.025))
        member(f"Diag{x}{sz}c", (x, YB + 0.04, sz * 3.0), (x, ytc(sz * 4.3) - 0.04, sz * 4.3), P_L(0.05, 0.006), "frame", "shed", (1, 0, 0), 0.002, off=(-0.025, -0.025))
    member(f"King{x}", (x, YB + 0.04, 0), (x, ytc(0) - 0.05, 0), P_L(0.05, 0.006), "frame", "shed", (0, 0, 1), 0.002, off=(-0.025, -0.025))
    joints += [(0, YB), (0, ytc(0) - 0.02), (-4.45, YB + 0.17), (4.45, YB + 0.17)]
    for k, (jz, jy) in enumerate(joints):
        box(f"Gusset{x}{k}", x - 0.005, x + 0.005, jy - 0.13, jy + 0.13, jz - 0.15, jz + 0.15, "frame", "shed", 0.003)
# eave beams along the front and back, on the columns
for z in (Z0, Z1):
    member(f"Eave{z}", (X0 - 0.1, YB - 0.16, z), (X1 + 0.1, YB - 0.16, z), P_I(0.22, 0.12, 0.012, 0.008), "frame", "shed", (0, 1, 0), 0.003)
# purlins: C channels on the top chords, tipped with the slope
PURL_T = [-0.3, 0.75, 1.8, 2.85, 3.9, T_RIDGE - 0.22]
for sz in (-1, 1):
    n = slope(sz)[2]
    for k, t in enumerate(PURL_T):
        a = on_slope(sz, X0 - 0.42, t * LL / LL, H_PURLIN + 0.07); b = on_slope(sz, X1 + 0.42, t, H_PURLIN + 0.07)
        member(f"Purlin{sz}{k}", a, b, P_C(0.14, 0.06, 0.006), "frame", "shed", tuple(n), 0.002, off=(-0.03 * sz, 0))
# cross-bracing rods in the end bays of the back wall
for xa, xb in ((X0, COLS[1]), (COLS[2], X1)):
    rod(f"BraceA{xa}", (xa, F + 0.4, Z1 - 0.06), (xb, YB - 0.3, Z1 - 0.06), 0.012, "darkSteel", "shed", 6)
    rod(f"BraceB{xa}", (xb, F + 0.4, Z1 - 0.07), (xa, YB - 0.3, Z1 - 0.07), 0.012, "darkSteel", "shed", 6)

# ── THE ROOF: sheets in two rows up each slope ───────────────────────────────
def roof_mat():
    r = random.random()
    return "roofRust" if r < 0.11 else ("roofNew" if r < 0.32 else "roofOld")
SW, COVER = 0.9, 0.8
xs = []
x = X0 - 0.42
while x + SW < X1 + 0.42 + 0.05:
    xs.append(x); x += COVER
xs.append(X1 + 0.42 - SW)
SWR = SW
if LOW: xs, SWR = [X0 - 0.42], X1 - X0 + 0.84
T0 = -0.42 * LL                                       # the overhang at the eave
ROWS = [(T0, 2.75), (T0 + 2.6, T_RIDGE - 0.06 - (T0 + 2.6))]
for sz in (-1, 1):
    E, l, n = slope(sz)
    for r, (t0, L) in enumerate(ROWS):
        for k, x0 in enumerate(xs):
            h = H_SHEET + (k % 2) * 0.005 + r * 0.011
            o = on_slope(sz, x0, t0, h)
            sheet(f"Roof{sz}{r}{k}", o, (1, 0, 0), tuple(l), tuple(n), SWR, L, roof_mat(), "shed", ribs_far=True)
    # verge flashings over the gables' edges
    for xv in (X0 - 0.43, X1 + 0.43):
        a = on_slope(sz, xv, T0 - 0.02, H_SHEET + 0.03); b = on_slope(sz, xv, T_RIDGE - 0.01, H_SHEET + 0.03)
        member(f"Verge{sz}{xv}", a, b, [(-0.004, -0.14), (0.004, -0.14), (0.004, 0.0), (-0.004, 0.0)], "wallOld", "shed", tuple(n), 0.0, off=(0, 0.02))
        member(f"VergeTop{sz}{xv}", a, b, P_R(0.12, 0.006), "wallOld", "shed", tuple(n), 0.0, off=(-0.06 if xv < 0 else 0.06, 0.02))
    # the gutter under the eave (a half-round), its downpipes
    edge = on_slope(sz, 0, T0, H_SHEET)
    gc = (edge.y - 0.07, edge.z + sz * 0.04)
    half = [(0.075 * math.cos(math.pi + math.pi * i / 8), 0.075 * math.sin(math.pi + math.pi * i / 8)) for i in range(9)]
    half += [(0.068 * math.cos(2 * math.pi - math.pi * i / 8), 0.068 * math.sin(2 * math.pi - math.pi * i / 8)) for i in range(9)]
    member(f"Gutter{sz}", (X0 - 0.45, gc[0], gc[1]), (X1 + 0.45, gc[0], gc[1]), [(-pz * sz, py) for pz, py in half], "wallOld", "shed", (0, 1, 0), 0.0, smooth=True)
    for xd in ((X0 - 0.25,) if sz < 0 else (X0 - 0.25, X1 + 0.25)):
        zd = gc[1]
        rod(f"Down{sz}{xd}", (xd, gc[0] - 0.05, zd), (xd, F + 0.32, zd), 0.045, "wallOld", "shed", 12)
        rod(f"Shoe{sz}{xd}", (xd, F + 0.34, zd), (xd, F + 0.12, zd + sz * 0.22), 0.045, "wallOld", "shed", 12)
# the ridge cap: a bent strip over both slopes' top ends
for sz in (-1, 1):
    E, l, n = slope(sz)
    hc = H_SHEET + 0.04
    apex = on_slope(sz, 0, T_RIDGE, hc)                # (the same point from both sides)
    sheet(f"Ridge{sz}", (X0 - 0.44, apex.y, apex.z), (1, 0, 0), tuple(-l), tuple(n), X1 - X0 + 0.88, 0.34, "roofOld", "shed", depth=0, thick=0.003)

# ── THE WALLS: a rendered upstand, girts, corrugated cladding ────────────────
def wall_mat():
    r = random.random()
    return "wallRust" if r < 0.15 else ("wallNew" if r < 0.25 else "wallOld")
ZB = Z1 + 0.12 + 0.15 + 0.016                        # the back wall's sheets
box("UpstandBack", X0 - 0.3, X1 + 0.3, F - 0.02, F + 0.42, Z1 + 0.06, ZB - 0.025, "render", "shed", 0.02)
for y in (F + 1.1, F + 2.6, YB - 0.2):
    member(f"GirtB{y:.2f}", (X0 - 0.1, y, Z1 + 0.12), (X1 + 0.1, y, Z1 + 0.12), P_C(0.15, 0.06, 0.005), "frame", "shed", (0, 1, 0), 0.002, off=(0, 0))
x = X0 - 0.27; k = 0
while x < X1 + 0.27 - 0.05:
    w_ = min(99 if LOW else SW, X1 + 0.27 - x)
    sheet(f"WallB{k}", (x, F + 0.36, ZB + (k % 2) * 0.005), (1, 0, 0), (0, 1, 0), (0, 0, 1), w_, YB + TD + 0.12 - (F + 0.36), wall_mat(), "shed")
    x += w_ if LOW else COVER; k += 1
# the gables (and the garage bay's partition): sheets cut along the roof line
def gable(name, xp, sgn, z0, z1, top, upstand=True, girts=True):
    xs_ = xp + sgn * (0.1 + 0.15 + 0.016)
    if upstand: box(f"Upstand{name}", min(xp + sgn * 0.06, xs_ - sgn * 0.025), max(xp + sgn * 0.06, xs_ - sgn * 0.025), F - 0.02, F + 0.42, z0 - 0.02, z1 + 0.02, "render", "shed", 0.02)
    if girts:
        for y in (F + 1.1, F + 2.6, YB - 0.2):
            member(f"Girt{name}{y:.2f}", (xp + sgn * 0.1, y, z0 + 0.1), (xp + sgn * 0.1, y, z1 - 0.1), P_C(0.15, 0.06, 0.005), "frame", "shed", (0, 1, 0), 0.002, off=(0, 0))
    z = z0; k = 0
    y0 = F + (0.36 if upstand else 0.06)
    while z < z1 - 0.05:
        w_ = min(99 if LOW else SW, z1 - z); xk = xs_ + sgn * (k % 2) * 0.005
        if sgn > 0: sheet(f"Wall{name}{k}", (xk, y0, z + w_), (0, 0, -1), (0, 1, 0), (sgn, 0, 0), w_, lambda w, z=z + w_: top(z - w) - y0, wall_mat(), "shed")
        else: sheet(f"Wall{name}{k}", (xk, y0, z), (0, 0, 1), (0, 1, 0), (sgn, 0, 0), w_, lambda w, z=z: top(z + w) - y0, wall_mat(), "shed")
        z += w_ if LOW else COVER; k += 1
gable_top = lambda z: min(ytc(z) + 0.02, YB + TD + 4.5 * T15) if abs(z) < 4.62 else ytc(4.62) + 0.02
gable("L", X0, -1, -4.62, ZB, gable_top)
gable("R", X1, 1, -4.62, ZB, gable_top)
gable("P", COLS[2], 1, -4.45, Z1 + 0.1, gable_top, upstand=False)      # the garage bay's partition (from inside)

# ── THE GARAGE BAY'S FRONT: header, the strip over it, the doors ─────────────
DH = 3.9                                              # door height
member("Header", (COLS[2] - 0.12, F + DH + 0.12, Z0 - 0.2), (COLS[3] + 0.12, F + DH + 0.12, Z0 - 0.2), P_C(0.2, 0.07, 0.007), "frame", "shed", (0, 1, 0), 0.002)
x = COLS[2] - 0.1; k = 0
while x < COLS[3] + 0.1 - 0.05:
    w_ = min(99 if LOW else SW, COLS[3] + 0.1 - x)
    sheet(f"Fascia{k}", (x, F + DH + 0.02, Z0 - 0.3 - (k % 2) * 0.005), (1, 0, 0), (0, 1, 0), (0, 0, -1), w_, YB + TD - 0.02 - (F + DH + 0.02), wall_mat(), "shed")
    x += w_ if LOW else COVER; k += 1
LW = (COLS[3] - COLS[2] - 0.24 - 0.04) / 2
HINGE = {"doorL": (COLS[2] + 0.12, Z0 - 0.36), "doorR": (COLS[3] - 0.12, Z0 - 0.36)}
for key, sx in (("doorL", 1), ("doorR", -1)):
    hx, hz = HINGE[key]; xa, xb = hx, hx + sx * LW
    lo, hi = min(xa, xb), max(xa, xb)
    T = 0.05
    for nm, a, b in (("Bot", (lo, F + 0.06, hz), (hi, F + 0.06, hz)), ("Top", (lo, F + DH - 0.04, hz), (hi, F + DH - 0.04, hz)),
                     ("Mid", (lo, F + DH * 0.5, hz), (hi, F + DH * 0.5, hz)), ("S0", (lo + T / 2, F + 0.06, hz), (lo + T / 2, F + DH - 0.04, hz)),
                     ("S1", (hi - T / 2, F + 0.06, hz), (hi - T / 2, F + DH - 0.04, hz)),
                     ("Diag", (xa + sx * 0.05, F + 0.1, hz), (xb - sx * 0.05, F + DH * 0.5 - 0.04, hz)),
                     ("Diag2", (xa + sx * 0.05, F + DH * 0.5 + 0.04, hz), (xb - sx * 0.05, F + DH - 0.08, hz))):
        member(f"{key}{nm}", a, b, P_R(T, T), "doorPaint", key, (0, 0, 1), 0.004)
    x = lo; k = 0
    while x < hi - 0.05:
        w_ = min(99 if LOW else 0.84, hi - x)
        sheet(f"{key}Sheet{k}", (x, F + 0.08, hz - 0.045 - (k % 2) * 0.005), (1, 0, 0), (0, 1, 0), (0, 0, -1), w_, DH - 0.12, "doorPaint", key)
        x += w_ if LOW else 0.76; k += 1
    for y in (F + 0.5, F + DH - 0.5):                   # the hinges and the handle
        box(f"{key}Hinge{y:.1f}", hx - 0.05, hx + 0.05, y - 0.06, y + 0.06, hz - 0.1, hz - 0.02, "darkSteel", key, 0.008)
        box(f"{key}Strap{y:.1f}", min(hx, hx + sx * 0.55), max(hx, hx + sx * 0.55), y - 0.025, y + 0.025, hz - 0.085, hz - 0.07, "darkSteel", key, 0.003)
    rod(f"{key}Handle", (xb - sx * 0.12, F + 1.05, hz - 0.12), (xb - sx * 0.12, F + 1.45, hz - 0.12), 0.014, "darkSteel", key, 8)
    if sx > 0: rod(f"{key}Bolt", (xb - 0.25, F + 1.25, hz - 0.1), (xb + 0.12, F + 1.25, hz - 0.1), 0.016, "darkSteel", key, 8)

# ── THE SIGNS ────────────────────────────────────────────────────────────────
box("SignBoard", -1.75, 1.75, YB - 0.62, YB - 0.04, Z0 - 0.17, Z0 - 0.135, "signGreen", "shed", 0.008)
box("SignFrame", -1.82, 1.82, YB - 0.67, YB + 0.01, Z0 - 0.135, Z0 - 0.125, "frame", "shed", 0.004)
text("SignText", "PARC AUTO", (0, YB - 0.33, Z0 - 0.182), 0.36, "signWhite", "shed")   # (8 mm proud of the board: at 4 mm its letters z-fought it, glbCoplanarTest)
box("NoSmoke", X0 - 0.32, X0 - 0.3, F + 1.55, F + 2.05, -1.6, -0.6, "signWhite", "shed", 0.004)
text("NoSmokeA", "DÉFENSE", (X0 - 0.324, F + 1.88, -1.1), 0.15, "signRed", "shed", "-x", 0.003)
text("NoSmokeB", "DE FUMER", (X0 - 0.324, F + 1.68, -1.1), 0.15, "signRed", "shed", "-x", 0.003)

# ── THE WORKSHOP: masonry, render, flat roof behind a parapet ────────────────
WX0, WX1, WZ0, WZ1, WT, WH = 8.2, 13.6, -4.4, 3.0, 0.35, 3.95
shell = box("Workshop", WX0, WX1, F, F + WH, WZ0, WZ1, "render", "workshop", 0)
shell.modifiers.remove(shell.modifiers["B"]) if shell.modifiers.get("B") else None
boolean(shell, cutter(WX0 + WT, WX1 - WT, F + 0.05, F + WH + 1, WZ0 + WT, WZ1 - WT))
DOOR = (9.0, 10.5, F, F + 2.35)
WIN = (11.6, 12.8, F + 1.0, F + 2.2)
SWIN = (-1.6, -0.5, F + 1.0, F + 2.1)
boolean(shell, cutter(DOOR[0], DOOR[1], DOOR[2] - 0.1, DOOR[3], WZ0 - 0.1, WZ0 + WT + 0.1))
boolean(shell, cutter(WIN[0], WIN[1], WIN[2], WIN[3], WZ0 - 0.1, WZ0 + WT + 0.1))
boolean(shell, cutter(WX1 - WT - 0.1, WX1 + 0.1, SWIN[2], SWIN[3], SWIN[0], SWIN[1]))
bevel(shell, 0.03, 2, 30)
box("WsFloor", WX0 + WT - 0.02, WX1 - WT + 0.02, F, F + 0.06, WZ0 + WT - 0.02, WZ1 - WT + 0.02, "concrete", "workshop", 0)
box("WsRoof", WX0 + WT - 0.04, WX1 - WT + 0.04, F + 3.4, F + 3.62, WZ0 + WT - 0.04, WZ1 - WT + 0.04, "render", "workshop", 0)
for nm, a in (("F", (WX0 - 0.05, WX1 + 0.05, WZ0 - 0.05, WZ0 + WT + 0.04)), ("Bk", (WX0 - 0.05, WX1 + 0.05, WZ1 - WT - 0.04, WZ1 + 0.05)),
              ("L", (WX0 - 0.05, WX0 + WT + 0.04, WZ0 + WT + 0.04, WZ1 - WT - 0.04)), ("R", (WX1 - WT - 0.04, WX1 + 0.05, WZ0 + WT + 0.04, WZ1 - WT - 0.04))):
    box(f"Coping{nm}", a[0], a[1], F + WH - 0.03, F + WH + 0.07, a[2], a[3], "concrete", "workshop", 0.015)
box("Step", DOOR[0] - 0.2, DOOR[1] + 0.2, F, F + 0.14, WZ0 - 0.38, WZ0 + 0.02, "concrete", "workshop", 0.02)
box("Lintel", DOOR[0] - 0.12, DOOR[1] + 0.12, DOOR[3], DOOR[3] + 0.2, WZ0 - 0.012, WZ0 + 0.1, "concrete", "workshop", 0.01)
box("Sill", WIN[0] - 0.08, WIN[1] + 0.08, WIN[2] - 0.06, WIN[2] + 0.005, WZ0 - 0.06, WZ0 + 0.2, "concrete", "workshop", 0.01)
# the doors: two planked leaves, set back in the opening, ledged and braced
for s, (xa, xb) in enumerate(((DOOR[0] + 0.02, (DOOR[0] + DOOR[1]) / 2 - 0.006), ((DOOR[0] + DOOR[1]) / 2 + 0.006, DOOR[1] - 0.02))):
    zf = WZ0 + 0.16; n = 5; pw_ = (xb - xa) / n
    for k in range(n):
        box(f"DoorPlank{s}{k}", xa + k * pw_ + 0.004, xa + (k + 1) * pw_ - 0.004, F + 0.02, DOOR[3] - 0.02, zf, zf + 0.04, "doorWood", "workshop", 0.006)
    for y in (F + 0.35, F + 1.2, DOOR[3] - 0.35):
        box(f"DoorLedge{s}{y:.1f}", xa + 0.05, xb - 0.05, y - 0.07, y + 0.07, zf + 0.04, zf + 0.07, "doorWood", "workshop", 0.006)
    rod(f"DoorRing{s}", (xb - 0.1 if s == 0 else xa + 0.1, F + 1.15, zf - 0.005), (xb - 0.1 if s == 0 else xa + 0.1, F + 1.15, zf - 0.04), 0.03, "darkSteel", "workshop", 10)
box("DoorFrame", DOOR[0], DOOR[1], DOOR[3] - 0.02, DOOR[3], WZ0 + 0.12, WZ0 + 0.22, "woodDark", "workshop", 0.004)
# the window: frame, dark glass, bars; the shutters folded back on the wall
def window(nm, x0, x1, y0, y1, zf, axis):
    """A window in the plane at `zf` (axis "z": along x; axis "x": the side wall, along z)."""
    def bx(n, a0, a1, b0, b1, c0, c1, mat, w=0.006):
        return box(n, a0, a1, b0, b1, c0, c1, mat, "workshop", w) if axis == "z" else box(n, zf + c0 - zf, zf + c1 - zf, b0, b1, a0, a1, mat, "workshop", w)
    d = 0.06
    bx(f"{nm}Glass", x0, x1, y0, y1, zf + 0.04, zf + 0.05, "glass", 0)
    for a0, a1, b0, b1 in ((x0, x1, y0, y0 + d), (x0, x1, y1 - d, y1), (x0, x0 + d, y0, y1), (x1 - d, x1, y0, y1), ((x0 + x1) / 2 - 0.025, (x0 + x1) / 2 + 0.025, y0, y1), (x0, x1, y0 + (y1 - y0) * 0.6, y0 + (y1 - y0) * 0.6 + 0.04)):
        bx(f"{nm}Frame{a0:.2f}{b0:.2f}", a0, a1, b0, b1, zf, zf + 0.06, "shutter")
    nb_ = 6
    for k in range(nb_):
        u = x0 + (x1 - x0) * (k + 0.5) / nb_
        if axis == "z": rod(f"{nm}Bar{k}", (u, y0 - 0.02, zf - 0.08), (u, y1 + 0.02, zf - 0.08), 0.011, "darkSteel", "workshop", 8)
        else: rod(f"{nm}Bar{k}", (zf - 0.08 * (-1), y0 - 0.02, u), (zf - 0.08 * (-1), y1 + 0.02, u), 0.011, "darkSteel", "workshop", 8)
window("Win", WIN[0], WIN[1], WIN[2], WIN[3], WZ0 + 0.14, "z")
window("SWin", SWIN[0], SWIN[1], SWIN[2], SWIN[3], WX1 - 0.14, "x")
for s, xe in ((-1, WIN[0]), (1, WIN[1])):            # the shutters, open against the wall
    sw = (WIN[1] - WIN[0]) / 2; xa = xe if s > 0 else xe - sw; zf = WZ0 - 0.07
    for k in range(3):
        box(f"Shutter{s}{k}", xa + s * 0.06 + k * sw / 3 + 0.004, xa + s * 0.06 + (k + 1) * sw / 3 - 0.004, WIN[2] + 0.01, WIN[3] - 0.01, zf - 0.03, zf, "shutter", "workshop", 0.005)
    for y in (WIN[2] + 0.18, WIN[3] - 0.18):
        box(f"ShutBat{s}{y:.1f}", xa + s * 0.06 + 0.03, xa + s * 0.06 + sw - 0.03, y - 0.05, y + 0.05, zf - 0.05, zf - 0.03, "shutter", "workshop", 0.004)
# the stove pipe, the spout, the lamp, the name
cyl("Stove", (12.5, F + 3.62, 1.7), 0.09, 1.5, "darkSteel", "workshop", 14)
cyl("StoveCap", (12.5, F + 5.18, 1.7), 0.2, 0.14, "darkSteel", "workshop", 14, r2=0.03)
for k in range(3): rod(f"StoveLeg{k}", (12.5 + 0.08 * math.cos(k * 2.1), F + 5.1, 1.7 + 0.08 * math.sin(k * 2.1)), (12.5 + 0.17 * math.cos(k * 2.1), F + 5.2, 1.7 + 0.17 * math.sin(k * 2.1)), 0.008, "darkSteel", "workshop", 5)
rod("Spout", (10.4, F + 3.66, WZ1 - WT - 0.1), (10.4, F + 3.6, WZ1 + 0.35), 0.05, "darkSteel", "workshop", 10)
rod("LampArm", ((DOOR[0] + DOOR[1]) / 2, F + 2.95, WZ0), ((DOOR[0] + DOOR[1]) / 2, F + 2.95, WZ0 - 0.42), 0.012, "darkSteel", "workshop", 8)
cyl("LampShade", ((DOOR[0] + DOOR[1]) / 2, F + 2.74, WZ0 - 0.45), 0.2, 0.16, "doorPaint", "workshop", 18, r2=0.04)
cyl("LampBulb", ((DOOR[0] + DOOR[1]) / 2, F + 2.7, WZ0 - 0.45), 0.045, 0.07, "bulb", "workshop", 10)
text("Atelier", "ATELIER", ((DOOR[0] + DOOR[1]) / 2, F + 2.62 + 0.38, WZ0 - 0.008), 0.26, "black", "workshop", "-z", 0.003)
if LOW:   # (the far's own enamel PLATE behind it: the near's letters are painted onto it by the bake, and a plate is its
         # own small UV island that boost_signs() below gives 4x the texture — on the whitewash they baked unreadable)
    box("AtelierPlate", (DOOR[0] + DOOR[1]) / 2 - 0.72, (DOOR[0] + DOOR[1]) / 2 + 0.72, F + 2.81, F + 3.19, WZ0 - 0.012, WZ0, "signWhite", "workshop", 0.003)

# ── THE PROPS ────────────────────────────────────────────────────────────────
def drum(nm, c, mat, lying=False, rot=0.0):
    x, y, z = c
    if not lying:
        cyl(f"{nm}", (x, y + 0.01, z), 0.29, 0.86, mat, "props", 24, w=0.01)
        for h in (0.0, 0.875): torus(f"{nm}Rim{h}", (x, y + 0.01 + h, z), 0.287, 0.012, mat, "props", "y", 16, 4)
        for h in (0.29, 0.58): torus(f"{nm}Hoop{h}", (x, y + h, z), 0.29, 0.016, mat, "props", "y", 16, 4)
        cyl(f"{nm}Bung", (x + 0.17, y + 0.87, z + 0.05), 0.03, 0.015, "darkSteel", "props", 8, w=0.002)
    else:
        ax = (math.cos(rot), 0, math.sin(rot)); a = gv(x, y + 0.3, z) - gv(*ax) * 0.43
        cyl(f"{nm}", tuple(a), 0.29, 0.86, mat, "props", 24, ax, 0.01)
        for h in (0.29, 0.58): torus(f"{nm}Hoop{h}", tuple(a + gv(*ax) * h), 0.29, 0.016, mat, "props", "x" if abs(ax[0]) > 0.7 else "z", 24, 6)
# (a row along the gable, behind the sandbags; one more stood off at the corner)
DRUMS = [(-8.32, -3.7, "drumOlive"), (-8.32, -3.08, "drumOlive"), (-8.32, -2.46, "drumRed"), (-8.32, -1.84, "drumOlive"), (-7.9, -4.95, "drumBlue")]
for k, (x, z, mt) in enumerate(DRUMS): drum(f"Drum{k}", (x, F, z), mt)
# one on its cradle
box("CradleA", -8.9, -8.2, F, F + 0.1, -0.72, -0.6, "woodDark", "props", 0.01)
box("CradleB", -8.9, -8.2, F, F + 0.1, -0.02, 0.1, "woodDark", "props", 0.01)
drum("DrumLying", (-8.55, F + 0.03, -0.31), "drumOlive", True, math.pi / 2)
# the hand pump on a drum by the workshop
drum("PumpDrum", (13.15, F, -5.05), "drumRed")
rod("Pump", (13.15, F + 0.88, -5.05), (13.15, F + 1.55, -5.05), 0.035, "darkSteel", "props", 10)
rod("PumpHandle", (13.15, F + 1.42, -5.05), (13.5, F + 1.62, -5.05), 0.014, "darkSteel", "props", 6)
rod("PumpSpout", (13.15, F + 1.45, -5.05), (12.88, F + 1.4, -5.05), 0.02, "darkSteel", "props", 8)
# jerrycans in a row under the window
def jerry(nm, x, z, rot=0.0, y=F):
    o = box(nm, x - 0.08, x + 0.08, y, y + 0.47, z - 0.17, z + 0.17, "jerry", "props", 0.022)
    o.rotation_euler.z = rot
    box(nm + "H", x - 0.02, x + 0.02, y + 0.46, y + 0.52, z - 0.12, z + 0.1, "jerry", "props", 0.01).rotation_euler.z = rot
for k in range(7):
    jerry(f"Jerry{k}", 11.0 + k * 0.19 + random.uniform(-0.01, 0.01), WZ0 - 0.26, random.uniform(-0.03, 0.03))
jerry("JerryOut", 12.6, WZ0 - 0.75, 0.6)
# the tyre stack and a leaning wheel
for k in range(4):
    torus(f"Tyre{k}", (-8.5 + random.uniform(-0.03, 0.03), F + 0.11 + k * 0.215, 1.25 + random.uniform(-0.03, 0.03)), 0.33, 0.105, "rubber", "props", "y", 30, 10, 0.95)
for s in (-1, 1):
    torus(f"LeanTyre{s}", (-8.62, F + 0.44, 2.15 + s * 0.12), 0.33, 0.105, "rubber", "props", "x", 30, 10, 0.95)
cyl("LeanRim", (-8.69, F + 0.44, 2.15), 0.24, 0.14, "darkSteel", "props", 18, "x")
# the gantry and hoist in the left bay, over an engine on its stand
GX0, GX1, GZ = -6.5, -3.5, -0.4
for gx in (GX0, GX1):
    for s in (-1, 1):
        rod(f"GLeg{gx}{s}", (gx, F, GZ + s * 0.85), (gx, F + 3.25, GZ), 0.04, "frame", "props", 10)
    rod(f"GTie{gx}", (gx, F + 0.9, GZ - 0.62), (gx, F + 0.9, GZ + 0.62), 0.025, "frame", "props", 8)
    for s in (-1, 1):
        cyl(f"GCaster{gx}{s}", (gx, F + 0.0, GZ + s * 0.85), 0.07, 0.05, "rubber", "props", 12, "x")
member("GBeam", (GX0 - 0.15, F + 3.33, GZ), (GX1 + 0.15, F + 3.33, GZ), P_I(0.16, 0.09, 0.01, 0.007), "frame", "props", (0, 1, 0), 0.003)
box("Trolley", -5.15, -4.85, F + 3.16, F + 3.27, GZ - 0.08, GZ + 0.08, "darkSteel", "props", 0.01)
cyl("HoistBlock", (-5.0, F + 2.82, GZ), 0.14, 0.3, "redPaint", "props", 16, "z", 0.012)
for k in range(9):
    torus(f"Chain{k}", (-5.0, F + 2.78 - k * 0.08, GZ), 0.022, 0.006, "darkSteel", "props", "x" if k % 2 else "z", 8, 4, 1.0)
rod("Hook", (-5.0, F + 2.07, GZ), (-5.0, F + 1.86, GZ), 0.014, "darkSteel", "props", 6)
for s in (-1, 1):
    rod(f"Sling{s}", (-5.0, F + 1.86, GZ), (-5.0 + s * 0.28, F + 1.33, GZ), 0.008, "darkSteel", "props", 5)
# the engine (a Hotchkiss four: block, head, sump, manifold, fan, pulleys) on a stand
box("StandTop", -5.45, -4.55, F + 0.62, F + 0.67, GZ - 0.32, GZ + 0.32, "frame", "props", 0.006)
for sx in (-1, 1):
    for sz in (-1, 1):
        rod(f"StandLeg{sx}{sz}", (-5.0 + sx * 0.42, F, GZ + sz * 0.3), (-5.0 + sx * 0.4, F + 0.62, GZ + sz * 0.28), 0.022, "frame", "props", 8)
box("EngSump", -5.32, -4.68, F + 0.67, F + 0.82, GZ - 0.2, GZ + 0.2, "engine", "props", 0.02)
box("EngBlock", -5.36, -4.64, F + 0.82, F + 1.2, GZ - 0.2, GZ + 0.2, "engine", "props", 0.02)
box("EngHead", -5.34, -4.66, F + 1.2, F + 1.33, GZ - 0.16, GZ + 0.18, "engine", "props", 0.02)
box("EngCover", -5.3, -4.7, F + 1.33, F + 1.4, GZ - 0.12, GZ + 0.12, "engine", "props", 0.02)
member("EngManifold", (-5.3, F + 1.08, GZ - 0.24), (-4.7, F + 1.08, GZ - 0.24), P_R(0.07, 0.09), "darkSteel", "props", (0, 1, 0), 0.015)
cyl("EngFan", (-5.4, F + 1.05, GZ), 0.2, 0.02, "engine", "props", 18, "x", 0.003)
cyl("EngPulley", (-5.42, F + 0.85, GZ), 0.09, 0.05, "darkSteel", "props", 16, "x", 0.004)
cyl("EngFly", (-4.64, F + 0.95, GZ), 0.2, 0.06, "darkSteel", "props", 20, "x", 0.004)
for k in range(4):
    cyl(f"EngPlug{k}", (-5.22 + k * 0.15, F + 1.2, GZ + 0.19), 0.014, 0.05, "black", "props", 6, "z", 0)
# the bench at the back of the left bay, its vice, the tool board
BX0, BX1, BZ = -7.0, -4.6, Z1 - 0.1
box("BenchTop", BX0, BX1, F + 0.86, F + 0.92, BZ - 0.7, BZ, "woodDark", "props", 0.01)
box("BenchShelf", BX0 + 0.05, BX1 - 0.05, F + 0.25, F + 0.28, BZ - 0.65, BZ - 0.05, "woodDark", "props", 0.006)
for x in (BX0 + 0.06, BX1 - 0.06):
    for z in (BZ - 0.64, BZ - 0.06):
        box(f"BenchLeg{x}{z}", x - 0.04, x + 0.04, F, F + 0.86, z - 0.04, z + 0.04, "woodDark", "props", 0.006)
box("ViceBase", BX0 + 0.25, BX0 + 0.45, F + 0.92, F + 0.97, BZ - 0.75, BZ - 0.55, "darkSteel", "props", 0.006)
box("ViceJawB", BX0 + 0.22, BX0 + 0.48, F + 0.97, F + 1.12, BZ - 0.66, BZ - 0.56, "doorPaint", "props", 0.008)
box("ViceJawF", BX0 + 0.22, BX0 + 0.48, F + 0.97, F + 1.12, BZ - 0.82, BZ - 0.74, "doorPaint", "props", 0.008)
rod("ViceScrew", (BX0 + 0.35, F + 1.02, BZ - 0.84), (BX0 + 0.35, F + 1.02, BZ - 1.0), 0.012, "darkSteel", "props", 6)
rod("ViceBar", (BX0 + 0.2, F + 1.02, BZ - 1.0), (BX0 + 0.5, F + 1.02, BZ - 1.0), 0.008, "darkSteel", "props", 6)
box("ToolBoard", BX0 + 0.3, BX1 - 0.3, F + 1.1, F + 1.9, BZ - 0.02, BZ, "wood", "props", 0.004)
for k in range(9):
    x = BX0 + 0.45 + k * 0.17; L = 0.18 + (k % 3) * 0.07
    box(f"Tool{k}", x - 0.012, x + 0.012, F + 1.75 - L, F + 1.75, BZ - 0.035, BZ - 0.02, "darkSteel", "props", 0.002)
box("ToolBox", BX1 - 0.65, BX1 - 0.2, F + 0.92, F + 1.12, BZ - 0.5, BZ - 0.25, "redPaint", "props", 0.01)
for k in range(3):
    cyl(f"OilCan{k}", (BX0 + 0.9 + k * 0.16, F + 0.92, BZ - 0.25 - (k % 2) * 0.08), 0.055, 0.17, "drumBlue", "props", 12, w=0.004)
# crates in the corner and on the apron
def crate(nm, x, y, z, w, h, d, rot=0.0):
    o = box(nm, x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2, "wood", "props", 0.012); o.rotation_euler.z = rot
    for s in (-1, 1):
        b = box(nm + f"Bat{s}", x - w / 2 - 0.012, x + w / 2 + 0.012, y + 0.04, y + h - 0.04, z + s * (d / 2 - 0.05) - 0.03, z + s * (d / 2 - 0.05) + 0.03, "woodDark", "props", 0.006)
        b.rotation_euler.z = rot
crate("Crate0", -3.15, F, Z1 - 0.55, 0.9, 0.55, 0.6, 0.02)
crate("Crate1", -3.2, F + 0.55, Z1 - 0.55, 0.9, 0.55, 0.6, -0.05)
crate("Crate2", -3.25, F, Z1 - 1.3, 0.7, 0.45, 0.5, 0.3)
crate("Crate3", 1.6, F, Z1 - 0.5, 0.8, 0.5, 0.6, 0.0)
# the fire point at the apron's front-left corner
FP = (-8.3, -6.4)
for s in (-1, 1): box(f"FirePost{s}", FP[0] - 0.05 + s * 0.5, FP[0] + 0.05 + s * 0.5, F, F + 1.75, FP[1] - 0.04, FP[1] + 0.04, "woodDark", "props", 0.008)
box("FireBoard", FP[0] - 0.6, FP[0] + 0.6, F + 0.9, F + 1.7, FP[1] - 0.08, FP[1] - 0.04, "redPaint", "props", 0.01)
for k in range(3):
    bx_ = FP[0] - 0.36 + k * 0.36
    cyl(f"Bucket{k}", (bx_, F + 1.0, FP[1] - 0.2), 0.08, 0.28, "redPaint", "props", 14, w=0.004, r2=0.14)
    rod(f"BucketPeg{k}", (bx_, F + 1.38, FP[1] - 0.04), (bx_, F + 1.38, FP[1] - 0.2), 0.01, "darkSteel", "props", 5)
box("SandBox", FP[0] - 0.5, FP[0] + 0.5, F, F + 0.42, FP[1] - 0.7, FP[1] - 0.2, "redPaint", "props", 0.015)
box("SandIn", FP[0] - 0.46, FP[0] + 0.46, F + 0.3, F + 0.4, FP[1] - 0.66, FP[1] - 0.24, "sand", "props", 0.02)
box("Shovel", FP[0] + 0.15, FP[0] + 0.19, F + 0.38, F + 1.25, FP[1] - 0.45, FP[1] - 0.42, "woodDark", "props", 0.004).rotation_euler.x = 0.25
# (the sandbags round the drums' corner: the game's cloth-simulated bags, added by algMotorPool.js)

# ── Join: the building into ONE object (one draw), the doors their own (they swing) ─
def join(name, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        if o.type in ("CURVE", "FONT"):
            bpy.context.view_layer.objects.active = o; o.select_set(True); bpy.ops.object.convert(target="MESH"); o.select_set(False)
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
        o.select_set(True)
    deconflict([o for o in objs if o.type == "MESH"], name)   # (bkit: parts sharing a plane moved 4 mm apart — no z-fighting)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active; j.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return j
if LOW:
    # (far: the hidden structure — purlins and girts behind the sheets, gussets, braces — and every part
    # too small to read from the RTS camera, 50-130 m out: bolts, chains, tools, hinges, rims)
    SKIP = ("Purlin", "Girt", "Gusset", "Brace", "Knee", "Nut", "Base", "Chain", "Tool", "EngPlug", "StoveLeg", "Sling", "Hook", "BucketPeg", "OilCan", "Vice", "PitLip")
    for g in GROUPS.values():
        for o in list(g):
            # (and the LETTERING — 2026-10-23, you: "for motorpool why don't you use a decal for text": the far,
            # the game's, has no letters of its own; the bake below paints the near's onto its boards' texture)
            if o.name.startswith(SKIP) or o.name in ("SignText", "NoSmokeA", "NoSmokeB", "Atelier") or any(t in o.name for t in ("Rim", "Hoop", "Bung")) or o.dimensions.length < 0.3:
                g.remove(o); bpy.data.objects.remove(o, do_unlink=True)
    for k in ("doorL", "doorR"):                           # (the doors: the near ones serve both levels)
        for o in GROUPS[k]: bpy.data.objects.remove(o, do_unlink=True)
        GROUPS[k] = []
if "--stats" in sys.argv:                              # (where the triangles go, by part kind)
    import re, collections
    dg = bpy.context.evaluated_depsgraph_get(); per = collections.Counter()
    for g in GROUPS.values():
        for o in g:
            if o.type != "MESH": continue
            me = o.evaluated_get(dg).to_mesh(); per[re.sub(r"[-\d.]+.*$", "", o.name) or o.name] += sum(len(p.vertices) - 2 for p in me.polygons); o.evaluated_get(dg).to_mesh_clear()
    for k, v in per.most_common(25): print("PART", k, v)
    sys.exit(0)
if os.environ.get("BKIT_TIME"):   # (timing the z-fight check alone: join, report, stop)
    import time; _t = time.time(); join("T", [o for k in ("shed", "workshop", "apron", "props") for o in GROUPS[k]]); print("JOIN", round(time.time() - _t, 1), "s"); sys.exit(0)
OBJS = {"Static": join("StaticFar" if LOW else "Static", [o for k in ("shed", "workshop", "apron", "props") for o in GROUPS[k]])}
if not LOW:
    OBJS["DoorL"] = join("DoorL", GROUPS["doorL"]); OBJS["DoorR"] = join("DoorR", GROUPS["doorR"])
for c in CUTTERS: bpy.data.objects.remove(c, do_unlink=True)
def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
print("TRIS", {o.name: tris(o) for o in OBJS.values()}, "TOTAL", sum(tris(o) for o in OBJS.values()))
for o in OBJS.values():
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))

# ── THE BAKE ─────────────────────────────────────────────────────────────────
import numpy as np
scn = bpy.context.scene
scn.render.engine = "CYCLES"; scn.cycles.device = "CPU"
scn.render.bake.margin = 8
scn.world.light_settings.distance = 2.2
NEAR_BLEND = os.path.join(REFS, "motorPool_near.blend")
def unwrap(o, margin):
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
def target(o, size, name):
    img = bpy.data.images.new(name, size, size, alpha=False)
    for m in o.data.materials:
        tn = m.node_tree.nodes.get("BakeTarget") or m.node_tree.nodes.new("ShaderNodeTexImage")
        tn.name = "BakeTarget"; tn.image = img; m.node_tree.nodes.active = tn
    return img
def colour_pass():
    scn.render.bake.use_pass_direct = False; scn.render.bake.use_pass_indirect = False; scn.render.bake.use_pass_color = True
def finish(o, px, size, name, rough):
    """The baked pixels → a PNG beside the refs and ONE plain material on the object."""
    out_img = bpy.data.images.new(f"motorPool_{name}", size, size, alpha=False)
    out_img.pixels = px.ravel().tolist()
    out_img.filepath_raw = os.path.join(REFS, f"motorPool_{name}.png"); out_img.file_format = "PNG"; out_img.save()
    m = bpy.data.materials.new(f"MotorPool_{name}"); m.use_nodes = True
    tn = m.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = out_img
    pb = m.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = rough
    m.node_tree.links.new(tn.outputs["Color"], pb.inputs["Base Color"])
    o.data.materials.clear(); o.data.materials.append(m)
    for p in o.data.polygons: p.material_index = 0
    print("BAKED", name, size)

if not LOW:
    # NEAR: colour × ambient occlusion, the building in one 4096 atlas, each door in a 512
    for key, o in OBJS.items():
        S_ = (4096 if key == "Static" else 512) // (4 if QUICK else 1)
        unwrap(o, 0.0015 if key == "Static" else 0.003)
        imgs = {}
        img = target(o, S_, f"{key}_col"); scn.cycles.samples = 4; colour_pass(); bpy.ops.object.bake(type="DIFFUSE"); imgs["col"] = img
        img = target(o, S_, f"{key}_ao"); scn.cycles.samples = 16 if QUICK else 96; bpy.ops.object.bake(type="AO"); imgs["ao"] = img
        c = np.array(imgs["col"].pixels[:]).reshape(-1, 4); a = np.array(imgs["ao"].pixels[:]).reshape(-1, 4)
        c[:, :3] *= 0.3 + 0.7 * a[:, :1]                      # (softened: the game lights it too)
        finish(o, c, S_, "Near" if key == "Static" else key, 0.85 if key == "Static" else 0.7)
    # the doors' origin on their hinges (a game swings them open, outward)
    for key, gk in (("DoorL", "doorL"), ("DoorR", "doorR")):
        o = OBJS[key]; hx, hz = HINGE[gk]
        scn.cursor.location = B(hx, F, hz)
        bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
        bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    scn.cursor.location = (0, 0, 0)
    bpy.ops.wm.save_as_mainfile(filepath=NEAR_BLEND)
    print("NEAR", NEAR_BLEND)
    print("DONE")
    sys.exit(0)

# FAR: its atlas baked FROM the near building (selected → active): the near's colour, AO and ribs land on
# the flat sheets and the box sections
far = OBJS["Static"]
unwrap(far, 0.004)
def boost_signs(o, mats=("signGreen", "signWhite"), k=4.0):
    """THE SIGNS' LETTERS READABLE (2026-10-23): painted into the far's atlas (no letter geometry — your "use a decal for
    text"), PARC AUTO came out clean but ATELIER and DÉFENSE DE FUMER, a few texels tall, unreadable. Every face of a
    sign board or plate scaled k times about its own centre in UV, then the islands packed again: those boards get
    k x k the texels, the building gives up a sliver of its share. (A box's faces are each their own island.)"""
    idx = {i for i, m in enumerate(o.data.materials) if m and m.name in mats}
    bm = bmesh.new(); bm.from_mesh(o.data); uv = bm.loops.layers.uv.active; n = 0
    for f in bm.faces:
        if f.material_index not in idx: continue
        cu = sum((l[uv].uv for l in f.loops), Vector((0, 0))) / len(f.loops)
        for l in f.loops: l[uv].uv = cu + (l[uv].uv - cu) * k
        n += 1
    bm.to_mesh(o.data); bm.free()
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(rotate=False, margin=0.004)
    bpy.ops.object.mode_set(mode="OBJECT")
    print("SIGNS", n, "faces x", k)
boost_signs(far)
S_ = 2048 // (4 if QUICK else 1)                      # (1024 blurred the rust and the sheets' laps at the closest zoom)
img = target(far, S_, "far_col")
with bpy.data.libraries.load(NEAR_BLEND, link=False) as (src, dst):
    dst.objects = [n for n in src.objects if n in ("Static", "DoorL", "DoorR")]
for o in dst.objects: scn.collection.objects.link(o)
near = bpy.data.objects["Static"]; near.name = "StaticNear"
bpy.ops.object.select_all(action="DESELECT"); near.select_set(True); far.select_set(True); bpy.context.view_layer.objects.active = far
scn.cycles.samples = 8; colour_pass()
bpy.ops.object.bake(type="DIFFUSE", use_selected_to_active=True, cage_extrusion=0.08, max_ray_distance=0.3)
finish(far, np.array(img.pixels[:]).reshape(-1, 4), S_, "Far", 0.85)

# TWO FILES (2026-10-19): the game draws the far level only (the near cost 2 ms at the closest zoom), so it
# never downloads the near's 4096 atlas — motorPool.glb = StaticFar + the doors, motorPoolNear.glb = StaticNear
# (the buildings lab's close look)
for fn, names in (("motorPool", ("StaticFar", "DoorL", "DoorR")), ("motorPoolNear", ("StaticNear",))):
    bpy.ops.object.select_all(action="DESELECT")
    for n in names: bpy.data.objects[n].select_set(True)
    kw = dict(filepath=os.path.join(out, f"{fn}.glb"), use_selection=True, export_yup=True, export_materials="EXPORT", export_image_format="JPEG")
    try: bpy.ops.export_scene.gltf(**kw, export_jpeg_quality=90)
    except TypeError: bpy.ops.export_scene.gltf(**kw)
    print("GLB", os.path.join(out, f"{fn}.glb"))

# ── Previews (workbench, the baked textures): the near, then the far ─────────
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1400, 850
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, frm, tgt, lens=35):
    cd.lens = lens; cam.location = B(*frm); cam.rotation_euler = (B(*tgt) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(REFS, f"blender_{name}.png"); bpy.ops.render.render(write_still=True)
far.hide_render = True
shot("front34", (-14, 9, -20), (2, 2, 0))
shot("inside", (-3, 2.2, -9), (-4.5, 1.6, 2))
far.hide_render = False; near.hide_render = True
shot("far_front34", (-14, 9, -20), (2, 2, 0))
shot("far_rts", (-20, 30, -30), (2.5, 0, 0), 45)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "motorPool.blend"))
print("DONE")
