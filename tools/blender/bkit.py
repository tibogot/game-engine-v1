"""THE BLENDER KIT (2026-10-19): what tools/blender/motorPool.py proved, shared by the buildings that follow
(tools/blender/house.py first). Game coordinates everywhere (x, y up, FRONT at -Z, metres as the game builds
them — the game draws them x1.3); procedural colour trees on the repo's photo textures, BAKED (colour x AO)
into one atlas per object — one draw, one texture, the CoH read (no normal map).

    import bkit; K = bkit.Kit(MATDEF, groups=("house",))
    K.box("Wall", x0, x1, y0, y1, z0, z1, "render", "house")
    ...
    obj = K.join("House", K.groups["house"]); K.bake(obj, 2048, "House"); K.export(path, [obj])
"""
import bpy, bmesh, math, os, random
import numpy as np
from mathutils import Vector, noise as mnoise

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TEX = os.path.join(ROOT, "public", "textures")

def B(x, y, z): return Vector((x, -z, y))           # game (x, y up, z) → Blender (z up; game -Z = Blender +Y)

# THE BAKE ON THE GPU (2026-10-27, you: "is there a way we can go faster"): `--gpu` on a script's command line (or
# BKIT_GPU=1) bakes with Cycles on the graphics card — OptiX, else CUDA, else HIP; the CPU when none answers. Opt-in: it
# shares the GPU with whatever is on the screen.
_device = None
def bakeDevice(scn):
    global _device
    if _device is None:
        _device = "CPU"
        if "--gpu" in __import__("sys").argv or os.environ.get("BKIT_GPU"):
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for kind in ("OPTIX", "CUDA", "HIP"):
                try:
                    prefs.compute_device_type = kind
                    prefs.get_devices()
                    gpus = [d for d in prefs.devices if d.type == kind]
                    if gpus:
                        for d in prefs.devices: d.use = d.type == kind
                        _device = "GPU"
                        print(f"BAKE on the GPU ({kind}: {', '.join(d.name for d in gpus)})", flush=True)
                        break
                except Exception: continue
            if _device == "CPU": print("BAKE: no GPU answered — the CPU", flush=True)
    scn.cycles.device = _device
def gv(*p): return Vector(p)
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
        nsep = s.N.new("ShaderNodeSeparateXYZ"); s.L.new(s.geo.outputs["Normal"], nsep.inputs[0])
        s.ny = nsep.outputs["Z"]
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
    """Dust settled at the foot of everything, up to `top` m."""
    f = nb.math("MULTIPLY", nb.mr(nb.gy, 0.05, top, 0.75 * k, 0.06 * k), nb.noise(4.0, 6))
    return nb.mix(nb.math("MULTIPLY", f, 1.7), col, DUST)
def flat(rgb, top=1.1):
    return lambda nb: dust(nb, nb.mix(nb.noise(2.0, 3), rgb, tuple(c * 0.82 for c in rgb)), top)
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

class Kit:
    def __init__(s, matdef, groups, low=False):
        s.MATDEF = matdef; s.MAT = {}; s.groups = {g: [] for g in groups}; s.low = low; s.cutters = []
    # ── materials ──
    def mat(s, name):
        if name not in s.MAT:
            m = bpy.data.materials.new(name); m.use_nodes = True
            pb = m.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = s.MATDEF[name][0]
            m.node_tree.links.new(s.MATDEF[name][1](NB(m)), pb.inputs["Base Color"])
            s.MAT[name] = m
        return s.MAT[name]
    # ── geometry ──
    def obj(s, name, bm, mat, group, smooth=False):
        m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
        o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o)
        o.data.materials.append(s.mat(mat))
        for p in o.data.polygons: p.use_smooth = smooth
        s.groups[group].append(o)
        return o
    def bevel(s, o, w=0.01, seg=2, angle=40):
        if w < 0.005 or s.low: return o
        b = o.modifiers.new("B", "BEVEL"); b.width = w; b.segments = seg; b.limit_method = "ANGLE"; b.angle_limit = math.radians(angle)
        return o
    def box(s, name, x0, x1, y0, y1, z0, z1, mat, group, w=0.01):
        bm = bmesh.new()
        vs = [bm.verts.new(B(x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
        bmesh.ops.convex_hull(bm, input=vs)
        return s.bevel(s.obj(name, bm, mat, group), w)
    def frame_of(s, a, b, up):
        d = (b - a).normalized(); u = d.cross(up)
        if u.length < 1e-4: u = d.cross(gv(0, 0, 1) if abs(d.z) < 0.9 else gv(1, 0, 0))
        u.normalize(); v = u.cross(d).normalized()
        return d, u, v
    def member(s, name, a, b, prof, mat, group, up=(0, 1, 0), w=0.004, smooth=False):
        a, b = gv(*a), gv(*b); d, u, v = s.frame_of(a, b, gv(*up))
        bm = bmesh.new()
        ring = lambda p: [bm.verts.new(B(*(p + u * pu + v * pv))) for pu, pv in prof]
        r0, r1 = ring(a), ring(b); n = len(prof)
        for i in range(n):
            j = (i + 1) % n; bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
        bm.faces.new(r0); bm.faces.new(list(reversed(r1)))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return s.bevel(s.obj(name, bm, mat, group, smooth), w, 1, 50)
    def rod(s, name, a, b, r, mat, group, n=8):
        return s.member(name, a, b, [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n)) for i in range(n)], mat, group, w=0, smooth=True)
    def cyl(s, name, c, r, h, mat, group, n=16, r2=None, w=0.006):
        a = gv(*c); bm = bmesh.new(); rr = r if r2 is None else r2
        rb = [bm.verts.new(B(a.x + r * math.cos(t), a.y, a.z + r * math.sin(t))) for t in (2 * math.pi * i / n for i in range(n))]
        rt = [bm.verts.new(B(a.x + rr * math.cos(t), a.y + h, a.z + rr * math.sin(t))) for t in (2 * math.pi * i / n for i in range(n))]
        for i in range(n):
            j = (i + 1) % n; bm.faces.new((rb[i], rb[j], rt[j], rt[i]))
        bm.faces.new(rb); bm.faces.new(list(reversed(rt)))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return s.bevel(s.obj(name, bm, mat, group, smooth=True), w, 2, 50)
    def lump(s, name, c, size, mat, group, seed=0, rough=0.35, sub=2, flatten=1.0):
        """A noisy rock / rubble lump: an icosphere pushed in and out, `size` (x, y, z) half-extents."""
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
        off = Vector((seed * 3.17, seed * 1.31, seed * 2.03))
        for v in bm.verts:
            k = 1 + rough * mnoise.noise(v.co * 1.8 + off)
            v.co = Vector((v.co.x * size[0] * k, v.co.y * size[2] * k, max(v.co.z * size[1] * k, -0.02 * flatten)))
            v.co += B(*c)
        return s.obj(name, bm, mat, group)
    # ── booleans ──
    def boolean(s, o, cutter, op="DIFFERENCE"):
        md = o.modifiers.new("Bool", "BOOLEAN"); md.object = cutter; md.operation = op; md.solver = "EXACT"
        md.material_mode = "TRANSFER"     # (the cut faces take the cutter's material: the stone under the render)
        cutter.hide_render = True; cutter.display_type = "WIRE"
        return md
    def cutter(s, x0, x1, y0, y1, z0, z1, mat=None):
        bm = bmesh.new()
        vs = [bm.verts.new(B(x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
        bmesh.ops.convex_hull(bm, input=vs)
        return s._cut(bm, mat)
    def arch(s, a0, a1, y0, ys, d0, d1, mat=None, across="z", n=12):
        """A ROUND ARCH's cutter: the opening a0..a1 wide, straight from y0 up to its springing ys, a half circle
        above; through the wall from d0 to d1 (along z for a front / back wall, along x for a side one)."""
        r, m = (a1 - a0) / 2, (a0 + a1) / 2
        prof = [(a0, y0), (a1, y0)] + [(m + r * math.cos(math.pi * i / n), ys + r * math.sin(math.pi * i / n)) for i in range(n + 1)]
        bm = bmesh.new()
        vs = [bm.verts.new(B(u, y, d) if across == "z" else B(d, y, u)) for u, y in prof for d in (d0, d1)]
        bmesh.ops.convex_hull(bm, input=vs)
        return s._cut(bm, mat)
    def breach(s, c, size, seed=0, mat=None, rough=0.45):
        """A ragged hole's cutter: a lumpy blob at c, half-extents `size`."""
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
        off = Vector((seed * 2.7, seed * 0.9, seed * 1.7))
        for v in bm.verts:
            k = 1 + rough * mnoise.noise(v.co * 2.3 + off) + 0.15 * mnoise.noise(v.co * 7.0 + off)
            v.co = Vector((v.co.x * size[0] * k, v.co.y * size[2] * k, v.co.z * size[1] * k)) + B(*c)
        return s._cut(bm, mat)
    def skyline(s, x0, x1, z0, z1, h, amp, seed=0, mat=None, n=28):
        """Cuts away everything above a jagged surface y = h + noise (a ruin's broken top)."""
        bm = bmesh.new(); grid = []
        off = Vector((seed * 1.9, seed * 0.7, 0))
        for i in range(n + 1):
            row = []
            for j in range(n + 1):
                x = x0 + (x1 - x0) * i / n; z = z0 + (z1 - z0) * j / n
                y = h + amp * mnoise.noise(Vector((x * 0.35, z * 0.35, 0)) + off) + amp * 0.35 * mnoise.noise(Vector((x * 1.3, z * 1.3, 3)) + off)
                row.append(bm.verts.new(B(x, y, z)))
            grid.append(row)
        top = [[bm.verts.new(B(x0 + (x1 - x0) * i / n, 60, z0 + (z1 - z0) * j / n)) for j in range(n + 1)] for i in range(n + 1)]
        for i in range(n):
            for j in range(n):
                bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
                bm.faces.new((top[i][j], top[i][j + 1], top[i + 1][j + 1], top[i + 1][j]))
        for k in range(n):
            for (a, b_), (c, d) in (((grid[k][0], grid[k + 1][0]), (top[k][0], top[k + 1][0])), ((grid[k][n], grid[k + 1][n]), (top[k][n], top[k + 1][n])),
                                   ((grid[0][k], grid[0][k + 1]), (top[0][k], top[0][k + 1])), ((grid[n][k], grid[n][k + 1]), (top[n][k], top[n][k + 1]))):
                bm.faces.new((a, b_, d, c))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return s._cut(bm, mat)
    def _cut(s, bm, mat):
        m = bpy.data.meshes.new("cut"); bm.to_mesh(m); bm.free()
        o = bpy.data.objects.new("cut", m); bpy.context.scene.collection.objects.link(o)
        if mat: o.data.materials.append(s.mat(mat))
        s.cutters.append(o)
        return o
    # ── one object, one atlas ──
    def join(s, name, objs):
        bpy.ops.object.select_all(action="DESELECT")
        objs = [o for o in objs if o.name in bpy.context.scene.objects]
        for o in objs:
            bpy.context.view_layer.objects.active = o
            for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
            o.select_set(True)
        if getattr(s, "deconflict_on", True): deconflict(objs, name)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        j = bpy.context.view_layer.objects.active; j.name = name
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        # (a piece may round its shading — a dry-stone sangar's stones: 80 deg, no weighted normals — flat walls
        # keep 35 and the weighted normals, the M'zab houses' banding fix)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(getattr(s, "smooth_angle", 35)))
        unsharp_cloth(j)
        if getattr(s, "weighted_on", True): weighted(j)
        return j
    def drop_cutters(s):
        for c in s.cutters: bpy.data.objects.remove(c, do_unlink=True)
        s.cutters = []
    def bake(s, objs, size, name, out_dir, samples_ao=96, rough=0.9, ao_dist=2.2, normals=False, normal_size=None, island_margin=0.002):
        """Colour × ambient occlusion into ONE atlas, then a plain material with it — for one object or
        SEVERAL sharing the atlas (a house's three states: their UVs packed together, one texture). They are
        spread apart while they bake (at one origin each would occlude the others: black AO) and every other
        mesh is hidden from the bake."""
        objs = list(objs) if isinstance(objs, (list, tuple)) else [objs]
        if os.environ.get("BKIT_NOBAKE"): print("BAKE skipped (BKIT_NOBAKE)", name); return   # (geometry checks only)
        o = objs[0]
        scn = bpy.context.scene
        scn.render.engine = "CYCLES"; bakeDevice(scn); scn.render.bake.margin = 8
        scn.world.light_settings.distance = ao_dist   # (a house's 2.2 m; small packed pieces less — 2.2 blackened a dry-stone wall)
        hidden = [q for q in scn.objects if q.type == "MESH" and q not in objs and not q.hide_render]
        for q in hidden: q.hide_render = True
        home = [q.location.copy() for q in objs]
        for i, q in enumerate(objs): q.location.x += i * 60
        bpy.ops.object.select_all(action="DESELECT")
        for q in objs: q.select_set(True)
        bpy.context.view_layer.objects.active = o
        # THE ATLAS ON ITS OWN UV LAYER (2026-10-21, the scanned stones): a piece's source textures (a scan's colour
        # and normal maps) read the mesh's own UVs — they stay the RENDER layer while the atlas is unwrapped on a
        # new one (the active layer: the unwrap and the bake's target); after the bake only the atlas is kept.
        for q in objs:
            src = q.data.uv_layers.active
            at = q.data.uv_layers.new(name="Atlas")
            q.data.uv_layers.active = at
            if src is not None: src.active_render = True
        bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
        # (`island_margin`: a piece of sharp colour edges — the red cross on white — wants its islands further apart, or
        # one colour bleeds into the next island at the mips)
        bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=island_margin)
        # PACKED AGAIN (2026-10-25, you on the French post: "that look so cheap and not AAA rts at all"): smart project's
        # own packing broke down on thousands of islands — the post's 4096 atlas 4 % used, 5 texels a metre. Every
        # island at one texel density, then Blender's packer (bounding boxes, turned to fit).
        bpy.ops.uv.select_all(action="SELECT")
        bpy.ops.uv.average_islands_scale()
        bpy.ops.uv.pack_islands(rotate=True, margin_method="FRACTION", margin=island_margin, shape_method="AABB")
        bpy.ops.object.mode_set(mode="OBJECT")
        def target(nm, sz=None):
            img = bpy.data.images.new(nm, sz or size, sz or size, alpha=False)
            for q in objs:
                for m in q.data.materials:
                    tn = m.node_tree.nodes.get("BakeTarget") or m.node_tree.nodes.new("ShaderNodeTexImage")
                    tn.name = "BakeTarget"; tn.image = img; m.node_tree.nodes.active = tn
            return img
        col = target(f"{name}_col"); scn.cycles.samples = 4
        scn.render.bake.use_pass_direct = False; scn.render.bake.use_pass_indirect = False; scn.render.bake.use_pass_color = True
        bpy.ops.object.bake(type="DIFFUSE")
        ao = target(f"{name}_ao"); scn.cycles.samples = samples_ao; bpy.ops.object.bake(type="AO")
        # NORMALS (opt-in): the materials' own normal maps (a scan's) and the shapes, tangent space, into an atlas
        # the game's material reads — the relief a colour bake alone flattens
        nrm = None
        if normals:
            # (`normal_size`: the relief at its own size — half the colour's is plenty under the shader's close-up
            # detail, and a quarter of the video memory: 2048 UASTC was ~5 MB a piece)
            nrm = target(f"{name}_nrm", normal_size); nrm.colorspace_settings.name = "Non-Color"; scn.cycles.samples = 4
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
            nrm.filepath_raw = os.path.join(out_dir, f"{name}_nrm.png"); nrm.file_format = "PNG"; nrm.save()
        if os.environ.get("BKIT_DEBUG"):                     # (the two layers on their own, to look at)
            for im, nm in ((col, "col"), (ao, "ao")):
                im.filepath_raw = os.path.join(out_dir, f"_{name}_{nm}.png"); im.file_format = "PNG"; im.save()
        c = np.array(col.pixels[:]).reshape(-1, 4); a = np.array(ao.pixels[:]).reshape(-1, 4)
        unbaked = c[:, :3].sum(1) == 0                         # (the atlas's empty background, round the islands)
        c[:, :3] *= 0.3 + 0.7 * a[:, :1]                      # (softened: the game lights it too)
        # THE BACKGROUND the islands' mean, not black (2026-10-20: a dry-stone wall's hundreds of tiny islands —
        # its mip levels averaged stone and black gaps, the wall drew near-black from the RTS camera)
        if unbaked.any() and (~unbaked).any(): c[unbaked, :3] = c[~unbaked, :3].mean(0)
        out = bpy.data.images.new(name, size, size, alpha=False); out.pixels = c.ravel().tolist()
        out.filepath_raw = os.path.join(out_dir, f"{name}.png"); out.file_format = "PNG"; out.save()
        m = bpy.data.materials.new(f"M_{name}"); m.use_nodes = True
        tn = m.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = out
        pb = m.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = rough
        m.node_tree.links.new(tn.outputs["Color"], pb.inputs["Base Color"])
        if nrm is not None:
            nt = m.node_tree.nodes.new("ShaderNodeTexImage"); nt.image = nrm; nt.interpolation = "Linear"
            nm = m.node_tree.nodes.new("ShaderNodeNormalMap")
            m.node_tree.links.new(nt.outputs["Color"], nm.inputs["Color"]); m.node_tree.links.new(nm.outputs["Normal"], pb.inputs["Normal"])
        for q, at in zip(objs, home):
            for l in [l for l in q.data.uv_layers if l.name != "Atlas"]: q.data.uv_layers.remove(l)
            if "Atlas" in q.data.uv_layers: q.data.uv_layers["Atlas"].active_render = True
            earth_mask(q)   # (before the materials go: which faces were earth)
            q.data.materials.clear(); q.data.materials.append(m)
            for p in q.data.polygons: p.material_index = 0
            q.location = at
        for q in hidden: q.hide_render = False
        print("BAKED", name, size, len(objs))
    def stencils(s, decals, name, out_dir, ppm=640, width=1024):
        """THE STENCIL SHEET (2026-10-25, you: "is it not better to use decals for lettering?" — then "do the stencil
        sheet now"): painted lettering as DECALS, the CoH way. `decals` {piece: [letter meshes]} — each letter mesh
        a flat text standing 8 mm off its board. Every distinct word is baked ONCE, at `ppm` texels a metre, into
        the kit's own small RGBA sheet (`{name}_stencils.png`: the paint's colour, its letters in the alpha); each
        piece gets a `<piece>_Decal` mesh of flat quads mapped onto it — 2 triangles a word, crisp at any zoom (in
        the shared atlas a 7 cm stencil was 6 texels: a blob). The game alpha-tests it, near level only, no shadow.
        The letter meshes are removed. Returns {piece: its decal object}."""
        scn = bpy.context.scene
        items = [(q, d) for q, ds in decals.items() for d in ds if d and d.name in scn.objects]
        if not items: return {}
        bpy.context.view_layer.update()
        PAD = 0.012
        def rect(d):
            xs = [v.co.x for v in d.data.vertices]; ys = [v.co.y for v in d.data.vertices]
            return min(xs) - PAD, max(xs) + PAD, min(ys) - PAD, max(ys) + PAD
        key = lambda d: (d.get("stencil", d.name), round(d.dimensions.length, 3), d.data.materials[0].name if d.data.materials else "")
        # the sheet: one slot per distinct word (shelf packing, 4 texels apart)
        slots, first, x, y, row = {}, {}, 4, 4, 0
        for q, d in items:
            k = key(d)
            if k in slots: continue
            x0, x1, y0, y1 = rect(d); w, h = math.ceil((x1 - x0) * ppm), math.ceil((y1 - y0) * ppm)
            if x + w + 4 > width: x, y, row = 4, y + row + 4, 0
            slots[k] = (x, y, w, h); first[k] = d; x += w + 4; row = max(row, h)
        H = 1 << math.ceil(math.log2(y + row + 4))
        def quads(bm, ds, uvl):
            for d in ds:
                x0, x1, y0, y1 = rect(d); sx, sy, w, h = slots[key(d)]
                vs = [bm.verts.new(d.matrix_world @ Vector((px, py, 0))) for px, py in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
                f = bm.faces.new(vs)
                for l, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                    l[uvl].uv = ((sx + u * w) / width, (sy + v * h) / H)
        def mesh_of(nm, ds, mat):
            bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); quads(bm, ds, uvl)
            me = bpy.data.meshes.new(nm); bm.to_mesh(me); bm.free()
            ob = bpy.data.objects.new(nm, me); scn.collection.objects.link(ob); me.materials.append(mat)
            return ob
        # bake the sheet: one quad per distinct word over its first letters (selected → active, a 5 mm ray)
        bakemat = bpy.data.materials.new(f"_{name}_StencilBake")
        img = lambda nm: bpy.data.images.new(nm, width, H, alpha=False)
        tgt = bakemat.node_tree.nodes.new("ShaderNodeTexImage"); bakemat.node_tree.nodes.active = tgt
        bo = mesh_of(f"_{name}_StencilBake", list(first.values()), bakemat)
        white = bpy.data.materials.new("_StencilMask"); nt = white.node_tree; nt.nodes.clear()
        em = nt.nodes.new("ShaderNodeEmission"); nt.links.new(em.outputs[0], nt.nodes.new("ShaderNodeOutputMaterial").inputs[0])
        texts = list(first.values()); mats = [list(d.data.materials) for d in texts]
        hid = [o for o in scn.objects if o.type == "MESH" and o not in texts and o is not bo and not o.hide_render]
        for o in hid: o.hide_render = True
        for o in texts + [bo]: o.hide_render = False
        scn.render.engine = "CYCLES"; bakeDevice(scn); scn.cycles.samples = 16; scn.render.bake.margin = 2
        bpy.ops.object.select_all(action="DESELECT")
        for d in texts: d.select_set(True)
        bo.select_set(True); bpy.context.view_layer.objects.active = bo
        kw = dict(use_selected_to_active=True, cage_extrusion=0.005, max_ray_distance=0.01)
        for d in texts: d.data.materials.clear(); d.data.materials.append(white)
        tgt.image = mk = img(f"{name}_smask"); bpy.ops.object.bake(type="EMIT", **kw)
        for d, ms in zip(texts, mats):
            d.data.materials.clear()
            for m_ in ms: d.data.materials.append(m_)
        scn.render.bake.use_pass_direct = False; scn.render.bake.use_pass_indirect = False; scn.render.bake.use_pass_color = True
        tgt.image = co = img(f"{name}_scol"); bpy.ops.object.bake(type="DIFFUSE", **kw)
        for o in hid: o.hide_render = False
        a = np.clip(np.array(mk.pixels[:]).reshape(-1, 4)[:, 0], 0, 1); c = np.array(co.pixels[:]).reshape(-1, 4)
        # (round the letters the paint's own mean colour, not black: the mips blend into it, no dark fringe)
        if (a > 0.5).any(): c[a < 0.5, :3] = c[a > 0.5, :3].mean(0)
        c[:, 3] = a
        out = bpy.data.images.new(f"{name}_stencils", width, H, alpha=True); out.pixels = c.ravel().tolist()
        out.filepath_raw = os.path.join(out_dir, f"{name}_stencils.png"); out.file_format = "PNG"; out.save()
        m = bpy.data.materials.new(f"M_{name}_Stencils")
        tn = m.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = out
        pb = m.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = 0.85
        m.node_tree.links.new(tn.outputs["Color"], pb.inputs["Base Color"]); m.node_tree.links.new(tn.outputs["Alpha"], pb.inputs["Alpha"])
        res = {}
        for q, ds in decals.items():
            ds = [d for d in ds if d and d.name in scn.objects]
            if ds: res[q] = mesh_of(f"{q.name}_Decal", ds, m)
        for o in {bo, *(d for _, d in items)}: bpy.data.objects.remove(o, do_unlink=True)
        print("STENCILS", name, f"{width}x{H}", len(slots), "words", {q.name: len(ds) for q, ds in decals.items()})
        return res
    def far(s, o, ratio=0.3, name=None):
        """A FAR level of a baked object: a copy decimated (its UVs kept: the SAME atlas, no new texture)."""
        f = o.copy(); f.data = o.data.copy(); f.name = name or f"{o.name}_Far"
        bpy.context.scene.collection.objects.link(f)
        bpy.ops.object.select_all(action="DESELECT"); f.select_set(True); bpy.context.view_layer.objects.active = f
        # PLANAR FIRST (2026-10-23, you at the ksar: the long dark streak down the far minaret "looks like a normal issue,
        # bad topology"): the collapse alone moved wall vertices off their plane, so a flat wall's normals disagreed and
        # smooth shading smeared them along its long slivers — a fake shadow on every far house, gone when the near
        # model took over at 60 m (the "shadows that disappear when the camera comes close"). A planar dissolve first
        # merges each flat wall into one exact plane (the UV seams kept: the same atlas); the collapse only takes
        # what is still over the budget.
        n0 = tris(f)
        d = f.modifiers.new("P", "DECIMATE"); d.decimate_type = "DISSOLVE"; d.angle_limit = math.radians(2); d.delimit = {"UV", "SHARP", "MATERIAL"}
        bpy.ops.object.modifier_apply(modifier="P")
        t = f.modifiers.new("T", "TRIANGULATE"); t.quad_method = "BEAUTY"; t.ngon_method = "BEAUTY"
        bpy.ops.object.modifier_apply(modifier="T")
        n1 = tris(f)
        if n1 > n0 * ratio * 1.05:
            d = f.modifiers.new("D", "DECIMATE"); d.decimate_type = "COLLAPSE"; d.ratio = (n0 * ratio) / n1; d.use_collapse_triangulate = True
            bpy.ops.object.modifier_apply(modifier="D")
        print(f"FAR {f.name}: {n0} -> planar {n1} -> {tris(f)}")
        # (the collapse loses the sharp edges: smooth shading then ran across the walls' corners and the
        # long collapsed triangles — dark diagonal streaks on flat whitewash that read as SHADOWS from the RTS
        # zoom and "vanished" up close when the near level took over; you, 2026-10-19. Split by angle again.)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        # …and THE NEAR MODEL'S OWN NORMALS (2026-10-23, you: "the far one makes bad shading … see between A and B" —
        # combed stripes, dark wedges, a streak down the minaret the near model never had): copied corner by corner
        # (copy_normals below — Blender's Data Transfer was measured WORSE). Gate: tools/glbLodShadingCheck.mjs.
        copy_normals(f, o)
        return f
    def export(s, path, objs, colors=False, images="JPEG"):
        """`colors`: the ACTIVE colour attribute exported too (COLOR_0) — data a piece carries for the game (the
        sangar's build order, tools/blender/sangar.py), not a colour the baked material uses."""
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs: o.select_set(True)
        kw = dict(filepath=path, use_selection=True, export_yup=True, export_materials="EXPORT", export_image_format=images)   # (AUTO: a kit with a stencil sheet — PNG keeps its alpha)
        kw["export_attributes"] = True   # (the custom attributes — the underscore ones: `_earth`, earth_mask)
        if colors: kw["export_vertex_color"] = "ACTIVE"
        try: bpy.ops.export_scene.gltf(**kw, export_jpeg_quality=90)
        except TypeError: bpy.ops.export_scene.gltf(**kw)
        print("GLB", path)

def earth_mask(o):
    """THE EARTH, MARKED (2026-10-25, you: the mortar pit's, the fortified point's, the MG nest's pit "a low-res texture"):
    a vertex attribute `_earth` (1 on the faces whose material is an earth — "earth", "mpEarth", "spoil"…), exported with
    the model (glTF custom attribute, the underscore). The game lays a fine tiling soil photo over those faces only
    (algGroundBlend earthDetail): the atlas's few texels a centimetre for a 7 m berm stop reading as a smear."""
    me = o.data
    if not me.materials: return
    # (not the M'zab's earth RENDERS — earthOchre, earthPink…: plastered walls, not soil; 2026-10-26)
    render = lambda n: n.startswith("earth") and len(n) > 5 and n[5].isupper()
    earthy = [bool(m and not render(m.name.split(".")[0]) and any(w in m.name.lower() for w in ("earth", "spoil", "soil", "berm"))) for m in me.materials]
    if not any(earthy): return
    val = [0.0] * len(me.vertices)
    for p in me.polygons:
        if earthy[p.material_index]:
            for vi in p.vertices: val[vi] = 1.0
    a = me.attributes.get("_earth") or me.attributes.new("_earth", "FLOAT", "POINT")
    a.data.foreach_set("value", val)
    print(f"[earth] {o.name}: {sum(1 for v in val if v)} earth vertices", flush=True)

def unsharp_cloth(o):
    """THE CANVAS SMOOTH ACROSS ITS FOLDS (2026-10-25, the tents' "saw tooth"): a fold sharper than the kit's smoothing
    angle was split into hard edges, its long triangles lit facet by facet. Every edge whose faces are ALL cloth
    (clothKit's "cloth" face attribute) is smooth again; where the canvas meets a pole or a frame it stays hard."""
    me = o.data
    if "cloth" not in me.attributes or "sharp_edge" not in me.attributes: return
    cloth = [False] * len(me.polygons); me.attributes["cloth"].data.foreach_get("value", cloth)
    other = [False] * len(me.edges)   # (an edge touching a face that is NOT cloth)
    for p in me.polygons:
        if not cloth[p.index]:
            for li in p.loop_indices: other[me.loops[li].edge_index] = True
    sharp = [False] * len(me.edges); me.attributes["sharp_edge"].data.foreach_get("value", sharp)
    n = 0
    for i in range(len(me.edges)):
        if sharp[i] and not other[i]: sharp[i] = False; n += 1
    me.attributes["sharp_edge"].data.foreach_set("value", sharp)
    if n: print(f"[cloth] {o.name}: {n} fold edges smooth again", flush=True)

def weighted(o):
    """FLAT WALLS SHADE FLAT (2026-10-19, you, on the M'zab houses' diagonal bands: "bad normals and bad
    topology"). A wall is one big face with its windows cut out by booleans: triangulated into long slivers from
    corner to corner; its bevel's steps (~22 deg) are under the 35 deg smooth limit, so the corner vertices'
    normals averaged with the bevel and TILTED, and every sliver smeared them across the wall — light and dark
    bands, baked into the AO too. Weighted normals (by face area, sharp edges kept): the big faces win their
    vertices' normals, the bevels still catch the light at the edges."""
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    md = o.modifiers.new("WN", "WEIGHTED_NORMAL"); md.mode = "FACE_AREA"; md.keep_sharp = True; md.weight = 100
    bpy.ops.object.modifier_apply(modifier=md.name)

def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)

def _coplanar_pairs(objs, tol=0.0025, cos_tol=math.cos(math.radians(1.5))):
    """Faces of two DIFFERENT parts in one plane, facing the same way and overlapping (z-fighting): the same
    test as tools/lib/coplanar.mjs (the game's check) — [(i, j, normal), …] by part index, one per pair of parts
    and plane. Bottoms on the ground (facing down under 0.35 m) are never seen and are left alone.
    (2026-10-23: the first version bucketed every triangle of the piece together — on the motor pool's hundreds of
    lapped roof sheets it ran over an hour. Now only parts whose BOXES touch are compared, and only their triangles
    inside the two boxes' overlap.)"""
    tris, boxes = [], []
    for o in objs:
        me = o.data; me.calc_loop_triangles(); M = o.matrix_world
        co = np.array([(M @ v.co)[:] for v in me.vertices]) if len(me.vertices) else np.zeros((0, 3))
        idx = np.array([lt.vertices[:] for lt in me.loop_triangles], dtype=np.int64).reshape(-1, 3)
        T = co[idx] if len(idx) else np.zeros((0, 3, 3))
        tris.append(T)
        boxes.append((co.min(0) - tol, co.max(0) + tol) if len(co) else (np.full(3, np.inf), np.full(3, -np.inf)))
    lo = np.array([b[0] for b in boxes]); hi = np.array([b[1] for b in boxes])
    def prep(T):
        n = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]); L = np.linalg.norm(n, axis=1)
        ok = L > 1e-7; n[ok] /= L[ok, None]
        c = T.mean(1)
        ok &= ~((n[:, 2] < -0.9) & (c[:, 2] < 0.35))
        return n, (n * T[:, 0]).sum(1), ok
    P = [prep(T) if len(T) else None for T in tris]
    def separated(A, Bq):
        for Q in (A, Bq):
            for i in range(3):
                e = Q[(i + 1) % 3] - Q[i]; nx = np.array([e[1], -e[0]])
                a, b = A @ nx, Bq @ nx
                if a.max() <= b.min() or b.max() <= a.min(): return True
        return False
    def shrink(Q):
        m = Q.mean(0); return m + (Q - m) * 0.97
    found = {}
    for i in range(len(objs)):
        if P[i] is None: continue
        cand = np.nonzero(np.all(lo[i + 1:] <= hi[i], 1) & np.all(hi[i + 1:] >= lo[i], 1))[0] + i + 1
        for j in cand:
            if P[j] is None: continue
            blo, bhi = np.maximum(lo[i], lo[j]), np.minimum(hi[i], hi[j])
            def inside(T, ok):
                return ok & np.all(T.max(1) >= blo, 1) & np.all(T.min(1) <= bhi, 1)
            na, da, oka = P[i]; nb, db, okb = P[j]
            ia = np.nonzero(inside(tris[i], oka))[0]; ib = np.nonzero(inside(tris[j], okb))[0]
            if not len(ia) or not len(ib): continue
            for ta in ia:
                cand_b = ib[(nb[ib] @ na[ta]) > cos_tol]
                if not len(cand_b): continue
                cand_b = cand_b[np.abs(db[cand_b] - da[ta]) < tol * 4 + 1e-9]
                if not len(cand_b): continue
                offB = np.abs(np.einsum("kij,j->ki", tris[j][cand_b], na[ta]) - da[ta]).max(1)
                offA = np.abs(np.einsum("ij,kj->ki", tris[i][ta], nb[cand_b]) - db[cand_b][:, None]).max(1)
                cand_b = cand_b[(offB < tol) & (offA < tol)]
                if not len(cand_b): continue
                key = (i, j, tuple(np.round(na[ta], 2)))
                if key in found: continue
                ax = int(np.abs(na[ta]).argmax())
                PA = shrink(np.delete(tris[i][ta], ax, axis=1))
                for tb in cand_b:
                    if not separated(PA, shrink(np.delete(tris[j][tb], ax, axis=1))):
                        found[key] = na[ta]; break
    return [(i, j, nv) for (i, j, _), nv in found.items()]

def deconflict(objs, name="", step=0.004, rounds=4):
    """NO Z-FIGHTING BETWEEN PARTS (2026-10-22, you, on the post: "z index shader issues, on each corner here, on the
    clothes hanging"): a kit piece is boxes and parts ending exactly on one another — two wall caps meeting at a
    tower's corner at the same height, a shirt on the line over the next. Before the join, the smaller of each pair
    of parts sharing a plane (and overlapping in it) moves `step` m off it, along that plane's normal — up for a
    top, out for a side — 4 mm: unseen, and past the game's check (tools/glbCoplanarCheck.mjs, 2.5 mm)."""
    size = []
    for o in objs:
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        ext = [max(v[k] for v in bb) - min(v[k] for v in bb) for k in range(3)]
        size.append(ext[0] * ext[1] + ext[1] * ext[2] + ext[0] * ext[2])
    import time
    moved, first = set(), None
    for r in range(rounds):
        t0 = time.time(); pairs = _coplanar_pairs(objs)
        if os.environ.get("BKIT_TIME"): print(f"  deconflict {name} round {r}: {len(objs)} parts, {len(pairs)} pairs, {time.time() - t0:.1f} s", flush=True)
        if first is None: first = len(pairs)
        if not pairs: break
        push = {}
        for i, j, nv in pairs:
            k = i if size[i] <= size[j] else j
            v = push.setdefault(k, Vector((0, 0, 0)))
            # (a slab sharing its top AND its bottom with another — two wall copes crossing at a corner — moves ONE
            # way: pushed up for the tops and down for the bottoms it stayed put, the corner's flicker, seen)
            along = v.dot(Vector(nv))
            # (each further round a little further: parts 2 mm apart need more than one 4 mm push to clear 2.5 mm)
            if -step * 0.5 < along < step * 0.5: v += Vector(nv) * step * (1 + r * 0.5)
        for k, v in push.items():
            objs[k].location += v; moved.add(k)
        bpy.context.view_layer.update()
    rest = _coplanar_pairs(objs) if first else []
    if first: print(f"DECONFLICT {name}: {first} coplanar part pairs, {len(moved)} parts moved 4 mm, {len(rest)} left")
    for i, j, nv in rest[:12]: print(f"  left: {objs[i].name} / {objs[j].name} n={tuple(round(x, 2) for x in nv)}")

def copy_normals(f, n, inset=0.03, max_dist=0.3, min_facing=0.5):
    """THE NEAR LEVEL'S NORMALS ON THE FAR ONE, corner by corner (2026-10-23 — the far levels' fake streaks and
    stripes, tools/glbLodShadingCheck.mjs). Blender's Data Transfer blends across a corner's two sides (a wall and its
    window reveal): measured WORSE than doing nothing. Here every corner of every far face is stepped `inset` m into
    its own face, the closest point of the near surface FACING THE SAME WAY is found (BVH), and the near's interpolated
    corner normal there becomes the far's custom normal; a corner with no such point keeps its face's normal."""
    from mathutils.bvhtree import BVHTree
    from mathutils.geometry import barycentric_transform
    # (matrix_world is stale after a location change until the scene updates — the bake spreads the pieces 60 m apart
    # and puts them back: without this every farBuilder kit's far looked for its near 180 m away and kept flat normals)
    bpy.context.view_layer.update()
    nm = n.data; nm.calc_loop_triangles()
    Mn, Mf = n.matrix_world, f.matrix_world
    Mn_inv = Mn.inverted(); rot_n = Mn.to_3x3(); rot_f = Mf.to_3x3()
    tris_n = [lt for lt in nm.loop_triangles]
    verts_n = [Mn @ v.co for v in nm.vertices]
    cn = nm.corner_normals
    bvh = BVHTree.FromPolygons(verts_n, [lt.vertices[:] for lt in tris_n], all_triangles=True)
    fm = f.data; fm.calc_loop_triangles()
    out = [None] * len(fm.loops)
    for poly in fm.polygons:
        fn = (rot_f @ poly.normal).normalized()
        centre = Mf @ poly.center
        for li in poly.loop_indices:
            p = Mf @ fm.vertices[fm.loops[li].vertex_index].co
            q = p + (centre - p).normalized() * min(inset, (centre - p).length * 0.5)
            best = None
            # every near triangle within reach; of those about as close as the closest (+5 cm), the one FACING most
            # like this far face (2026-10-23: the nearest-that-faces-roughly-the-same-way took a 45° bevel at a small
            # terrace wall's corners — its far level shaded 12-21 % off)
            cand = bvh.find_nearest_range(q, max_dist)
            if cand:
                dmin = min(c[3] for c in cand)
                score_best = -2.0
                for loc2, face2, ti2, d2 in cand:
                    if d2 > dmin + 0.05: continue
                    lt = tris_n[ti2]
                    a, b, c = (verts_n[i] for i in lt.vertices)
                    tn = (b - a).cross(c - a)
                    if tn.length < 1e-12: continue
                    sc = tn.normalized().dot(fn)
                    if sc < min_facing or sc <= score_best: continue
                    na, nb, nc = (rot_n @ cn[l].vector for l in lt.loops)
                    best = barycentric_transform(loc2, a, b, c, na, nb, nc).normalized(); score_best = sc
            v = best if best is not None else fn
            out[li] = tuple((rot_f.inverted() @ v).normalized())
    fm.normals_split_custom_set(out)
