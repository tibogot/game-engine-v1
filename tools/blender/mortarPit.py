"""THE MORTAR PIT IN BLENDER (2026-10-21, you: "except the sandbags everything looks too cheap"): the French 81 mm pit round
the user's cloth-simulated ring (sandbagPit.glb — laid on the crest at r ~2.8, 0.44 up, the old pit's own):

  BERM      the pit's spoil thrown up in a low ring: its inner wall from the floor (the ground) at r 2.35, the crest
            0.5 m up at r 2.85, the outer slope to r 3.75, lower at the back (+z) where the crew come in; lumpy, clods
            on its slope — the MG nest's photographed dry mud with its relief
  STORES    at the back: 81 mm ammunition crates (planked, end battens, rope handles; one open, three tubes in it), the
            rounds' fibre tubes stacked on a timber rack, three bombs laid ready on a canvas, the empty tubes thrown by
  STAKES    the two aiming stakes out in front, red and white
  GUN       type "gun": the 81 mm mortar (milprops.mortar81 — the old piece's frame: the game reads its muzzle)

    INTACT    as above
    DAMAGED   a shell in the berm's front-left (a bite), the crates thrown, a stake down, tubes spilled
    RUIN      blown in: a scorched crater in the floor, the berm slumped, the stores burnt to black heaps

  BUILD ORDER (COLOR_0): the berm, the rack and the crates, the stakes, then the bombs; the gun last (the game).

Real metres (the game ×1.3); the front (the stakes) at -Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/mortarPit.py -- <out dir> [--quick]

Writes <out>/mortarpit.glb (PitMortar_Intact … , PitM81_… + _Far) — then tools/optimizeGlb.mjs.
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
import milprops

# (in GAME metres / 1.3 — the game scales the piece x1.3: the user's simulated ring (sandbagPit) was laid on a flat crest
# 0.44 up from r ~2.6 to 3.0 in GAME metres; built in real metres the crest landed further out and higher and the bags
# hung over the inner slope, 2026-10-21)
KS = 1.3
R_IN, R_T0, R_T1, R_OUT, H_C = 2.25 / KS, 2.5 / KS, 3.1 / KS, 3.95 / KS, 0.43 / KS
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
        return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.78, 1.15)), 0.9)
    return f
def fibre(nb):
    c = nb.mix(nb.noise(6.0, 3), srgb(0x2e3324), srgb(0x232719))
    return nb.scale(c, nb.mr(nb.island(), 0, 1, 0.85, 1.15))
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update({
    "mpEarth": (1.0, earth(0xb09070)), "mpCrate": (0.85, timber(0x7d7556)), "mpRack": (0.9, timber(0x8f7c62)),
    "mpFibre": (0.8, fibre), "mpCanvas": (0.95, flat(srgb(0x5c5e3e), 0.3)), "mpRope": (0.9, flat(srgb(0x9a8a68), 0.0)),
    "mpRed": (0.6, flat(srgb(0xa32a20), 0.0)), "mpWhite": (0.7, flat(srgb(0xe2ddd0), 0.0)), "mpChar": (0.95, charred),
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
    return tag(K.bevel(K.obj(nm, bm, mat, "h"), 0.01 if not LOW() else 0, 2, 40), t)

def berm(K, R, state):
    na, nr = (72, 12) if not LOW() else (36, 6)
    off = Vector((R.uniform(0, 50), R.uniform(0, 50), 0))
    bm = bmesh.new(); grid = []
    for j in range(nr + 1):
        r = R_IN + (R_OUT - R_IN) * j / nr
        row = []
        for i in range(na):
            a = -2 * math.pi * i / na
            x, z = math.cos(a) * r, math.sin(a) * r
            # +z: the way in, lower — only in the ring's gap (the bags stand everywhere else)
            back = max(0.0, (math.sin(a) - 0.82) / 0.18) ** 1.5
            if r < R_T0: crest = math.sin((r - R_IN) / (R_T0 - R_IN) * math.pi / 2)
            elif r <= R_T1: crest = 1.0                                          # the flat crest the bags lie on
            else: crest = math.cos((r - R_T1) / (R_OUT - R_T1) * math.pi / 2) ** 1.4
            y = -0.12 + (H_C + 0.12) * crest * (1 - 0.6 * back)
            if j in (0, nr): y = -0.12
            y += mnoise.noise(Vector((x * 0.9, z * 0.9, 0)) + off) * (0.012 if R_T0 <= r <= R_T1 else 0.05) * crest
            if state == "damaged":
                d = math.hypot(x + 1.8, z + 2.0); y -= max(0.0, 0.4 * (1 - d / 1.3)) * crest
            if state == "ruin": y *= 0.65
            row.append(bm.verts.new(B(x, y, z)))
        grid.append(row)
    for j in range(nr):
        for i in range(na):
            bm.faces.new((grid[j][i], grid[j][(i + 1) % na], grid[j + 1][(i + 1) % na], grid[j + 1][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    tag(K.obj("Berm", bm, "mpEarth", "h", smooth=True), 0.0)
    for k in range(22 if not LOW() else 8):   # clods on the outer slope
        a = R.uniform(0, 6.283); r = R.uniform(R_T1 + 0.08, R_OUT - 0.08)
        s = R.uniform(0.06, 0.14)
        y = -0.12 + (H_C + 0.12) * math.cos((r - R_T1) / (R_OUT - R_T1) * math.pi / 2) ** 1.4
        tag(K.lump(f"Clod{k}", (math.cos(-a) * r, y, math.sin(-a) * r), (s * 1.3, s * 0.55, s), "mpEarth", "h", seed=k + 21, rough=0.4, sub=1), 0.02)
    if state == "ruin":
        tag(K.lump("Crater", (0.1, -0.04, 0.2), (1.5, 0.05, 1.4), "mpChar", "h", seed=8, rough=0.3, sub=2), 0.0)

def crate(K, nm, at, yaw, size, t, mat="mpCrate", tilt=0.0, lid=True):
    """An ammunition crate standing on its foot at `at`: planked, end battens and rope handles; lid off: its tubes."""
    x, y, z = size
    c, s = math.cos(yaw), math.sin(yaw)
    L = lambda lx, ly, lz: (at[0] + lx * c + lz * s, at[1] + ly, at[2] - lx * s + lz * c)
    if lid:
        o = K.box(nm, -x / 2, x / 2, 0, y, -z / 2, z / 2, mat, "h", 0.01)
        o.rotation_mode = "XYZ"; o.rotation_euler = (tilt, 0, yaw); o.location = B(*at); tag(o, t)
    else:   # open: floor and four walls, three tubes inside
        th = 0.02
        for nmx, (cx, cz, sx, sz) in {"F": (0, 0, x / 2, z / 2)}.items():
            beam(K, nm + "F", L(-x / 2, th / 2, 0), L(x / 2, th / 2, 0), z, th, mat, t)
        for sx in (-1, 1):
            beam(K, f"{nm}Wx{sx}", L(sx * (x / 2 - th / 2), 0, -z / 2), L(sx * (x / 2 - th / 2), 0, z / 2), th, y * 2, mat, t)
            beam(K, f"{nm}Wz{sx}", L(-x / 2, y / 2, sx * (z / 2 - th / 2)), L(x / 2, y / 2, sx * (z / 2 - th / 2)), y, th, mat, t)
        for k in range(3):
            a, b = L(-x / 2 + 0.06, 0.07, (k - 1) * 0.12), L(x / 2 - 0.06, 0.07, (k - 1) * 0.12)
            tag(K.rod(f"{nm}Tube{k}", a, b, 0.05, "mpFibre", "h", n=8 if not LOW() else 5), t)
    if LOW() or mat == "mpChar": return
    for sx in (-1, 1):
        b = K.box(nm + f"Bat{sx}", -0.025, 0.025, 0.02, y - 0.02, -z / 2 - 0.012, z / 2 + 0.012, mat, "h", 0.004)
        b.rotation_mode = "XYZ"; b.rotation_euler = (tilt, 0, yaw)
        ox = sx * (x / 2 - 0.06)
        b.location = B(*at) + Vector((ox * math.cos(yaw), ox * math.sin(yaw), 0)); tag(b, t)
        r0 = L(sx * (x / 2 + 0.015), y * 0.62, -0.06); r1 = L(sx * (x / 2 + 0.015), y * 0.62, 0.06)
        tag(K.rod(f"{nm}Rope{sx}", r0, r1, 0.009, "mpRope", "h", n=4), t)

def stores(K, R, state):
    if state == "ruin":
        for k in range(5):
            beam(K, f"Burnt{k}", (R.uniform(-1.6, 1.4), 0.04, R.uniform(0.6, 1.8)), (R.uniform(-1.6, 1.4), 0.06, R.uniform(0.6, 1.8)), 0.3, 0.12, "mpChar", 0.6)
        return
    thrown = state == "damaged"
    # the crates at the back-left: two side by side, one on them, one open beside
    spots = [(-0.95, 0.75, 0.1), (-0.95, 1.27, -0.05), (-0.15, 1.3, 0.35)]   # (inside the floor: r < 1.6)
    for k, (x, z, yw) in enumerate(spots):
        if thrown: x, z, yw = x + R.uniform(-0.5, 0.7), z + R.uniform(-0.9, 0.2), yw + R.uniform(-1.2, 1.2)
        crate(K, f"Crate{k}", (x, 0.0, z), yw, (0.9, 0.34, 0.5), 0.55 + 0.03 * k, tilt=R.uniform(-0.2, 0.2) if thrown else 0, lid=k != 2)
    if not thrown:
        crate(K, "CrateTop", (-0.95, 0.34, 1.0), 0.2, (0.9, 0.34, 0.5), 0.62)
    # the rack of tubes at the back-right: two bearers, the tubes stacked three-two-one
    rx, rz = 0.75, 1.0
    if not thrown:
        for sx in (-0.32, 0.32):
            beam(K, f"Rack{sx}", (rx + sx, 0.04, rz - 0.3), (rx + sx, 0.04, rz + 0.3), 0.08, 0.08, "mpRack", 0.6)
        for row in range(3):
            for i in range(3 - row):
                x = rx - 0.13 * (2 - row) / 2 + i * 0.13 + 0.0
                y = 0.13 + row * 0.11
                tag(K.rod(f"Tube{row}{i}", (rx - 0.4, y, rz - 0.13 * (2 - row) / 2 + i * 0.13), (rx + 0.4, y, rz - 0.13 * (2 - row) / 2 + i * 0.13), 0.055, "mpFibre", "h", n=10 if not LOW() else 6), 0.66)
    else:
        for k in range(5):
            x, z, a = rx + R.uniform(-0.8, 0.6), rz + R.uniform(-1.0, 0.5), R.uniform(0, 3.14)
            tag(K.rod(f"Tube{k}", (x, 0.055, z), (x + math.cos(a) * 0.8, 0.055, z + math.sin(a) * 0.8), 0.055, "mpFibre", "h", n=8), 0.66)
    # three bombs ready on a canvas, by the tube's right
    if state == "intact":
        tag(K.box("Canvas", 0.35, 1.05, 0.005, 0.015, 0.05, 0.5, "mpCanvas", "h", 0), 0.7)
        F = milprops.Frame((0, 0, 0), 0.0)
        for k in range(3):
            milprops.bomb81(K, f"Bomb{k}", F, (0.45, 0.06, 0.12 + k * 0.17), (1, 0, 0.05 * (k - 1)), 0.8)

def stakes(K, R, state):
    """The two aiming stakes out front: red and white, 1.8 m."""
    for k, (x, z) in enumerate(((0.4, -4.75), (0.35, -5.35))):
        down = state != "intact" and k == 0
        for b in range(4):
            if down:
                a, c = (x + b * 0.45, 0.04, z), (x + (b + 1) * 0.45, 0.04, z + 0.05)
            else:
                a, c = (x, -0.1 + b * 0.45, z), (x, -0.1 + (b + 1) * 0.45, z)
            tag(K.rod(f"Stake{k}{b}", a, c, 0.028, "mpRed" if b % 2 else "mpWhite", "h", n=6), 0.7)

def buildPit(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    berm(K, random.Random(seed), state)
    stores(K, random.Random(seed + 1), state)
    if state != "ruin": stakes(K, random.Random(seed + 2), state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

def buildGun(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    milprops.mortar81(K, "M", 0.95)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farPit = lambda K, n, s, st, sd: buildPit(K, n, s, st, sd, far=True)
farGun = lambda K, n, s, st, sd: buildGun(K, n, s, st, sd, far=True)
TYPES = {
    "mortar": dict(builder=buildPit, farBuilder=farPit, atlas=2048, normalAtlas=1024, aoDist=0.5, smoothAngle=40, weighted=False, normals=True),
    "m81": dict(builder=buildGun, farBuilder=farGun, atlas=1024, aoDist=0.1, smoothAngle=40, weighted=False),   # (not "gun": the MG nest's kit has one — one table of parts)
}
exported = buildKit(TYPES, MATDEF, "mortarpit.glb", prefix="Pit", seed0=1963, colors=True)

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
    f_ = 0.35 if "Gun" in o.name else 1.0
    cd.lens = 35; cam.location = B(-4 * f_, 6 * f_, -7 * f_); cam.rotation_euler = (B(0, 0.4 * f_, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
