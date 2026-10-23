"""TURNIN' TURBO — the red body as a SUBDIVISION CAGE (the user: "with the back, side and front views, couldn't you make
the chassis in Blender?"). A coarse cage — CAGE_STATIONS cross-sections of 18 points each — smoothed by Catmull-Clark
gives the flowing 911 nose: a hood dipping between raised fenders, the lamps on the fenders' ends, round sides, an
upright face above a bumper that wraps only the back corners. The lamps, the bumper and the top sticker are placed ON
the smoothed surface by raycasts (BVH). Kept SEPARATE from the main model: the page shows it with ?body=cage.

    "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
        --python tools/blender/turninTurboBody.py -- public/models/turnin-turbo/body_cage.glb

Game frame (x right, y up, the toy's FRONT at +z, the back = the car's nose at -z), metres, as turninTurbo.py.
"""
import sys, os, math
import bpy, bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

for _o in list(bpy.data.objects): bpy.data.objects.remove(_o)
R4 = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))   # game -> Blender

def mat(name, rgb, rough):
    m = bpy.data.materials.new(name)
    b = m.node_tree.nodes["Principled BSDF"] if m.node_tree else None
    if b: b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough
    return m
RED, SLATE, BLACK = mat("Red", (0.62, 0.03, 0.02), 0.3), mat("Slate", (0.035, 0.042, 0.05), 0.55), mat("Black", (0.012, 0.012, 0.013), 0.35)
GREY, LENS, FACE = mat("Grey", (0.33, 0.34, 0.35), 0.45), mat("Lens", (0.5, 0.51, 0.52), 0.2), mat("Face", (0.5, 0.5, 0.5), 0.6)

def link(name, me, material):
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    me.materials.append(material); return ob

# ---- the cage ---------------------------------------------------------------------------------------------------
# per station: z, half width at the table (wb), max half width (w, at ~40 % height), the fender crest height (hf, at
# x = FX), the hood's centre height (hh). The front stations stay under the bezel (its face leans back 28 deg).
FX = 0.148
CAGE_STATIONS = [
    # z       wb     w      hf     hh
    (-0.020, 0.198, 0.200, 0.168, 0.162),   # full height: sheared back along the leaning face by under_face()
    (-0.090, 0.190, 0.201, 0.168, 0.162),
    (-0.140, 0.180, 0.201, 0.164, 0.156),   # the hood only a little lower than the fenders (straight back photo)
    (-0.190, 0.176, 0.199, 0.160, 0.152),
    (-0.228, 0.172, 0.197, 0.156, 0.148),   # the top's rounded back edge starts
    (-0.248, 0.168, 0.193, 0.140, 0.134),   # the upright face carrying the lamps
    (-0.258, 0.160, 0.182, 0.112, 0.108),   # its rounded edge before the cap
]
TAN_TILT = math.tan(math.radians(28.0))
def under_face(y, z):
    """The red body stays behind the leaning face (28 deg about y 25 mm at z 0.02), 33 mm back — behind the panels,
    inside the slate band (in-hand side photo: the red comes right up to that band); 46 mm: the panels sit ~40 back."""
    return min(z, 0.02 - max(y - 0.025, 0.0) * TAN_TILT - 0.046) if y > 0.03 else z
def ring(z, wb, w, hf, hh):
    sh = min(hf, hh + 0.03)
    half = [(0.0, 0.0), (wb * 0.6, 0.0), (wb, 0.004), (w, 0.04), (w + 0.002, 0.075), (w - 0.004, sh * 0.72),
            (w - 0.022, hf - 0.006), (FX + 0.02, hf), (FX - 0.02, hf - 0.002), (0.078, hh + (hf - hh) * 0.35),
            (0.0, hh)]
    pts = half + [(-x, y) for x, y in reversed(half[1:-1])]
    return [(x, y, under_face(y, z)) for x, y in pts]

me = bpy.data.meshes.new("ShellCage")
bm = bmesh.new()
rings = [[bm.verts.new(R4.to_3x3() @ Vector(p)) for p in ring(*st)] for st in CAGE_STATIONS]
n = len(rings[0])
for a, b in zip(rings, rings[1:]):
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((a[i], a[j], b[j], b[i]))
# the back: an inner ring 55 % in, then an n-gon (subdivision turns it into a smooth slightly domed face)
last = rings[-1]; zc = CAGE_STATIONS[-1][0] - 0.006
cy = 0.05
inner = [bm.verts.new(R4.to_3x3() @ Vector((v.co.x * 0.55, cy + (v.co.z - cy) * 0.55, zc))) for v in last]
for i in range(n):
    j = (i + 1) % n
    bm.faces.new((last[i], last[j], inner[j], inner[i]))
bm.faces.new(inner[::-1])
# the front: closed too (hidden behind the bezel)
bm.faces.new(rings[0])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
# crease the bottom edge so the underside stays flat and the sides meet it crisply
bm.to_mesh(me); bm.free()
shell = link("ShellB", me, RED)
mod = shell.modifiers.new("sub", "SUBSURF"); mod.levels = 3; mod.render_levels = 3
dg = bpy.context.evaluated_depsgraph_get()
me2 = bpy.data.meshes.new_from_object(shell.evaluated_get(dg)); shell.modifiers.clear()
old = shell.data; shell.data = me2; bpy.data.meshes.remove(old)
for p in me2.polygons: p.use_smooth = True
# flatten whatever sank under the table, clamp to y >= 0
for v in me2.vertices:
    if v.co.z < 0: v.co.z = 0.0
me2.update()

# the apron under the bezel strip: a plain red block (in the cage, its low section pulled the smoothed surface forward
# in front of the panels — red showed through the windows)
me = bpy.data.meshes.new("ApronB"); bm = bmesh.new()
bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.scale(bm, vec=(0.398, 0.026, 0.07), verts=bm.verts)
bmesh.ops.translate(bm, vec=(0, 0.013, -0.019), verts=bm.verts)
for v in bm.verts: v.co = R4.to_3x3() @ v.co
bm.to_mesh(me); bm.free(); link("ApronB", me, RED)

# ---- raycasts on the smoothed body (game frame helpers) ---------------------------------------------------------
bvh = BVHTree.FromPolygons([v.co.copy() for v in me2.vertices], [tuple(p.vertices) for p in me2.polygons])
G = lambda v: Vector((v.x, v.z, -v.y))           # Blender -> game
B = lambda v: R4.to_3x3() @ Vector(v)            # game -> Blender
def hit(origin_g, dir_g):
    loc, nrm, _, _ = bvh.ray_cast(B(origin_g), B(dir_g).normalized())
    return (G(loc), G(nrm)) if loc else (None, None)

def gmat(origin, ex, ey):
    ex = Vector(ex).normalized(); ey = Vector(ey).normalized(); ez = ex.cross(ey).normalized(); ey = ez.cross(ex)
    m = Matrix.Identity(4)
    for i in range(3): m[i][0], m[i][1], m[i][2], m[i][3] = ex[i], ey[i], ez[i], origin[i]
    return R4 @ m
def lathe(name, prof, material, M, nseg=48):
    me = bpy.data.meshes.new(name); bm = bmesh.new(); rs = []
    for r, h in prof:
        rs.append([bm.verts.new((max(r, 0.0004) * math.cos(2 * math.pi * i / nseg), max(r, 0.0004) * math.sin(2 * math.pi * i / nseg), h)) for i in range(nseg)])
    for a, b in zip(rs, rs[1:]):
        for i in range(nseg):
            j = (i + 1) % nseg; bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(rs[0][::-1]); bm.faces.new(rs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me); bm.free(); me.transform(M)
    for p in me.polygons: p.use_smooth = True
    return link(name, me, material)

# ---- the lamps: on the fenders' ends, facing back and a little up; the ring just proud of the surface -------------
LAMP_Y, LAMP_UP = 0.112, math.radians(10)   # into the upright face, below its top (straight back photo)
POD = [(0.0, 0.0085), (0.0283, 0.0085), (0.0289, 0.0105), (0.0306, 0.0118), (0.0344, 0.0115), (0.0359, 0.0099),
       (0.0366, 0.0068), (0.0366, -0.03)]
for sx in (-1, 1):
    axis = Vector((0, math.sin(LAMP_UP), -math.cos(LAMP_UP)))
    p, nrm = hit((sx * FX, LAMP_Y, -0.1), axis)          # from inside the body, out through the fender's end
    ex = Vector((1, 0, 0)); ey = axis.cross(ex)
    M = gmat(p - axis * 0.011, ex, ey)                  # local z = the lamp's axis (ex x (axis x ex) = axis)
    lathe("PodB" + ("L" if sx < 0 else "R"), POD, GREY, M)
    lathe("LensB" + ("L" if sx < 0 else "R"), [(0.0, 0.0093), (0.026, 0.0093), (0.0265, 0.0088), (0.0265, 0.008)], LENS, M)

# ---- the bumper: round the back corners only, following the body's outline at its height, ribbed end caps --------
BUMP = [(-0.006, 0.036), (0.006, 0.036), (0.0092, 0.0375), (0.0105, 0.041), (0.0105, 0.052), (0.009, 0.0535),
        (0.0105, 0.055), (0.0105, 0.066), (0.009, 0.0675), (0.0105, 0.069), (0.009, 0.071), (0.006, 0.073), (-0.006, 0.073)]
outline = []
for k in range(41):                                    # plan outline at y 0.055, from one side round the back to the other
    a = math.pi * k / 40
    d = Vector((math.cos(a), 0, -math.sin(a)))
    p, _ = hit((0, 0.055, -0.15), d)
    outline.append((p.x, p.z))
outline = [q for q in outline if q[1] < -0.165]        # the corners and the back only
me = bpy.data.meshes.new("BumperB"); bm = bmesh.new(); rs = []
for i, (x, z) in enumerate(outline):
    a = Vector(outline[max(i - 1, 0)]); b = Vector(outline[min(i + 1, len(outline) - 1)])
    t = (b - a).normalized(); nn = Vector((t.y, -t.x))
    if nn.dot(Vector((x, z + 0.15))) < 0: nn = -nn
    rs.append([bm.verts.new(B((x + nn.x * o, y, z + nn.y * o))) for o, y in BUMP])
for a, b in zip(rs, rs[1:]):
    for i in range(len(BUMP) - 1): bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
bm.faces.new(rs[0]); bm.faces.new(rs[-1][::-1])
bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
for p in me.polygons: p.use_smooth = True
link("BumperB", me, SLATE)
for end in (outline[0], outline[-1]):                 # the ribbed caps where it stops
    sx = 1 if end[0] > 0 else -1
    M = gmat((end[0] + sx * 0.004, 0.0545, end[1] + 0.004), (0, 0, -sx), (0, 1, 0))
    for k, (w, h, d) in enumerate([(0.026, 0.056, 0.016)] + [(0.022, 0.0035, 0.019)] * 5):
        yy = 0 if k == 0 else -0.02 + (k - 1) * 0.01
        me = bpy.data.meshes.new("Cap"); bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0); bmesh.ops.scale(bm, vec=(w, h, d), verts=bm.verts)
        bmesh.ops.translate(bm, vec=(0, yy, 0), verts=bm.verts); bm.to_mesh(me); bm.free(); me.transform(M)
        link(f"BumperCap{sx}{k}", me, BLACK)

# ---- the TURNIN' TURBO DASHBOARD sticker, laid on the hood by raycasts down ---------------------------------------
X0, X1, ZC, D = 0.069, -0.103, -0.11, 0.02
verts, uvs, faces = [], [], []
NX, NZ = 40, 4
for j in range(NZ + 1):
    for i in range(NX + 1):
        x = X0 + (X1 - X0) * i / NX; z = ZC + D / 2 - D * j / NZ
        p, _ = hit((x, 0.4, z), (0, -1, 0))
        verts.append(B((x, p.y + 0.0006, z))); uvs.append((i / NX, 1 - j / NZ))
for j in range(NZ):
    for i in range(NX):
        q = j * (NX + 1) + i; faces.append((q, q + NX + 1, q + NX + 2, q + 1))
me = bpy.data.meshes.new("TopStickerB"); me.from_pydata(verts, [], faces); me.update()
uvl = me.uv_layers.new(name="UVMap")
for poly in me.polygons:
    for li in poly.loop_indices: uvl.data[li].uv = uvs[me.loops[li].vertex_index]
link("TopStickerB", me, FACE)

def join(name, names):
    obs = [bpy.data.objects[n] for n in names]
    with bpy.context.temp_override(active_object=obs[0], selected_editable_objects=obs, selected_objects=obs):
        bpy.ops.object.join()
    obs[0].name = name
join("BumperCapsB", [n for n in bpy.data.objects.keys() if n.startswith("BumperCap")])

print("BODY", [(o.name, len(o.data.polygons)) for o in bpy.data.objects])
out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.export_scene.gltf(filepath=os.path.abspath(out), export_format="GLB", export_yup=True, export_apply=True,
                          export_texcoords=True, export_normals=True, export_materials="EXPORT")
print("wrote", out)
