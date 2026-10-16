"""THE NEW SOLDIER BODY (2026-10-15, you: "compared to Company of Heroes it reads too cartoonish — create
one French appelé, very optimised"). Stage 1: the BODY and its RIG, from MPFB 2 (MakeHuman for Blender,
GPL code, CC0 base mesh — installed as the Blender extension `mpfb`). Run headless:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/soldierBody.py -- assets-src/soldiers/appele2

Makes a young man of realistic proportions (~7.5 heads, the CoH look — the old pack soldier is a
cartoon: big head and hands, short legs), rigs him with MPFB's MIXAMO rig (Mixamo's own bone names and
weights, its joints placed for THIS body — the pack's clips drive it by name), and writes:
  <out>/body.blend      the human + rig (stage 2, the uniform, starts from it)
  <out>/preview_*.png   front / side / three-quarter renders, to judge the proportions
  <out>/body.json       height, joint heights, triangle count
"""
import bpy, bmesh, sys, os, json, math, addon_utils
from mathutils import Vector

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
os.makedirs(out, exist_ok=True)

# MPFB is a user extension: not loaded under --factory-startup until enabled by its module name.
addon_utils.enable("bl_ext.user_default.mpfb", default_set=True, persistent=False)   # (in the prefs: MPFB reads its own)
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()

# A conscript of 20: male, lean and fit (a soldier, not a body-builder), average height, the
# "idealised" proportions MakeHuman gives (0.5 = average; higher: longer legs, smaller head).
macro = TargetService.get_default_macro_info_dict()
macro.update({"gender": 1.0, "age": 0.44, "muscle": 0.62, "weight": 0.42, "proportions": 0.7, "height": 0.55})
macro["race"] = {"caucasian": 0.8, "african": 0.05, "asian": 0.15}
# (detailed_helpers: the rig places its joints on the helper "joint" cubes — off, every joint fell back
# to MPFB's default T-pose spot: the arm bones floated above the arms, nothing weighted to a forearm)
body = HumanService.create_human(mask_helpers=True, detailed_helpers=True, extra_vertex_groups=True,
                                 feet_on_ground=True, scale=0.1, macro_detail_dict=macro)
rig = HumanService.add_builtin_rig(body, "mixamo")
body.name, rig.name = "Body", "Rig"

# The helpers masked away: apply the mask so what is measured and exported is the body only.
bpy.context.view_layer.objects.active = body
# The macro targets are SHAPE KEYS: baked into the mesh as they are mixed (the rig is fitted already).
if body.data.shape_keys:
    bpy.ops.object.shape_key_remove(all=True, apply_mix=True)
# The MASK keeps the skin AND the two EYE helpers (spheres fitted in the sockets — MPFB's eyes are
# separate assets we do not use: without them the sockets read as holes in his face, 2026-10-15).
for m in list(body.modifiers):
    if m.type == "MASK":
        body.modifiers.remove(m)
keepg = [body.vertex_groups[n].index for n in ("body", "helper-l-eye", "helper-r-eye") if n in body.vertex_groups]
_bm = bmesh.new(); _bm.from_mesh(body.data)
dl = _bm.verts.layers.deform.active
gone = [v for v in _bm.verts if not any(g in v[dl] for g in keepg)]
bmesh.ops.delete(_bm, geom=gone, context="VERTS")
_bm.to_mesh(body.data); _bm.free()
print("EYES kept:", sum(1 for v in body.data.vertices if any(body.vertex_groups[e.group].name.startswith("helper-") and body.vertex_groups[e.group].name.endswith("-eye") for e in v.groups)), "verts")

# ── HIS SKIN WEIGHTS: Blender's automatic (bone heat) ────────────────────────
# MPFB's bundled Mixamo weights did not deform this body (posed, the arms and legs went elsewhere than
# their bones; the hands barely weighted): they are dropped, and the mesh skinned to the rig by bone heat.
for g in [g for g in body.vertex_groups if g.name.startswith("mixamorig:")]:
    body.vertex_groups.remove(g)
for m in [m for m in body.modifiers if m.type == "ARMATURE"]:
    body.modifiers.remove(m)
# The BONE TAILS first: bone heat weights each vertex by its distance to the bone's segment, and MPFB's
# Mixamo hands run 50 cm (back over the forearm): the forearms came out weighted to the HANDS (not one
# vertex to a forearm — the arm folded at the wrist in the game). Each chain bone ends at its child's
# joint, the hand at the middle knuckle, the foot at the toes, the head ~18 cm up.
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="EDIT")
eb = rig.data.edit_bones
TAIL_TO = {"Hips": "Spine", "Spine": "Spine1", "Spine1": "Spine2", "Spine2": "Neck", "Neck": "Head",
           "Shoulder": "Arm", "Arm": "ForeArm", "ForeArm": "Hand", "Hand": "HandMiddle1", "UpLeg": "Leg", "Leg": "Foot", "Foot": "ToeBase"}
fixed = 0
for b in eb:
    k = b.name.split(":")[-1]
    side = "Left" if k.startswith("Left") else "Right" if k.startswith("Right") else ""
    part = k[len(side):]
    if part in TAIL_TO and "mixamorig:" + side + TAIL_TO[part] in eb:
        b.tail = eb["mixamorig:" + side + TAIL_TO[part]].head.copy(); fixed += 1
    elif part == "Head":
        b.tail = b.head + Vector((0, 0, 0.18)); fixed += 1
    elif part == "ToeBase":
        b.tail = b.head + (b.head - eb["mixamorig:" + side + "Foot"].head).normalized() * 0.06; fixed += 1
bpy.ops.object.mode_set(mode="OBJECT")
print("TAILS", fixed, "bones re-ended")
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True)
rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
print("WEIGHTS", sum(1 for g in body.vertex_groups if g.name.startswith("mixamorig:")), "bone groups")

# ── HIS HANDS CLOSED ON A GRIP (2026-10-15, you: "zoom on his hand and finger placement") ────────────
# The pack's clips move no finger (the old rig has no finger keys worth keeping): his fingers stay as they
# REST — MPFB's flat open hand, the fingers splayed off the rifle. So his rest is a grip: each finger curled
# toward the palm, joint by joint (a rifle's wrist ~4 cm thick), the thumb across — applied as his rest.
# Each joint turns about the axis across the finger, the way that brings its tip toward the thumb's root
# (the palm side), measured — MPFB's bone rolls are not trusted.
from mathutils import Matrix
CURL = {"Index": (42, 55, 35), "Middle": (55, 65, 40), "Ring": (60, 68, 42), "Pinky": (64, 70, 44), "Thumb": (8, 22, 25)}
# FOR MIXAMO (--flat-hands, 2026-10-15): the auto-rigger places the finger bones on OPEN hands and the
# clips then animate them — no curl.
if "--flat-hands" in sys.argv:
    CURL = {k: (0, 0, 0) for k in CURL}
bpy.ops.object.select_all(action="DESELECT")
bpy.context.view_layer.objects.active = rig
rig.select_set(True)
bpy.ops.object.mode_set(mode="POSE")
pbs = rig.pose.bones
def head(n): bpy.context.view_layer.update(); return pbs[n].head.copy()
def turn(pb, q, at):
    pb.matrix = Matrix.Translation(at) @ q.to_matrix().to_4x4() @ Matrix.Translation(-at) @ pb.matrix
curled = 0
for side in ("Left", "Right"):
    pre = "mixamorig:" + side + "Hand"
    if pre not in pbs: continue
    for f, angles in CURL.items():
        names = [f"{pre}{f}{i}" for i in (1, 2, 3)]
        if not all(n in pbs for n in names): continue
        palm_ref = head(pre + "Thumb1") if f != "Thumb" else head(pre + "Middle1")
        for j, n in enumerate(names):
            pb = pbs[n]
            h = head(n)
            tipn = names[j + 1] if j < 2 else None
            tip = head(tipn) if tipn else (rig.matrix_world.inverted() @ (rig.matrix_world @ pb.tail))
            d = (tip - h)
            if d.length < 1e-6: continue
            # across the finger: perpendicular to it and to the hand's spread (index→pinky knuckles)
            spread = head(pre + "Pinky1") - head(pre + "Index1")
            axis = d.cross(spread).normalized()
            if f == "Thumb":
                axis = d.cross(head(pre + "Index1") - head(pre + "Thumb1")).normalized()
            best = None
            for sgn in (1, -1):
                from mathutils import Quaternion
                q = Quaternion(axis, math.radians(angles[j]) * sgn)
                newtip = h + q @ d
                dist = (newtip - palm_ref).length
                if best is None or dist < best[0]: best = (dist, q)
            # the whole rest of the finger turns with this joint (children follow in pose space)
            turn(pb, best[1], h)
            curled += 1
bpy.context.view_layer.update()
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = body
for m in [m for m in body.modifiers if m.type == "ARMATURE"]:
    bpy.ops.object.modifier_apply(modifier=m.name)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="POSE")
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode="OBJECT")
am = body.modifiers.new("Armature", "ARMATURE"); am.object = rig
print("FINGERS", curled, "joints curled into a grip")

# HIS REST POSE stays MPFB's A-pose: the clips are RETARGETED in the pack (tools/packMixamo.mjs, three's
# own skinning — what the game draws): his limbs aligned to the Mixamo rig's rest there, each clip
# applied as world turns from rest. (Posing him in Blender to the T-pose and applying it as rest moved
# the mesh's arms away from their bones — 35 cm at the wrist; three is measurable, Blender here was not.)

dg = bpy.context.evaluated_depsgraph_get()
ev = body.evaluated_get(dg)
zs = [(body.matrix_world @ v.co).z for v in ev.data.vertices]
H = max(zs) - min(zs)
tris = sum(len(p.vertices) - 2 for p in ev.data.polygons)
bones = {b.name: [round(c, 3) for c in (rig.matrix_world @ b.head_local)] for b in rig.data.bones}
head_h = H - bones["mixamorig:Neck"][2]
info = {"height_m": round(H, 3), "heads_tall": round(H / max(1e-6, head_h * 0.95), 2), "tris": tris,
        "bones": len(bones), "joints": {k.split(":")[1]: v for k, v in bones.items() if not any(f in k for f in ("Thumb", "Index", "Middle", "Ring", "Pinky"))}}
json.dump(info, open(os.path.join(out, "body.json"), "w"), indent=1)
print("BODY", json.dumps({k: info[k] for k in ("height_m", "heads_tall", "tris", "bones")}))

# ── Previews: workbench, flat grey studio, orthographic ──────────────────────
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
scn.display.shading.light = "STUDIO"
scn.display.shading.color_type = "SINGLE"
scn.display.shading.single_color = (0.62, 0.6, 0.55)
scn.display.shading.show_cavity = True
scn.render.resolution_x, scn.render.resolution_y = 700, 900
scn.render.film_transparent = False
scn.world = scn.world or bpy.data.worlds.new("W")
cam_data = bpy.data.cameras.new("Cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = H * 1.15
cam = bpy.data.objects.new("Cam", cam_data)
scn.collection.objects.link(cam)
scn.camera = cam
rig.hide_render = True
for name, yaw in (("front", 0), ("side", 90), ("threequarter", 35)):
    # (MPFB's human faces -Y: a camera on the -Y side looks at his front; yaw turns it round him)
    a = math.radians(yaw)
    cam.location = Vector((math.sin(a) * 6, -math.cos(a) * 6, H * 0.5))
    cam.rotation_euler = (math.radians(90), 0, a)
    scn.render.filepath = os.path.join(out, f"preview_{name}.png")
    bpy.ops.render.render(write_still=True)

bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(os.path.join(out, "body.blend")))
# The skinned body + rig for the pack: glTF, Y up, metres.
bpy.ops.object.select_all(action="DESELECT")
body.select_set(True); rig.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "body.glb"), use_selection=True, export_animations=False,
                          export_skins=True, export_yup=True, export_apply=False, export_materials="NONE")
print("DONE", out)
