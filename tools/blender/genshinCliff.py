"""GENSHIN-STYLE HERO CLIFF, built in Blender (2026-10-14, you: "create a page just
to show me the cliff done in blender; check Genshin Impact's typical stylized
cliffs").

What the refs show (the Genshin cliff with the grass ledges, the Fab cliff kit):
  - TIERS: a lower wall and an upper one set back, grass on each ledge
  - each tier is big BLOCKS: columns split by VERTICAL JOINTS (real gaps: the
    crevasses), courses split by horizontal BEDDING, every block a little in or
    out, a little tilted, its edges bevelled and its corners CHIPPED by flat
    chisel cuts
  - fine CRACKS over the faces, painted dark; light worn edges
  - blue-grey stone, lighter high up, cool and dark in the joints; grass tops

How:
  LOW  the blocks themselves (bevelled boxes, boolean chisel cuts) -> the game mesh
  HIGH a voxel-remeshed copy with a crack network displaced in (Voronoi F2-F1)
  (v2, after the first preview read as clean boxes with crazy paving: each
  block is remeshed, pushed into big soft lumps, then DECIMATED to a few
  hundred faces — the big irregular flat facets of a chiselled stylized rock;
  the pre-decimate copy, plus fine grain, is the HIGH mesh)
  BAKE high -> low in Cycles: the NORMAL map, and a PAINTED colour map
       (stone gradient x AO x cracks x worn edges, grass on what faces up)
  glTF out, plus preview renders to judge before the engine sees it.

  blender -b -P tools/blender/genshinCliff.py -- <out.glb> <preview_dir> [seed]
"""
import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "genshin_cliff.glb")
PREV = os.path.abspath(argv[1] if len(argv) > 1 else os.path.dirname(OUT))
SEED = int(argv[2]) if len(argv) > 2 else 3
TEX = 2048
rng = random.Random(SEED)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
os.makedirs(PREV, exist_ok=True)

# ── clean scene ──────────────────────────────────────────────────────────────
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def select_only(*objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[-1]


def apply_mods(obj):
    select_only(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def box(name, cx, cy, cz, sx, sy, sz, rx=0.0, ry=0.0, rz=0.0):
    """A box from its centre and FULL sizes (Blender: Z up, front = -Y)."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(me)
    bm.free()
    ob = link(bpy.data.objects.new(name, me))
    ob.scale = (sx, sy, sz)
    ob.rotation_euler = (rx, ry, rz)
    ob.location = (cx, cy, cz)
    select_only(ob)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ob


# ── THE BLOCKS ───────────────────────────────────────────────────────────────
# Two tiers. x across (26 m), y depth (front at y = front), z up; ground z = 0,
# everything runs 3 m below it (buried in the game). FEW, BIG blocks that
# overlap (narrow, irregular joints), each a little in or out and tilted.
TIERS = [
    dict(z0=-3.0, z1=8.5, front=0.0, depth=9.0, width=26.0, x0=0.0),
    dict(z0=5.5, z1=15.5, front=4.0, depth=8.0, width=22.0, x0=1.0),
]
boxes = []
for ti, T in enumerate(TIERS):
    x = -T["width"] / 2 + T["x0"]
    xe = T["width"] / 2 + T["x0"]
    while x < xe - 1.5:
        w = min(rng.uniform(3.6, 6.5), xe - x)
        overlap = rng.uniform(-0.05, 0.35)                  # < 0: a joint opens
        top = T["z1"] + rng.uniform(-1.2, 0.4)
        out = rng.uniform(-0.7, 0.5)
        courses = rng.choice([1, 1, 2])
        cut = rng.uniform(T["z0"] + 4.0, top - 2.5) if courses == 2 else None
        spans = [(T["z0"], cut), (cut, top)] if cut else [(T["z0"], top)]
        for k, (za, zb) in enumerate(spans):
            setback = 0.35 * k + rng.uniform(-0.2, 0.3)
            depth = T["depth"] + rng.uniform(-0.8, 0.8)
            b = box(f"blk_{ti}_{len(boxes)}", x + w / 2 + rng.uniform(-0.2, 0.2), T["front"] + out + setback + depth / 2,
                    (za + zb) / 2, w + overlap, depth, zb - za,
                    rx=math.radians(rng.uniform(-3, 3)), ry=math.radians(rng.uniform(-3, 3)), rz=math.radians(rng.uniform(-4, 4)))
            boxes.append(b)
        x += w

# Each block: remesh -> big soft lumps -> (HIGH copy: + fine grain for the
# normal bake) -> LOW: decimate to a few hundred faces. The decimation is what
# leaves the big irregular FLAT FACETS of a hand-chiselled stylized rock.
lumps_big = bpy.data.textures.new("lumpsBig", type="CLOUDS"); lumps_big.noise_scale = 3.5; lumps_big.noise_depth = 1
lumps_mid = bpy.data.textures.new("lumpsMid", type="CLOUDS"); lumps_mid.noise_scale = 0.9; lumps_mid.noise_depth = 2
grain = bpy.data.textures.new("grain", type="STUCCI"); grain.noise_scale = 0.35; grain.turbulence = 5.0
lows, highs = [], []
for b in boxes:
    # 1-2 big CHISEL cuts through a top corner / edge first: the remesh and the
    # decimation melt them into the facets (a slanted top, a sheared corner)
    dims = b.dimensions
    for _ in range(rng.choice([1, 2])):
        sxn = rng.choice([-1, 1])
        s = rng.uniform(1.6, 3.2)
        cutter = box("cut", b.location.x + sxn * dims.x / 2, b.location.y - dims.y / 2 + rng.uniform(0, 1.5), b.location.z + dims.z / 2,
                     s, s * 1.6, s, rx=math.radians(rng.uniform(25, 60)), ry=math.radians(rng.uniform(25, 60)), rz=math.radians(rng.uniform(10, 80)))
        mod = b.modifiers.new("chisel", "BOOLEAN"); mod.operation = "DIFFERENCE"; mod.object = cutter; mod.solver = "EXACT"
        apply_mods(b)
        bpy.data.objects.remove(cutter, do_unlink=True)
    rem = b.modifiers.new("remesh", "REMESH"); rem.mode = "VOXEL"; rem.voxel_size = 0.12
    d1 = b.modifiers.new("big", "DISPLACE"); d1.texture = lumps_big; d1.texture_coords = "GLOBAL"; d1.strength = 1.3; d1.mid_level = 0.5
    d2 = b.modifiers.new("mid", "DISPLACE"); d2.texture = lumps_mid; d2.texture_coords = "GLOBAL"; d2.strength = 0.18; d2.mid_level = 0.5
    apply_mods(b)
    area = sum(p.area for p in b.data.polygons)
    dec = b.modifiers.new("facets", "DECIMATE"); dec.decimate_type = "COLLAPSE"
    dec.ratio = max(0.002, min(1.0, (area / 5.0) / max(1, len(b.data.polygons))))   # ~1 face per 5 m²: BIG facets
    apply_mods(b)
    lows.append(b)
    # the bake source is the faceted block itself: Genshin's faces are clean
    # planes (a fine-grain high mesh baked crumpled-paper normals into them)
    hi = b.copy(); hi.data = b.data.copy(); link(hi)
    highs.append(hi)

# ── LOW: the faceted blocks joined (separate shells; overlap is fine) ────────
select_only(*lows)
bpy.ops.object.join()
low = bpy.context.view_layer.objects.active
low.name = "GenshinCliff"
select_only(low)
bpy.ops.object.shade_flat()
bpy.ops.object.shade_auto_smooth(angle=math.radians(28))

# ── HIGH: the detailed blocks joined ─────────────────────────────────────────
select_only(*highs)
bpy.ops.object.join()
high = bpy.context.view_layer.objects.active
high.name = "high"
print("[cliff] high faces", len(high.data.polygons), "low faces", len(low.data.polygons))

# ── UVs on the low mesh ──────────────────────────────────────────────────────
select_only(low)
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(40), island_margin=0.004, area_weight=0.0)
bpy.ops.object.mode_set(mode="OBJECT")

# ── the PAINTED look, on the high mesh (baked to the low one) ────────────────
def painted_material():
    m = bpy.data.materials.new("painted")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N = nt.nodes.new
    L = nt.links.new
    out = N("ShaderNodeOutputMaterial")
    emit = N("ShaderNodeEmission")
    L(emit.outputs[0], out.inputs["Surface"])
    geo = N("ShaderNodeNewGeometry")
    sep = N("ShaderNodeSeparateXYZ"); L(geo.outputs["Position"], sep.inputs[0])
    sepn = N("ShaderNodeSeparateXYZ"); L(geo.outputs["Normal"], sepn.inputs[0])
    # stone: dark cool blue-grey low -> light grey-blue high
    hgt = N("ShaderNodeMapRange"); L(sep.outputs["Z"], hgt.inputs["Value"])
    hgt.inputs["From Min"].default_value = -2.0
    hgt.inputs["From Max"].default_value = 16.0
    ramp = N("ShaderNodeValToRGB"); L(hgt.outputs[0], ramp.inputs[0])
    ramp.color_ramp.elements[0].color = (0.10, 0.13, 0.19, 1)
    ramp.color_ramp.elements[1].color = (0.36, 0.40, 0.47, 1)
    # cracks: the same Voronoi F2-F1 as the displacement -> dark lines
    vor = N("ShaderNodeTexVoronoi")
    vor.feature = "DISTANCE_TO_EDGE"
    vor.inputs["Scale"].default_value = 1.0 / 1.6 * 1.0
    L(geo.outputs["Position"], vor.inputs["Vector"])
    cr = N("ShaderNodeMapRange"); L(vor.outputs["Distance"], cr.inputs["Value"])
    cr.inputs["From Min"].default_value = 0.0
    cr.inputs["From Max"].default_value = 0.06
    cr.inputs["To Min"].default_value = 0.45
    cr.inputs["To Max"].default_value = 1.0
    # AO: the joints and crevasses go dark and cool
    ao = N("ShaderNodeAmbientOcclusion")
    ao.inputs["Distance"].default_value = 1.2
    aor = N("ShaderNodeMapRange"); L(ao.outputs["AO"], aor.inputs["Value"])
    aor.inputs["To Min"].default_value = 0.35
    # worn edges: pointiness lighter
    pt = N("ShaderNodeMapRange"); L(geo.outputs["Pointiness"], pt.inputs["Value"])
    pt.inputs["From Min"].default_value = 0.52
    pt.inputs["From Max"].default_value = 0.62
    pt.inputs["To Min"].default_value = 1.0
    pt.inputs["To Max"].default_value = 1.35
    m1 = N("ShaderNodeMix"); m1.data_type = "RGBA"; m1.blend_type = "MULTIPLY"; m1.inputs["Factor"].default_value = 1.0
    L(ramp.outputs[0], m1.inputs[6]); L(aor.outputs[0], m1.inputs[7])
    # (no Voronoi cell cracks in the colour: they read as crazy paving — the
    # cracks are the real joints between blocks, dark through the AO)
    m2 = N("ShaderNodeMix"); m2.data_type = "RGBA"; m2.blend_type = "MULTIPLY"; m2.inputs["Factor"].default_value = 0.0
    L(m1.outputs[2], m2.inputs[6]); L(cr.outputs[0], m2.inputs[7])
    m3 = N("ShaderNodeMix"); m3.data_type = "RGBA"; m3.blend_type = "MULTIPLY"; m3.inputs["Factor"].default_value = 1.0
    L(m2.outputs[2], m3.inputs[6]); L(pt.outputs[0], m3.inputs[7])
    # grass on what faces up (ragged edge from noise), darker at its border
    noise = N("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 0.6
    L(geo.outputs["Position"], noise.inputs["Vector"])
    up = N("ShaderNodeMath"); up.operation = "ADD"
    L(sepn.outputs["Z"], up.inputs[0])
    nsub = N("ShaderNodeMath"); nsub.operation = "MULTIPLY_ADD"
    L(noise.outputs["Fac"], nsub.inputs[0]); nsub.inputs[1].default_value = 0.35; nsub.inputs[2].default_value = -0.175
    L(nsub.outputs[0], up.inputs[1])
    gmask = N("ShaderNodeMapRange"); L(up.outputs[0], gmask.inputs["Value"])
    gmask.inputs["From Min"].default_value = 0.72
    gmask.inputs["From Max"].default_value = 0.86
    gcol = N("ShaderNodeValToRGB"); L(gmask.outputs[0], gcol.inputs[0])
    gcol.color_ramp.elements[0].color = (0.05, 0.14, 0.03, 1)
    gcol.color_ramp.elements[1].color = (0.13, 0.34, 0.05, 1)
    mg = N("ShaderNodeMix"); mg.data_type = "RGBA"
    L(gmask.outputs[0], mg.inputs["Factor"]); L(m3.outputs[2], mg.inputs[6]); L(gcol.outputs[0], mg.inputs[7])
    L(mg.outputs[2], emit.inputs["Color"])
    return m


high.data.materials.clear()
high.data.materials.append(painted_material())

# the low mesh's material: the image targets (and, after the bake, the game material)
col_img = bpy.data.images.new("cliff_color", TEX, TEX)
nrm_img = bpy.data.images.new("cliff_normal", TEX, TEX, float_buffer=False)
nrm_img.colorspace_settings.name = "Non-Color"
lowmat = bpy.data.materials.new("GenshinCliff")
lowmat.use_nodes = True
nt = lowmat.node_tree
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 0.9
tc = nt.nodes.new("ShaderNodeTexImage"); tc.image = col_img
tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = nrm_img
nm = nt.nodes.new("ShaderNodeNormalMap")
nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
# (no normal map: the faces are meant to be clean planes)
low.data.materials.clear()
low.data.materials.append(lowmat)

# ── BAKE (Cycles, high -> low) ───────────────────────────────────────────────
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
bk = scene.render.bake
bk.use_selected_to_active = True
bk.cage_extrusion = 0.25
bk.max_ray_distance = 0.6
bk.margin = 8


def bake(img, kind):
    for n in nt.nodes:
        n.select = False
    target = tc if img is col_img else tn
    target.select = True
    nt.nodes.active = target
    select_only(high, low)
    if kind == "EMIT":
        bpy.ops.object.bake(type="EMIT")
    else:
        bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
    img.filepath_raw = os.path.join(PREV, img.name + ".png")
    img.file_format = "PNG"
    img.save()


bake(col_img, "EMIT")
print("[cliff] colour baked")

col_img.pack()


# ── export the low mesh (glTF: Y up, front -Y -> +Z) ─────────────────────────
bpy.data.objects.remove(high, do_unlink=True)
select_only(low)
bpy.ops.export_scene.gltf(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True,
                          export_image_format="JPEG", export_jpeg_quality=92)
print("[cliff] wrote", OUT, "tris", sum(len(p.vertices) - 2 for p in low.data.polygons))

# ── previews: sun + sky, three angles ────────────────────────────────────────
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (0.42, 0.6, 0.95, 1)
bg.inputs["Strength"].default_value = 0.8
sun = link(bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN")))
sun.data.energy = 4.0
sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
ground = box("ground", 0, 10, -0.05, 120, 120, 0.1)
gm = bpy.data.materials.new("g"); gm.use_nodes = True
gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.3, 0.05, 1)
ground.data.materials.append(gm)
cam = link(bpy.data.objects.new("cam", bpy.data.cameras.new("cam")))
cam.data.lens = 35
scene.camera = cam
scene.render.resolution_x, scene.render.resolution_y = 1280, 720
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.film_transparent = False
scene.view_settings.view_transform = "AgX"
for i, (pos, tgt) in enumerate([((0, -38, 9), (0, 0, 7)), ((-26, -26, 12), (0, 2, 6)), ((10, -14, 4), (2, 0, 6))]):
    cam.location = Vector(pos)
    d = Vector(tgt) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.join(PREV, f"preview_{i}.png")
    bpy.ops.render.render(write_still=True)
print("[cliff] previews in", PREV)
