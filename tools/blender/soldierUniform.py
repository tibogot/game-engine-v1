"""THE APPELÉ'S UNIFORM (2026-10-15, stage 2 of the realistic soldier — stage 1 tools/blender/soldierBody.py).
Run headless on the body stage 1 saved:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      assets-src/soldiers/appele2/body.blend --python tools/blender/soldierUniform.py -- assets-src/soldiers/appele2

The French conscript in Algeria, from the reference photos (assets-src/refs/appele/: the Algerian-war
collage, the M51 helmet):
  M47 FATIGUES   olive-green, sun-faded: the jacket to the upper thigh, sleeves ROLLED to mid-forearm, two
                 chest pockets with flaps and two big skirt pockets; the trousers with the left-thigh cargo
                 pocket, BLOUSED over the boots
  RANGERS        black-brown leather boots (the 1950s "brodequins à jambières" and their successor)
  M51 HELMET     the US-pattern steel pot, olive, a slight flare to the brim
  M50 WEBBING    khaki belt, two ammunition pouches in front, the suspenders over the shoulders, the canteen
                 on the right hip behind
Built on the body itself (every garment a shell of the skin it covers, pushed out by its thickness — so it
fits him exactly and moves with his own weights), the covered skin deleted (no z-fighting, fewer
triangles), folds by a fine displacement, then DECIMATED to the RTS budget, UV-unwrapped, and its colour
and ambient occlusion BAKED into one texture (the crowd renderer reads no normal map: the shading is in the
colour). Writes <out>/appele.glb (skinned, the rig, the texture) and preview renders.
"""
import bpy, bmesh, sys, os, math, json, random
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
TARGET_TRIS = 7000   # (the hands kept fine: +500)
TEX = 1024
random.seed(1958)

body = bpy.data.objects["Body"]
rig = bpy.data.objects["Rig"]
for o in list(bpy.data.objects):
    if o.type == "CAMERA":
        bpy.data.objects.remove(o, do_unlink=True)

# ── Regions of the skin, by the bone that moves each vertex most ─────────────
# (ONLY the bones' groups: MPFB also keeps "Left" / "Right" / "Mid" halves, every vertex at 1.0 — read as
# bones they made the whole man "torso", the jacket over his head and hands)
groups = {g.index: g.name.split(":")[-1] for g in body.vertex_groups if g.name.startswith("mixamorig:")}
def dominant(v):
    best, bw = None, 0
    for e in v.groups:
        n = groups.get(e.group)
        if n and e.weight > bw:
            best, bw = n, e.weight
    return best or ""
me = body.data
dom = [dominant(v) for v in me.vertices]
Z = [ (body.matrix_world @ v.co).z for v in me.vertices ]
H = max(Z)

def part(n):
    if n.startswith(("Head", "Neck")): return "head"
    if "Hand" in n: return "hand"
    if "ForeArm" in n: return "forearm"
    if n.endswith(("Arm", "Shoulder")): return "upperarm"
    if n.startswith(("Spine", "Hips")): return "torso"
    if n.endswith("UpLeg"): return "thigh"
    if n.endswith("Leg"): return "shin"
    if n.endswith(("Foot", "ToeBase")): return "foot"
    return "torso"
P = [part(n) for n in dom]

# Landmarks (metres; the body stands at the origin facing -Y, +Z up).
def bone_head(n): return rig.matrix_world @ rig.data.bones["mixamorig:" + n].head_local
hips_z = bone_head("Hips").z
knee_z = bone_head("LeftLeg").z
ankle_z = bone_head("LeftFoot").z
neck_z = bone_head("Neck").z
elbow = {s: bone_head(s + "ForeArm") for s in ("Left", "Right")}
wrist = {s: bone_head(s + "Hand") for s in ("Left", "Right")}
BOOT_TOP = ankle_z + (knee_z - ankle_z) * 0.42           # rangers: a third up the shin
HEM_Z = hips_z - 0.17                                     # the jacket skirt: mid upper-thigh
WAIST_Z = hips_z + 0.06                                   # the belt
print("LANDMARKS", {k: round(v, 3) for k, v in dict(hips=hips_z, knee=knee_z, ankle=ankle_z, neck=neck_z, boot=BOOT_TOP, hem=HEM_Z, waist=WAIST_Z).items()})

def along_forearm(i, side):
    """0 at the elbow, 1 at the wrist (a forearm vertex)."""
    p = body.matrix_world @ me.vertices[i].co
    a, b = elbow[side], wrist[side]
    return max(0.0, min(1.0, (p - a).dot(b - a) / (b - a).length_squared))
def side_of(i): return "Left" if (body.matrix_world @ me.vertices[i].co).x > 0 else "Right"

# What each vertex is covered by (one garment; the outermost wins).
SLEEVE_END = 0.38    # rolled to just below the elbow
cover = []
for i, p in enumerate(P):
    z = Z[i]
    if p == "head" or p == "hand":
        cover.append(None)
    elif p == "forearm":
        cover.append("jacket" if along_forearm(i, side_of(i)) < SLEEVE_END else None)
    elif p in ("upperarm", "torso"):
        cover.append("jacket" if z > HEM_Z else "trousers")
    elif p == "thigh":
        cover.append("jacket" if z > HEM_Z and z > hips_z - 0.25 else "trousers")
    elif p == "shin":
        cover.append("boots" if z < BOOT_TOP else "trousers")
    else:
        cover.append("boots")
# The neck under the collar: the lower neck is jacket.
for i, p in enumerate(P):
    if p == "head" and Z[i] < neck_z + 0.02 and dom[i].startswith("Neck"):
        cover[i] = "jacket"

# The WHOLE body, kept as it is, for the skin weights the garments take (the body itself is trimmed below).
WEIGHT_BODY = body.copy()
WEIGHT_BODY.data = body.data.copy()
WEIGHT_BODY.name = "WeightBody"
bpy.context.scene.collection.objects.link(WEIGHT_BODY)
WEIGHT_BODY.modifiers.clear()
# ...and the TRUNK alone (no arms, no hands): for everything that is not a sleeve. In his rest (MPFB's
# A-pose) the hands hang by the jacket skirt — the skirt took the forearm's weights from the nearest skin,
# and a sheet of it rose with his arm when he aimed (2026-10-15).
WEIGHT_TRUNK = body.copy()
WEIGHT_TRUNK.data = body.data.copy()
WEIGHT_TRUNK.name = "WeightTrunk"
bpy.context.scene.collection.objects.link(WEIGHT_TRUNK)
WEIGHT_TRUNK.modifiers.clear()
_bm = bmesh.new(); _bm.from_mesh(WEIGHT_TRUNK.data); _bm.verts.ensure_lookup_table()
bmesh.ops.delete(_bm, geom=[v for v in _bm.verts if P[v.index] in ("upperarm", "forearm", "hand")], context="VERTS")
_bm.to_mesh(WEIGHT_TRUNK.data); _bm.free()

# ── Garments: shells of the skin they cover ─────────────────────────────────
THICK = {"jacket": 0.022, "trousers": 0.014, "boots": 0.018}
def shell(name, keep, offset, extra=None):
    """A copy of the body's faces whose vertices are all `keep`, pushed out along the normals."""
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    gone = [f for f in bm.faces if not all(keep(v.index) for v in f.verts)]
    bmesh.ops.delete(bm, geom=gone, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.normal_update()
    for v in bm.verts:
        d = offset + (extra(v) if extra else 0.0)
        v.co += v.normal * d
    m = bpy.data.meshes.new(name)
    bm.to_mesh(m)
    bm.free()
    o = bpy.data.objects.new(name, m)
    bpy.context.scene.collection.objects.link(o)
    o.matrix_world = body.matrix_world.copy()
    return o

def blouse(v):
    """Trousers bagging over the boot tops; the seat and knees a little loose."""
    z = (body.matrix_world @ v.co).z
    b = max(0.0, 1 - abs(z - (BOOT_TOP + 0.035)) / 0.06) * 0.022
    return b + max(0.0, 1 - abs(z - knee_z) / 0.08) * 0.004
def jacket_extra(v):
    """The M47 is cut loose: fuller at the chest and skirt, the skirt flaring a little."""
    z = (body.matrix_world @ v.co).z
    skirt = max(0.0, min(1.0, (hips_z + 0.02 - z) / 0.2)) * 0.02
    return skirt + 0.004
def boot_extra(v):
    z = (body.matrix_world @ v.co).z
    return 0.004 if z < ankle_z - 0.04 else 0.0

# (the jacket's own shell stops at the HIPS; its skirt is a separate hanging tube — a shell of the thighs
# made the M47 read as shorts)
SKIRT_TOP = hips_z + 0.03
jacket = shell("Jacket", lambda i: cover[i] == "jacket" and (Z[i] > SKIRT_TOP - 0.03 or P[i] in ("upperarm", "forearm")), THICK["jacket"], jacket_extra)
# (the seams OVERLAP: a face on the line between two garments belonged to neither — a band of bare leg
# between the trousers and the boots. The trousers run 4 cm down into the boot, the boots 5 cm up under
# the blousing; the outer one is the thicker, so they never z-fight.)
trousers = shell("Trousers", lambda i: P[i] in ("thigh", "shin", "torso") and Z[i] < hips_z + 0.12 and Z[i] > BOOT_TOP - 0.04, THICK["trousers"], blouse)
boots = shell("Boots", lambda i: P[i] in ("foot", "shin") and Z[i] < BOOT_TOP + 0.05, THICK["boots"], boot_extra)

# The skin that shows: head, hands, the bare forearms. (The rest is under cloth.)
bm = bmesh.new()
bm.from_mesh(me)
# (the ARMS and the NECK keep their skin under the cloth: a sleeve and the collar are OPEN — with the skin
# gone you looked into them and through the man, 2026-10-15. Torso, hips and legs are closed in.)
SKIN_KEPT = ("upperarm", "forearm", "hand", "head")
bmesh.ops.delete(bm, geom=[f for f in bm.faces if all(cover[v.index] is not None and P[v.index] not in SKIN_KEPT for v in f.verts)], context="FACES")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
# THE FACE CLOSED (2026-10-15: MPFB's skin is OPEN at the eyes, nostrils, mouth and ear canals — its eyes
# and teeth are separate meshes we do not use: you saw through his face). Every open loop on the HEAD is
# capped; the cut edges at the torso and thighs (under the cloth) are left as they are.
head_z = neck_z + 0.02
loops = [e for e in bm.edges if e.is_boundary and min(v.co.z for v in e.verts) > head_z]
if loops:
    r = bmesh.ops.holes_fill(bm, edges=loops, sides=0)
    print("FACE holes capped:", len(r["faces"]))
bm.to_mesh(me)
bm.free()

# RANGERS, BUILT (2026-10-15, you: "the boots look wrong" — and a long spike from his foot to his wrist):
# the foot's own skin, smoothed to lose the toes, stayed lumpy with chopped toes, and the smoothing threw
# one vertex 1.3 m out. Each boot is now LOFTED: rings round the shin from the boot top down to the ankle,
# then along the foot from the heel to the toe — each ring the skin's outline there (its extent across and
# up/down), plus the leather; a flat sole at the ground, the toe one rounded cap; closed (top and toe
# capped). Nothing taken from the toes' shape.
bpy.data.objects.remove(boots, do_unlink=True)
skin_pts = [(WEIGHT_BODY.matrix_world @ v.co, P[v.index]) for v in WEIGHT_BODY.data.vertices]
def boot(side):
    sx = 1 if side == "Left" else -1
    ank = bone_head(side + "Foot"); toe_j = bone_head(side + "ToeBase"); knee = bone_head(side + "Leg")
    foot = [p for p, part in skin_pts if part == "foot" and p.x * sx > 0]
    shin = [p for p, part in skin_pts if part == "shin" and p.x * sx > 0]
    fwd = Vector((toe_j.x - ank.x, toe_j.y - ank.y, 0)).normalized()
    rgt = fwd.cross(Vector((0, 0, 1))).normalized()
    along = [(p - ank).dot(fwd) for p in foot]
    heel, tip = min(along), max(along)
    T = 0.016                        # the leather
    N = 16                           # points round a ring
    rings = []
    # the SHAFT: rings round the shin axis (knee → ankle), boot top to just above the ankle
    for z in [BOOT_TOP + 0.05, BOOT_TOP - 0.03, ankle_z + 0.12, ankle_z + 0.07]:
        u = (knee.z - z) / max(1e-6, knee.z - ank.z)
        c = knee.lerp(ank, u); c.z = z
        sl = [p for p in shin + foot if abs(p.z - z) < 0.02] or shin
        ex = max(abs((p - c).dot(rgt)) for p in sl) + T
        ey = max(abs((p - c).dot(fwd)) for p in sl) + T
        rings.append([c + rgt * math.cos(t) * ex + fwd * math.sin(t) * ey for t in (k / N * math.pi * 2 for k in range(N))])
    # the FOOT: sections along it, heel to toe — width from the skin there, height falling to the toe cap
    S = 7
    for j in range(S):
        u = j / (S - 1)
        d = heel - 0.01 + (tip + 0.012 - (heel - 0.01)) * u
        sl = [p for p in foot if abs((p - ank).dot(fwd) - d) < (tip - heel) / S]
        if not sl: continue
        w = max(abs((p - ank).dot(rgt)) for p in sl) + T
        top = max(p.z for p in sl) + T
        top = max(top, 0.05 if u > 0.7 else top)
        c = ank + fwd * d; cz_mid = (top + 0.0) / 2
        taper = 1.0 if u < 0.75 else 1.0 - (u - 0.75) / 0.25 * 0.45     # the rounded toe
        ring = []
        for k in range(N):
            t = k / N * math.pi * 2
            x, zz = math.cos(t), math.sin(t)
            z = cz_mid + zz * (top / 2) * (taper if zz > 0 else 1.0)
            z = max(z, -0.006)                                            # the flat sole
            ring.append(Vector((c.x, c.y, 0)) + rgt * x * w * taper + Vector((0, 0, z)))
        rings.append(ring)
    bm = bmesh.new()
    V = [[bm.verts.new(p) for p in r] for r in rings]
    for r in range(len(V) - 1):
        for k in range(N):
            k2 = (k + 1) % N
            bm.faces.new((V[r][k], V[r][k2], V[r + 1][k2], V[r + 1][k]))
    bm.faces.new(V[0][::-1]); bm.faces.new(V[-1])                         # top and toe closed
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    m = bpy.data.meshes.new("Boot" + side); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new("Boot" + side, m); bpy.context.scene.collection.objects.link(o)
    sub = o.modifiers.new("S", "SUBSURF"); sub.levels = 1
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=sub.name)
    for v in o.data.vertices:
        if v.co.z < 0.004: v.co.z = -0.006                                # (the sole flat after smoothing)
    return o
bl, br = boot("Left"), boot("Right")
bpy.ops.object.select_all(action="DESELECT")
bl.select_set(True); br.select_set(True); bpy.context.view_layer.objects.active = bl
bpy.ops.object.join()
boots = bl; boots.name = "Boots"
print("BOOTS lofted:", len(boots.data.polygons), "faces")

# ── Rigid kit: helmet, belt, pouches, suspenders, canteen ────────────────────
def new_obj(name, bm):
    m = bpy.data.meshes.new(name)
    bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m)
    bpy.context.scene.collection.objects.link(o)
    return o

# The surface the kit sits on (the jacket), for rays.
def bvh_of(o):
    dg = bpy.context.evaluated_depsgraph_get()
    e = o.evaluated_get(dg)
    m = e.to_mesh()
    bm = bmesh.new(); bm.from_mesh(m); bm.transform(o.matrix_world)
    t = BVHTree.FromBMesh(bm)
    bm.free(); e.to_mesh_clear()
    return t
jb = bvh_of(jacket)

# M51 HELMET on the head: the scalp's extent.
head_pts = [body.matrix_world @ v.co for v in body.data.vertices]
head_pts = [p for p in head_pts if p.z > neck_z + 0.05]
hx = [p.x for p in head_pts]; hy = [p.y for p in head_pts]; hz = [p.z for p in head_pts]
hc = Vector(((min(hx) + max(hx)) / 2, (min(hy) + max(hy)) / 2, max(hz)))
hw, hd = (max(hx) - min(hx)), (max(hy) - min(hy))
bm = bmesh.new()
rings, segs = 7, 20
crown = hc.z + 0.03
rim_z = max(hz) - 0.115
rx, ry = hw / 2 + 0.035, hd / 2 + 0.035
verts = []
for r in range(rings + 1):
    a = (r / rings) * (math.pi / 2)            # 0 at the crown, 90° at the rim
    row = []
    for k in range(segs):
        t = k / segs * math.pi * 2
        s = math.sin(a)
        z = crown - (crown - rim_z) * (1 - math.cos(a)) ** 0.85
        row.append(bm.verts.new((hc.x + math.cos(t) * rx * s, hc.y + math.sin(t) * ry * s, z)))
    verts.append(row)
# the brim: out and a little down, the M1/M51's flare
brim = [bm.verts.new((hc.x + math.cos(k / segs * math.pi * 2) * (rx + 0.02), hc.y + math.sin(k / segs * math.pi * 2) * (ry + 0.022), rim_z - 0.012)) for k in range(segs)]
under = [bm.verts.new((hc.x + math.cos(k / segs * math.pi * 2) * (rx - 0.004), hc.y + math.sin(k / segs * math.pi * 2) * (ry - 0.004), rim_z - 0.004)) for k in range(segs)]
for r in range(rings):
    for k in range(segs):
        k2 = (k + 1) % segs
        if r == 0:
            continue
        bm.faces.new((verts[r][k], verts[r][k2], verts[r + 1][k2], verts[r + 1][k]))
top = bm.verts.new((hc.x, hc.y, crown))
for k in range(segs):
    bm.faces.new((top, verts[1][k], verts[1][(k + 1) % segs])) if False else bm.faces.new((top, verts[1][(k + 1) % segs], verts[1][k]))
for k in range(segs):
    k2 = (k + 1) % segs
    bm.faces.new((verts[rings][k], verts[rings][k2], brim[k2], brim[k]))
    bm.faces.new((brim[k], brim[k2], under[k2], under[k]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
helmet = new_obj("Helmet", bm)

# THE BELT: a band round the jacket at the waist, rays from the body's axis outward.
def band(name, z, half_h, out_by, n=28, center=None):
    c = center or Vector((0, 0, z))
    bm = bmesh.new()
    loops = []
    for zz in (z - half_h, z + half_h):
        row = []
        for k in range(n):
            t = k / n * math.pi * 2
            d = Vector((math.cos(t), math.sin(t), 0))
            o = Vector((c.x, c.y, zz)) + d * 0.4
            hit = jb.ray_cast(o, -d, 0.5)
            p = (hit[0] + hit[1] * out_by) if hit[0] else Vector((c.x, c.y, zz)) + d * 0.17
            row.append(bm.verts.new(p))
        loops.append(row)
    for k in range(n):
        k2 = (k + 1) % n
        bm.faces.new((loops[0][k], loops[0][k2], loops[1][k2], loops[1][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm)
belt = band("Belt", WAIST_Z, 0.024, 0.008)

# THE SKIRT: rings from the hips down to the hem, each the body's OUTLINE there (rays from outside onto the
# trousers and jacket, the gap between the legs bridged by smoothing the ring), out by the cloth, a little
# flare toward the hem. It hangs over both thighs as the M47 does.
def skirt(n=36, rows=5):
    tb2 = bvh_of(trousers)
    bm = bmesh.new()
    loops = []
    for r in range(rows + 1):
        u = r / rows
        z = SKIRT_TOP - (SKIRT_TOP - HEM_Z) * u
        rad = []
        for k in range(n):
            t = k / n * math.pi * 2
            d = Vector((math.cos(t), math.sin(t), 0))
            o = Vector((0, 0, z)) + d * 0.6
            best = None
            for b in (jb, tb2):
                hit = b.ray_cast(o, -d, 0.6)
                if hit[0] is not None:
                    rr = Vector((hit[0].x, hit[0].y, 0)).length
                    best = rr if best is None else max(best, rr)
            rad.append(best)
        known = [x for x in rad if x is not None] or [0.17]
        rad = [x if x is not None else max(known) for x in rad]
        # bridge the hollows (between the legs): a ring's radius never below its neighbours' average less a bit
        for _ in range(6):
            rad = [max(rad[k], 0.5 * (rad[k - 1] + rad[(k + 1) % n]) - 0.003) for k in range(n)]
        flare = 0.022 + 0.016 * u
        row = [bm.verts.new((math.cos(k / n * math.pi * 2) * (rad[k] + flare), math.sin(k / n * math.pi * 2) * (rad[k] + flare), z)) for k in range(n)]
        loops.append(row)
    for r in range(rows):
        for k in range(n):
            k2 = (k + 1) % n
            bm.faces.new((loops[r][k], loops[r][k2], loops[r + 1][k2], loops[r + 1][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj("Skirt", bm)
skirt_o = skirt()
sb = bvh_of(skirt_o)   # (the skirt's pockets, the canteen and the musette sit on it)

def box_on(name, at, size, out_by, facing=None, bvh=jb, ray=None):
    """A box laid on the surface: at = a point outside the body, ray = toward the body."""
    hit = bvh.ray_cast(at, ray, 1.0)
    if not hit[0]:
        print("! no surface for", name); return None
    n = hit[1]
    x = Vector((0, 0, 1)).cross(n).normalized()
    z = n.cross(x).normalized()
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = hit[0] + n * (out_by + size[2] / 2 + v.co.z * size[2]) + x * v.co.x * size[0] + z * v.co.y * size[1]
    return new_obj(name, bm)

front = Vector((0, -1, 0))
pouches = [box_on(f"Pouch{s}", Vector((s * 0.105, -0.5, WAIST_Z + 0.005)), (0.085, 0.07, 0.045), 0.012, ray=-front) for s in (-1, 1)]
canteen = box_on("Canteen", Vector((0.5, 0.06, WAIST_Z - 0.08)), (0.07, 0.15, 0.06), 0.004, bvh=sb, ray=Vector((-1, 0, 0)))
musette = box_on("Musette", Vector((-0.5, 0.0, WAIST_Z - 0.11)), (0.16, 0.13, 0.05), 0.004, bvh=sb, ray=Vector((1, 0, 0)))

# THE SUSPENDERS: from the belt in front, over each shoulder, down to the belt behind — a strip of points
# found on the jacket by rays from outside.
def strap(name, side, w=0.034, out_by=0.006):
    xs = side * 0.085
    sh = bone_head(("Left" if side > 0 else "Right") + "Shoulder")
    path = []
    N = 14
    for k in range(N + 1):
        u = k / N                              # 0 front belt → 0.5 over the shoulder → 1 back belt
        ang = math.pi * u                      # round the shoulder in the y-z plane
        y = -math.cos(ang) * 0.25
        z = WAIST_Z + 0.02 + math.sin(ang) * (sh.z + 0.06 - WAIST_Z)
        x = xs + side * math.sin(ang) * 0.06
        o = Vector((x, y * 2.2, z + (0.25 if 0.3 < u < 0.7 else 0)))
        tgt = Vector((x * 0.6, 0, z - (0.05 if 0.3 < u < 0.7 else 0)))
        d = (tgt - o).normalized()
        hit = jb.ray_cast(o, d, 2.0)
        if hit[0]:
            path.append((hit[0], hit[1]))
    bm = bmesh.new()
    prev = None
    for i, (p, n) in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)][0] - path[max(i - 1, 0)][0]).normalized()
        sdir = t.cross(n).normalized()
        a = bm.verts.new(p + n * out_by + sdir * w / 2)
        b = bm.verts.new(p + n * out_by - sdir * w / 2)
        if prev:
            f = bm.faces.new((prev[0], prev[1], b, a))
            f.normal_update()
            if f.normal.dot(n) < 0:      # (facing the body: drawn dark from outside)
                f.normal_flip()
        prev = (a, b)
    return new_obj(name, bm)
straps = [strap("StrapL", 1), strap("StrapR", -1)]

# M47 POCKETS: patches on the jacket — two chest pockets with flaps, two skirt pockets; the cargo pocket
# on the left thigh of the trousers.
def patch(name, center, w, h, out_by, bvh, ray, nx=4, ny=4):
    up = Vector((0, 0, 1))
    side = ray.cross(up).normalized()
    bm = bmesh.new()
    grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            o = center + side * ((i / nx - 0.5) * w) + up * ((j / ny - 0.5) * h) - ray * 0.4
            hit = bvh.ray_cast(o, ray, 1.0)
            if not hit[0]:
                return None
            row.append(bm.verts.new(hit[0] + hit[1] * out_by))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return new_obj(name, bm)
chest_z = bone_head("Spine2").z + 0.02
pockets = []
for s in (-1, 1):
    pockets.append(patch(f"ChestPocket{s}", Vector((s * 0.095, 0, chest_z)), 0.11, 0.12, 0.006, jb, -front))
    pockets.append(patch(f"ChestFlap{s}", Vector((s * 0.095, 0, chest_z + 0.07)), 0.12, 0.04, 0.011, jb, -front, 4, 1))
    pockets.append(patch(f"SkirtPocket{s}", Vector((s * 0.11, 0, hips_z - 0.08)), 0.14, 0.13, 0.006, sb, -front))
    pockets.append(patch(f"SkirtFlap{s}", Vector((s * 0.11, 0, hips_z - 0.01)), 0.15, 0.04, 0.011, sb, -front, 4, 1))
tb = bvh_of(trousers)
pockets.append(patch("CargoPocket", Vector((0, 0.02, hips_z - 0.27)), 0.15, 0.17, 0.006, tb, Vector((-1, 0, 0))))
pockets = [p for p in pockets if p]

# The rolled sleeve cuffs: a fat ring where each sleeve ends.
cuffs = []
for s in ("Left", "Right"):
    a, b = elbow[s], wrist[s]
    c = a.lerp(b, SLEEVE_END)
    axis = (b - a).normalized()
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=12, radius1=0.052, radius2=0.05, depth=0.045)
    rot = axis.to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(c) @ rot, verts=bm.verts)
    cuffs.append(new_obj("Cuff" + s, bm))

# ── Folds: a fine displacement on the cloth ──────────────────────────────────
tex = bpy.data.textures.new("Folds", "CLOUDS")
tex.noise_scale = 0.06
for o, k in ((jacket, 0.006), (trousers, 0.007)):
    # (no subdivision first: ×4 the cloth's triangles, decimated back down into spiky shards)
    d = o.modifiers.new("Folds", "DISPLACE"); d.texture = tex; d.strength = k; d.mid_level = 0.5
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)

# ── Colours (materials, baked into one texture below) ────────────────────────
def mat(name, rgb, rough=0.85):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = rough
    return m
def srgb(h): return tuple(((h >> s & 255) / 255) ** 2.2 for s in (16, 8, 0))
M = {
    "skin": mat("Skin", srgb(0xb88a6c)),
    "olive": mat("Olive", srgb(0x6f6d4b)),              # M47, faded (soldierLooks appelé green)
    "olive_dark": mat("OliveDark", srgb(0x5d5b3e)),     # flaps, seams
    "trousers": mat("Trousers", srgb(0x67653f)),
    "helmet": mat("Helmet", srgb(0x55563d), 0.6),
    "web": mat("Web", srgb(0x9a8a5e)),                  # M50 webbing, khaki
    "leather": mat("Leather", srgb(0x2b2119), 0.5),
    "canteen": mat("Canteen", srgb(0x4c4b38)),
}
assign = {body: "skin", jacket: "olive", skirt_o: "olive", trousers: "trousers", boots: "leather", helmet: "helmet", belt: "web",
          canteen: "canteen", musette: "web"}
for o in pouches + straps: assign[o] = "web"
for o in pockets: assign[o] = "olive_dark" if "Flap" in o.name else "olive"
# (the separate cuff rings are OFF: edge-on they drew a black arc by his head when he aimed; the sleeve's
# own end reads as rolled)
for o in cuffs: bpy.data.objects.remove(o, do_unlink=True)
cuffs = []
for o, k in assign.items():
    if o is None: continue
    o.data.materials.clear()
    o.data.materials.append(M[k])
# His EYES (the MPFB eye helpers, kept by the body stage): a dark iris-and-white mix, read as eyes at any
# distance (skin-coloured, the sockets read as closed lids or holes).
eyeg = [g.index for g in body.vertex_groups if g.name in ("helper-l-eye", "helper-r-eye")]
if eyeg:
    body.data.materials.append(mat("Eye", srgb(0x4a4038), 0.3))
    ei = len(body.data.materials) - 1
    eyev = {v.index for v in body.data.vertices if any(e.group in eyeg and e.weight > 0.5 for e in v.groups)}
    for f in body.data.polygons:
        if all(i in eyev for i in f.vertices): f.material_index = ei

# ── One mesh: weights, decimation ─────────────────────────────────────────────
kit = [o for o in assign if o is not None and o is not body]
# THE HANDS KEPT FINE (2026-10-15: decimated with the rest, the fingers came out faceted shards): a
# "Keep" group on the skin — 1 on the hands and fingers, 0.6 on the face — the decimation spares it.
keep = body.vertex_groups.new(name="Keep")
gi = {g.index: g.name for g in body.vertex_groups}
for v in body.data.vertices:
    w = 0.0
    for e in v.groups:
        n = gi.get(e.group, "")
        if e.weight > 0.3 and "Hand" in n: w = max(w, 1.0)
    if w > 0: keep.add([v.index], w, "REPLACE")
# Each garment and piece takes its skin weights from the body (nearest surface, interpolated); the helmet
# rides the head alone.
for o in kit:
    for g in body.vertex_groups:
        o.vertex_groups.new(name=g.name)
    if o is helmet:
        g = o.vertex_groups["mixamorig:Head"]
        g.add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        continue
    # A rolled CUFF rides its forearm alone (rigid): its inner side lay by his ribs at rest, took the
    # torso's weights, and stretched into a flap when he raised his arm.
    if o.name.startswith("Cuff"):
        o.vertex_groups["mixamorig:" + o.name[4:] + "ForeArm"].add(list(range(len(o.data.vertices))), 1.0, "REPLACE")
        continue
    dt = o.modifiers.new("W", "DATA_TRANSFER")
    # the jacket (its sleeves) and the cuffs from the whole skin; everything else from the trunk
    dt.object = WEIGHT_BODY if (o is jacket or o is boots or o.name.startswith("Cuff")) else WEIGHT_TRUNK
    dt.use_vert_data = True
    dt.data_types_verts = {"VGROUP_WEIGHTS"}
    dt.vert_mapping = "POLYINTERP_NEAREST"
    dt.layers_vgroup_select_src = "ALL"
    dt.layers_vgroup_select_dst = "NAME"
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=dt.name)
bpy.data.objects.remove(WEIGHT_BODY, do_unlink=True)
bpy.data.objects.remove(WEIGHT_TRUNK, do_unlink=True)

# THE JACKET'S ARM WEIGHTS ONLY ON ITS SLEEVES: at rest his elbow hangs by the jacket's side at the waist,
# and the side took the forearm's weights — a flap of it rose with his arm when he aimed. A jacket vertex
# keeps an arm bone's weight only within a sleeve's reach of that bone (the segment to its child joint).
from mathutils.geometry import intersect_point_line
def seg_dist(p, a, b):
    q, t = intersect_point_line(p, a, b)
    t = max(0.0, min(1.0, t))
    return (p - a.lerp(b, t)).length
arm_segs = {}
for sd in ("Left", "Right"):
    sh, el, wr, kn = (bone_head(sd + n) for n in ("Arm", "ForeArm", "Hand", "HandMiddle1"))
    arm_segs[f"mixamorig:{sd}Arm"] = (sh, el, 0.10)
    arm_segs[f"mixamorig:{sd}ForeArm"] = (el, wr, 0.085)
    arm_segs[f"mixamorig:{sd}Hand"] = (wr, kn, 0.07)
gidx = {g.name: g.index for g in jacket.vertex_groups}
stripped = 0
for v in jacket.data.vertices:
    p = jacket.matrix_world @ v.co
    drop = [e for e in v.groups if jacket.vertex_groups[e.group].name in arm_segs and e.weight > 0
            and seg_dist(p, *arm_segs[jacket.vertex_groups[e.group].name][:2]) > arm_segs[jacket.vertex_groups[e.group].name][2]]
    if not drop: continue
    for e in drop:
        jacket.vertex_groups[e.group].remove([v.index]); stripped += 1
    tot = sum(e.weight for e in v.groups if jacket.vertex_groups[e.group].name.startswith("mixamorig:"))
    if tot < 1e-4:
        jacket.vertex_groups["mixamorig:Spine2"].add([v.index], 1.0, "REPLACE")
    else:
        for e in v.groups:
            if jacket.vertex_groups[e.group].name.startswith("mixamorig:"): e.weight /= tot
print("JACKET arm weights stripped off its sides:", stripped)

# DECIMATION PER PIECE, each to its own budget (2026-10-15: one budget for the whole man — the hands spared
# — collapsed the cloth, the helmet and the face into shards). The skin keeps its hands (the Keep group);
# the small kit (helmet, pockets, pouches, straps, cuffs) is low already and left alone.
def tris_of(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
# UVs FIRST, PER PIECE, on the full-resolution shapes (2026-10-15: unwrapped after decimation the atlas
# shattered into hundreds of specks — black slivers on the face and hands, white sleeve rims). Each piece
# unwrapped alone; the decimation keeps its UVs; packed together after the join.
for o in [x for x in assign if x is not None]:
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    # (the SKIN in big islands: its face and hands in 70° pieces gave specks the bake missed — dark
    # triangles on his face)
    bpy.ops.uv.smart_project(angle_limit=math.radians(88 if o is body else 70), island_margin=0.02, area_weight=1.0)
    bpy.ops.object.mode_set(mode="OBJECT")
BUDGET = {"Body": 6000, "Jacket": 1500, "Trousers": 900, "Boots": 450}
for o in [body, jacket, trousers, boots]:
    for m in [m for m in o.modifiers if m.type == "ARMATURE"]:
        o.modifiers.remove(m)
    b0 = tris_of(o)
    if b0 <= BUDGET[o.name]: continue
    d = o.modifiers.new("Dec", "DECIMATE")
    d.ratio = BUDGET[o.name] / b0
    d.use_collapse_triangulate = True
    # (no vertex-group protection: Blender's collapse then took the UNprotected part to nothing — the
    # head vanished. One even ratio; the skin's budget is what keeps the fingers whole.)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=d.name)
    print("DEC", o.name, b0, "->", tris_of(o))

# THE SKIN'S FACES OUTWARD again: decimating the face flipped some triangles inside out (the game draws
# only fronts — holes at the eyes, nostrils, mouth, ears). Normals recomputed, consistent, outward.
_bm = bmesh.new(); _bm.from_mesh(body.data)
bmesh.ops.recalc_face_normals(_bm, faces=_bm.faces)
_bm.to_mesh(body.data); _bm.free()

# SEALED (2026-10-15, you: "hollow mesh everywhere"): every garment was a single open sheet — the game
# draws only the outside of a surface, so through a sleeve, the collar, a boot top or under the helmet you
# looked into nothing. Each sheet gets a real thickness with its edges closed (Solidify, rim on): inside a
# sleeve you now see the cloth's inside, never through him. (Pouches, canteen, musette: closed boxes.)
for o in [jacket, skirt_o, trousers, helmet, belt] + straps + pockets:
    if o is None: continue
    so = o.modifiers.new("Seal", "SOLIDIFY")
    so.thickness = 0.008 if o is helmet else 0.005
    so.offset = -1.0 if o in (jacket, skirt_o, trousers, helmet, belt) else 0.0
    so.use_rim = True; so.use_rim_only = False; so.use_even_offset = True
    so.material_offset = 0
    bpy.context.view_layer.objects.active = o
    for m in [m for m in o.modifiers if m.type == "ARMATURE"]: o.modifiers.remove(m)
    bpy.ops.object.modifier_apply(modifier=so.name)

bpy.ops.object.select_all(action="DESELECT")
for o in kit + [body]:
    o.select_set(True)
bpy.context.view_layer.objects.active = body
for o in kit:
    o.parent = None
bpy.ops.object.join()
soldier = body
soldier.name = "Appele"

def tri_count(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
# smooth shading, sharp only at real corners (the pouches' edges): the flat-shaded helmet and pockets read
# as facets
before = tri_count(soldier)
# the armature back on top
for m in list(soldier.modifiers):
    if m.type == "ARMATURE":
        soldier.modifiers.remove(m)
am = soldier.modifiers.new("Armature", "ARMATURE"); am.object = rig
soldier.parent = rig
print("TRIS", before, "->", tri_count(soldier))
bpy.ops.object.select_all(action="DESELECT")
soldier.select_set(True)
bpy.context.view_layer.objects.active = soldier
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(50))

# ── UVs and the bake: colour × ambient occlusion → one texture ──────────────
bpy.ops.object.select_all(action="DESELECT")
soldier.select_set(True)
bpy.context.view_layer.objects.active = soldier
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.pack_islands(rotate=True, margin=0.006)
bpy.ops.object.mode_set(mode="OBJECT")

img = bpy.data.images.new("AppeleColour", TEX, TEX, alpha=False)
for m in soldier.data.materials:
    nt = m.node_tree
    n = nt.nodes.new("ShaderNodeTexImage"); n.image = img; nt.nodes.active = n
scn = bpy.context.scene
scn.render.engine = "CYCLES"
scn.cycles.device = "CPU"
scn.cycles.samples = 48
# The colour first (diffuse colour only), then AO into a second image, multiplied after.
scn.render.bake.use_pass_direct = False
scn.render.bake.use_pass_indirect = False
scn.render.bake.use_pass_color = True
scn.render.bake.margin = 16
bpy.ops.object.bake(type="DIFFUSE")
col = list(img.pixels)
ao_img = bpy.data.images.new("AppeleAO", TEX, TEX, alpha=False)
for m in soldier.data.materials:
    for n in m.node_tree.nodes:
        if n.type == "TEX_IMAGE": n.image = ao_img
scn.world = scn.world or bpy.data.worlds.new("W")
bpy.ops.object.bake(type="AO")
ao = list(ao_img.pixels)
px = [0.0] * len(col)
for i in range(0, len(col), 4):
    a = 0.45 + 0.55 * ao[i]             # (AO softened: the game lights him too)
    px[i], px[i + 1], px[i + 2], px[i + 3] = col[i] * a, col[i + 1] * a, col[i + 2] * a, 1.0
img.pixels = px
img.filepath_raw = os.path.join(out, "appele_colour.png")
img.file_format = "PNG"
img.save()
# One material carries the baked texture (the pack keeps one colour map a soldier).
one = bpy.data.materials.new("Appele")
one.use_nodes = True
bsdf = one.node_tree.nodes["Principled BSDF"]
tn = one.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = img
one.node_tree.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])
soldier.data.materials.clear()
soldier.data.materials.append(one)

# ── Previews (workbench, textured) and the export ─────────────────────────────
scn.render.engine = "BLENDER_WORKBENCH"
scn.display.shading.light = "STUDIO"
scn.display.shading.color_type = "TEXTURE"
scn.display.shading.show_cavity = True
scn.render.resolution_x, scn.render.resolution_y = 700, 900
cd = bpy.data.cameras.new("Cam"); cd.type = "ORTHO"; cd.ortho_scale = 2.0
cam = bpy.data.objects.new("Cam", cd); scn.collection.objects.link(cam); scn.camera = cam
for name, yaw in (("front", 0), ("side", 90), ("threequarter", 35), ("back", 180)):
    a = math.radians(yaw)
    cam.location = Vector((math.sin(a) * 6, -math.cos(a) * 6, 0.92))
    cam.rotation_euler = (math.radians(90), 0, a)
    scn.render.filepath = os.path.join(out, f"uniform_{name}.png")
    bpy.ops.render.render(write_still=True)
# an RTS-like view: high, three-quarter, perspective
cd.type = "PERSP"; cd.lens = 120
cam.location = Vector((6, -9, 9)); cam.rotation_euler = (math.radians(48), 0, math.radians(34))
scn.render.filepath = os.path.join(out, "uniform_rts.png")
bpy.ops.render.render(write_still=True)

bpy.ops.object.select_all(action="DESELECT")
soldier.select_set(True); rig.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "appele.glb"), use_selection=True, export_animations=False,
                          export_skins=True, export_yup=True, export_materials="EXPORT", export_image_format="AUTO")
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "appele.blend"))
print("DONE", tri_count(soldier), "tris")
