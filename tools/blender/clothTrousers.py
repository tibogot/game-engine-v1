"""THE APPELÉ'S TROUSERS BY CLOTH SIMULATION (2026-10-15, you: "it can be done if you use Blender right" —
the CoH soldier's trousers are loose cloth that hangs and folds; mine were the skin inflated by a few mm).
Step 1 of the rebuilt uniform. Run on the body stage's file (tools/blender/soldierBody.py --flat-hands):

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      assets-src/soldiers/appele2/body.blend --python tools/blender/clothTrousers.py -- assets-src/soldiers/appele2

The M47 trousers: cut LOOSE (a few cm off the leg all round, fuller at the seat and thighs), the waist
held at the belt line, and the legs BLOUSED — tucked tight round the shin at the gaiter top with spare
length above, which bunches over it. Made the way cloth is: a shell cut from the hips and legs, inflated,
subdivided, then SIMULATED (cotton, gravity, colliding with the body): the waistband pinned, the hems
pinned to a ring that gathers in (a shape key the pins follow over the first frames) — the folds, the
sag at the knees and the bunching at the ankles come from the simulation. Writes <out>/trousers.blend
(the draped, high-resolution trousers on the body) and close-up renders trousers_*.png.
"""
import bpy, bmesh, sys, os, math
from mathutils import Vector

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
body = bpy.data.objects["Body"]
rig = bpy.data.objects["Rig"]
for o in list(bpy.data.objects):
    if o.type == "CAMERA": bpy.data.objects.remove(o, do_unlink=True)

def bone_head(n): return rig.matrix_world @ rig.data.bones["mixamorig:" + n].head_local
hips_z = bone_head("Hips").z
knee = {s: bone_head(s + "Leg") for s in ("Left", "Right")}
ankle = {s: bone_head(s + "Foot") for s in ("Left", "Right")}
WAIST = hips_z + 0.06                     # where the belt holds them
GAITER = ankle["Left"].z + 0.17           # the gaiter / boot top the legs are bloused over
HEM = ankle["Left"].z + 0.04              # where the cut shell ends: ~13 cm of spare length to bunch above GAITER
print("LEVELS", {k: round(v, 3) for k, v in dict(hips=hips_z, waist=WAIST, gaiter=GAITER, hem=HEM).items()})

# ── The skin as it is (the collider and the shape to cut from) ───────────────
dg = bpy.context.evaluated_depsgraph_get()
skin = bpy.data.meshes.new_from_object(body.evaluated_get(dg)); skin.transform(body.matrix_world)
gi = {g.index: g.name.split(":")[-1] for g in body.vertex_groups if g.name.startswith("mixamorig:")}
def dom(v):
    best, bw = "", 0
    for e in v.groups:
        n = gi.get(e.group)
        if n and e.weight > bw: best, bw = n, e.weight
    return best
LEGS = ("Hips", "Spine", "Spine1", "LeftUpLeg", "RightUpLeg", "LeftLeg", "RightLeg", "LeftFoot", "RightFoot")
NOT_LEGS = ("Arm", "Hand", "Shoulder", "Neck", "Head")
inside = [not any(k in dom(v) for k in NOT_LEGS) and HEM <= skin.vertices[v.index].co.z <= WAIST + 0.06 for v in body.data.vertices]
# (the waist cut LEVEL: belly vertices led by Spine1 vs Hips made two notches at the front)

# ── The cut: the skin of the hips and legs, inflated loose ───────────────────
bm = bmesh.new(); bm.from_mesh(skin)
bm.verts.ensure_lookup_table()
bmesh.ops.delete(bm, geom=[f for f in bm.faces if not all(inside[v.index] for v in f.verts)], context="FACES")
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
# keep only the big piece (stray islands — a finger brushing the thigh — dropped)
islands, seen = [], set()
for v in bm.verts:
    if v in seen: continue
    stack, isl = [v], []
    while stack:
        x = stack.pop()
        if x in seen: continue
        seen.add(x); isl.append(x)
        stack.extend(e.other_vert(x) for e in x.link_edges)
    islands.append(isl)
islands.sort(key=len, reverse=True)
for isl in islands[1:]:
    bmesh.ops.delete(bm, geom=isl, context="VERTS")
bm.normal_update()
def loose(z):
    """How far off the skin the cloth starts: snug at the waistband, full at the seat and thighs."""
    if z > WAIST - 0.03: return 0.008
    if z > hips_z - 0.25: return 0.040     # seat and thighs (the M47 is cut full)
    return 0.032
for v in bm.verts:
    v.co += v.normal * loose(v.co.z)
# THE WAISTBAND, CUT FLAT: the shell was cut 6 cm high (the skin's own edge there had a scoop at the
# belly — two points either side of it) and is sliced level at the belt line here.
bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, WAIST), plane_no=(0, 0, 1), clear_outer=True)
# THE WAISTBAND LEVEL: the cut followed the skin's topology — at the front it dipped and left two points
# standing up (the "notches"). Every vertex of the top edge, and the row under it, set to the belt line.
top = [v for v in bm.verts if v.is_boundary and v.co.z > hips_z]
for v in top:
    v.co.z = WAIST
    for e in v.link_edges:
        w = e.other_vert(v)
        if not w.is_boundary and w.co.z > WAIST - 0.03: w.co.z = min(w.co.z, WAIST - 0.012)
print("WAIST levelled:", len(top), "verts")
tr = bpy.data.meshes.new("Trousers"); bm.to_mesh(tr); bm.free()
trousers = bpy.data.objects.new("Trousers", tr); bpy.context.scene.collection.objects.link(trousers)
bpy.context.view_layer.objects.active = trousers
sub = trousers.modifiers.new("Sub", "SUBSURF"); sub.levels = 1
bpy.ops.object.modifier_apply(modifier=sub.name)
# a light relax first (the inflated skin's dents ironed out: cloth, not a skin cast)
sm = trousers.modifiers.new("Relax", "SMOOTH"); sm.factor = 0.6; sm.iterations = 6
bpy.ops.object.modifier_apply(modifier=sm.name)
print("TROUSERS cut:", len(tr.vertices), "verts")

# ── Pins: the waistband, and the hems (gathered by a shape key) ──────────────
# (the HEM is the open edge low on the legs — every vertex of it, the cut is uneven: pinning by height
# caught a few and the rest hung open like culottes)
pin = trousers.vertex_groups.new(name="Pin")
bq = bmesh.new(); bq.from_mesh(tr); bq.verts.ensure_lookup_table()
hem = {v.index for v in bq.verts if v.is_boundary and v.co.z < hips_z - 0.3}
bq.free()
for v in tr.vertices:
    if v.co.z > WAIST - 0.012 or v.index in hem: pin.add([v.index], 1.0, "REPLACE")
print("HEM verts pinned:", len(hem))
trousers.shape_key_add(name="Basis")
gather = trousers.shape_key_add(name="Gather")
def shin_radius(side, z):
    pts = [skin.vertices[i].co for i in range(len(skin.vertices)) if abs(skin.vertices[i].co.z - z) < 0.015
           and (skin.vertices[i].co.x > 0) == (side == "Left") and dom(body.data.vertices[i]) in ("LeftLeg", "RightLeg")]
    c = knee[side].lerp(ankle[side], (knee[side].z - z) / (knee[side].z - ankle[side].z))
    return c, (max((Vector((p.x - c.x, p.y - c.y, 0)).length for p in pts), default=0.05))
R = {s: shin_radius(s, GAITER) for s in ("Left", "Right")}
print("GAITER radius", {k: round(v[1], 3) for k, v in R.items()})
for v in tr.vertices:
    if v.index in hem:
        s = "Left" if v.co.x > 0 else "Right"
        c, r = R[s]
        d = Vector((v.co.x - c.x, v.co.y - c.y, 0)).normalized()
        gather.data[v.index].co = Vector((c.x, c.y, GAITER)) + d * (r + 0.006)   # tight round the gaiter top
gather.value = 0.0
gather.keyframe_insert("value", frame=1)
gather.value = 1.0
gather.keyframe_insert("value", frame=22)

# ── The simulation ───────────────────────────────────────────────────────────
coll = bpy.data.objects.new("Collider", skin); bpy.context.scene.collection.objects.link(coll)
cm = coll.modifiers.new("Collision", "COLLISION")
coll.collision.thickness_outer = 0.006; coll.collision.cloth_friction = 6
cl = trousers.modifiers.new("Cloth", "CLOTH")
st = cl.settings
st.quality = 10
st.mass = 0.35                     # cotton twill, ~300 g/m²
st.tension_stiffness = 18; st.compression_stiffness = 18; st.shear_stiffness = 6
st.bending_stiffness = 2.0         # (twill: it folds in a few broad folds, not crumpled paper)
st.air_damping = 1.5
st.vertex_group_mass = "Pin"; st.pin_stiffness = 1.0
cc = cl.collision_settings
cc.collision_quality = 4; cc.distance_min = 0.004
cc.use_self_collision = True; cc.self_distance_min = 0.003
scn = bpy.context.scene
FR = 70
scn.frame_start, scn.frame_end = 1, FR
cl.point_cache.frame_start, cl.point_cache.frame_end = 1, FR
for f in range(1, FR + 1):
    scn.frame_set(f)
print("SIM done, frame", scn.frame_current)

# Freeze the drape: the cloth applied at the last frame (the shape keys go with it).
bpy.context.view_layer.objects.active = trousers
dg = bpy.context.evaluated_depsgraph_get()
done = bpy.data.meshes.new_from_object(trousers.evaluated_get(dg))
bpy.data.objects.remove(trousers, do_unlink=True)
trousers = bpy.data.objects.new("Trousers", done); scn.collection.objects.link(trousers)
for p in trousers.data.polygons: p.use_smooth = True
# THE WAISTBAND after the drape: its top edge (and the row under it) set level at the belt line — the
# pinned edge still left two small points standing at the fly
_bm = bmesh.new(); _bm.from_mesh(trousers.data)
for v in _bm.verts:
    if v.co.z > WAIST - 0.035:
        v.co.z = min(v.co.z, WAIST - (0.0 if v.is_boundary else 0.01))
_bm.to_mesh(trousers.data); _bm.free()
# the sim's finest crumple ironed a little (the broad folds stay)
bpy.context.view_layer.objects.active = trousers
_s = trousers.modifiers.new("Iron", "SMOOTH"); _s.factor = 0.5; _s.iterations = 3
bpy.ops.object.modifier_apply(modifier=_s.name)
bpy.data.objects.remove(coll, do_unlink=True)
# Broken vertices? (a cloth that exploded shows edges far longer than its cut)
bmq = bmesh.new(); bmq.from_mesh(done)
lmax = max(e.calc_length() for e in bmq.edges); bmq.free()
print("DRAPED", len(done.vertices), "verts; longest edge", round(lmax, 3), "m")

# ── Look: matte khaki-olive cotton, the body under it ────────────────────────
m = bpy.data.materials.new("M47"); m.diffuse_color = (0.24, 0.23, 0.14, 1)
trousers.data.materials.append(m)
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading
sh.light = "STUDIO"; sh.color_type = "MATERIAL"; sh.show_cavity = True; sh.cavity_type = "BOTH"
sh.show_backface_culling = True; sh.show_specular_highlight = False
scn.render.resolution_x, scn.render.resolution_y = 600, 800
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, target, frm, lens=50, ortho=None):
    if ortho: cd.type = "ORTHO"; cd.ortho_scale = ortho
    else: cd.type = "PERSP"; cd.lens = lens
    cam.location = Vector(frm)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(out, f"trousers_{name}.png"); bpy.ops.render.render(write_still=True)
mid = (WAIST + GAITER) / 2
shot("front", (0, 0, mid), (0, -6, mid), ortho=1.3)
shot("side", (0, 0, mid), (6, 0, mid), ortho=1.3)
shot("back", (0, 0, mid), (0, 6, mid), ortho=1.3)
shot("threequarter", (0, 0, mid), (3.5, -4.5, mid + 0.6), ortho=1.3)
shot("knee", (0.1, 0, knee["Left"].z), (0.6, -0.9, knee["Left"].z + 0.15), lens=60)
shot("ankle", (0.1, 0, GAITER), (0.5, -0.7, GAITER + 0.15), lens=60)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "trousers.blend"))
print("DONE")
