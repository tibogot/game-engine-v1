"""THE APPELÉ'S BOOTS AND GAITERS (2026-10-15, step 2 of the rebuilt uniform — step 1 tools/blender/clothTrousers.py).
Run on the trousers' file:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      assets-src/soldiers/appele2/trousers.blend --python tools/blender/clothBoots.py -- assets-src/soldiers/appele2

RANGERS / BRODEQUINS: a leather ankle boot is one smooth closed shape — no toes. Each boot is the foot's
skin inflated (the leather and the sock), its toes MERGED by a voxel remesh into one rounded toe cap,
smoothed, cut level at the shaft top and capped; then a separate SOLE under it: the boot's outline at the
ground pushed out into a welt, 2 cm thick, 3 cm at the heel.
GAITERS (guêtres): canvas tubes from inside the boot's shaft up over the trousers' bunched hem (the
trousers are BLOUSED over them), each ring sized from what it covers; two leather straps with buckles on
the outside. Closed solids — nothing to see through. Writes <out>/lower.blend and boots_*.png close-ups.
"""
import bpy, bmesh, sys, os, math
from mathutils import Vector

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "appele2")
body, rig, trousers = bpy.data.objects["Body"], bpy.data.objects["Rig"], bpy.data.objects["Trousers"]
for o in list(bpy.data.objects):
    if o.type == "CAMERA": bpy.data.objects.remove(o, do_unlink=True)
def bone_head(n): return rig.matrix_world @ rig.data.bones["mixamorig:" + n].head_local
ankle = {s: bone_head(s + "Foot") for s in ("Left", "Right")}
knee = {s: bone_head(s + "Leg") for s in ("Left", "Right")}
SHAFT_TOP = ankle["Left"].z + 0.09
GAITER = ankle["Left"].z + 0.17
print("LEVELS", dict(ankle=round(ankle["Left"].z, 3), shaft=round(SHAFT_TOP, 3), gaiter=round(GAITER, 3)))

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

def link(name, bm):
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o); return o
def apply(o, mod):
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=mod.name)
def ring_extent(pts, c):
    return max((Vector((p.x - c.x, p.y - c.y, 0)).length for p in pts), default=0.05)

boots, gaiters, soles = [], [], []
from mathutils.bvhtree import BVHTree
SKIN_BVH = BVHTree.FromPolygons([v.co for v in skin.vertices], [p.vertices for p in skin.polygons])
BOOT_BVH = {}
for side in ("Left", "Right"):
    sx = 1 if side == "Left" else -1
    keep = {i for i, d in enumerate(DOM) if (d in (side + "Foot", side + "ToeBase") or (d == side + "Leg" and skin.vertices[i].co.z < SHAFT_TOP + 0.03))}
    # ── the boot: the foot inflated, toes merged ──
    bm = bmesh.new(); bm.from_mesh(skin); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.index not in keep], context="VERTS")
    bm.normal_update()
    for v in bm.verts: v.co += v.normal * (0.019 if v.co.z < 0.06 else 0.014)   # (a boot, not a sock: fuller over the foot)
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    o = link("Boot" + side, bm)
    toe_j = bone_head(side + "ToeBase")
    tg = o.vertex_groups.new(name="Toe")
    for v in o.data.vertices:
        if (o.matrix_world @ v.co - ankle[side]).dot((toe_j - ankle[side]).normalized()) > (toe_j - ankle[side]).length * 0.7:
            tg.add([v.index], 1.0, "REPLACE")
    rm = o.modifiers.new("R", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = 0.009; apply(o, rm)
    sm = o.modifiers.new("S", "LAPLACIANSMOOTH"); sm.iterations = 8; sm.lambda_factor = 0.8; sm.use_volume_preserve = True; apply(o, sm)
    # the TOE CAP: the toes' bumps smoothed away hard (only there — the remesh keeps the group)
    tg2 = o.vertex_groups.new(name="Toe2")
    for v in o.data.vertices:
        if (o.matrix_world @ v.co - ankle[side]).dot((toe_j - ankle[side]).normalized()) > (toe_j - ankle[side]).length * 0.6:
            tg2.add([v.index], 1.0, "REPLACE")
    sm = o.modifiers.new("T", "SMOOTH"); sm.factor = 1.0; sm.iterations = 30; sm.vertex_group = "Toe2"; apply(o, sm)
    bm = bmesh.new(); bm.from_mesh(o.data)
    # cut level at the shaft top, capped
    r = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, SHAFT_TOP), plane_no=(0, 0, 1), clear_outer=True)
    bmesh.ops.holes_fill(bm, edges=[e for e in bm.edges if e.is_boundary], sides=0)
    # the bottom flat on the sole's top
    SOLE = 0.02
    for v in bm.verts:
        if v.co.z < SOLE: v.co.z = SOLE
    lmax = max(e.calc_length() for e in bm.edges)
    bm.to_mesh(o.data); bm.free()
    print("BOOT", side, len(o.data.polygons), "faces, longest edge", round(lmax, 3))
    boots.append(o)
    BOOT_BVH[side] = BVHTree.FromPolygons([o.matrix_world @ v.co for v in o.data.vertices], [p.vertices for p in o.data.polygons])
    # ── the sole: the outline at the ground, welted, a raised heel ──
    # (the FOOTPRINT's convex hull, a few mm out — the polar outline from its centre made a dog-bone plate)
    from mathutils.geometry import convex_hull_2d
    low = [o.matrix_world @ v.co for v in o.data.vertices if v.co.z < SOLE + 0.006]
    hull = [low[i] for i in convex_hull_2d([(p.x, p.y) for p in low])]
    c = sum(hull, Vector()) / len(hull)
    ang_r = []
    for p in hull:
        d = (p - c) * Vector((1, 1, 0))
        ang_r.append(p + d.normalized() * 0.004)
    # the hull's corners ROUNDED (Chaikin, 4 passes): a sole is a smooth curve, not a polygon
    for _ in range(4):
        nr = []
        for i in range(len(ang_r)):
            a, b = ang_r[i], ang_r[(i + 1) % len(ang_r)]
            nr += [a.lerp(b, 0.25), a.lerp(b, 0.75)]
        ang_r = nr
    N = len(ang_r)
    fwd = Vector((bone_head(side + "ToeBase").x - ankle[side].x, bone_head(side + "ToeBase").y - ankle[side].y, 0)).normalized()
    bm = bmesh.new()
    bot = [bm.verts.new((p.x, p.y, 0.0)) for p in ang_r]
    def h(p): return 0.03 if (p - ankle[side]).dot(fwd) < 0.02 else SOLE + 0.002   # the heel block
    topv = [bm.verts.new((p.x, p.y, h(p))) for p in ang_r]
    bm.faces.new(bot[::-1]); bm.faces.new(topv)
    for k in range(N):
        k2 = (k + 1) % N
        bm.faces.new((bot[k], bot[k2], topv[k2], topv[k]))
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    soles.append(link("Sole" + side, bm))
    # ── the gaiter: rings from inside the shaft up over the trousers' hem ──
    tpts = [trousers.matrix_world @ v.co for v in trousers.data.vertices if (v.co.x > 0) == (sx > 0)]
    bpts = [o.matrix_world @ v.co for v in o.data.vertices]
    # (sized from the SHIN'S SKIN, not the trousers: its top just wider than their gathered hem, so the
    # bunched cloth HANGS OVER it, as bloused trousers do; from just above the ankle)
    # (every skin point round this shin — by place, not by bone: few vertices are LED by the shin bone)
    ax = Vector((ankle[side].x, ankle[side].y, 0))
    spts = [v.co for v in skin.vertices if (v.co.x > 0) == (sx > 0) and (Vector((v.co.x, v.co.y, 0)) - ax).length < 0.13 and v.co.z < GAITER + 0.06]
    zs = [ankle[side].z + 0.04, ankle[side].z + 0.07, (ankle[side].z + 0.07 + GAITER) / 2, GAITER + 0.005]
    bm = bmesh.new(); rings = []
    S = 24
    for z in zs:
        # the outline at this height by RAYS onto the skin (and the boot) from outside — the shin's skin
        # is too sparse (3-16 vertices a cm) to slice into rings
        c0 = knee[side].lerp(ankle[side], (knee[side].z - z) / (knee[side].z - ankle[side].z)); c0.z = z
        rr = []
        for k in range(S):
            a = k / S * math.pi * 2
            d = Vector((math.cos(a), math.sin(a), 0))
            o0 = c0 + d * 0.3
            hits = [t.ray_cast(o0, -d, 0.35) for t in (SKIN_BVH, BOOT_BVH[side])]
            dist = min((h[3] for h in hits if h[0] is not None), default=0.25)
            on_boot = hits[1][0] is not None and hits[1][3] <= dist + 1e-6
            rr.append(bm.verts.new(o0 - d * dist + d * (0.004 if on_boot else 0.016)))
        rings.append(rr)
    for j in range(len(rings) - 1):
        for k in range(S):
            k2 = (k + 1) % S
            bm.faces.new((rings[j][k], rings[j][k2], rings[j + 1][k2], rings[j + 1][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    g = link("Gaiter" + side, bm)
    sub = g.modifiers.new("Sub", "SUBSURF"); sub.levels = 1; apply(g, sub)
    so = g.modifiers.new("T", "SOLIDIFY"); so.thickness = 0.004; so.offset = 1.0; so.use_rim = True; apply(g, so)
    gaiters.append(g)
    # two straps with buckles on the outside
    G_BVH = BVHTree.FromPolygons([g.matrix_world @ v.co for v in g.data.vertices], [p.vertices for p in g.data.polygons])
    for zz in (ankle[side].z + 0.065, GAITER - 0.03):
        c0 = knee[side].lerp(ankle[side], (knee[side].z - zz) / (knee[side].z - ankle[side].z)); c0.z = zz
        bm = bmesh.new(); R2 = []; e_out = 0.05
        for k in range(S):
            a = k / S * math.pi * 2
            d = Vector((math.cos(a), math.sin(a), 0))
            hcast = G_BVH.ray_cast(c0 + d * 0.3, -d, 0.35)
            e = 0.3 - hcast[3] if hcast[0] is not None else 0.06
            if k == (0 if sx > 0 else S // 2): e_out = e
            R2.append([bm.verts.new(c0 + d * (e + 0.003) + Vector((0, 0, dz))) for dz in (-0.009, 0.009)])
        for k in range(S):
            k2 = (k + 1) % S
            bm.faces.new((R2[k][0], R2[k2][0], R2[k2][1], R2[k][1]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        st = link("Strap", bm)
        so = st.modifiers.new("T", "SOLIDIFY"); so.thickness = 0.003; so.offset = 1.0; apply(st, so)
        gaiters.append(st)
        cz = c0
        bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
        for v in bm.verts:
            v.co = Vector((cz.x + sx * (e_out + 0.008), cz.y, zz)) + Vector((v.co.x * 0.006, v.co.y * 0.022, v.co.z * 0.024))
        gaiters.append(link("Buckle", bm))

# ── Look and close-ups ───────────────────────────────────────────────────────
def mat(name, rgb):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name); m.diffuse_color = (*rgb, 1); return m
leather, canvas, strapm, solem = mat("Leather", (0.05, 0.035, 0.025)), mat("Canvas", (0.25, 0.23, 0.14)), mat("StrapLeather", (0.12, 0.08, 0.05)), mat("Sole", (0.03, 0.03, 0.03))
for o in boots: o.data.materials.append(leather)
for o in soles: o.data.materials.append(solem)
for o in gaiters: o.data.materials.append(canvas if o.name.startswith("Gaiter") else strapm)
for o in boots + gaiters:
    for p in o.data.polygons: p.use_smooth = True
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading
sh.light = "STUDIO"; sh.color_type = "MATERIAL"; sh.show_cavity = True; sh.cavity_type = "BOTH"
sh.show_backface_culling = True; sh.show_specular_highlight = False
scn.render.resolution_x, scn.render.resolution_y = 700, 700
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, target, frm, lens=55):
    cd.lens = lens
    cam.location = Vector(frm)
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(out, f"boots_{name}.png"); bpy.ops.render.render(write_still=True)
T = (0, -0.02, 0.17)
shot("front", T, (0, -1.6, 0.35))
shot("side", T, (1.6, 0, 0.3))
shot("back", T, (0, 1.6, 0.35))
shot("threequarter", T, (1.0, -1.2, 0.6))
shot("low", (0.11, -0.05, 0.08), (0.45, -0.55, 0.06), lens=50)
shot("top", (0.11, 0, 0.2), (0.25, -0.35, 0.75), lens=50)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, "lower.blend"))
print("DONE")
