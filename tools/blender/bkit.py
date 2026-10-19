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
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.object.join()
        j = bpy.context.view_layer.objects.active; j.name = name
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))
        return j
    def drop_cutters(s):
        for c in s.cutters: bpy.data.objects.remove(c, do_unlink=True)
        s.cutters = []
    def bake(s, objs, size, name, out_dir, samples_ao=96, rough=0.9):
        """Colour × ambient occlusion into ONE atlas, then a plain material with it — for one object or
        SEVERAL sharing the atlas (a house's three states: their UVs packed together, one texture). They are
        spread apart while they bake (at one origin each would occlude the others: black AO) and every other
        mesh is hidden from the bake."""
        objs = list(objs) if isinstance(objs, (list, tuple)) else [objs]
        o = objs[0]
        scn = bpy.context.scene
        scn.render.engine = "CYCLES"; scn.cycles.device = "CPU"; scn.render.bake.margin = 8
        scn.world.light_settings.distance = 2.2
        hidden = [q for q in scn.objects if q.type == "MESH" and q not in objs and not q.hide_render]
        for q in hidden: q.hide_render = True
        home = [q.location.copy() for q in objs]
        for i, q in enumerate(objs): q.location.x += i * 60
        bpy.ops.object.select_all(action="DESELECT")
        for q in objs: q.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(55), island_margin=0.002)
        bpy.ops.object.mode_set(mode="OBJECT")
        def target(nm):
            img = bpy.data.images.new(nm, size, size, alpha=False)
            for q in objs:
                for m in q.data.materials:
                    tn = m.node_tree.nodes.get("BakeTarget") or m.node_tree.nodes.new("ShaderNodeTexImage")
                    tn.name = "BakeTarget"; tn.image = img; m.node_tree.nodes.active = tn
            return img
        col = target(f"{name}_col"); scn.cycles.samples = 4
        scn.render.bake.use_pass_direct = False; scn.render.bake.use_pass_indirect = False; scn.render.bake.use_pass_color = True
        bpy.ops.object.bake(type="DIFFUSE")
        ao = target(f"{name}_ao"); scn.cycles.samples = samples_ao; bpy.ops.object.bake(type="AO")
        if os.environ.get("BKIT_DEBUG"):                     # (the two layers on their own, to look at)
            for im, nm in ((col, "col"), (ao, "ao")):
                im.filepath_raw = os.path.join(out_dir, f"_{name}_{nm}.png"); im.file_format = "PNG"; im.save()
        c = np.array(col.pixels[:]).reshape(-1, 4); a = np.array(ao.pixels[:]).reshape(-1, 4)
        c[:, :3] *= 0.3 + 0.7 * a[:, :1]                      # (softened: the game lights it too)
        out = bpy.data.images.new(name, size, size, alpha=False); out.pixels = c.ravel().tolist()
        out.filepath_raw = os.path.join(out_dir, f"{name}.png"); out.file_format = "PNG"; out.save()
        m = bpy.data.materials.new(f"M_{name}"); m.use_nodes = True
        tn = m.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = out
        pb = m.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = rough
        m.node_tree.links.new(tn.outputs["Color"], pb.inputs["Base Color"])
        for q, at in zip(objs, home):
            q.data.materials.clear(); q.data.materials.append(m)
            for p in q.data.polygons: p.material_index = 0
            q.location = at
        for q in hidden: q.hide_render = False
        print("BAKED", name, size, len(objs))
    def far(s, o, ratio=0.3, name=None):
        """A FAR level of a baked object: a copy decimated (its UVs kept: the SAME atlas, no new texture)."""
        f = o.copy(); f.data = o.data.copy(); f.name = name or f"{o.name}_Far"
        bpy.context.scene.collection.objects.link(f)
        d = f.modifiers.new("D", "DECIMATE"); d.decimate_type = "COLLAPSE"; d.ratio = ratio; d.use_collapse_triangulate = True
        bpy.ops.object.select_all(action="DESELECT"); f.select_set(True); bpy.context.view_layer.objects.active = f
        bpy.ops.object.modifier_apply(modifier="D")
        return f
    def export(s, path, objs):
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs: o.select_set(True)
        kw = dict(filepath=path, use_selection=True, export_yup=True, export_materials="EXPORT", export_image_format="JPEG")
        try: bpy.ops.export_scene.gltf(**kw, export_jpeg_quality=90)
        except TypeError: bpy.ops.export_scene.gltf(**kw)
        print("GLB", path)

def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
