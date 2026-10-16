"""THE APPELÉ'S M47 JACKET BY CLOTH SIMULATION (2026-10-15, step 3 — steps 1-2 clothTrousers.py, clothBoots.py).
Run on the lower body's file:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      assets-src/soldiers/appele2/lower.blend --python tools/blender/clothJacket.py -- assets-src/soldiers/appele2

The M47 field jacket: loose, hanging to mid-thigh OVER the trousers (one skirt round both legs, not a
shell of each thigh — that read as shorts), a stand collar, sleeves rolled up to just below the elbow.
  BODY      rings from the hem up to the collar, each the OUTLINE of what it covers at that height (the
            torso's skin, the trousers below the hips — their 2-D convex hull, so the skirt bridges the
            legs), out by its looseness; closed over the shoulders into the collar
  SLEEVES   tubes along each arm (shoulder → elbow → the roll), each ring sized by rays onto the arm,
            starting inside the body tube (a set-in sleeve); the last rings the ROLLED CUFF, fatter
  DRAPE     cloth simulation (cotton, gravity, colliding with the skin and the trousers): the collar and
            the sleeves' tops pinned — the folds at the waist, the elbows and the skirt come from it
  THICKNESS solidified (closed rims: nothing to see through)
Writes <out>/upper.blend and jacket_*.png close-ups.
"""
import bpy, bmesh, sys, os, math
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from mathutils.geometry import convex_hull_2d, intersect_line_line_2d

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
body, rig, trousers = bpy.data.objects["Body"], bpy.data.objects["Rig"], bpy.data.objects["Trousers"]
for o in list(bpy.data.objects):
    if o.type == "CAMERA": bpy.data.objects.remove(o, do_unlink=True)
def bone_head(n): return rig.matrix_world @ rig.data.bones["mixamorig:" + n].head_local
hips_z = bone_head("Hips").z
neck_z = bone_head("Neck").z
HEM = hips_z - 0.35                      # mid-thigh (the cut takes ~2 cm, the drape rides it up a little)
COLLAR = neck_z + 0.035                  # the stand collar's top
SLEEVE_END = 0.35                        # along the forearm: rolled to just below the elbow

dg = bpy.context.evaluated_depsgraph_get()
skin = bpy.data.meshes.new_from_object(body.evaluated_get(dg)); skin.transform(body.matrix_world)
gi = {g.index: g.name.split(":")[-1] for g in body.vertex_groups if g.name.startswith("mixamorig:")}
def dom(v):
    best, bw = "", 0
    for e in v.groups:
        n = gi.get(e.group)
        if n and e.weight > bw: best, bw = n, e.weight
    return best
DOM = [dom(v) for v in body.data.vertices]
ARM = ("Arm", "Hand")                    # (LeftArm, LeftForeArm, LeftHand… — not the Shoulder/clavicle)
tpts = [trousers.matrix_world @ v.co for v in trousers.data.vertices]
torso = [skin.vertices[i].co for i, d in enumerate(DOM) if not any(k in d for k in ARM) and not d.startswith("Head")]

def outline(z, band=0.012):
    """The 2-D convex hull of what the jacket covers at height z (torso skin; the trousers below the hips)."""
    pts = [p for p in torso if abs(p.z - z) < band]
    if z < hips_z + 0.05: pts += [p for p in tpts if abs(p.z - z) < band]
    # the SHOULDER rings take in the top of the upper arm (the deltoid): ending at the torso, they left
    # the shoulder's skin bare between the body and the sleeve
    if z > SH_Z - 0.07:
        pts += [p for p in DELTOID if abs(p.z - z) < band]
    if len(pts) < 3: return None
    idx = convex_hull_2d([(p.x, p.y) for p in pts])
    return [Vector((pts[i].x, pts[i].y)) for i in idx]
def radial(hull, c, a):
    """The hull's distance from c along angle a."""
    d = Vector((math.cos(a), math.sin(a)))
    far = c + d * 2.0
    best = None
    for i in range(len(hull)):
        h = intersect_line_line_2d(c, far, hull[i], hull[(i + 1) % len(hull)])
        if h is not None:
            r = (h - c).length
            best = r if best is None else max(best, r)
    return best or 0.15

SH_Z = max(bone_head("LeftArm").z, bone_head("RightArm").z)
DELTOID = [skin.vertices[i].co for i, d in enumerate(DOM) if d.endswith("Arm") and not d.endswith("ForeArm")
           and min((skin.vertices[i].co - bone_head(s + "Arm")).length for s in ("Left", "Right")) < 0.11]
def loose(z):
    if z < hips_z - 0.02: return 0.030    # the skirt: hangs clear
    if z > neck_z - 0.04: return 0.010    # the collar: close
    return 0.024

# ── BODY: rings hem → shoulders → collar ─────────────────────────────────────
N = 48
sh_z = max(bone_head("LeftArm").z, bone_head("RightArm").z)
levels = []
z = HEM
while z < sh_z + 0.02:
    levels.append(z); z += 0.025
levels += [sh_z + 0.045, neck_z - 0.01, neck_z + 0.015, COLLAR]
bm = bmesh.new(); rings = []
for z in levels:
    band = 0.012 if z < sh_z else 0.02
    hull = outline(z, band)
    if hull is None: continue
    c = sum(hull, Vector((0, 0))) / len(hull)
    if z > sh_z:                                  # the shoulders close in to the neck: centred on it
        nb = bone_head("Neck"); c = Vector((nb.x, nb.y))
    rr = []
    for k in range(N):
        a = k / N * math.pi * 2
        r = radial(hull, c, a) + loose(z)
        rr.append(bm.verts.new((c.x + math.cos(a) * r, c.y + math.sin(a) * r, z)))
    rings.append(rr)
for j in range(len(rings) - 1):
    for k in range(N):
        k2 = (k + 1) % N
        bm.faces.new((rings[j][k], rings[j][k2], rings[j + 1][k2], rings[j + 1][k]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
def link(name, bm):
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o); return o
jbody = link("JacketBody", bm)
bpy.context.view_layer.objects.active = jbody
_r = jbody.modifiers.new("Relax", "SMOOTH"); _r.factor = 0.5; _r.iterations = 4
bpy.ops.object.modifier_apply(modifier=_r.name)
print("BODY rings", len(rings))

# ── SLEEVES ──────────────────────────────────────────────────────────────────
# (the ARM's skin only: rays from outside hit the TORSO first on the sleeve's inner side — the sleeves came
# out as bells as wide as the chest)
SKIN_BVH = {}
for side in ("Left", "Right"):
    keepf = [p.vertices for p in skin.polygons if all(side + "Arm" in DOM[i] or side + "ForeArm" in DOM[i] or side + "Shoulder" in DOM[i] for i in p.vertices)]
    SKIN_BVH[side] = BVHTree.FromPolygons([v.co for v in skin.vertices], keepf)
sleeves = []
for side in ("Left", "Right"):
    sh, el, wr = bone_head(side + "Arm"), bone_head(side + "ForeArm"), bone_head(side + "Hand")
    end = el.lerp(wr, SLEEVE_END)
    start = sh + (sh - el).normalized() * 0.015           # (just inside the shoulder: deeper, it puckered)
    path = [start.lerp(sh, t) for t in (0, 0.5)] + [sh.lerp(el, t) for t in (0, 0.25, 0.5, 0.75, 1.0)] + [el.lerp(end, t) for t in (0.5, 0.8, 1.0)]
    M = 20
    bm = bmesh.new(); R = []
    for i, p in enumerate(path):
        ax = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        u = ax.cross(Vector((0, 0, 1))).normalized()
        if u.length < 0.1: u = ax.cross(Vector((0, 1, 0))).normalized()
        v = ax.cross(u).normalized()
        rr = []
        for k in range(M):
            a = k / M * math.pi * 2
            d = u * math.cos(a) + v * math.sin(a)
            h = SKIN_BVH[side].ray_cast(p + d * 0.25, -d, 0.3)
            r = (0.25 - h[3]) if h[0] is not None else 0.05
            r = max(r, 0.035)
            roll = 0.010 if i >= len(path) - 2 else 0.0      # the rolled cuff (gripping the forearm)
            looser = 0.016 if i < len(path) - 3 else 0.008
            rr.append(bm.verts.new(p + d * (r + looser + roll)))
        R.append(rr)
    for j in range(len(R) - 1):
        for k in range(M):
            k2 = (k + 1) % M
            bm.faces.new((R[j][k], R[j][k2], R[j + 1][k2], R[j + 1][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    sleeves.append(link("Sleeve" + side, bm))

# ── DRAPE ────────────────────────────────────────────────────────────────────
# the collider: the skin and the trousers
col_bm = bmesh.new(); col_bm.from_mesh(skin)
tm = trousers.data.copy(); tm.transform(trousers.matrix_world); col_bm.from_mesh(tm)
cm_ = bpy.data.meshes.new("Col"); col_bm.to_mesh(cm_); col_bm.free()
coll = bpy.data.objects.new("Collider", cm_); bpy.context.scene.collection.objects.link(coll)
coll.modifiers.new("Collision", "COLLISION")
coll.collision.thickness_outer = 0.005; coll.collision.cloth_friction = 5
def simulate(o, pin_test, frames=40):
    bpy.context.view_layer.objects.active = o
    g = o.vertex_groups.new(name="Pin")
    for v in o.data.vertices:
        if pin_test(o.matrix_world @ v.co): g.add([v.index], 1.0, "REPLACE")
    cl = o.modifiers.new("Cloth", "CLOTH"); st = cl.settings
    st.quality = 10; st.mass = 0.3
    st.tension_stiffness = 25; st.compression_stiffness = 25; st.shear_stiffness = 10; st.bending_stiffness = 6.0
    st.air_damping = 1.5; st.vertex_group_mass = "Pin"; st.pin_stiffness = 1.0
    st.shrink_min = 0.05   # (drawn a little taut: the spare width buckled into lumps all over)
    cc = cl.collision_settings; cc.collision_quality = 4; cc.distance_min = 0.004
    cc.use_self_collision = True; cc.self_distance_min = 0.003
    scn = bpy.context.scene; scn.frame_start, scn.frame_end = 1, frames
    cl.point_cache.frame_start, cl.point_cache.frame_end = 1, frames
    for f in range(1, frames + 1): scn.frame_set(f)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    name = o.name; bpy.data.objects.remove(o, do_unlink=True)
    n = bpy.data.objects.new(name, me); scn.collection.objects.link(n)
    scn.frame_set(1)
    return n
# ONE GARMENT (2026-10-15: the body and the sleeves draped as separate cloths overlapped and tore at the
# shoulder seam). The pieces are FUSED into one surface before the drape — closed (the hem, the cuffs and
# the collar capped), voxel-remeshed into one watertight shape, then the caps cut open again — and draped
# as one cloth, the sleeve sewn into the armhole as a real jacket is.
bpy.ops.object.select_all(action="DESELECT")
for o in [jbody] + sleeves:
    bm_ = bmesh.new(); bm_.from_mesh(o.data)
    bmesh.ops.holes_fill(bm_, edges=[e for e in bm_.edges if e.is_boundary], sides=0)
    bm_.to_mesh(o.data); bm_.free()
    o.select_set(True)
bpy.context.view_layer.objects.active = jbody
bpy.ops.object.join()
jacket = jbody; jacket.name = "Jacket"
rm = jacket.modifiers.new("Fuse", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = 0.011
bpy.context.view_layer.objects.active = jacket
bpy.ops.object.modifier_apply(modifier=rm.name)
# the voxel surface's lumps smoothed out first (the soft cloth turned them into crinkles all over)
_sm = jacket.modifiers.new("Calm", "LAPLACIANSMOOTH"); _sm.iterations = 10; _sm.lambda_factor = 1.0; _sm.use_volume_preserve = True
bpy.ops.object.modifier_apply(modifier=_sm.name)
# open the caps again: the hem, the collar, each cuff — every face beyond those planes goes
bm_ = bmesh.new(); bm_.from_mesh(jacket.data)
cuts = [((0, 0, HEM + 0.018), (0, 0, -1)), ((0, 0, COLLAR - 0.012), (0, 0, 1))]   # (above the rounded corner the remesh leaves where it was capped: it curled in and snagged)
for sd in ("Left", "Right"):
    el, wr = bone_head(sd + "ForeArm"), bone_head(sd + "Hand")
    ax = (wr - el).normalized()
    cuts.append((el.lerp(wr, SLEEVE_END) - ax * 0.015, ax))
# Cut with exact PLANES (deleting whole faces left stepped, jagged edges): the hem and the collar across the
# whole jacket; each cuff only in the geometry round its own forearm (its plane would slice the skirt too).
for co, no in cuts:
    co, no = Vector(co), Vector(no)
    if abs(no.z) > 0.9 and (no.z < 0 or co.z > 1.0):
        geom = bm_.verts[:] + bm_.edges[:] + bm_.faces[:]
    else:
        near = {v for v in bm_.verts if (v.co - co).length < 0.1}
        geom = list(near) + [e for e in bm_.edges if all(v in near for v in e.verts)] + [f for f in bm_.faces if all(v in near for v in f.verts)]
    bmesh.ops.bisect_plane(bm_, geom=geom, plane_co=co, plane_no=no, clear_outer=True)
bmesh.ops.delete(bm_, geom=[v for v in bm_.verts if not v.link_faces], context="VERTS")
bm_.to_mesh(jacket.data); bm_.free()
print("FUSED", len(jacket.data.vertices), "verts")
def jacket_pin(p):
    if p.z > sh_z - 0.01 and abs(p.x) < 0.2: return True            # the yoke and collar hold it
    for sd in ("Left", "Right"):
        el, wr = bone_head(sd + "ForeArm"), bone_head(sd + "Hand")
        if (p - el.lerp(wr, SLEEVE_END)).length < 0.07: return True  # the rolled cuffs grip the forearms
    return False
jacket = simulate(jacket, jacket_pin)
jacket.name = "Jacket"
bpy.data.objects.remove(coll, do_unlink=True)
bmq = bmesh.new(); bmq.from_mesh(jacket.data)
lmax = max(e.calc_length() for e in bmq.edges); bmq.free()
sm = jacket.modifiers.new("Iron", "SMOOTH"); sm.factor = 0.6; sm.iterations = 6
so = jacket.modifiers.new("T", "SOLIDIFY"); so.thickness = 0.004; so.offset = -1.0; so.use_rim = True
bpy.context.view_layer.objects.active = jacket
for m in list(jacket.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
for p in jacket.data.polygons: p.use_smooth = True
print("JACKET", len(jacket.data.polygons), "faces; longest edge after drape", round(lmax, 3))

# ── THE M47's DETAILS, laid on the draped cloth ──────────────────────────────
# (a plain smock read as a tunic: the M47 has a turned-down collar, a buttoned front placket, two chest
# pockets and two skirt pockets with buttoned flaps.) Each is a patch that FOLLOWS the cloth (rays onto
# it), raised a few mm, thick (closed) — sewn on, not floating.
# (triangulated, with a hit tolerance: on the raw quads rays slipped between faces and patches gave up)
_tb = bmesh.new(); _tb.from_mesh(jacket.data); _tb.transform(jacket.matrix_world)
bmesh.ops.triangulate(_tb, faces=_tb.faces[:])
J_BVH = BVHTree.FromBMesh(_tb, epsilon=0.002); _tb.free()
FRONT = Vector((0, -1, 0))
def patch(name, cx, cz, w, h, lift, nx=6, ny=6, curve=0.0):
    """A rectangle on the jacket's front, centred (cx, cz), w × h, `lift` off the cloth; `curve`: its lower
    corners rounded up by that much (a flap's point)."""
    bm = bmesh.new(); grid = []
    for j in range(ny + 1):
        row = []
        for i in range(nx + 1):
            u, v = i / nx - 0.5, j / ny
            x, z = cx + u * w, cz - h + v * h
            if curve and j == 0: z += curve * (abs(u) * 2) ** 2
            o0 = Vector((x, -0.6, z))
            hit = J_BVH.ray_cast(o0, -FRONT, 1.0)
            if hit[0] is None:
                print("  PATCH MISS", name, round(x, 3), round(z, 3)); bm.free(); return None
            row.append(bm.verts.new(hit[0] + hit[1] * lift))
        grid.append(row)
    try:
        for j in range(ny):
            for i in range(nx):
                bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    except Exception as e:
        print("  PATCH FAIL", name, e); bm.free(); return None
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.y > 0: f.normal_flip()
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o)
    so = o.modifiers.new("T", "SOLIDIFY"); so.thickness = 0.003; so.offset = -1.0; so.use_rim = True
    bpy.context.view_layer.objects.active = o; bpy.ops.object.modifier_apply(modifier=so.name)
    for pg in o.data.polygons: pg.use_smooth = True
    return o
def button(name, x, z, lift=0.004):
    hit = J_BVH.ray_cast(Vector((x, -0.6, z)), -FRONT, 1.0)
    if hit[0] is None: return None
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=10, radius1=0.008, radius2=0.007, depth=0.004)
    rot = hit[1].to_track_quat("Z", "Y").to_matrix().to_4x4()
    bmesh.ops.transform(bm, matrix=Matrix.Translation(hit[0] + hit[1] * lift) @ rot, verts=bm.verts)
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o); return o
from mathutils import Matrix
# placed from the hem the drape ACTUALLY gave (its shrink rides it up ~9 cm)
J_BOTTOM = min((jacket.matrix_world @ v.co).z for v in jacket.data.vertices)
print("HEM after drape", round(J_BOTTOM, 3), "(hips", round(hips_z, 3), ")")
chest_z = bone_head("Spine2").z + 0.03
pieces, buttons = [], []
pieces.append(patch("Placket", 0.0, neck_z - 0.02, 0.045, neck_z - 0.02 - (J_BOTTOM + 0.015), 0.004, nx=2, ny=14))
for k in range(6):
    z = neck_z - 0.05 - k * (neck_z - 0.05 - (J_BOTTOM + 0.06)) / 5
    buttons.append(button(f"Btn{k}", 0.0, z, 0.007))
for sx in (-1, 1):
    pieces.append(patch(f"ChestPocket{sx}", sx * 0.095, chest_z + 0.02, 0.11, 0.12, 0.004))
    pieces.append(patch(f"ChestFlap{sx}", sx * 0.095, chest_z + 0.035, 0.12, 0.05, 0.008, ny=2, curve=0.012))
    buttons.append(button(f"ChestBtn{sx}", sx * 0.095, chest_z - 0.005, 0.011))
    SK = J_BOTTOM + 0.03 + 0.15   # the skirt pocket's top, 3 cm above the hem
    pieces.append(patch(f"SkirtPocket{sx}", sx * 0.1, SK, 0.13, 0.15, 0.004))
    pieces.append(patch(f"SkirtFlap{sx}", sx * 0.1, SK + 0.015, 0.14, 0.055, 0.008, ny=2, curve=0.012))
    buttons.append(button(f"SkirtBtn{sx}", sx * 0.1, SK - 0.025, 0.011))
# THE COLLAR: a band round the neck opening, turned down over the yoke
nb = bone_head("Neck")
bm = bmesh.new(); C = 28; rows = []
# (each row ON the jacket at its own height — the stand at the neck, the fold, the fall lying on the yoke;
# sized at the neck only, the fall floated as a ring over the shoulders)
for r, (dz, out_, ) in enumerate(((COLLAR - 0.012, 0.004), (COLLAR + 0.006, 0.010), (COLLAR - 0.045, 0.006))):
    row = []
    for k in range(C):
        a = k / C * math.pi * 2
        d = Vector((math.cos(a), math.sin(a), 0))
        zr = min(dz, COLLAR - 0.012)
        hit = J_BVH.ray_cast(Vector((nb.x, nb.y, zr)) + d * 0.3, -d, 0.35)
        rr = (Vector((hit[0].x - nb.x, hit[0].y - nb.y, 0)).length if hit[0] is not None else 0.07)
        # the front: open in a small V (the collar points)
        vz = dz - (0.03 if r == 0 and abs(a + math.pi / 2) < 0.35 else 0.0)
        row.append(bm.verts.new(Vector((nb.x, nb.y, vz)) + d * (rr + out_)))
    rows.append(row)
for j in range(len(rows) - 1):
    for k in range(C):
        k2 = (k + 1) % C
        bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
m = bpy.data.meshes.new("Collar"); bm.to_mesh(m); bm.free()
collar = bpy.data.objects.new("Collar", m); bpy.context.scene.collection.objects.link(collar)
so = collar.modifiers.new("T", "SOLIDIFY"); so.thickness = 0.004; so.use_rim = True
bpy.context.view_layer.objects.active = collar; bpy.ops.object.modifier_apply(modifier=so.name)
sub = collar.modifiers.new("S", "SUBSURF"); sub.levels = 1; bpy.ops.object.modifier_apply(modifier=sub.name)
for pg in collar.data.polygons: pg.use_smooth = True
pieces.append(collar)
pieces = [p for p in pieces if p]; buttons = [b for b in buttons if b]
print("DETAILS", len(pieces), "patches,", len(buttons), "buttons")
btn_mat = bpy.data.materials.new("Button"); btn_mat.diffuse_color = (0.12, 0.11, 0.07, 1)
for b in buttons: b.data.materials.append(btn_mat)

# ── Look and close-ups ───────────────────────────────────────────────────────
m = bpy.data.materials.get("M47") or bpy.data.materials.new("M47"); m.diffuse_color = (0.24, 0.23, 0.14, 1)
jacket.data.materials.append(m)
for o_ in pieces: o_.data.materials.append(m)
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh_ = scn.display.shading
sh_.light = "STUDIO"; sh_.color_type = "MATERIAL"; sh_.show_cavity = True; sh_.cavity_type = "BOTH"
sh_.show_backface_culling = True; sh_.show_specular_highlight = False
scn.render.resolution_x, scn.render.resolution_y = 600, 800
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, target, frm, lens=50, ortho=None):
    if ortho: cd.type = "ORTHO"; cd.ortho_scale = ortho
    else: cd.type = "PERSP"; cd.lens = lens
    cam.location = Vector(frm)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(out, f"jacket_{name}.png"); bpy.ops.render.render(write_still=True)
H = 0.9
shot("front", (0, 0, H), (0, -6, H), ortho=2.0)
shot("side", (0, 0, H), (6, 0, H), ortho=2.0)
shot("back", (0, 0, H), (0, 6, H), ortho=2.0)
shot("threequarter", (0, 0, H), (3.5, -4.5, H + 0.8), ortho=2.0)
shot("collar", (0, 0, neck_z), (0.25, -0.55, neck_z + 0.25), lens=55)
shot("chest", (0, 0, chest_z - 0.1), (0.25, -0.9, chest_z), lens=55)
shot("sleeve", bone_head("LeftForeArm"), bone_head("LeftForeArm") + Vector((0.25, -0.5, -0.05)), lens=55)
shot("skirt", (0, 0, hips_z - 0.1), (0.4, -0.75, hips_z - 0.25), lens=50)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "upper.blend"))
print("DONE")
