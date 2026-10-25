"""CANVAS BY CLOTH SIMULATION (2026-10-21, you: "for tent or other things like that wouldn't it be better to use cloth
simulation like we did with the bags of sand?"): a tarp, a tent's roof, a collapsed tent — Blender's cloth run ONCE
here, the settled sheet kept as a plain mesh (no cost in the game but its triangles).

  drape(K, nm, fn, nu, nv, mats, t, pins=…, colliders=…, frames=…, …)

`fn(u, v)` → game point: the sheet's REST shape (its slack: a pre-sagged sheet hangs in folds, a taut one barely moves);
`pins(u, v)` → True where it is tied (a pole's top, a peg); `colliders`: ("box", (x0, x1, y0, y1, z0, z1)) and
("rod", a, b, r) in game metres — stand-ins that exist only for the sim (the ground is always there); `mats(u, v)` → a
material name per face (a red cross on white is the CLOTH's own faces: it folds with it, it can never z-fight).
Both faces kept (solidified: the game draws front faces only). Results cached per (name, grid): the far level asks
again on a coarser grid.
"""
import math
import bpy, bmesh
from mathutils import Vector
from bkit import B
from drystone import tag

_CACHE = {}

def _collider(col, o, thick=0.02):
    o.modifiers.new("Collision", "COLLISION")
    o.collision.thickness_outer = thick
    o.collision.cloth_friction = 20
    o.collision.damping = 0.5
    col.objects.link(o)

def _box(col, x0, x1, y0, y1, z0, z1):
    bm = bmesh.new()
    vs = [bm.verts.new(B(x, y, z)) for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)]
    bmesh.ops.convex_hull(bm, input=vs)
    me = bpy.data.meshes.new("_col"); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new("_col", me)
    _collider(col, o)
    return o

def _rod(col, a, b, r, n=8):
    a, b = Vector(B(*a)), Vector(B(*b))
    d = (b - a).normalized()
    u = d.cross(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))).normalized(); v = d.cross(u)
    bm = bmesh.new()
    r0 = [bm.verts.new(a + (u * math.cos(2 * math.pi * i / n) + v * math.sin(2 * math.pi * i / n)) * r) for i in range(n)]
    r1 = [bm.verts.new(b + (u * math.cos(2 * math.pi * i / n) + v * math.sin(2 * math.pi * i / n)) * r) for i in range(n)]
    for i in range(n):
        j = (i + 1) % n; bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(r0); bm.faces.new(list(reversed(r1)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("_col"); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new("_col", me)
    _collider(col, o)
    return o

def _simulate(fn, nu, nv, pins, colliders, frames, stiff, mass, compress=None, bend=0.6):
    scn = bpy.context.scene
    col = bpy.data.collections.new("_clothcol"); scn.collection.children.link(col)
    tmp = [_box(col, -30, 30, -0.2, 0.0, -30, 30)]   # the ground
    for c in colliders:
        tmp.append(_box(col, *c[1]) if c[0] == "box" else _rod(col, c[1], c[2], c[3]))
    bm = bmesh.new()
    g = [[bm.verts.new(B(*fn(i / nu, j / nv))) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
    me = bpy.data.meshes.new("_cloth"); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new("_cloth", me); scn.collection.objects.link(o)
    vg = o.vertex_groups.new(name="pin")
    pinned = [i * (nv + 1) + j for i in range(nu + 1) for j in range(nv + 1) if pins(i / nu, j / nv)]
    vg.add(pinned, 1.0, "REPLACE")
    free = o.vertex_groups.new(name="free")
    free.add([k for k in range((nu + 1) * (nv + 1)) if k not in set(pinned)], 1.0, "REPLACE")
    m = o.modifiers.new("Cloth", "CLOTH")
    s = m.settings
    s.quality = 10
    s.mass = mass
    s.air_damping = 1.5
    s.tension_stiffness = stiff
    s.compression_stiffness = stiff if compress is None else compress
    s.shear_stiffness = stiff * 0.5
    s.bending_stiffness = bend                      # (canvas: soft folds, not paper)
    s.vertex_group_mass = "pin"
    m.collision_settings.collection = col
    m.collision_settings.distance_min = 0.015
    m.collision_settings.use_self_collision = False
    m.point_cache.frame_start, m.point_cache.frame_end = 1, frames
    scn.frame_start, scn.frame_end = 1, frames
    for f in range(1, frames + 1): scn.frame_set(f)
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = o; o.select_set(True)
    bpy.ops.object.modifier_apply(modifier="Cloth")
    scn.frame_set(1)
    # the settled cloth's jitter relaxed (its collisions leave a saw-tooth where it lies over a pole); the tied points
    # stay where they are tied
    sm = o.modifiers.new("Smooth", "SMOOTH"); sm.factor = 0.5; sm.iterations = 3; sm.vertex_group = "free"
    bpy.ops.object.modifier_apply(modifier="Smooth")
    verts = [v.co.copy() for v in o.data.vertices]
    bpy.data.objects.remove(o, do_unlink=True)
    for q in tmp: bpy.data.objects.remove(q, do_unlink=True)
    bpy.data.collections.remove(col)
    return verts

def _sheet(K, key, nu, nv):
    """A settled sheet's vertices (and grid size): a far level THINS the near's sheet — 2026-10-23: it used to simulate
    its own coarser grid, which fell differently (the ruined aid tent's canvas changed shape at the LOD switch,
    tools/glbLodShadingCheck.mjs 11 %)."""
    verts = _CACHE[(key, nu, nv)]
    if not K.low: return verts, nu, nv
    NU, NV = nu, nv; nu, nv = max(4, nu // 2), max(3, nv // 2)
    return [verts[round(i * NU / nu) * (NV + 1) + round(j * NV / nv)] for i in range(nu + 1) for j in range(nv + 1)], nu, nv

def drape(K, nm, fn, nu, nv, mats, t, pins=lambda u, v: False, colliders=(), frames=50, stiff=40.0, mass=0.3,
          key=None, thick=0.006, compress=None, bend=0.6, keep=0.5):
    # (`compress`: its compression stiffness — low, the cloth BUCKLES into wrinkles where it is pushed together, as
    # canvas does between its ties; the tension stays `stiff`. `bend`: soft folds low, stiff panels high)
    """The settled sheet as a kit object (its faces' materials from `mats(u, v)` at their centres)."""
    ck = (key or nm, nu, nv)
    if ck not in _CACHE:
        _CACHE[ck] = _simulate(fn, nu, nv, pins, colliders, frames, stiff, mass, compress, bend)
        print(f"[cloth] {nm} {nu}x{nv} settled", flush=True)
    verts, nu, nv = _sheet(K, key or nm, nu, nv)
    bm = bmesh.new()
    g = [[bm.verts.new(verts[i * (nv + 1) + j]) for j in range(nv + 1)] for i in range(nu + 1)]
    names = []
    for i in range(nu):
        for j in range(nv):
            f = bm.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
            mn = mats((i + 0.5) / nu, (j + 0.5) / nv)
            if mn not in names: names.append(mn)
            f.material_index = names.index(mn)
    o = K.obj(nm, bm, names[0], "h", smooth=True)
    for mn in names[1:]: o.data.materials.append(K.mat(mn))
    # THE FOLDS SMOOTH (2026-10-25, you: the tents' folds "saw tooth" — the French post's yard tent, the damaged forward
    # post and aid station): one Catmull-Clark level on the settled sheet (the near level), so a fold is a curve and not
    # a crease between long triangles, BEFORE the decimation; and the canvas marked "cloth" so the kit's join never
    # splits its normals at a fold (bkit.Kit.join: smooth by angle, then the cloth's own edges smooth again).
    if not K.low:
        sd = o.modifiers.new("SD", "SUBSURF"); sd.levels = sd.render_levels = 1
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier="SD")
    o.data.attributes.new("cloth", "BOOLEAN", "FACE").data.foreach_set("value", [True] * len(o.data.polygons))
    writeFold(o)
    # OPTIMISED (2026-10-22, you: "optimise as much as possible"): the sim grid is fine to make the folds; the mesh
    # kept is decimated (`keep`: its share of the triangles) — the folds' shape stays, the flat runs lose theirs
    if keep < 1.0:
        dm = o.modifiers.new("D", "DECIMATE"); dm.decimate_type = "COLLAPSE"; dm.ratio = keep; dm.use_collapse_triangulate = True
    so = o.modifiers.new("S", "SOLIDIFY"); so.thickness = thick; so.offset = 0.0
    o["cloth"] = 1.0
    return tag(o, t)

def writeFold(o, gain=6.0):
    """THE CLOTH'S CURVATURE per vertex into a "fold" colour attribute (milprops.foldShade bakes it): how far a vertex
    sits below (a crease) or above (a ridge) its neighbours' mean, along its normal, over the local edge length."""
    bm = bmesh.new(); bm.from_mesh(o.data); bm.verts.ensure_lookup_table(); bm.normal_update()
    vals = []
    for v in bm.verts:
        nb_ = [e.other_vert(v).co for e in v.link_edges]
        if not nb_: vals.append(0.5); continue
        avg = sum(nb_, Vector()) / len(nb_)
        L = sum((q - v.co).length for q in nb_) / len(nb_) or 1.0
        n = v.normal if v.normal.z >= 0 else -v.normal
        c = (avg - v.co).dot(n) / L                    # > 0: the neighbours above it — a crease
        vals.append(max(0.0, min(1.0, 0.5 - c * gain)))
    bm.free()
    a = o.data.color_attributes.new("fold", "FLOAT_COLOR", "POINT")
    for d, val in zip(a.data, vals): d.color = (val, 1.0, 0.0, 1.0)

def decal(K, nm, key, nu, nv, region, mat, t, lift=0.012, uv=True):
    """A MESH DECAL cut from a settled sheet (you, 2026-10-21: "the red cross looks bad, why don't you use decals"):
    the sheet's faces whose centres fall in `region(u, v)` → panel (pu, pv) in 0..1 (or None), lifted `lift` along
    their normals, a "Panel" UV layer from the region — its own material reads THAT (its own small sharp atlas, not
    the canvas's): it follows every fold of the cloth, crisp at any distance; the game draws it with a depth offset."""
    verts, nu, nv = _sheet(K, key, nu, nv)
    full = bmesh.new()
    g = [[full.verts.new(verts[i * (nv + 1) + j]) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            full.faces.new((g[i][j], g[i + 1][j], g[i + 1][j + 1], g[i][j + 1]))
    full.normal_update()
    # (`uv`: False for a strip of the piece's own canvas — a "Panel" layer on only some of a joined mesh's parts
    # crashed Cycles' bake)
    # (the panel coordinates as a POINT colour attribute "panel", NOT a UV layer: a second UV layer on these crashed
    # Cycles' bake — ccl::create_mesh — nearly every run, 2026-10-22)
    bm = bmesh.new(); made = {}; coords = []
    for i in range(nu):
        for j in range(nv):
            c = region((i + 0.5) / nu, (j + 0.5) / nv)
            if c is None: continue
            side = c[2] if len(c) > 2 else 0
            quad = []
            for (a, b) in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)):
                k = (a, b, side)
                if k not in made:
                    v = g[a][b]; n = v.normal.copy()
                    if n.z < 0: n = -n
                    made[k] = (bm.verts.new(v.co + n * lift), region(a / nu, b / nv, side))
                    coords.append(made[k][1])
                quad.append(made[k])
            bm.faces.new([q[0] for q in quad])
    full.free()
    # (single-sided in the game: every face turned to face UP, out of the cloth — wound down, the roof's were culled)
    bm.normal_update()
    down = [f for f in bm.faces if f.normal.z < 0]
    if down: bmesh.ops.reverse_faces(bm, faces=down)
    o = K.obj(nm, bm, mat, "h", smooth=True)
    if uv: _panel(o, [(c[0], c[1]) for c in coords])
    if not uv: o["cloth"] = 1.0                        # (a strip of the canvas itself — a seam, grime: woven too)
    return tag(o, t)

def _panel(o, uvs):
    a = o.data.color_attributes.new("panel", "FLOAT_COLOR", "POINT")
    for d, (pu, pv) in zip(a.data, uvs): d.color = (pu, pv, 1.0, 1.0)

def quad(K, nm, corners, mat, t):
    """A flat decal quad: four game points (counter-clockwise seen from its front), the Panel UV 0..1 over it."""
    bm = bmesh.new()
    bm.faces.new([bm.verts.new(B(*p)) for p in corners])
    o = K.obj(nm, bm, mat, "h")
    _panel(o, ((0, 0), (1, 0), (1, 1), (0, 1)))
    return tag(o, t)

def hem(K, nm, key, nu, nv, j, drop, out, mat, t, thick=0.006):
    """A flap hanging from a settled sheet's edge row `j` (0 or nv): `drop` m down, flared `out` (a game vector) at its
    foot — a tent's valance, from the cloth's own edge (no gap, no poke where the eave sags between the guys)."""
    verts, nu, nv = _sheet(K, key, nu, nv)
    j = 0 if j == 0 else nv
    o3 = Vector(B(*out)); down = Vector(B(0, -drop, 0))
    bm = bmesh.new()
    top = [bm.verts.new(verts[i * (nv + 1) + j] + Vector(B(0, -0.01, 0))) for i in range(nu + 1)]
    bot = [bm.verts.new(verts[i * (nv + 1) + j] + down + o3 * (0.6 + 0.4 * math.sin(i * 1.7) ** 2)) for i in range(nu + 1)]
    for i in range(nu):
        bm.faces.new((top[i], top[i + 1], bot[i + 1], bot[i]))
    o = K.obj(nm, bm, mat, "h", smooth=True)
    so = o.modifiers.new("S", "SOLIDIFY"); so.thickness = thick; so.offset = 0.0
    o["cloth"] = 1.0
    return tag(o, t)

def rim(K, nm, key, nu, nv, r, mat, t, n=6):
    """THE ROLLED HEM round a settled sheet's border: a thin tube through its edge vertices (a cut sheet's edge
    reads as paper; a sewn hem as cloth)."""
    if K.low: return None
    verts = _CACHE[(key, nu, nv)]
    at = lambda i, j: verts[i * (nv + 1) + j]
    loop = [at(i, 0) for i in range(nu + 1)] + [at(nu, j) for j in range(1, nv + 1)] + [at(i, nv) for i in range(nu - 1, -1, -1)] + [at(0, j) for j in range(nv - 1, 0, -1)]
    bm = bmesh.new(); rings = []
    m = len(loop)
    for k in range(m):
        p, q = loop[k], loop[(k + 1) % m]
        d = (q - p).normalized(); u = d.cross(Vector((0, 0, 1))); u = u.normalized() if u.length > 1e-4 else Vector((1, 0, 0)); w = d.cross(u)
        rings.append([bm.verts.new(p + (u * math.cos(2 * math.pi * i / n) + w * math.sin(2 * math.pi * i / n)) * r) for i in range(n)])
    for k in range(m):
        a, b = rings[k], rings[(k + 1) % m]
        for i in range(n):
            j = (i + 1) % n; bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = K.obj(nm, bm, mat, "h", smooth=True)
    o["cloth"] = 1.0
    return tag(o, t)
