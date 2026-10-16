"""THE APPELÉ'S KIT: M51 HELMET AND M50 WEBBING (2026-10-16, step 4 — steps 1-3 clothTrousers.py,
clothBoots.py, clothJacket.py). Run on the jacket's file:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      assets-src/soldiers/appele2/upper.blend --python tools/blender/clothKit.py -- assets-src/soldiers/appele2

  HELMET   the M51 (the US M1 pattern): a deep steel dome a little longer than wide, sides falling almost
           straight, the brim flaring out at the rim with a rolled edge; sized on HIS head (its extent
           above the brow), 4 mm steel; the chinstrap from the rim at each side round the jaw to the chin
  BELT     a webbing band round the jacket at the waist, its buckle in front
  POUCHES  two ammunition pouches either side of the buckle, flapped, soft-cornered (canvas)
  BRACES   the suspenders: from the pouches up the chest, over the shoulders, down the back to the belt
  CANTEEN  in its canvas cover on the right hip, behind
Every piece LAID ON what it rests on (rays onto the jacket/skin), closed (thick), smooth-shaded.
Writes <out>/kit.blend and kit_*.png close-ups.
"""
import bpy, bmesh, sys, os, math
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
body, rig, jacket = bpy.data.objects["Body"], bpy.data.objects["Rig"], bpy.data.objects["Jacket"]
for o in list(bpy.data.objects):
    if o.type == "CAMERA": bpy.data.objects.remove(o, do_unlink=True)
def bone_head(n): return rig.matrix_world @ rig.data.bones["mixamorig:" + n].head_local
hips_z, neck_z = bone_head("Hips").z, bone_head("Neck").z
chest_z = bone_head("Spine2").z
sh_z = max(bone_head("LeftArm").z, bone_head("RightArm").z)
WAIST = hips_z + 0.06

dg = bpy.context.evaluated_depsgraph_get()
skin = bpy.data.meshes.new_from_object(body.evaluated_get(dg)); skin.transform(body.matrix_world)
def bvh_of(objs):
    bm = bmesh.new()
    for o in objs:
        me = o.data.copy(); me.transform(o.matrix_world); bm.from_mesh(me); bpy.data.meshes.remove(me)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    t = BVHTree.FromBMesh(bm, epsilon=0.002); bm.free(); return t
SKIN = BVHTree.FromPolygons([v.co for v in skin.vertices], [p.vertices for p in skin.polygons], epsilon=0.002)
JK = bvh_of([o for o in bpy.data.objects if o.type == "MESH" and o.name in ("Jacket", "Collar") or o.name.startswith(("Placket", "Chest", "Skirt"))])

def link(name, bm, smooth=True):
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o)
    if smooth:
        for p in o.data.polygons: p.use_smooth = True
    return o
def apply(o, mod):
    bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier=mod.name)
def thicken(o, t, offset=1.0):
    so = o.modifiers.new("T", "SOLIDIFY"); so.thickness = t; so.offset = offset; so.use_rim = True; so.use_even_offset = True; apply(o, so)
def on(bvh, origin, d, lift):
    h = bvh.ray_cast(origin, d, 1.5)
    return (h[0] + h[1] * lift, h[1]) if h[0] is not None else (None, None)

# ── HELMET ───────────────────────────────────────────────────────────────────
head = [v.co for v in skin.vertices if v.co.z > neck_z + 0.10]
top = max(p.z for p in head)
brow = [p for p in head if abs(p.z - (top - 0.11)) < 0.012]
hx0, hx1 = min(p.x for p in brow), max(p.x for p in brow)
hy0, hy1 = min(p.y for p in brow), max(p.y for p in brow)
hc = Vector(((hx0 + hx1) / 2, (hy0 + hy1) / 2 + 0.008, top))
RX, RY = (hx1 - hx0) / 2 + 0.03, (hy1 - hy0) / 2 + 0.035
CROWN = top + 0.03
DEPTH = 0.12                                      # crown to rim: the rim at his brow, eyes clear (0.165 sat it over his eyes)
# profile from the crown: (radius fraction, depth fraction) — a dome whose sides fall almost straight
PROF = [(0.0, 0.0), (0.35, 0.03), (0.62, 0.10), (0.80, 0.21), (0.91, 0.36), (0.97, 0.53), (0.995, 0.72), (1.0, 0.88), (1.035, 1.0)]
N = 40
bm = bmesh.new(); rings = []
for rf, df in PROF:
    z = CROWN - DEPTH * df
    # the M1 rim dips a little at the back and rises over the brow less than at the sides — kept level here
    rings.append([bm.verts.new((hc.x + math.cos(k / N * 2 * math.pi) * RX * rf, hc.y + math.sin(k / N * 2 * math.pi) * RY * rf, z)) for k in range(N)] if rf > 0 else [bm.verts.new((hc.x, hc.y, z))])
# the rolled rim: out, then turned under
lip = [bm.verts.new((hc.x + math.cos(k / N * 2 * math.pi) * (RX * 1.035 + 0.007), hc.y + math.sin(k / N * 2 * math.pi) * (RY * 1.035 + 0.007), CROWN - DEPTH - 0.004)) for k in range(N)]
for k in range(N):
    k2 = (k + 1) % N
    bm.faces.new((rings[0][0], rings[1][k], rings[1][k2]))
for j in range(1, len(rings) - 1):
    for k in range(N):
        k2 = (k + 1) % N
        bm.faces.new((rings[j][k], rings[j + 1][k], rings[j + 1][k2], rings[j][k2]))
for k in range(N):
    k2 = (k + 1) % N
    bm.faces.new((rings[-1][k], lip[k], lip[k2], rings[-1][k2]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
helmet = link("Helmet", bm)
thicken(helmet, 0.004, -1.0)
sub = helmet.modifiers.new("S", "SUBSURF"); sub.levels = 1; apply(helmet, sub)
# chinstrap: from each side of the rim, down along the jaw, under the chin
chin_z = neck_z + 0.03
pts = {}
for sx in (-1, 1):
    a = hc + Vector((sx * RX * 0.98, 0.005, -(CROWN - DEPTH * 0.98 - hc.z) * 0 - (top - (CROWN - DEPTH * 0.98))))
    a.z = CROWN - DEPTH * 0.98
    pts[sx] = a
path = []
for t in [i / 16 for i in range(17)]:
    # side rim → jaw → chin → jaw → other side: a U under the face
    ang = math.pi * t                          # 0: left side, pi: right side, through the front-bottom
    x = hc.x + math.cos(ang) * RX * 0.9
    y = hc.y - math.sin(ang) * (RY * 0.75)
    z = pts[1].z + (chin_z - pts[1].z) * math.sin(ang) ** 0.7
    path.append(Vector((x, y, z)))
bm = bmesh.new(); prev = None; W = 0.009
for i, p in enumerate(path):
    near = SKIN.find_nearest(p)
    if near[0] is None: continue
    q = near[0] + near[1] * 0.004
    t_ = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
    s = t_.cross(near[1]).normalized()
    a, b = bm.verts.new(q + s * W / 2), bm.verts.new(q - s * W / 2)
    if prev: bm.faces.new((prev[0], prev[1], b, a))
    prev = (a, b)
chinstrap = link("Chinstrap", bm); thicken(chinstrap, 0.002)

# ── BELT, POUCHES, BRACES, CANTEEN ───────────────────────────────────────────
N = 48
bm = bmesh.new(); rows = []
for dz in (-0.025, 0.0, 0.025):
    row = []
    for k in range(N):
        a = k / N * 2 * math.pi
        d = Vector((math.cos(a), math.sin(a), 0))
        p, n = on(JK, Vector((0, 0, WAIST + dz)) + d * 0.6, -d, 0.004)
        row.append(bm.verts.new(p if p is not None else Vector((0, 0, WAIST + dz)) + d * 0.18))
    rows.append(row)
for j in range(2):
    for k in range(N):
        k2 = (k + 1) % N
        bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
belt = link("Belt", bm); thicken(belt, 0.004)
BELT = bvh_of([belt])
# the pouches hang from the belt down over the jacket: laid on both
BELT_JK = bvh_of([belt] + [o for o in bpy.data.objects if o.type == "MESH" and (o.name in ("Jacket", "Collar") or o.name.startswith(("Placket", "Chest", "Skirt")))])

FRAMES = {}
def box_on(name, bvh, origin, d, size, lift, bevel=0.008):
    """A soft-cornered box laid on the surface hit from `origin` along `d`; size (w, h, depth)."""
    p, n = on(bvh, origin, d, lift)
    if p is None: print("! no surface for", name); return None
    n = Vector((n.x, n.y, 0)).normalized() if abs(n.z) < 0.9 else n
    x = Vector((0, 0, 1)).cross(n).normalized(); z = n.cross(x).normalized()
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    M = Matrix((x, z, n)).transposed().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(p + n * size[2] / 2) @ M @ Matrix.Diagonal((size[0], size[1], size[2], 1)), verts=bm.verts)
    o = link(name, bm)
    bv = o.modifiers.new("B", "BEVEL"); bv.width = bevel; bv.segments = 3; apply(o, bv)
    FRAMES[name] = Matrix.Translation(p + n * size[2] / 2) @ M      # (its centre and axes: x across, y up, z out)
    return o
FRONT = Vector((0, 1, 0))
pouches, flaps = [], []
PH, FH = 0.12, 0.05                  # the pouch's height; its flap's
for sx in (-1, 1):
    # the pouch: its top at the belt's top, hanging down over the jacket
    po = box_on(f"Pouch{sx}", BELT_JK, Vector((sx * 0.105, -0.6, WAIST + 0.025 - PH / 2)), FRONT, (0.105, PH, 0.05), 0.0)
    pouches.append(po)
    # its flap: built in the POUCH's own frame (placed on its own it tilted differently) — over the top
    # of the box, a few mm proud on the front and sides
    if po:
        M = FRAMES[po.name]
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        bmesh.ops.transform(bm, matrix=M @ Matrix.Translation((0, (PH - FH) / 2 + 0.002, 0.003)) @ Matrix.Diagonal((0.111, FH, 0.056, 1)), verts=bm.verts)
        fl = link(f"PouchFlap{sx}", bm)
        bv = fl.modifiers.new("B", "BEVEL"); bv.width = 0.006; bv.segments = 3; apply(fl, bv)
        flaps.append(fl)
buckle = box_on("BeltBuckle", BELT, Vector((0, -0.6, WAIST)), FRONT, (0.04, 0.046, 0.006), 0.0, 0.003)
canteen = box_on("Canteen", BELT, Vector((-0.6, 0.25, WAIST - 0.02)), Vector((1, -0.42, 0)).normalized(), (0.13, 0.17, 0.07), 0.002, 0.03)
if canteen: canteen.location.z -= 0.09

def strap(name, sx, W=0.034):
    """A brace: up the chest from the pouch, over the shoulder, down the back to the belt."""
    pts = []
    x_front, x_sh, x_back = sx * 0.1, sx * 0.13, sx * 0.07
    for i in range(10):                                   # the chest
        t = i / 9
        z = WAIST + 0.03 + (sh_z - 0.04 - WAIST - 0.03) * t
        pts.append((Vector((x_front + (x_sh - x_front) * t, -0.6, z)), FRONT))
    for i in range(1, 12):                                # over the shoulder
        a = math.pi * i / 12
        c = Vector((x_sh, bone_head("Neck").y, sh_z - 0.04))
        d = Vector((0, -math.cos(a), math.sin(a)))
        pts.append((c + d * 0.6, -d))
    for i in range(10):                                   # the back, slanting in
        t = i / 9
        z = sh_z - 0.04 - (sh_z - 0.04 - WAIST - 0.03) * t
        pts.append((Vector((x_sh + (x_back - x_sh) * t, 0.6, z)), -FRONT))
    hits = [on(JK, o, d, 0.005) for o, d in pts]
    hits = [(p, n) for p, n in hits if p is not None]
    bm = bmesh.new(); prev = None
    for i, (p, n) in enumerate(hits):
        t_ = (hits[min(i + 1, len(hits) - 1)][0] - hits[max(i - 1, 0)][0]).normalized()
        s = t_.cross(n).normalized()
        a, b = bm.verts.new(p + s * W / 2), bm.verts.new(p - s * W / 2)
        if prev: bm.faces.new((prev[0], prev[1], b, a))
        prev = (a, b)
    o = link(name, bm); thicken(o, 0.003)
    sm = o.modifiers.new("S", "SMOOTH"); sm.factor = 0.5; sm.iterations = 3; apply(o, sm)
    return o
braces = [strap("BraceL", 1), strap("BraceR", -1)]

# ── Look and close-ups ───────────────────────────────────────────────────────
def mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name); m.diffuse_color = (*rgb, 1); return m
web, steel, metal, cover = mat("Web", (0.33, 0.30, 0.19)), mat("Steel", (0.13, 0.13, 0.09)), mat("Metal", (0.12, 0.12, 0.12)), mat("CanteenCover", (0.26, 0.24, 0.15))
for o in [belt] + pouches + flaps + braces + [chinstrap]:
    if o: o.data.materials.append(web)
helmet.data.materials.append(steel)
if buckle: buckle.data.materials.append(metal)
if canteen: canteen.data.materials.append(cover)
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading
sh.light = "STUDIO"; sh.color_type = "MATERIAL"; sh.show_cavity = True; sh.cavity_type = "BOTH"
sh.show_backface_culling = True; sh.show_specular_highlight = False
scn.render.resolution_x, scn.render.resolution_y = 600, 800
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, target, frm, lens=50, ortho=None):
    if ortho: cd.type = "ORTHO"; cd.ortho_scale = ortho
    else: cd.type = "PERSP"; cd.lens = lens
    cam.location = Vector(frm); cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(out, f"kit_{name}.png"); bpy.ops.render.render(write_still=True)
H = 0.92
shot("front", (0, 0, H), (0, -6, H), ortho=2.0)
shot("side", (0, 0, H), (6, 0, H), ortho=2.0)
shot("back", (0, 0, H), (0, 6, H), ortho=2.0)
shot("threequarter", (0, 0, H), (3.5, -4.5, H + 0.8), ortho=2.0)
shot("helmet", (0, 0, top - 0.05), (0.45, -0.7, top + 0.05), lens=55)
shot("helmet_side", (0, 0, top - 0.05), (0.8, 0.0, top), lens=55)
shot("belt", (0, 0, WAIST - 0.04), (0.3, -0.85, WAIST + 0.1), lens=50)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "kit.blend"))
print("DONE")

# ── For the soldier viewer (games/shared-rts/model-viewer.html): the whole man as he stands, one GLB ──
for m in bpy.data.materials:
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    if b:
        b.inputs["Base Color"].default_value = m.diffuse_color
        b.inputs["Roughness"].default_value = 0.6 if m.name in ("Steel", "Metal", "Leather") else 0.9
skin_mat = bpy.data.materials.get("SkinView") or bpy.data.materials.new("SkinView"); skin_mat.use_nodes = True
skin_mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.62, 0.42, 0.31, 1)
if not body.data.materials: body.data.materials.append(skin_mat)
else: body.data.materials[0] = skin_mat
bpy.ops.object.select_all(action="DESELECT")
for o in bpy.data.objects:
    if o.type == "MESH": o.select_set(True)
view = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "models", "soldiers", "test", "appele_view.glb")
bpy.ops.export_scene.gltf(filepath=os.path.abspath(view), use_selection=True, export_animations=False, export_skins=False,
                          export_yup=True, export_apply=True, export_materials="EXPORT")
print("VIEW", os.path.abspath(view))
