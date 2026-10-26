"""THE HAYSTACK (2026-10-26, you on the village props' hay: "look really like some low poly assets, very cheap … show me a
nice looking haystack you can do"; then "that's the minimum level we want for assets, nothing cheaper"). A straw stack
round its pole, as the Aurès and Kabylie farms stacked the threshed straw before the balers: lopsided, leaning, sagging;
its outside bleached by the sun, golden where it was pulled; branches laid over its top against the wind; the trodden
straw round its foot; a pitchfork against it.

THE CoH WAY — the outline is what reads as straw from the RTS camera, so:
  CORE   a lumpy turned body round the pole: the dark straw under the cards
  STRAW  ~550 CARDS — strips of a straw-strand texture with transparent gaps (alpha-tested), layered like shingles from
         the foot up, each hanging from its root tucked into the core, its tip flared out: the ragged outline. Their
         normals the STACK's (from its axis), not the cards' own: it shades as one volume, not as 500 planes. Vertex
         colour: dark at the roots, light at the tips — the occlusion between the clumps, which the game's shadow map
         is far too coarse to draw
  SKIRT  flat cards on the ground round its foot (the trodden straw — not lumps)
TWO LEVELS, each ONE object and ONE draw (one material, one sheet — the straw's strands left, the core's opaque straw
right; the wood on a dark corner of it):
  HayNear  ~4.7k triangles: everything above
  HayFar   ~0.8k: the core coarser and a little fuller, ~110 bigger cards in rings, a few skirt cards — the ragged
           outline kept from the RTS camera. The game cross-fades the two (a dither over a few metres: no pop).
The SHEET goes out as a PNG (public/textures/props/haystack.png, 1024×512): the game builds its mipmaps itself, scaling
each level's alpha to keep the straw's coverage (strands one texel wide dissolve down a plain mip chain).
The flutter: the game reads it from the UV (the straw half, its v: 1 at a card's root, 0 at its tip).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup --python tools/blender/haystack.py

Writes public/models/alg/haystack.glb (HayNear, HayFar; geometry only — then tools/optimizeGlb.mjs for meshopt),
public/textures/props/haystack.png, and previews in assets-src/refs/haystack/. Real metres; the game draws props ×1.3.
"""
import bpy, bmesh, sys, os, math, random
import numpy as np
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT_GLB = os.path.join(ROOT, "public", "models", "alg", "haystack.glb")
OUT_TEX = os.path.join(ROOT, "public", "textures", "props", "haystack.png"); os.makedirs(os.path.dirname(OUT_TEX), exist_ok=True)
REFS = os.path.join(ROOT, "assets-src", "refs", "haystack"); os.makedirs(REFS, exist_ok=True)
NOPREVIEW = "--nopreview" in sys.argv
R = random.Random(1956)
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()
def B(x, y, z): return Vector((x, -z, y))           # game (y up) → Blender (z up)

# ── THE SHEET: 2048 × 1024 — left half the straw cards' strands (four columns: four card variants, alpha), right half the
# core (the same strands over dark straw, opaque). Halved to 1024 × 512 for the game. ─────────────────────────────────
S = 1024
GOLD, PALE, GREY, DARK = (0.74, 0.55, 0.24), (0.80, 0.68, 0.44), (0.60, 0.54, 0.43), (0.40, 0.29, 0.14)   # (warm, darkish: the occlusion is in the colour)
def strand_colour(r):
    a, b, t = (GREY, PALE, r * 3) if r < 0.33 else ((PALE, GOLD, (r - 0.33) * 3) if r < 0.66 else (GOLD, DARK, (r - 0.66) * 3))
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))
def strands(n_cols, per_col, gutter):
    px = np.zeros((S, S, 4), np.float32)
    for col in range(n_cols):
        x_lo, x_hi = col * S // n_cols + gutter, (col + 1) * S // n_cols - gutter
        for k in range(per_col):
            x0 = R.uniform(x_lo, x_hi); L = R.uniform(0.25, 1.0) * S; y0 = R.uniform(0, 0.2) * S   # (most strands start at the root)
            bend = R.uniform(-22, 22); w = R.choice((1, 1, 2, 2, 2, 3)); c = strand_colour(R.random())
            shade = R.uniform(0.8, 1.1)
            for yy in range(int(y0), min(S, int(y0 + L))):
                t = (yy - y0) / L
                x = int(x0 + bend * t * t)
                ww = w if t < 0.75 else max(1, w - 1)                                   # (thinner toward the tip)
                for dx in range(ww):
                    xi = x + dx
                    if max(0, x_lo - 4) <= xi < min(S, x_hi + 4):
                        k2 = shade * (0.82 + 0.18 * t) * (1.0 if dx == ww // 2 else 0.86)
                        px[yy, xi, :3] = [ch * k2 for ch in c]; px[yy, xi, 3] = 1.0
    return px[::-1]                                        # (the top edge = the cards' roots: v = 1)
straw = strands(4, 520, 6)
core = strands(1, 1500, 0)
under = np.array([*DARK, 1.0], np.float32) * np.array([0.8, 0.8, 0.8, 1.0], np.float32)
core = core * core[..., 3:4] + under * (1 - core[..., 3:4]); core[..., 3] = 1.0
sheet = np.concatenate([straw, core], axis=1)          # (S, 2S, 4)
sheet[:, S - 12:S + 12, :3] = np.where(sheet[:, S - 12:S + 12, 3:4] > 0, sheet[:, S - 12:S + 12, :3], under[:3])   # (a gutter of dark straw)
def save(name, px, path):
    h, w = px.shape[:2]
    im = bpy.data.images.new(name, w, h, alpha=True)
    im.pixels = px.ravel().tolist()
    im.filepath_raw = path; im.file_format = "PNG"; im.save()
    return im
sheet_img = save("haystack_sheet", sheet, os.path.join(REFS, "haystack_sheet.png"))
# the game's: halved, premultiplied (no dark fringe from the transparent texels), then un-premultiplied
pm = sheet.copy(); pm[..., :3] *= pm[..., 3:4]
half = (pm[0::2, 0::2] + pm[1::2, 0::2] + pm[0::2, 1::2] + pm[1::2, 1::2]) / 4
a = half[..., 3:4]; half[..., :3] = np.where(a > 1e-4, half[..., :3] / np.maximum(a, 1e-4), np.array(GOLD, np.float32) * 0.7)
save("haystack_game", half, OUT_TEX)

M = bpy.data.materials.new("Haystack"); M.use_nodes = True
nt = M.node_tree; pb = nt.nodes["Principled BSDF"]
tn = nt.nodes.new("ShaderNodeTexImage"); tn.image = sheet_img
vc = nt.nodes.new("ShaderNodeVertexColor"); vc.layer_name = "Col"
mul = nt.nodes.new("ShaderNodeMix"); mul.data_type = "RGBA"; mul.blend_type = "MULTIPLY"; mul.inputs[0].default_value = 1.0
nt.links.new(tn.outputs["Color"], mul.inputs[6]); nt.links.new(vc.outputs["Color"], mul.inputs[7])
nt.links.new(mul.outputs[2], pb.inputs["Base Color"]); nt.links.new(tn.outputs["Alpha"], pb.inputs["Alpha"])
pb.inputs["Roughness"].default_value = 0.95
try: M.surface_render_method = "DITHERED"
except Exception: pass

# ── THE STACK'S SHAPE: radius at a height, around the (leaning) axis ─────────────────────────────────────────────────
H = 2.55                                                  # the straw's top
PROF = [(0.0, 1.22), (0.25, 1.32), (0.7, 1.36), (1.2, 1.24), (1.7, 0.98), (2.1, 0.66), (2.4, 0.34), (H, 0.08)]
def radius(y, a):
    for (y0, r0), (y1, r1) in zip(PROF, PROF[1:]):
        if y <= y1:
            t = (y - y0) / (y1 - y0); r = r0 + (r1 - r0) * (t * t * (3 - 2 * t))
            break
    else: r = PROF[-1][1]
    return r * (1 + 0.07 * math.cos(a - 0.8) - 0.05 * math.cos(2 * a + 1.3) + 0.035 * math.sin(3 * a + y * 2.1) + 0.025 * math.sin(5 * a - y * 3.7))
LEAN = Vector((0.16, 0, 0.06))                             # the top's drift (game x, -, z) over its height
def axis(y): return Vector((LEAN.x * (y / H) ** 1.6, y, LEAN.z * (y / H) ** 1.6))
def surf(y, a, push=0.0):
    c = axis(y); r = radius(y, a) + push
    return c + Vector((math.cos(a) * r, 0, math.sin(a) * r))
def vol_normal(p):
    """The stack's volume normal at a point (game space): out from its axis, tipped up toward the top; the skirt's up."""
    if p.y < 0.06 and (p - axis(0)).length > 0.9: return Vector((0, 1, 0))
    c = axis(max(0.0, min(H, p.y))); n = p - c; n.y = max(n.y, 0) + 0.35 * (p.y / H) + 0.1
    return n.normalized()

class Mesh:
    """One level's bmesh: UV (the sheet: straw u in [0, .5], core u in [.5, 1]) and a vertex colour."""
    def __init__(s): s.bm = bmesh.new(); s.uv = s.bm.loops.layers.uv.new("UV"); s.col = s.bm.loops.layers.color.new("Col"); s.vol = set()
    def v(s, p, vol=False):
        q = s.bm.verts.new(B(*p))
        if vol: s.vol.add(q)
        return q
    def face(s, vs, uvs, cols):
        f = s.bm.faces.new(vs)
        for l, u, c in zip(f.loops, uvs, cols): l[s.uv].uv = u; l[s.col] = c
        return f
    def finish(s, name):
        s.bm.verts.index_update()                              # (to_mesh writes the verts in this order)
        vol_idx = {q.index for q in s.vol}
        me = bpy.data.meshes.new(name)
        s.bm.to_mesh(me); s.bm.free()
        o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o); me.materials.append(M)
        for p in me.polygons: p.use_smooth = True
        me.update()
        # the straw's normals the VOLUME's; the core's and the wood's their own (smooth)
        ln = []
        for l in me.loops:
            vi = l.vertex_index
            if vi in vol_idx:
                co = me.vertices[vi].co; ln.append(B(*vol_normal(Vector((co.x, co.z, -co.y)))) - B(0, 0, 0))
            else: ln.append(me.vertices[vi].normal.copy())
        me.normals_split_custom_set(ln)
        return o
def grey(g): return (g, g, g, 1.0)

def core_shell(m, NA, NY, push, g0, g1):
    """The lumpy turned body: per-quad UVs in the core half (its strands up the stack), shade g0 at the foot → g1 at the top."""
    rows = [[m.v(surf(H * j / NY, 2 * math.pi * i / NA, push)) for i in range(NA)] for j in range(NY + 1)]
    top = m.v(axis(H + 0.05 + push))
    UW, VW = 8, max(2, NY // 2)                            # (UV repeat: the core half spans UW quads around, VW up)
    for j in range(NY):
        for i in range(NA):
            u0, u1 = 0.5 + 0.5 * (i % UW) / UW, 0.5 + 0.5 * (i % UW + 1) / UW
            v0, v1 = (j % VW) / VW, (j % VW + 1) / VW
            ga, gb = g0 + (g1 - g0) * j / NY, g0 + (g1 - g0) * (j + 1) / NY
            m.face((rows[j][i], rows[j][(i + 1) % NA], rows[j + 1][(i + 1) % NA], rows[j + 1][i]),
                   ((u0, v0), (u1, v0), (u1, v1), (u0, v1)), (grey(ga), grey(ga), grey(gb), grey(gb)))
    for i in range(NA):
        m.face((rows[NY][i], rows[NY][(i + 1) % NA], top), ((0.75, 0.5),) * 3, (grey(g1),) * 3)

def rod(m, a, b, r, n=6, g=0.6):
    a, b = Vector(a), Vector(b); d = (b - a).normalized()
    u = d.cross(Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))).normalized(); v = d.cross(u)
    ra = [m.v(a + (u * math.cos(t) + v * math.sin(t)) * r) for t in (2 * math.pi * i / n for i in range(n))]
    rb = [m.v(b + (u * math.cos(t) + v * math.sin(t)) * r * 0.8) for t in (2 * math.pi * i / n for i in range(n))]
    wc = (g * 0.55, g * 0.42, g * 0.3, 1.0)               # (wood: a dark corner of the core half, tinted)
    for i in range(n):
        m.face((ra[i], ra[(i + 1) % n], rb[(i + 1) % n], rb[i]), ((0.98, 0.5),) * 4, (wc,) * 4)

def card(m, root, down, out_, w, L, variant, flare, dark=0.28, seg=3):
    """A strip hanging from `root` along `down`, `w` wide, curling out by `flare` toward its tip."""
    side = down.cross(out_).normalized()
    u0, u1 = 0.5 * (variant / 4 + 0.01), 0.5 * ((variant + 1) / 4 - 0.01)
    rows = []
    for s_ in range(seg + 1):
        t = s_ / seg
        c = root + down * (L * t) + out_ * (flare * t * t)
        rows.append((m.v(c - side * w / 2, True), m.v(c + side * w / 2, True), t))
    for s_ in range(seg):
        (a0, a1, t0), (b0, b1, t1) = rows[s_], rows[s_ + 1]
        g0, g1 = dark + (1 - dark) * t0 ** 0.8, dark + (1 - dark) * t1 ** 0.8
        m.face((a0, a1, b1, b0), ((u0, 1 - t0), (u1, 1 - t0), (u1, 1 - t1), (u0, 1 - t1)), (grey(g0), grey(g0), grey(g1), grey(g1)))

def shingles(m, R_, spacing_y, spacing_a, Lr, Wr, seg):
    y = 0.08
    while y < H - 0.22:
        a_n = max(6, int(2 * math.pi * radius(y, 0) / spacing_a))
        off = R_.uniform(0, 2 * math.pi)
        for i in range(a_n):
            a = off + 2 * math.pi * (i + R_.uniform(-0.3, 0.3)) / a_n
            # (each card its own height, length, lean and twist: in neat rows it read as a thatched roof)
            L = R_.uniform(*Lr); yc = y + R_.uniform(-0.4, 0.4) * spacing_y; yr = max(0.1, min(H - 0.05, yc + L * 0.85))
            root = surf(yr, a, -0.04); tip = surf(max(0.0, yc), a + R_.uniform(-0.12, 0.12), R_.uniform(-0.01, 0.07))
            down = (tip - root).normalized()
            out_ = surf(yr, a) - axis(yr); out_.y = 0; out_.normalize()
            tw = Matrix.Rotation(R_.uniform(-0.35, 0.35), 3, out_)
            card(m, root, (tw @ down).normalized(), out_, R_.uniform(*Wr), L, R_.randrange(4), R_.uniform(0.02, 0.16) + (0.05 if y < 0.4 else 0), seg=seg)
        y += spacing_y + R_.uniform(-0.02, 0.02)
def cap(m, R_, n, seg):
    for i in range(n):
        a = 2 * math.pi * i / n + R_.uniform(-0.15, 0.15)
        root = axis(H + 0.04); tip = surf(H - 0.45, a, 0.04)
        down = (tip - root).normalized(); out_ = Vector((math.cos(a), 0.3, math.sin(a))).normalized()
        card(m, root, down, out_, R_.uniform(0.22, 0.3) * (14 / n) ** 0.5, (tip - root).length + 0.08, R_.randrange(4), 0.03, 0.5, seg)
def skirt(m, R_, n, Wr, Lr):
    for i in range(n):
        a = R_.uniform(0, 2 * math.pi); r0 = radius(0.0, a) * R_.uniform(0.85, 1.0)
        root = axis(0) + Vector((math.cos(a) * r0, 0.025, math.sin(a) * r0))
        down = Vector((math.cos(a + R_.uniform(-0.5, 0.5)), -0.02, math.sin(a + R_.uniform(-0.5, 0.5)))).normalized()
        card(m, root, down, Vector((0, 1, 0)), R_.uniform(*Wr), R_.uniform(*Lr), R_.randrange(4), 0.0, 0.45, 2)
def wood(m, R_, detail):
    rod(m, (0.02, 0.0, 0.0), axis(H + 0.75) + Vector((0.04, 0, 0.0)), 0.045, 7 if detail else 4, 0.8)
    for k in range(4):
        a = R_.uniform(0, math.pi) + k * 0.8
        p0 = axis(H - 0.55) + Vector((math.cos(a) * 0.75, 0, math.sin(a) * 0.75)); p1 = axis(H - 0.55) - Vector((math.cos(a) * 0.75, 0, math.sin(a) * 0.75))
        mid = axis(H + 0.06) + Vector((0, 0.06, 0))
        rod(m, p0 + Vector((0, 0.02, 0)), mid, 0.04, 5 if detail else 3, 0.7); rod(m, mid, p1, 0.035, 5 if detail else 3, 0.7)
    fa = 3.6; fb = surf(1.15, fa, 0.18); fg = surf(0.0, fa, 0.95)     # the pitchfork: its tines up in the straw, its handle on the ground
    rod(m, fg, fb, 0.02, 6 if detail else 3, 1.0)
    if detail:
        d = (fb - fg).normalized(); side = d.cross(Vector((0, 1, 0))).normalized()
        for t in (-1, 0, 1):
            base = fb + side * (0.05 * t); rod(m, base, base + d * 0.32 + side * (0.02 * t), 0.006, 4, 0.4)

# ── THE NEAR LEVEL ──────────────────────────────────────────────────────────────────────────────────────────────────
mN = Mesh()
core_shell(mN, 40, 16, -0.06, 0.5, 0.85)
wood(mN, random.Random(7), True)
shingles(mN, random.Random(11), 0.2, 0.17, (0.3, 0.75), (0.16, 0.34), 3)
cap(mN, random.Random(12), 14, 3)
skirt(mN, random.Random(13), 46, (0.25, 0.4), (0.35, 0.9))
near = mN.finish("HayNear")
# ── THE FAR LEVEL: the core coarser and fuller (where the near's cards' mass sits), fewer bigger cards ─────────────────
mF = Mesh()
core_shell(mF, 16, 6, 0.0, 0.55, 0.85)
wood(mF, random.Random(7), False)
shingles(mF, random.Random(21), 0.42, 0.42, (0.55, 0.95), (0.38, 0.55), 2)
cap(mF, random.Random(22), 7, 2)
skirt(mF, random.Random(23), 14, (0.45, 0.6), (0.6, 1.0))
far = mF.finish("HayFar")
far.location.x = 0
tris = lambda o: sum(len(p.vertices) - 2 for p in o.data.polygons)
print("TRIS", {"HayNear": tris(near), "HayFar": tris(far)})

# ── EXPORT: geometry only (the game's material, its sheet), the vertex colour as COLOR_0 ─────────────────────────────
bpy.ops.object.select_all(action="DESELECT"); near.select_set(True); far.select_set(True)
for o in (near, far): o.data.color_attributes.active_color = o.data.color_attributes["Col"]
kw = dict(filepath=OUT_GLB, use_selection=True, export_yup=True, export_materials="NONE")
try: bpy.ops.export_scene.gltf(**kw, export_vertex_color="ACTIVE")
except TypeError: bpy.ops.export_scene.gltf(**kw, export_colors=True)
print("GLB", OUT_GLB)

if NOPREVIEW: print("DONE"); sys.exit(0)
# ── PREVIEWS (Cycles): the near close, near and far side by side from the RTS camera ─────────────────────────────────
scn = bpy.context.scene
scn.render.engine = "CYCLES"; scn.cycles.samples = 48; scn.cycles.device = "CPU"
scn.render.resolution_x, scn.render.resolution_y = 1000, 800
ground = bpy.data.meshes.new("G"); bmg = bmesh.new(); bmesh.ops.create_grid(bmg, x_segments=1, y_segments=1, size=12); bmg.to_mesh(ground); bmg.free()
go = bpy.data.objects.new("G", ground); scn.collection.objects.link(go)
gm = bpy.data.materials.new("Ground"); gm.use_nodes = True; gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.22, 0.13, 1); ground.materials.append(gm)
sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN")); scn.collection.objects.link(sun); sun.data.energy = 4.5
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
scn.world = bpy.data.worlds.new("W"); scn.world.use_nodes = True; scn.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.62, 0.72, 1)
scn.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, frm, tgt, lens):
    cd.lens = lens; cam.location = B(*frm); cam.rotation_euler = (B(*tgt) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(REFS, f"preview_{name}.png"); bpy.ops.render.render(write_still=True)
far.hide_render = True
shot("close", (4.2, 2.4, -5.2), (0, 1.1, 0), 40)
far.hide_render = False; far.location = B(4.0, 0, 0)
shot("rts_near_far", (16, 24, -20), (2, 1.0, 0), 70)
print("DONE")
