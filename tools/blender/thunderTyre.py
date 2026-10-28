"""THUNDERLINE'S TYRE (2026-10-28, you: "the oil barrel, swing gates, tyre stacks look kind of cheap … make better AAA
assets for the obstacles"; real motorsport; the tyre stack first). A worn TRUCK tyre — the stack's tyre is 1.4 m across
and 0.45 m thick (the old game's physics: TIRE_OUTER_R 0.70, TIRE_TUBE_R 0.224, three of them a 1.3 m wall), the size of
a 385/65 R22.5: deep chevron lugs on the tread, a bulging sidewall with rim-protector ribs, raised lettering, serrations
at the shoulder; black rubber, dust in the grooves and round the bead, the lug tops scuffed.

THE MESH, three levels, centred on the body's pivot (the physics' own), axis = game Y:
  TyreLOD0  ~4k triangles: the section turned (72 steps) with the tread floor sunk, the LUGS as geometry (2 staggered
            rows of 32, chevron) — the outline at the chase camera is a lugged tyre
  TyreLOD1  ~1k: the section, 36 steps, the tread face whole (its lugs in the texture)
  TyreLOD2  ~0.25k: 16 steps, a few section points
THE TEXTURES (1024², one set — later a slot of the obstacles' shared atlas), painted HERE from the geometry's own numbers
(the lugs, ribs and letters exactly where the mesh has them), the occlusion baked from LOD0:
  tyre_color.png   rubber, dust, scuffs (sRGB)
  tyre_normal.png  the relief: letters, ribs, serrations, the lugs' rounded edges and sipes (OpenGL, +Y = +v)
  tyre_arm.png     R occlusion, G roughness, B metalness (0) — "_arm": the KTX2 tool and loadTexture keep it linear
UV: u = a quarter turn (everything repeats 4 times round — a real tyre says its name twice), v: [0, 0.74] the sidewall
from the bore to the shoulder (the bottom side MIRRORS the top: it faces the road), [0.745, 0.775] the hidden groove
floor and lug walls (plain), [0.78, 0.98] the tread band across its width.

  node tools/thunderObstacles.mjs tyre      (runs this, then optimises the mesh into public/models/thunderline/)
Writes .cache/blender/thunder-obstacles/tyre.glb, public/textures/thunderline/obstacles/tyre_*.png and previews in
assets-src/refs/thunderline-obstacles/.
"""
import bpy, bmesh, sys, os, math
import numpy as np
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CACHE = os.path.join(ROOT, ".cache", "blender", "thunder-obstacles"); os.makedirs(CACHE, exist_ok=True)
TEX = os.path.join(ROOT, "public", "textures", "thunderline", "obstacles"); os.makedirs(TEX, exist_ok=True)
REFS = os.path.join(ROOT, "assets-src", "refs", "thunderline-obstacles"); os.makedirs(REFS, exist_ok=True)
QUICK = "--quick" in sys.argv
NOPREVIEW = "--nopreview" in sys.argv
S = 1024                       # texture size
bpy.ops.wm.read_factory_settings(use_empty=True)

# ── THE PHYSICS' TYRE (games/modular-road-v3/modularRoadPropPhysics.js) ──────────────────────────────────────────────
OUT, HW = 0.70, 0.224          # outer radius, half thickness (m)
BORE = 0.35                    # the bead's bore
FLOOR = 0.672                  # LOD0: the tread floor between the lugs
TREAD_Z = 0.188                # the tread face's half width (the lugs' outer ends)

# the half section (r, z) from the bore's middle (z = 0) to the tread's edge; mirrored for the other half
SIDE = [(BORE, 0.0), (BORE, 0.120), (BORE + 0.004, 0.150), (0.362, 0.170), (0.380, 0.181), (0.405, 0.190), (0.43, 0.197),
        (0.47, 0.207), (0.52, 0.216), (0.57, 0.221), (0.61, 0.222), (0.640, 0.216), (0.660, 0.206)]
def section(tread_r, n_tread=4, lod=0):
    """The closed section as three paths of (r, z, v): TOP (bore → top shoulder, sidewall v), TREAD (top edge → bottom
    edge across the face, tread-band v), BOTTOM (bottom shoulder → bore, the top's v mirrored)."""
    side = SIDE if lod == 0 else [SIDE[i] for i in ((0, 2, 3, 5, 7, 9, 11, 12) if lod == 1 else (0, 2, 4, 7, 10, 12))]
    shoulder = [(tread_r - 0.006, TREAD_Z + 0.006), (tread_r, TREAD_Z)] if lod < 2 else [(tread_r, TREAD_Z)]
    half = side + shoulder
    s, acc = [0.0], 0.0
    for a, b in zip(half, half[1:]): acc += math.hypot(b[0] - a[0], b[1] - a[1]); s.append(acc)
    top = [(r, z, 0.74 * si / acc) for (r, z), si in zip(half, s)]
    tread = [(tread_r, z, 0.78 + 0.20 * (z + 0.19) / 0.38) for z in np.linspace(TREAD_Z, -TREAD_Z, n_tread + 1)]
    bottom = [(r, -z, v) for (r, z, v) in reversed(top)]
    return top, tread, bottom, acc
_, _, _, S_A = section(OUT)    # the sidewall's arc length (the texture's v scale)

def lathe(name, steps, tread_r, lod):
    """The section turned round Z (Blender: z up = the game's y), UVs per face corner (u: a quarter turn)."""
    top, tread, bottom, _ = section(tread_r, 4 if lod < 2 else 2, lod)
    me = bpy.data.meshes.new(name); bm = bmesh.new(); uv = bm.loops.layers.uv.new("UV")
    q = steps // 4
    def band(prof, plain=False):
        rows = [[bm.verts.new((r * math.cos(2 * math.pi * k / steps), r * math.sin(2 * math.pi * k / steps), z)) for k in range(steps)] for (r, z, _) in prof]
        for j in range(len(prof) - 1):
            for k in range(steps):
                k2 = (k + 1) % steps
                f = bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
                u0, u1 = (k % q) / q, (k % q + 1) / q
                va, vb = (0.76, 0.76) if plain else (prof[j][2], prof[j + 1][2])
                for loop, (uu, vv) in zip(f.loops, ((u0, va), (u1, va), (u1, vb), (u0, vb))): loop[uv].uv = (uu, vv)
    band(top); band(tread, plain=(lod == 0)); band(bottom)   # (LOD0's tread floor: plain rubber under the lugs)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)   # (the paths share their end rows)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)         # (a closed ring: outward)
    for f in bm.faces: f.smooth = True
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    me.set_sharp_from_angle(angle=math.radians(40))
    return o

# THE LUGS (LOD0 geometry; the same numbers paint them in the textures): two rows, 40 round each, staggered half a pitch,
# slanted the opposite way (a chevron); each a block from the floor to the tread face, its ends at the rows' z limits
PITCH = 11.25                  # degrees (32 round: 8 a quarter turn — the texture's repeat)
LUG_W = 7.4                    # degrees of a lug's width (~9 cm; the groove: the rest, ~4.7 cm)
SLANT = 24.0                   # degrees of turn per metre of z: a gentle chevron (~17° off square, a drive tyre's)
ROW = [(0.014, TREAD_Z, 0.0, +1), (-TREAD_Z, -0.014, PITCH / 2, -1)]   # (z0, z1, phase, slant sign)
def lug_center(z, phase, sgn, k):
    """A lug's centre angle (deg) at height z: the k-th of its row."""
    return k * PITCH + phase + sgn * SLANT * abs(z)
def lugs(name):
    me = bpy.data.meshes.new(name); bm = bmesh.new(); uv = bm.loops.layers.uv.new("UV")
    for (z0, z1, phase, sgn) in ROW:
        for k in range(32):
            corners = []
            for z in (z0, z1):
                c = lug_center(z, phase, sgn, k)
                for d in (-LUG_W / 2, LUG_W / 2): corners.append((c + d, z))
            # (a, z0)-(b, z0)-(b, z1)-(a, z1) at the floor and at the face
            quad = [corners[0], corners[1], corners[3], corners[2]]
            def V(ang, z, r): t = math.radians(ang); return bm.verts.new((r * math.cos(t), r * math.sin(t), z))
            face = [V(a, z, OUT) for (a, z) in quad]; floor = [V(a, z, FLOOR - 0.002) for (a, z) in quad]
            mid = sum((v.co for v in face + floor), Vector()) / 8
            tp = bm.faces.new(face)
            # (the top face's corners in ONE quarter: a lug may straddle a quarter's edge — unwrapped continuously)
            base = math.floor(quad[0][0] / 90.0) * 90.0
            for loop, (a, z) in zip(tp.loops, quad): loop[uv].uv = ((a - base) / 90.0, 0.78 + 0.20 * (z + 0.19) / 0.38)
            walls = [bm.faces.new((floor[i], floor[(i + 1) % 4], face[(i + 1) % 4], face[i])) for i in range(4)]
            for w in walls:
                for loop in w.loops: loop[uv].uv = (0.5, 0.76)   # (the walls: the groove's plain rubber)
            # outward, every face: the top away from the axis, a wall away from the lug's middle
            bm.normal_update()
            radial = Vector((tp.calc_center_median().x, tp.calc_center_median().y, 0))
            if tp.normal.dot(radial) < 0: tp.normal_flip()
            for w in walls:
                if w.normal.dot(w.calc_center_median() - mid) < 0: w.normal_flip()
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    return o

def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active; o.name = name; o.data.name = name
    return o

lod0 = join([lathe("TyreBody0", 72, FLOOR, 0), lugs("TyreLugs")], "TyreLOD0")
lod1 = lathe("TyreLOD1", 36, OUT, 1)
lod2 = lathe("TyreLOD2", 16, OUT, 2)
def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
for o in (lod0, lod1, lod2): print("TRIS", o.name, tris(o))

# ── THE LETTERING, rendered into the sidewall's UV (white letters on black: a height map) ──────────────────────────────
def r_of_v(v):
    """The sidewall's radius at texture v (inverse of the section's arc length)."""
    half = SIDE + [(OUT - 0.006, TREAD_Z + 0.006), (OUT, TREAD_Z)]
    s, acc = [0.0], 0.0
    for a, b in zip(half, half[1:]): acc += math.hypot(b[0] - a[0], b[1] - a[1]); s.append(acc)
    t = v / 0.74 * acc
    for i in range(len(half) - 1):
        if s[i + 1] >= t: f = (t - s[i]) / max(s[i + 1] - s[i], 1e-9); return half[i][0] + f * (half[i + 1][0] - half[i][0])
    return half[-1][0]
def v_of_r(r):
    lo, hi = 0.0, 0.74
    for _ in range(40):
        mid = (lo + hi) / 2
        if r_of_v(mid) < r: lo = mid
        else: hi = mid
    return (lo + hi) / 2
FONT = next((p for p in ("C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/impact.ttf") if os.path.exists(p)), None)
LETTERS = [  # (text, u centre, radius of its middle (m), letter height (m))
    ("THUNDERLINE", 0.36, 0.515, 0.050),
    ("TL-900 DRIVE", 0.80, 0.515, 0.030),
    ("385/65 R22.5   160K   TUBELESS", 0.42, 0.448, 0.013),
    ("M+S", 0.86, 0.448, 0.013),
]
def render_letters():
    scn = bpy.data.scenes.new("Letters")
    scn.render.engine = "BLENDER_WORKBENCH"
    scn.display.shading.light = "FLAT"; scn.display.shading.color_type = "SINGLE"; scn.display.shading.single_color = (1, 1, 1)
    scn.view_settings.view_transform = "Standard"
    scn.world = bpy.data.worlds.new("Black"); scn.world.color = (0, 0, 0)
    H = int(S * 0.74)
    scn.render.resolution_x, scn.render.resolution_y = S, H
    font = bpy.data.fonts.load(FONT) if FONT else None
    for text, uc, r, h in LETTERS:
        cu = bpy.data.curves.new("T", "FONT"); cu.body = text; cu.size = h; cu.align_x = "CENTER"; cu.align_y = "CENTER"
        if font: cu.font = font
        o = bpy.data.objects.new("T", cu); scn.collection.objects.link(o)
        # metres → UV: along the turn 1 / (r · π/2), across (radial) the sidewall's v per metre
        dv = (v_of_r(r + 0.01) - v_of_r(r - 0.01)) / 0.02
        # (u runs the other way round from the way the text reads, seen from above: mirrored in u, it reads right)
        o.location = (uc, v_of_r(r), 0); o.scale = (-1 / (r * math.pi / 2), dv, 1)
    cd = bpy.data.cameras.new("C"); cd.type = "ORTHO"; cd.ortho_scale = 1.0
    cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
    cam.location = (0.5, 0.37, 5)
    path = os.path.join(CACHE, "tyre_letters.png"); scn.render.filepath = path
    bpy.ops.render.render(write_still=True, scene=scn.name)
    img = bpy.data.images.load(path); a = np.array(img.pixels[:], np.float32).reshape(H, S, 4)[..., 0]
    out = np.zeros((S, S), np.float32); out[:H] = a
    return out

# ── THE HEIGHT FIELD (metres) over the whole texture, and the masks the colour reads ────────────────────────────────
def smooth(e0, e1, x): t = np.clip((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t)
rng = np.random.default_rng(1977)
def noise(scale, octaves=3):
    """Tileable value noise in [0, 1] (periodic in u: the quarter turn repeats)."""
    acc = np.zeros((S, S), np.float32); amp, tot = 1.0, 0.0
    for o in range(octaves):
        n = int(scale * 2 ** o)
        g = rng.random((n + 1, n + 1)).astype(np.float32); g[:, -1] = g[:, 0]
        y = np.linspace(0, n, S, endpoint=False); x = np.linspace(0, n, S, endpoint=False)
        yi, xi = y.astype(int), x.astype(int); fy, fx = (y - yi)[:, None], (x - xi)[None, :]
        fy, fx = fy * fy * (3 - 2 * fy), fx * fx * (3 - 2 * fx)
        a = g[yi][:, xi]; b = g[yi][:, xi + 1]; c = g[yi + 1][:, xi]; d = g[yi + 1][:, xi + 1]
        acc += amp * (a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy); tot += amp; amp *= 0.5
    return acc / tot
V = (np.arange(S) + 0.5) / S; U = (np.arange(S) + 0.5) / S
VV, UU = np.meshgrid(V, U, indexing="ij")
inA, inC, inB = VV < 0.742, (VV >= 0.742) & (VV < 0.778), VV >= 0.778
R_A = np.vectorize(r_of_v)(np.minimum(V, 0.74))[:, None] * np.ones((1, S))   # (the sidewall's radius per row)
h = np.zeros((S, S), np.float32)
# the sidewall: the rim-protector rib, two fine rings, the shoulder's serrations, the letters
rib = lambda r0, w, hh: hh * smooth(w, 0, np.abs(R_A - r0))
h += np.where(inA, rib(0.398, 0.007, 0.004) + rib(0.428, 0.0018, 0.0012) + rib(0.436, 0.0018, 0.0012) + rib(0.590, 0.0022, 0.0012), 0)
ang = UU * 90.0
serr = (smooth(0.60, 0.615, R_A) * smooth(0.665, 0.65, R_A)) * (np.abs(((ang % 3.0) / 3.0) - 0.5) < 0.18)
h += np.where(inA, 0.0025 * serr, 0)
letters = render_letters()
letters = np.where(inA, letters, 0)
h += 0.0016 * letters
# the tread band: the lugs (raised), their sipes (slits), the centre groove
Zb = (VV - 0.78) / 0.20 * 0.38 - 0.19
lugmask = np.zeros((S, S), np.float32)
for (z0, z1, phase, sgn) in ROW:
    inrow = (Zb >= z0) & (Zb <= z1)
    c = phase + sgn * SLANT * np.abs(Zb)                     # the row's centre angle at this z (deg), lug k = 0
    d = ((ang - c) % PITCH); d = np.minimum(d, PITCH - d)    # (distance in degrees to the nearest lug's centre)
    edge = smooth(LUG_W / 2 + 0.25, LUG_W / 2 - 0.35, d) * smooth(0, 0.006, np.minimum(Zb - z0, z1 - Zb).clip(0))
    sipe = smooth(0.5, 0.15, np.abs(d - LUG_W * 0.12))     # one sipe across each lug, soft-edged (thin ones aliased)
    lugmask = np.maximum(lugmask, np.where(inrow, edge, 0))
    h += np.where(inrow & inB, 0.026 * edge - 0.004 * sipe * edge, 0)
grooves = np.where(inB, 1 - lugmask, 0)

# ── THE NORMAL MAP from the height (tangent: +u along the turn, +v outward / across the tread) ───────────────────────
du_m = np.where(inA, R_A * (math.pi / 2) / S, OUT * (math.pi / 2) / S)      # metres per texel along u
dv_m = np.where(inA, S_A / (0.74 * S), 0.38 / (0.20 * S))                    # … along v
gy, gx = np.gradient(h)
nx, ny = -gx / du_m, -gy / dv_m
nz = np.ones_like(nx); n = np.sqrt(nx * nx + ny * ny + nz * nz)
normal = np.stack([nx / n * 0.5 + 0.5, ny / n * 0.5 + 0.5, nz / n * 0.5 + 0.5], -1)
normal[inC] = (0.5, 0.5, 1.0)

# ── THE OCCLUSION, baked from LOD0 (Cycles) ─────────────────────────────────────────────────────────────────────────
def bake_ao(o):
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"; scn.cycles.samples = 16 if QUICK else 96; scn.cycles.device = "CPU"
    if scn.world is None: scn.world = bpy.data.worlds.new("W")
    scn.world.light_settings.distance = 0.12
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
ao = bake_ao(lod0)
ao = np.where(inC, 0.35, ao)                                  # (the groove floor and lug walls: deep in)
ao = np.where(inB, np.maximum(ao, 0.35 + 0.65 * lugmask), ao) # (the band: the LOD1 tread reads the lugs too)
ao = np.clip(ao, 0, 1)

# ── THE COLOUR AND ROUGHNESS ────────────────────────────────────────────────────────────────────────────────────────
def lin(hexv): return np.array([((hexv >> s & 255) / 255) ** 2.2 for s in (16, 8, 0)], np.float32)
RUBBER, WORN, DUST, GREYDUST = lin(0x1d1d1f), lin(0x2c2c2e), lin(0x6e6253), lin(0x55524c)
mott = noise(6, 4); fine = noise(48, 2)
col = RUBBER[None, None, :] * (0.85 + 0.3 * mott[..., None])
# dust: in the grooves, round the bead and in the sidewall's low places (the occlusion), patchy
dustA = np.where(inA, smooth(0.42, 0.37, R_A) * 0.35 + (1 - ao) * 0.35, 0)
dustB = np.where(inB, grooves * 0.75, 0) + np.where(inC, 0.8, 0)
dmask = np.clip((dustA + dustB) * (0.6 + 0.6 * noise(10, 3)), 0, 0.85)
col = col * (1 - dmask[..., None]) + (DUST * 0.55 + GREYDUST * 0.45)[None, None, :] * 0.35 * dmask[..., None]
# the raised letters and ribs catch light and dust: a touch lighter; the lug tops scuffed (worn, a little sheen)
col = col + (WORN - RUBBER)[None, None, :] * np.clip(letters + np.where(inA, rib(0.398, 0.007, 1.0), 0), 0, 1)[..., None] * 0.9
scuff = np.where(inB, lugmask * (0.5 + 0.5 * noise(20, 3)), 0)
col = col + (WORN - RUBBER)[None, None, :] * scuff[..., None] * 0.3   # (worn tread stays dark: a sheen, not grey)
col = col * (0.92 + 0.08 * fine[..., None])
col = col * (0.55 + 0.45 * ao[..., None])                     # (some occlusion in the colour: the sun's light too)
col = col * (1 - 0.45 * smooth(0.37, 0.351, R_A) * inA)[..., None]   # (the bore: inside, darker)
rough = 0.86 - 0.12 * scuff + 0.06 * dmask - 0.04 * letters
orm = np.stack([ao, np.clip(rough, 0, 1), np.zeros_like(ao)], -1)

def save(name, arr, srgb):
    img = bpy.data.images.new(name, S, S, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "sRGB" if srgb else "Non-Color"
    px = np.ones((S, S, 4), np.float32)
    px[..., :3] = np.clip(arr ** (1 / 2.2) if srgb else arr, 0, 1)
    img.pixels.foreach_set(px.ravel())
    img.filepath_raw = os.path.join(TEX, f"{name}.png"); img.file_format = "PNG"; img.save()
    return img
imgC = save("tyre_color", col, True); imgN = save("tyre_normal", normal, False); imgO = save("tyre_arm", orm, False)

# ── EXPORT: the three levels, geometry + UVs only (the game loads the textures itself: loadTexture → KTX2) ───────────
for o in (lod0, lod1, lod2): o.data.materials.clear()
bpy.ops.object.select_all(action="DESELECT")
for o in (lod0, lod1, lod2): o.select_set(True)
glb = os.path.join(CACHE, "tyre.glb")
# (glTF flips v on export; the game's textures go through loadTexture, which keeps three's default flipY — PNG and its
# KTX2 copy alike — so the mesh leaves with v pre-flipped: the game samples the image the way Blender baked it)
def flip_v(objs):
    for o in objs:
        for d in o.data.uv_layers[0].data: d.uv = (d.uv[0], 1.0 - d.uv[1])
flip_v((lod0, lod1, lod2))
bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_yup=True, export_materials="NONE",
                          export_texcoords=True, export_normals=True, export_apply=True)
flip_v((lod0, lod1, lod2))     # (back, for the preview)

# ── PREVIEW: a stack of three and one lying apart, lit by a sun over a grey floor (Cycles) ──────────────────────────
if not NOPREVIEW:
    scn = bpy.context.scene
    mat = bpy.data.materials.new("Tyre"); mat.use_nodes = True; nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    tc = nt.nodes.new("ShaderNodeTexImage"); tc.image = imgC; nt.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    to = nt.nodes.new("ShaderNodeTexImage"); to.image = imgO; sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(to.outputs["Color"], sep.inputs[0]); nt.links.new(sep.outputs[1], bsdf.inputs["Roughness"])
    tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = imgN; nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(tn.outputs["Color"], nm.inputs["Color"]); nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    for o in (lod0, lod1, lod2): o.data.materials.append(mat)
    stack = [lod0] + [lod0.copy() for _ in range(2)]
    for i, o in enumerate(stack):
        if i: scn.collection.objects.link(o)
        o.location = (0, 0, HW + i * 2 * HW); o.rotation_euler = (0, 0, i * 0.7)
    lone = lod0.copy(); scn.collection.objects.link(lone); lone.location = (1.9, 0.6, HW); lone.rotation_euler = (0, 0, 1.3)
    lod1.location = (-1.9, 0.9, HW); lod2.location = (-3.6, 1.4, HW)
    bpy.ops.mesh.primitive_plane_add(size=40); fl = bpy.context.active_object
    fm = bpy.data.materials.new("Floor"); fm.use_nodes = True; fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.18, 0.18, 0.19, 1)
    fl.data.materials.append(fm)
    sun = bpy.data.lights.new("Sun", "SUN"); sun.energy = 4.0; sun.angle = math.radians(2)
    so = bpy.data.objects.new("Sun", sun); scn.collection.objects.link(so); so.rotation_euler = (math.radians(52), 0, math.radians(35))
    scn.world.use_nodes = True; bg = scn.world.node_tree.nodes["Background"]; bg.inputs["Color"].default_value = (0.55, 0.65, 0.8, 1); bg.inputs["Strength"].default_value = 0.6
    cd = bpy.data.cameras.new("C"); cd.lens = 50; cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
    scn.render.resolution_x, scn.render.resolution_y = 1400, 800; scn.cycles.samples = 24 if QUICK else 96
    scn.view_settings.view_transform = "AgX"
    for tag, loc, aim in (("wide", (2.6, -6.0, 2.6), (0, 0.4, 0.75)), ("close", (0.9, -2.0, 1.25), (0.15, 0, 0.9)),
                          ("side", (0.4, -1.3, 2.6), (0.1, 0.1, 1.34))):
        cam.location = loc; cam.rotation_euler = (Vector(aim) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        scn.render.filepath = os.path.join(REFS, f"tyre_{tag}.png"); bpy.ops.render.render(write_still=True)
print("DONE")
