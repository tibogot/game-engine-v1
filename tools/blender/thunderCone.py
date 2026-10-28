"""THUNDERLINE'S TRAFFIC CONE (2026-10-28, the obstacles' third asset; real motorsport). A 0.93 m motorway cone at the
physics' own size (the old game's cone: CONE_SCALE 1 — the body 0.275 → 0.051 m round, the pivot 0.42 m over the base):
fluorescent red-orange PVC, slightly concave, open at the top with a lip, flared into a flange seated in a heavy black
base of recycled rubber (granular, rounded corners, a raised seat ring, worn edges); two white retroreflective sleeves
(a microprism pattern, more sheen, dirty edges, peeling a little); black tyre scuffs and pale abrasions on the body,
dust at the foot, the standard moulded on the flange.

THE MESH, three levels, axis = game Y, the pivot 0.42 m over the base (the physics' baseY):
  ConeLOD0  ~2.3k triangles: the body turned (40 steps) with its open top, the flange, the base with its seat ring
  ConeLOD1  ~0.45k: 20 steps, the base a bevelled box
  ConeLOD2  ~70: 8 steps, a box
TEXTURES (1024²): cone_color · cone_normal · cone_arm
UV: the body one turn round, u 0..1, v 0..0.70 up its height; the base's top in [0.02, 0.32] × [0.72, 0.99], its sides
[0.34, 0.98] × [0.72, 0.80], the hole inside [0.34, 0.40] × [0.82, 0.88].

  node tools/thunderObstacles.mjs cone [--quick]
"""
import sys, os, math
sys.path.append(os.path.dirname(__file__))
import bpy, bmesh
import numpy as np
from mathutils import Vector
import thunderKit as T

T.reset()
PIVOT = 0.42                           # the physics' root over the base (baseY −0.42)
H = 0.93                               # the body's height
BASE_W, BASE_H, CORNER = 0.55, 0.045, 0.06
# the body: (r, y) from the flange up — the physics' rings: r 0.150 at 0.21, 0.119 at 0.42, 0.083 at 0.66
BODY = [(0.278, BASE_H), (0.272, BASE_H + 0.012), (0.205, BASE_H + 0.018), (0.190, 0.085), (0.150, 0.21), (0.135, 0.31), (0.119, 0.42),
        (0.101, 0.54), (0.083, 0.66), (0.070, 0.76), (0.060, 0.84), (0.053, 0.905), (0.051, H)]
TOP_IN = [(0.044, H), (0.040, H - 0.05)]          # the lip turned in: the open top
SLEEVES = [(0.45, 0.62), (0.70, 0.805)]           # the white bands (y ranges), the old cone's
S = T.S
def vb(y): return 0.70 * y / H                     # the body's texture v at height y

def cone(name, steps, lod):
    me = bpy.data.meshes.new(name); bm = bmesh.new(); uv = bm.loops.layers.uv.new("UV")
    body = BODY if lod == 0 else ([BODY[i] for i in (0, 2, 4, 6, 8, 10, 12)] if lod == 1 else [BODY[0], BODY[6], BODY[12]])
    prof = body + (TOP_IN if lod == 0 else [])
    rows = [[bm.verts.new((r * math.cos(2 * math.pi * k / steps), r * math.sin(2 * math.pi * k / steps), y)) for k in range(steps)] for (r, y) in prof]
    for j in range(len(prof) - 1):
        # (the RIM's flat top — body top → the lip — is orange like the body; only the hole's wall is inside. Painted
        # as the hole, the rim read as a black cap from the side: user, 2026-10-28, "a weird black cap at the top")
        inside = j >= len(body)
        rim = j == len(body) - 1
        for k in range(steps):
            k2 = (k + 1) % steps
            f = bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
            u0, u1 = k / steps, (k + 1) / steps
            if inside:   # (the lip and the hole: a small dark square)
                for loop, (uu, vv) in zip(f.loops, ((0.34, 0.82), (0.40, 0.82), (0.40, 0.88), (0.34, 0.88))): loop[uv].uv = (uu, vv)
            elif rim:
                vt = vb(H) - 0.004
                for loop, (uu, vv) in zip(f.loops, ((u0, vt), (u1, vt), (u1, vt), (u0, vt))): loop[uv].uv = (uu, vv)
            else:
                for loop, (uu, vv) in zip(f.loops, ((u0, vb(prof[j][1])), (u1, vb(prof[j][1])), (u1, vb(prof[j + 1][1])), (u0, vb(prof[j + 1][1])))): loop[uv].uv = (uu, vv)
    if lod > 0:   # (no hole: the top closed — orange, the body's top: from afar a hole is not seen)
        c = bm.verts.new((0, 0, H + 0.004))
        for k in range(steps):
            f = bm.faces.new((rows[-1][k], rows[-1][(k + 1) % steps], c))
            for loop in f.loops: loop[uv].uv = ((k + 0.5) / steps, vb(H) - 0.004)
    else:
        c = bm.verts.new((0, 0, H - 0.05))
        for k in range(steps):
            f = bm.faces.new((rows[-1][(k + 1) % steps], rows[-1][k], c))
            for loop in f.loops: loop[uv].uv = (0.37, 0.85)
    # THE BASE: a rounded square (corners turned in 4 steps), its top bevelled; the body sits in it
    n = 4 if lod == 0 else (2 if lod == 1 else 1)
    hw = BASE_W / 2
    def outline(inset, rc):
        pts = []
        for (cx, cy, a0) in ((hw, hw, 0), (-hw, hw, 90), (-hw, -hw, 180), (hw, -hw, 270)):
            ox, oy = cx - math.copysign(rc, cx), cy - math.copysign(rc, cy)   # (the corner's centre)
            for i in range(n + 1):
                a = math.radians(a0 + 90 * i / n)
                pts.append((ox + (rc - inset) * math.cos(a), oy + (rc - inset) * math.sin(a)))
        return pts
    lo = outline(0, CORNER); top = outline(0.012 if lod < 2 else 0, CORNER)
    vlo = [bm.verts.new((x, y, 0)) for (x, y) in lo]
    vmid = [bm.verts.new((x, y, BASE_H - 0.012)) for (x, y) in lo]
    vtop = [bm.verts.new((x, y, BASE_H)) for (x, y) in top]
    m = len(lo)
    per = sum(math.hypot(lo[(i + 1) % m][0] - lo[i][0], lo[(i + 1) % m][1] - lo[i][1]) for i in range(m))
    acc = 0.0
    for i in range(m):
        i2 = (i + 1) % m
        seg = math.hypot(lo[i2][0] - lo[i][0], lo[i2][1] - lo[i][1])
        ua, ub = 0.34 + 0.64 * acc / per, 0.34 + 0.64 * (acc + seg) / per; acc += seg
        for (a, b, va, vbb) in ((vlo, vmid, 0.72, 0.775), (vmid, vtop, 0.775, 0.80)):
            f = bm.faces.new((a[i], a[i2], b[i2], b[i]))
            for loop, (uu, vv) in zip(f.loops, ((ua, va), (ub, va), (ub, vbb), (ua, vbb))): loop[uv].uv = (uu, vv)
    def topuv(x, y): return (0.02 + (x / BASE_W + 0.5) * 0.30, 0.72 + (y / BASE_W + 0.5) * 0.27)
    # the top: a ring from the outline in to the body's foot (the seat ring), a fan would sit under the body
    seat = [bm.verts.new((BODY[0][0] * 1.05 * math.cos(2 * math.pi * i / m), BODY[0][0] * 1.05 * math.sin(2 * math.pi * i / m), BASE_H + (0.006 if lod == 0 else 0))) for i in range(m)]
    # (pair each outline point with the seat point at its angle)
    angs = [math.atan2(y, x) for (x, y) in top]
    for i, a in enumerate(angs): seat[i].co.x, seat[i].co.y = BODY[0][0] * 1.05 * math.cos(a), BODY[0][0] * 1.05 * math.sin(a)
    for i in range(m):
        i2 = (i + 1) % m
        f = bm.faces.new((vtop[i], vtop[i2], seat[i2], seat[i]))
        for loop in f.loops: loop[uv].uv = topuv(loop.vert.co.x, loop.vert.co.y)
    bot = bm.faces.new(list(reversed(vlo)))
    for loop in bot.loops: loop[uv].uv = (0.97, 0.97)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces: f.smooth = True
    for v in bm.verts: v.co.z -= PIVOT                # the pivot: the physics' root
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    me.set_sharp_from_angle(angle=math.radians(40))
    return o

lod0, lod1, lod2 = cone("ConeLOD0", 40, 0), cone("ConeLOD1", 20, 1), cone("ConeLOD2", 8, 2)
for o in (lod0, lod1, lod2): print("TRIS", o.name, T.tris(o))

# ── THE TEXTURE ─────────────────────────────────────────────────────────────────────────────────────────────────────
VV, UU = T.grid()
body = VV < 0.70
btop = (VV >= 0.72) & (UU < 0.32)
bside = (VV >= 0.72) & (VV < 0.80) & (UU >= 0.34)
hole = (VV >= 0.82) & (VV < 0.88) & (UU >= 0.34) & (UU < 0.40)
Y = VV / 0.70 * H                                  # the body's height at each texel
R_at = np.interp(Y, [b[1] for b in BODY], [b[0] for b in BODY])
sleeve = np.zeros((S, S), np.float32)
for (y0, y1) in SLEEVES:
    # the sleeve's edges a little ragged (peeling), soft
    e0 = y0 + 0.004 * T.noise(80, 1, 21); e1 = y1 - 0.004 * T.noise(80, 1, 22)
    sleeve = np.maximum(sleeve, T.smooth(e0 - 0.002, e0 + 0.002, Y) * T.smooth(e1 + 0.002, e1 - 0.002, Y))
sleeve *= body
peel = body * sleeve * (T.noise(30, 3, 23) > 0.78)
sleeve = sleeve * (1 - peel)
# the microprism pattern: a fine hex lattice (in the normal map, and a sparkle in the roughness)
px_m = 2 * math.pi * R_at / S                      # metres per texel round the body at this height
xx, yy = UU * 2 * math.pi * R_at, Y
cell = 0.006
hexp = (np.sin(xx / cell * math.pi) * np.sin((yy + 0.5 * xx * 0.57735) / cell * math.pi)) * 0.5 + 0.5
# scuffs: black tyre marks (dark streaks across the lower body), pale abrasions (scratches)
scuffN = T.noise(6, 3, 24); streaks = T.noise(90, 2, 25)
tyre_mark = body * T.smooth(0.58, 0.72, scuffN) * T.smooth(0.55, 0.8, streaks) * T.smooth(0.55, 0.15, Y)
abrade = body * (T.noise(120, 2, 26) > 0.93) * T.smooth(0.55, 0.65, T.noise(7, 2, 27))   # (a few: many read as speckle)
dust = body * T.smooth(0.30, 0.05, Y) * (0.55 + 0.45 * T.noise(16, 3, 28))
# the base: granular recycled rubber
gran = T.noise(160, 2, 29); BX = (UU - 0.02) / 0.30 * BASE_W - BASE_W / 2; BY = (VV - 0.72) / 0.27 * BASE_W - BASE_W / 2
base_wear = bside * T.smooth(0.78, 0.80, VV) + btop * T.smooth(BASE_W / 2 - 0.02, BASE_W / 2, np.maximum(np.abs(BX), np.abs(BY)))
# the standard moulded on the flange (normal map only): round the turn at the foot
xs = 1.0 / (2 * math.pi * 0.21) / (0.70 / H)
txt = T.render_text([("EN 13422  CLASS 1", 0.25, vb(BASE_H + 0.045), 0.70 / H * 0.016, xs, False),
                     ("EN 13422  CLASS 1", 0.75, vb(BASE_H + 0.045), 0.70 / H * 0.016, xs, False)])

h = np.zeros((S, S), np.float32)
h += body * sleeve * 0.0004 * hexp + body * 0.0003 * sleeve
h += body * 0.0006 * txt
h -= body * 0.0003 * abrade
h += (btop | bside) * 0.0006 * gran
du_m = np.where(body, np.maximum(px_m, 1e-5), BASE_W / (0.30 * S)); dv_m = np.where(body, H / (0.70 * S), BASE_W / (0.27 * S))
normal = T.normal_from_height(h, du_m, dv_m)
normal[hole] = (0.5, 0.5, 1.0)

ao = T.bake_ao(lod0, 0.15)
def lin(hx): return np.array([((hx >> s & 255) / 255) ** 2.2 for s in (16, 8, 0)], np.float32)
ORANGE, WHITE, RUBBER, DUST, MARK, PALE, DARK = lin(0xff4a14), lin(0xe9ecee), lin(0x1b1b1c), lin(0x5a4f43), lin(0x161616), lin(0xffb08a), lin(0x0c0c0c)
# (the dust brown and sparing: a pale dust over the orange read PINK)
col = ORANGE[None, None, :] * (0.9 + 0.12 * T.noise(5, 3, 30)[..., None]) * (0.92 + 0.08 * T.smooth(0.3, 0.9, Y))[..., None]  # (a touch sun-faded up top)
col = col * (1 - sleeve[..., None]) + WHITE[None, None, :] * (0.82 + 0.1 * hexp)[..., None] * sleeve[..., None]
col = col * (1 - 0.8 * tyre_mark[..., None]) + MARK[None, None, :] * 0.8 * tyre_mark[..., None]
col = col * (1 - 0.5 * abrade[..., None]) + PALE[None, None, :] * 0.5 * abrade[..., None]
d = np.clip(dust * 0.45, 0, 0.45)[..., None]
col = col * (1 - d) + DUST[None, None, :] * d
baseC = RUBBER[None, None, :] * (0.8 + 0.4 * gran[..., None]) * (1 + 0.6 * base_wear[..., None])
bdust = ((btop | bside) * (0.3 + 0.4 * T.noise(12, 3, 31)))[..., None]
baseC = baseC * (1 - bdust * 0.6) + DUST[None, None, :] * 0.45 * bdust * 0.6
col = np.where((btop | bside)[..., None], baseC, col)
col = np.where(hole[..., None], ORANGE[None, None, :] * 0.18, col)   # (the hole: the same plastic, in its own shade)
col = col * (0.62 + 0.38 * ao[..., None])
rough = np.where(body, 0.45 - 0.2 * sleeve + 0.08 * sleeve * hexp + 0.3 * dust + 0.25 * tyre_mark + 0.2 * abrade, 0.9 - 0.15 * base_wear)
arm = np.stack([ao, np.clip(rough, 0, 1), np.zeros_like(ao)], -1)
imgC = T.save("cone_color", col, True); imgN = T.save("cone_normal", normal, False); imgA = T.save("cone_arm", arm, False)

T.export((lod0, lod1, lod2), "cone")

if not T.NOPREVIEW:
    mat = T.material("Cone", imgC, imgN, imgA)
    for o in (lod0, lod1, lod2): o.data.materials.append(mat)
    scn, cam = T.preview_scene()
    lod0.location = (0, 0, PIVOT)
    for i, (x, y, rz) in enumerate(((0.9, 0.4, 20), (1.8, 0.8, 50), (-0.9, 0.6, 70))):
        c = lod0.copy(); scn.collection.objects.link(c); c.location = (x, y, PIVOT); c.rotation_euler = (0, 0, math.radians(rz))
    knocked = lod0.copy(); scn.collection.objects.link(knocked); knocked.location = (0.4, -0.9, 0.16); knocked.rotation_euler = (math.radians(70), 0, math.radians(120))
    lod1.location = (3.0, 1.6, PIVOT); lod2.location = (3.8, 2.0, PIVOT)
    T.shoot(scn, cam, "cone_wide", (1.2, -4.2, 1.5), (0.6, 0.6, 0.4))
    T.shoot(scn, cam, "cone_close", (0.25, -1.25, 0.75), (0, 0, 0.45))
print("DONE")
