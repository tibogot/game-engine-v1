"""THUNDERLINE'S ASSET KIT — what every obstacle / sign script shares (2026-10-28, after the tyre: thunderTyre.py has
its own copies of these, written first). Import it from a script in tools/blender/:

    import sys, os; sys.path.append(os.path.dirname(__file__)); import thunderKit as T

  T.S                      texture size (1024)
  T.QUICK, T.NOPREVIEW     the command line's --quick / --nopreview
  T.CACHE, T.TEX, T.REFS   .cache/blender/thunder-obstacles · public/textures/thunderline/obstacles · the previews
  T.grid()                 (VV, UU): each texel's v and u, rows = v from 0 (Blender's image rows, bottom up)
  T.noise(scale, oct)      tileable value noise in [0, 1]: periodic in u AND v (a lathe's seam never shows)
  T.smooth(e0, e1, x)      smoothstep (e0 > e1 flips it)
  T.render_text(items, h)  white letters on black in UV space: [(text, u, v, height_in_v, width_scale, mirror)] → S×S
  T.normal_from_height(h, du_m, dv_m)   tangent-space normal map (OpenGL, +Y = +v) from a height field in metres
  T.bake_ao(obj, dist)     the object's occlusion into its UV (Cycles), S×S
  T.save(name, arr, srgb)  a PNG in T.TEX (colour sRGB-encoded here; normal / "_arm" linear)
  T.export(objs, name)     geometry + UVs only, v pre-flipped (loadTexture keeps three's flipY) → T.CACHE/<name>.glb
  T.preview_scene()        a floor, a sun, a sky, a camera: returns (scene, camera)
"""
import bpy, sys, os, math
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "blender", "thunder-obstacles"); os.makedirs(CACHE, exist_ok=True)
TEX = os.path.join(ROOT, "public", "textures", "thunderline", "obstacles"); os.makedirs(TEX, exist_ok=True)
REFS = os.path.join(ROOT, "assets-src", "refs", "thunderline-obstacles"); os.makedirs(REFS, exist_ok=True)
QUICK = "--quick" in sys.argv
NOPREVIEW = "--nopreview" in sys.argv
S = 1024
FONT = next((p for p in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/impact.ttf") if os.path.exists(p)), None)
STENCIL = next((p for p in ("C:/Windows/Fonts/STENCIL.TTF", "C:/Windows/Fonts/impact.ttf", "C:/Windows/Fonts/arialbd.ttf") if os.path.exists(p)), None)
_rng = np.random.default_rng(1977)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def grid():
    v = (np.arange(S) + 0.5) / S
    return np.meshgrid(v, v, indexing="ij")   # VV (rows), UU (columns)

def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)

def noise(scale, octaves=3, seed=None):
    rng = np.random.default_rng(seed) if seed is not None else _rng
    acc = np.zeros((S, S), np.float32); amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = int(scale * 2 ** o)
        g = rng.random((n + 1, n + 1)).astype(np.float32); g[:, -1] = g[:, 0]; g[-1, :] = g[0, :]
        x = np.linspace(0, n, S, endpoint=False); xi = x.astype(int); fx = x - xi; fx = fx * fx * (3 - 2 * fx)
        fy, fxx = fx[:, None], fx[None, :]
        a = g[xi][:, xi]; b = g[xi][:, xi + 1]; c = g[xi + 1][:, xi]; d = g[xi + 1][:, xi + 1]
        acc += amp * (a * (1 - fxx) * (1 - fy) + b * fxx * (1 - fy) + c * (1 - fxx) * fy + d * fxx * fy); tot += amp; amp *= 0.5
    return acc / tot

def render_text(items, font=None):
    """items: [(text, u, v, height (in v units), x scale (u per v: the texel aspect), mirror)] → S×S in [0, 1]."""
    scn = bpy.data.scenes.new("Letters")
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "FLAT"; scn.display.shading.color_type = "SINGLE"; scn.display.shading.single_color = (1, 1, 1)
    scn.view_settings.view_transform = "Standard"
    scn.world = bpy.data.worlds.new("Black"); scn.world.color = (0, 0, 0)
    scn.render.resolution_x = scn.render.resolution_y = S
    f = bpy.data.fonts.load(font or FONT) if (font or FONT) else None
    for text, u, v, h, xs, mirror in items:
        cu = bpy.data.curves.new("T", "FONT"); cu.body = text; cu.size = h; cu.align_x = "CENTER"; cu.align_y = "CENTER"
        if f: cu.font = f
        o = bpy.data.objects.new("T", cu); scn.collection.objects.link(o)
        o.location = (u, v, 0); o.scale = (-xs if mirror else xs, 1, 1)
    cd = bpy.data.cameras.new("C"); cd.type = "ORTHO"; cd.ortho_scale = 1.0
    cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam; cam.location = (0.5, 0.5, 5)
    path = os.path.join(CACHE, f"letters_{len(items)}.png"); scn.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=scn.name)
    img = bpy.data.images.load(path)
    return np.array(img.pixels[:], np.float32).reshape(S, S, 4)[..., 0]

def normal_from_height(h, du_m, dv_m):
    gy, gx = np.gradient(h)
    nx, ny = -gx / du_m, -gy / dv_m
    nz = np.ones_like(nx); n = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / n * 0.5 + 0.5, ny / n * 0.5 + 0.5, nz / n * 0.5 + 0.5], -1)

def bake_ao(o, dist=0.12):
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"; scn.cycles.samples = 16 if QUICK else 96; scn.cycles.device = "CPU"
    if scn.world is None: scn.world = bpy.data.worlds.new("W")
    scn.world.light_settings.distance = dist
    img = bpy.data.images.new("AO", S, S, float_buffer=True)
    mat = bpy.data.materials.new("Bake"); mat.use_nodes = True
    nt = mat.node_tree; tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img; nt.nodes.active = tex
    o.data.materials.clear(); o.data.materials.append(mat)
    # ALONE in the bake (2026-10-28): the other levels sat in the same place — a dent or a groove of LOD0 inside the
    # coarser LOD1's shell baked as fully occluded (black blobs with LOD1's facets for edges)
    others = [x for x in bpy.context.scene.objects if x is not o and not x.hide_render]
    for x in others: x.hide_render = True
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.bake(type="AO", margin=6, use_clear=True)
    for x in others: x.hide_render = False
    a = np.array(img.pixels[:], np.float32).reshape(S, S, 4)[..., 0]
    o.data.materials.clear()
    return a

def save(name, arr, srgb):
    img = bpy.data.images.new(name, S, S, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    px = np.ones((S, S, 4), np.float32)
    px[..., :3] = np.clip(np.clip(arr, 0, 1) ** (1 / 2.2) if srgb else arr, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = os.path.join(TEX, f"{name}.png"); img.file_format = "PNG"; img.save()
    return img

def _flip_v(objs):
    for o in objs:
        for d in o.data.uv_layers[0].data: d.uv = (d.uv[0], 1.0 - d.uv[1])

def export(objs, name):
    for o in objs: o.data.materials.clear()
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    _flip_v(objs)
    bpy.ops.export_scene.gltf(filepath=os.path.join(CACHE, f"{name}.glb"), export_format="GLB", use_selection=True, export_yup=True,
                              export_materials="NONE", export_texcoords=True, export_normals=True, export_apply=True)
    _flip_v(objs)

def material(name, col, nrm, arm):
    """A Principled material on the three images (the preview's; the game builds its own from the PNGs)."""
    mat = bpy.data.materials.new(name); mat.use_nodes = True; nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexImage"); tc.image = col; nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    ta = nt.nodes.new("ShaderNodeTexImage"); ta.image = arm; sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(ta.outputs["Color"], sep.inputs[0]); nt.links.new(sep.outputs[1], bsdf.inputs["Roughness"]); nt.links.new(sep.outputs[2], bsdf.inputs["Metallic"])
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = nrm; nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    return mat

def preview_scene():
    scn = bpy.context.scene
    bpy.ops.mesh.primitive_plane_add(size=40); fl = bpy.context.active_object
    fm = bpy.data.materials.new("Floor"); fm.use_nodes = True; fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.18, 0.18, 0.19, 1)
    fl.data.materials.append(fm)
    sun = bpy.data.lights.new("Sun", "SUN"); sun.energy = 4.0; sun.angle = math.radians(2)
    so = bpy.data.objects.new("Sun", sun); scn.collection.objects.link(so); so.rotation_euler = (math.radians(52), 0, math.radians(35))
    if scn.world is None: scn.world = bpy.data.worlds.new("W")
    scn.world.use_nodes = True; bg = scn.world.node_tree.nodes["Background"]; bg.inputs["Color"].default_value = (0.55, 0.65, 0.8, 1); bg.inputs["Strength"].default_value = 0.6
    cd = bpy.data.cameras.new("C"); cd.lens = 50; cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
    scn.render.engine = "CYCLES"; scn.render.resolution_x, scn.render.resolution_y = 1400, 800; scn.cycles.samples = 24 if QUICK else 96
    scn.view_settings.view_transform = "AgX"
    return scn, cam

def shoot(scn, cam, name, loc, aim):
    cam.location = loc; cam.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(REFS, f"{name}.png"); bpy.ops.render.render(write_still=True)

def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
