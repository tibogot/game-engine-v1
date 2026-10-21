"""THE MG NEST IN BLENDER (2026-10-21, you: "except the sandbags everything looks too cheap"): the French AA-52 nest
round the user's cloth-simulated ring (sandbagRing.glb — its geometry is the old piece's, so the ring still fits):

  EARTH     the raised platform of dug spoil the ring stands on — flat top 0.45 m up to r 3.1, falling to the ground at
            r 3.9, lumpy, its outer slope heaped with clods; the floor inside trodden. A photographed dry mud (its colour
            and RELIEF baked: normals=True)
  ROOF      over the back half: four squared POSTS on the floor, two bearers, five rough squared timbers across — the
            simulated roof course of bags lies on them (the old kit's sticks floated half a metre over the ring)
  STORES    steel ammunition boxes for the AA-52, a wooden crate, a jerrycan, spent brass by the gun
  GUN       type "gun": the AA-52 on its tripod — its own object (the game turns it): origin at the cradle's pivot,
            barrel toward -Z, its tripod on the nest's floor (0.75 down: the game sets the pivot 1.2 m up — algSangar)

    INTACT    as above
    DAMAGED   shelled: a post down, two timbers fallen into the nest, a bite out of the berm, the boxes thrown
    RUIN      blown in: a scorched crater in the floor, the posts charred stumps, timbers scattered and burnt

  BUILD ORDER (COLOR_0): the earth, the posts, the bearers, the timbers (the bags go on in between — the game's ring),
  the stores; the gun last (the game shows it at the end).

Real metres (the game ×1.3); the front (the gun) at -Z, the open back +Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/mgNest.py -- <out dir> [--quick]

Writes <out>/mgnest.glb (NestMg_Intact … , NestGun_… + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, noise as mnoise
import house
from house import buildKit
from bkit import B, gv, srgb, dust, flat, wood
import drystone
from drystone import tag

TOP, R_TOP, R_OUT, FOOT = 0.45, 3.1, 3.9, -0.14
GROUND = os.path.join(house.bkit.ROOT, "public", "textures", "ground")

def photo(nb, folder, file, sc, data=False):
    im = bpy.data.images.load(os.path.join(GROUND, folder, file), check_existing=True)
    if data: im.colorspace_settings.name = "Non-Color"
    mp = nb.N.new("ShaderNodeMapping"); nb.L.new(nb.tc.outputs["Object"], mp.inputs["Vector"]); mp.inputs["Scale"].default_value = (sc, sc, sc)
    n = nb.N.new("ShaderNodeTexImage"); n.image = im; n.projection = "BOX"; n.projection_blend = 0.3
    nb.L.new(mp.outputs["Vector"], n.inputs["Vector"]); return n.outputs["Color"]
def earth(tint, sc=0.45):
    def f(nb):
        c = photo(nb, "brown_mud_dry", "brown_mud_dry_diff_1k.jpg", sc)
        # (the photo's pale salt crust read as white blotches at full strength: half of it, over the spoil's brown)
        c = nb.mix(0.5, c, srgb(tint))
        c = nb.mix(1.0, c, (0.62, 0.52, 0.4), "MULTIPLY")
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(1.2, 4), 0.45, 0.7), 0.5), c, tuple(v * 0.8 for v in srgb(tint)))
        pb = next(n for n in nb.N if n.type == "BSDF_PRINCIPLED")
        nm = nb.N.new("ShaderNodeNormalMap"); nm.inputs["Strength"].default_value = 1.4
        nb.L.new(photo(nb, "brown_mud_dry", "brown_mud_dry_nor_gl_1k.jpg", sc, True), nm.inputs["Color"])
        nb.L.new(nm.outputs["Normal"], pb.inputs["Normal"])
        return c
    return f
def timber(tint):
    def f(nb):
        c = nb.mix(1.0, nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 0.9), srgb(tint), "MULTIPLY")
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.78, 1.15))
        return dust(nb, c, 0.9)
    return f
def steel(base, wear=1.0, dusty=True):
    def f(nb):
        c = nb.mix(nb.noise(1.5, 4), srgb(base), tuple(v * 0.78 for v in srgb(base)))
        w = nb.math("MULTIPLY", nb.mr(nb.point(), 0.52, 0.6), nb.noise(25.0, 3))
        c = nb.mix(nb.math("MULTIPLY", w, 1.5 * wear), c, srgb(0x8a8578))
        # (`dusty`: the ground's dust up its foot — NOT on the gun, whose origin is its pivot: all of it is "low", and the
        # dust turned the whole AA-52 pale beige, 2026-10-21)
        return dust(nb, c, 0.6, 0.6) if dusty else c
    return f
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "mnEarth": (1.0, earth(0xb09070)), "mnFloor": (1.0, earth(0xa08468, 0.6)), "mnTimber": (0.9, timber(0x9a876a)),
    "mnBox": (0.6, steel(0x4c5236)), "mnCrate": (0.85, timber(0x7d7556)), "mnJerry": (0.6, steel(0x56603a)),
    "mnBrass": (0.35, steel(0xb39048, 0.2)), "mnGun": (0.45, steel(0x2b2d2a, 0.15, False)), "mnGunPaint": (0.6, steel(0x45503a, 0.2, False)), "mnRound": (0.35, steel(0xb39048, 0.1, False)),
    "mnCharred": (0.95, charred),
})
LOW = lambda: drystone.LOW

def beam(K, nm, a, b, w, h, mat, t):
    a, b = gv(*a), gv(*b)
    d = (b - a); L_ = d.length; d.normalize()
    up = gv(0, 1, 0) if abs(d.y) < 0.95 else gv(1, 0, 0)
    u = d.cross(up).normalized(); v = u.cross(d).normalized()
    bm = bmesh.new()
    vs = [bm.verts.new(B(*(a + d * s + u * (cu * w / 2) + v * (cv * h / 2)))) for s in (0, L_) for cu in (-1, 1) for cv in (-1, 1)]
    bmesh.ops.convex_hull(bm, input=vs)
    return tag(K.bevel(K.obj(nm, bm, mat, "h"), 0.012 if not LOW() else 0, 2, 40), t)

def platform(K, R, state):
    """The spoil platform: a polar grid — flat top to R_TOP, the slope to the ground, noise; a bite (damaged), a
    scorched crater (ruin)."""
    na, nr = (64, 16) if not LOW() else (32, 8)
    bm = bmesh.new(); grid = []
    off = Vector((R.uniform(0, 50), R.uniform(0, 50), 0))
    for j in range(nr + 1):
        r = R_OUT * j / nr
        row = []
        for i in range(na):
            a = 2 * math.pi * i / na
            x, z = math.cos(a) * r, math.sin(a) * r
            if r <= R_TOP: y = TOP - (0.05 * (1 - (r / 2.0) ** 2) if r < 2.0 else 0)
            else:
                f = (r - R_TOP) / (R_OUT - R_TOP)
                y = TOP + (FOOT - TOP) * (f * f * (3 - 2 * f))
            n = mnoise.noise(Vector((x * 0.9, z * 0.9, 0)) + off)
            y += n * (0.03 if r < R_TOP else 0.08)
            if state == "damaged":   # a bite out of the front-left slope
                d = math.hypot(x + 2.2, z + 2.6); y -= max(0.0, 0.35 * (1 - d / 1.4))
            if state == "ruin":      # the crater in the floor, the berm slumped
                d = math.hypot(x - 0.3, z + 0.2); y -= max(0.0, 0.38 * (1 - (d / 1.8) ** 2)); y *= 0.85
            row.append(bm.verts.new(B(x, y, z)))
        grid.append(row)
    centre = bm.verts.new(B(0, grid[0][0].co.z, 0))
    for i in range(na):
        bm.faces.new((centre, grid[1][(i + 1) % na], grid[1][i])) if False else None
    for j in range(nr):
        for i in range(na):
            bm.faces.new((grid[j][i], grid[j][(i + 1) % na], grid[j + 1][(i + 1) % na], grid[j + 1][i]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    tag(K.obj("Earth", bm, "mnCharred" if False else "mnEarth", "h", smooth=True), 0.0)
    if state == "ruin":
        tag(K.lump("Scorch", (0.3, TOP - 0.3, -0.2), (1.2, 0.04, 1.1), "mnCharred", "h", seed=4, rough=0.3, sub=2), 0.0)
    # clods heaped on the outer slope (the spoil thrown up), stones
    for k in range(26 if not LOW() else 10):
        a = R.uniform(0, 6.283); r = R.uniform(R_TOP + 0.05, R_OUT - 0.15)
        f = (r - R_TOP) / (R_OUT - R_TOP); y = TOP + (FOOT - TOP) * (f * f * (3 - 2 * f))
        s = R.uniform(0.08, 0.2)
        tag(K.lump(f"Clod{k}", (math.cos(a) * r, y + s * 0.2, math.sin(a) * r), (s * 1.3, s * 0.6, s), "mnEarth", "h", seed=k + 11, rough=0.4, sub=1), 0.02)

POSTS = [(-1.1, 0.35), (1.1, 0.35), (-1.1, 1.6), (1.1, 1.6)]
def roof(K, R, state):
    yb, yt = 1.2, 1.32
    ruin = state == "ruin"
    for i, (x, z) in enumerate(POSTS):
        if ruin:
            beam(K, f"Post{i}", (x, TOP - 0.05, z), (x, TOP + R.uniform(0.15, 0.35), z), 0.13, 0.13, "mnCharred", 0.5)
        elif state == "damaged" and i == 2:
            beam(K, f"Post{i}", (x, TOP - 0.05, z), (x + 0.7, TOP + 0.15, z - 0.4), 0.13, 0.13, "mnTimber", 0.5)
        else:
            beam(K, f"Post{i}", (x, TOP - 0.05, z), (x, yb - 0.06, z), 0.13, 0.13, "mnTimber", 0.5 + 0.02 * i)
    if ruin:
        for k in range(6):
            a = gv(R.uniform(-2.5, 2.5), TOP + 0.05, R.uniform(-2.0, 2.2)); d = gv(R.uniform(-1, 1), 0.04, R.uniform(-1, 1)).normalized()
            beam(K, f"Timber{k}", tuple(a), tuple(a + d * R.uniform(1.2, 3.5)), 0.15, 0.13, "mnCharred", 0.6)
        return
    for zz in (0.35, 1.6):
        if state == "damaged" and zz == 1.6:
            beam(K, f"Bearer{zz}", (-1.35, yb, zz), (0.5, TOP + 0.3, zz - 0.2), 0.15, 0.12, "mnTimber", 0.56)
        else:
            beam(K, f"Bearer{zz}", (-1.35, yb, zz), (1.35, yb, zz), 0.15, 0.12, "mnTimber", 0.56)
    for k in range(5):
        z = 0.3 + k * 0.38
        if state == "damaged" and k in (3, 4):
            # fallen into the nest, one end still up
            beam(K, f"Timber{k}", (-2.2, yt, z), (1.6, TOP + 0.08, z - 0.6 - 0.2 * k), 0.16, 0.13, "mnTimber", 0.62)
            continue
        beam(K, f"Timber{k}", (-2.2 + R.uniform(-0.05, 0.05), yt, z), (2.2 + R.uniform(-0.05, 0.05), yt + R.uniform(-0.02, 0.02), z), 0.16, 0.13, "mnTimber", 0.6 + 0.02 * k)

def box(K, nm, at, size, yaw, mat, t, tilt=0.0):
    x, y, z = size
    o = K.box(nm, -x / 2, x / 2, 0, y, -z / 2, z / 2, mat, "h", 0.008)
    o.rotation_mode = "XYZ"; o.rotation_euler = (tilt, 0, yaw); o.location = B(*at)
    return tag(o, t)

def stores(K, R, state):
    if state == "ruin":
        for k in range(4):
            box(K, f"Burnt{k}", (R.uniform(-1.5, 1.5), TOP - 0.02, R.uniform(0.3, 1.6)), (0.32, 0.1, 0.18), R.uniform(0, 3), "mnCharred", 0.8, R.uniform(-0.3, 0.3))
        return
    thrown = state == "damaged"
    spots = [(-1.3, 0.9), (-0.95, 0.95), (-1.15, 1.25), (0.9, 1.1)]
    for k, (x, z) in enumerate(spots[:3]):   # the AA-52's steel ammunition boxes, a handle on each
        if thrown: x, z = x + R.uniform(-0.6, 0.8), z + R.uniform(-0.8, 0.3)
        y = TOP - 0.02 + (0.2 if k == 2 and not thrown else 0)
        o = box(K, f"Ammo{k}", (x, y, z), (0.3, 0.2, 0.15), R.uniform(-0.3, 0.3) + (R.uniform(0, 3) if thrown else 0), "mnBox", 0.8 + 0.02 * k, R.uniform(-0.4, 0.4) if thrown else 0)
        if not LOW():
            h = box(K, f"AmmoH{k}", (x, y + 0.205, z), (0.12, 0.02, 0.025), o.rotation_euler.z, "mnGun", 0.8 + 0.02 * k)
    box(K, "Crate", (0.95, TOP - 0.02, 1.15), (0.7, 0.32, 0.42), 0.2, "mnCrate", 0.84)
    if not thrown:
        box(K, "Jerry", (1.45, TOP - 0.02, 0.55), (0.17, 0.47, 0.34), 0.6, "mnJerry", 0.86)
    if not LOW():   # spent brass under the gun, lying on the floor (each built where it lies: a K.cyl bakes its place
        # into the mesh, and turning the object afterwards swung the cases round the nest's centre into the air)
        for k in range(14 if not thrown else 6):
            a, r, h = R.uniform(0, 6.283), R.uniform(0.1, 0.45), R.uniform(0, 6.283)
            c = gv(0.2 + math.cos(a) * r, TOP + 0.008, -1.55 + math.sin(a) * r); d = gv(math.cos(h), 0, math.sin(h)) * 0.025
            tag(K.rod(f"Brass{k}", tuple(c - d), tuple(c + d), 0.007, "mnBrass", "h", n=6), 0.9)

def buildNest(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    platform(K, random.Random(seed), state)
    roof(K, random.Random(seed + 1), state)
    stores(K, random.Random(seed + 2), state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

def buildGun(K, name, spec, state, seed, far=False):
    """The AA-52 on its tripod — origin at the cradle's pivot, the barrel toward -Z (the same in every state)."""
    drystone.setLow(K, far)
    for k in range(3):
        a = k / 3 * 2 * math.pi + math.pi / 2
        foot = (math.cos(a) * 0.55, -0.75, math.sin(a) * 0.55 + 0.1)   # (on the floor: the pivot 1.2 m up, the floor 0.45)
        tag(K.rod(f"Leg{k}", (0, -0.06, 0.05), foot, 0.016, "mnGunPaint", "h", n=6 if not LOW() else 4), 0.95)
        tag(K.cyl(f"Shoe{k}", (foot[0], foot[1] - 0.01, foot[2]), 0.03, 0.02, "mnGunPaint", "h", 6, w=0), 0.95)
    beam(K, "Cradle", (0, -0.06, 0.1), (0, -0.06, -0.1), 0.08, 0.06, "mnGunPaint", 0.95)
    beam(K, "Receiver", (0, 0.02, 0.32), (0, 0.02, -0.18), 0.075, 0.1, "mnGun", 0.95)
    beam(K, "Cover", (0, 0.085, 0.25), (0, 0.085, -0.1), 0.06, 0.03, "mnGun", 0.95)
    beam(K, "Stock", (0, 0.0, 0.32), (0, -0.04, 0.62), 0.05, 0.09, "mnGun", 0.95)
    beam(K, "Grip", (0, -0.03, 0.27), (0, -0.14, 0.31), 0.03, 0.04, "mnGun", 0.95)
    tag(K.rod("Barrel", (0, 0.03, -0.18), (0, 0.03, -0.82), 0.014, "mnGun", "h", n=8 if not LOW() else 5), 0.95)
    tag(K.rod("Jacket", (0, 0.03, -0.18), (0, 0.03, -0.42), 0.024, "mnGun", "h", n=8 if not LOW() else 5), 0.95)
    tag(K.rod("Flash", (0, 0.03, -0.82), (0, 0.03, -0.9), 0.022, "mnGun", "h", n=8 if not LOW() else 5), 0.95)
    tag(K.rod("Handle", (0, 0.03, -0.3), (0, 0.13, -0.3), 0.008, "mnGun", "h", n=5), 0.95)
    # the belt box on the left, a short belt into the feed
    beam(K, "BeltBox", (-0.13, -0.03, 0.12), (-0.13, -0.03, -0.08), 0.12, 0.16, "mnGunPaint", 0.95)
    if not LOW():
        for k in range(6):
            tag(K.cyl(f"Round{k}", (-0.075 + k * 0.012, 0.0, 0.05 - k * 0.012), 0.006, 0.05, "mnRound", "h", 5, w=0), 0.95)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farNest = lambda K, n, s, st, sd: buildNest(K, n, s, st, sd, far=True)
farGun = lambda K, n, s, st, sd: buildGun(K, n, s, st, sd, far=True)
TYPES = {
    "mg": dict(builder=buildNest, farBuilder=farNest, atlas=2048, normalAtlas=1024, aoDist=0.5, smoothAngle=40, weighted=False, normals=True),
    "gun": dict(builder=buildGun, farBuilder=farGun, atlas=512, aoDist=0.1, smoothAngle=40, weighted=False),
}
exported = buildKit(TYPES, MATDEF, "mgnest.glb", prefix="Nest", seed0=1962, colors=True)

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
    far_ = 0.35 if "Gun" in o.name else 1.0
    cd.lens = 35; cam.location = B(-4 * far_, 6 * far_, -7 * far_); cam.rotation_euler = (B(0, 0.4 * far_, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
