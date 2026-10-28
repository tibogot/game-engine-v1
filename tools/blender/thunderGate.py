"""THUNDERLINE'S SWING GATE (2026-10-28, the obstacles' fourth asset; real motorsport). One gate of the pair: a 90 kg
panel on a sprung hinge (the old game's physics: 4.4 m from the hinge, 1.5 m high, 0.15 m off the road, the post
0.11 m round and 1.9 m tall on the hinge axis). A galvanised steel tube frame — hinge stile, free stile, top and bottom
rails, a diagonal brace behind — and a red PVC-mesh banner with white chevrons pointing the way it opens, zip-tied
through metal eyelets, dirty at the foot; a latch and a castor wheel at the free end; the heavy round post with its
welded base flange and a red / white reflective band.

THE POST TURNS WITH THE PANEL in the game (it is part of the gate's mesh): it is kept round all the way — the flange, the
cap, the bands — so the turn never shows; the hinge collars are rings round it, as real ones are.

THE MESH, three levels, axis = game Y through the hinge, the panel along +X (the physics' frame):
  GateLOD0  the post, collars, the frame's tubes, the banner (both faces), latch, castor
  GateLOD1  tubes and post coarser, no castor
  GateLOD2  the post (8 sides), the banner, the frame as flat bars
TEXTURES (1024²): gate_color · gate_normal · gate_arm
UV: the banner's front [0, 1] × [0.30, 1.0] (its back: the same print, mirrored); the tubes [0, 0.5] × [0, 0.24] (round
× along); the post and its rings [0.5, 1] × [0, 0.24] (round × up); rubber [0.02, 0.10] × [0.26, 0.29].

  node tools/thunderObstacles.mjs gate [--quick]
"""
import sys, os, math
sys.path.append(os.path.dirname(__file__))
import bpy, bmesh
import numpy as np
from mathutils import Vector
import thunderKit as T

T.reset()
W, PH, BASE = 4.4, 1.5, 0.15              # the panel's reach, height, its foot over the road (physics)
PR, POST_H = 0.11, 1.9                     # the post
TR = 0.03                                  # the frame's tube radius
X0, X1 = 0.20, W - 0.04                    # the stiles' axes
Y0, Y1 = BASE + TR, BASE + PH - TR         # the rails' axes
BX0, BX1, BY0, BY1 = X0 + 0.05, X1 - 0.05, Y0 + 0.05, Y1 - 0.05   # the banner
BZ = TR + 0.004                            # the banner's face, just in front of the tubes
S = T.S

def build(name, lod):
    me = bpy.data.meshes.new(name); bm = bmesh.new(); uv = bm.loops.layers.uv.new("UV")
    seg = {0: 12, 1: 6, 2: 4}[lod]

    def tube(a, b, r, n, region):
        """A tube from a to b (game coordinates x, y, z → Blender x, -z, y), UV round × along in its region."""
        A, Bv = Vector((a[0], -a[2], a[1])), Vector((b[0], -b[2], b[1]))
        d = (Bv - A); L = d.length; d.normalize()
        ref = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
        e1 = d.cross(ref).normalized(); e2 = d.cross(e1)
        rings = [[bm.verts.new(P + (e1 * math.cos(2 * math.pi * k / n) + e2 * math.sin(2 * math.pi * k / n)) * r) for k in range(n)] for P in (A, Bv)]
        u0, u1, v0, v1 = region
        for k in range(n):
            k2 = (k + 1) % n
            f = bm.faces.new((rings[0][k], rings[0][k2], rings[1][k2], rings[1][k]))
            ua, ub = u0 + (u1 - u0) * k / n, u0 + (u1 - u0) * (k + 1) / n
            va, vbb = v0, v0 + (v1 - v0) * min(1.0, L / 4.6)
            for loop, (uu, vv) in zip(f.loops, ((ua, va), (ub, va), (ub, vbb), (ua, vbb))): loop[uv].uv = (uu, vv)
        for ring, flip in ((rings[0], True), (rings[1], False)):
            c = bm.verts.new(sum((v.co for v in ring), Vector()) / n)
            for k in range(n):
                f = bm.faces.new((ring[k], ring[(k + 1) % n], c) if not flip else (ring[(k + 1) % n], ring[k], c))
                for loop in f.loops: loop[uv].uv = (u0 + 0.01, v0 + 0.01)

    def lathe(prof, n):
        """The post and its rings round the hinge axis: prof (r, y) bottom → top; UV round × y in the post's region."""
        rows = [[bm.verts.new((r * math.cos(2 * math.pi * k / n), r * math.sin(2 * math.pi * k / n), y)) for k in range(n)] for (r, y) in prof]
        for j in range(len(prof) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                f = bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
                for loop, (kk, jj) in zip(f.loops, ((k, j), (k + 1, j), (k + 1, j + 1), (k, j + 1))):
                    loop[uv].uv = (0.5 + 0.5 * kk / n, 0.24 * prof[jj][1] / POST_H)
        return rows

    # THE POST: flange, weld, tube, the dome cap (all round)
    pn = {0: 24, 1: 12, 2: 8}[lod]
    if lod < 2:
        post = [(0.0, 0.0), (0.22, 0.0), (0.22, 0.02), (0.13, 0.025), (PR, 0.045), (PR, POST_H - 0.04), (PR * 0.8, POST_H - 0.01), (0.0, POST_H)]
    else:
        post = [(0.0, 0.0), (PR, 0.0), (PR, POST_H), (0.0, POST_H)]
    lathe(post, pn)
    # THE HINGE COLLARS: rings round the post (they turn with the panel), each with its strap to the hinge stile
    if lod < 2:
        for yc in (BASE + 0.25, BASE + PH - 0.25):
            lathe([(PR + 0.002, yc - 0.05), (0.14, yc - 0.045), (0.14, yc + 0.045), (PR + 0.002, yc + 0.05)], pn)
            tube((0.13, yc, 0), (X0, yc, 0), 0.022, max(4, seg // 2), (0.0, 0.5, 0.0, 0.24))
    # THE FRAME
    if lod < 2:
        T_ = (0.0, 0.5, 0.0, 0.24)
        tube((X0, BASE, 0), (X0, BASE + PH, 0), TR, seg, T_)
        tube((X1, BASE, 0), (X1, BASE + PH, 0), TR, seg, T_)
        tube((X0, Y0, 0), (X1, Y0, 0), TR, seg, T_)
        tube((X0, Y1, 0), (X1, Y1, 0), TR, seg, T_)
        tube((X0 + 0.04, Y0 + 0.04, -0.035), (X1 - 0.04, Y1 - 0.04, -0.035), 0.022, max(4, seg // 2), T_)   # (the brace, behind)
    else:
        # flat bars: the frame as four thin boxes (a box is a 4-sided tube)
        T_ = (0.0, 0.5, 0.0, 0.24)
        for a, b in (((X0, BASE, 0), (X0, BASE + PH, 0)), ((X1, BASE, 0), (X1, BASE + PH, 0)), ((X0, Y0, 0), (X1, Y0, 0)), ((X0, Y1, 0), (X1, Y1, 0))):
            tube(a, b, TR, 4, T_)
    # THE BANNER: front and back faces, the print NOT mirrored on the back: its chevrons point to the free end from either
    # side (the right gate stands turned round, its back to the car — a mirrored back made both gates point the same way)
    for z, flip in ((BZ, False), (-BZ + 0.002 if lod == 2 else BZ - 0.003, True)):
        vs = [bm.verts.new((x, -z, y)) for (x, y) in ((BX0, BY0), (BX1, BY0), (BX1, BY1), (BX0, BY1))]
        f = bm.faces.new(vs if not flip else list(reversed(vs)))
        for loop in f.loops:
            x, y = loop.vert.co.x, loop.vert.co.z
            u = (x - BX0) / (BX1 - BX0)
            loop[uv].uv = (u, 0.30 + 0.70 * (y - BY0) / (BY1 - BY0))
    if lod == 0:
        # THE LATCH on the free stile, THE CASTOR under it
        tube((X1 - 0.06, BASE + PH * 0.55, 0), (X1 + 0.05, BASE + PH * 0.55, 0), 0.018, 6, (0.0, 0.5, 0.0, 0.24))
        tube((X1, BASE + 0.0, 0), (X1, 0.11, 0), 0.016, 6, (0.0, 0.5, 0.0, 0.24))   # (the fork's stem)
        tube((X1, 0.075, -0.035), (X1, 0.075, 0.035), 0.075, 14, (0.02, 0.10, 0.26, 0.29))   # (the wheel: rubber)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bm.normal_update()
    for f in bm.faces: f.smooth = True
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    me.set_sharp_from_angle(angle=math.radians(40))
    return o

lod0, lod1, lod2 = build("GateLOD0", 0), build("GateLOD1", 1), build("GateLOD2", 2)
for o in (lod0, lod1, lod2): print("TRIS", o.name, T.tris(o))

# ── THE TEXTURE ─────────────────────────────────────────────────────────────────────────────────────────────────────
VV, UU = T.grid()
banner = VV >= 0.30
tubes = (VV < 0.245) & (UU < 0.5)
post = (VV < 0.245) & (UU >= 0.5)
rubber = (VV >= 0.255) & (VV < 0.295) & (UU < 0.12)
BXm = UU * (BX1 - BX0); BYm = (VV - 0.30) / 0.70 * (BY1 - BY0)     # banner metres from its corner
# the chevrons: white on red, pointing +x (the way the gate opens), 5 across
period = (BX1 - BX0) / 5
cx = (BXm % period) / period                                      # 0..1 across one chevron's cell
yc = np.abs(BYm - (BY1 - BY0) / 2) / ((BY1 - BY0) / 2)             # 0 in the middle, 1 at the edges
arm_c = 0.25 + 0.35 * yc                                          # the chevron's slanted arm: its centre moves with |y|
chev = banner * T.smooth(0.13, 0.11, np.abs(cx - (1 - arm_c)))
hem = banner * np.maximum(T.smooth(0.04, 0.03, np.minimum(BXm, (BX1 - BX0) - BXm)), T.smooth(0.04, 0.03, np.minimum(BYm, (BY1 - BY0) - BYm)))
# eyelets every ~0.3 m round the edge, a zip tie through each
eye_d = np.full((S, S), 9.0, np.float32)
for xs_ in np.arange(0.15, BX1 - BX0, 0.30):
    for ys_ in (0.02, (BY1 - BY0) - 0.02):
        eye_d = np.minimum(eye_d, np.hypot(BXm - xs_, BYm - ys_))
for ys_ in np.arange(0.15, BY1 - BY0, 0.30):
    for xs_ in (0.02, (BX1 - BX0) - 0.02):
        eye_d = np.minimum(eye_d, np.hypot(BXm - xs_, BYm - ys_))
eyelet = banner * T.smooth(0.014, 0.010, eye_d) * T.smooth(0.004, 0.007, eye_d)
eyehole = banner * T.smooth(0.007, 0.004, eye_d)
weave = (np.sin(BXm / 0.0025 * math.pi) * np.sin(BYm / 0.0025 * math.pi)) * 0.5 + 0.5
dirtB = banner * T.smooth(0.6, 0.0, BYm) * (0.5 + 0.5 * T.noise(12, 3, 41))
# (a banner is pulled tight between its ties and sags between them: soft creases from each eyelet, a slow sag; hit by
# cars at the free end: black tyre scuffs low down)
crease = banner * T.smooth(0.35, 0.0, eye_d) * (0.5 + 0.5 * np.sin((BXm + BYm * 0.6) / 0.05 * math.pi) * np.sin((BXm - BYm * 0.6) / 0.07 * math.pi))
sag = banner * np.sin(BXm / 0.30 * math.pi) ** 2 * T.smooth(0.0, 0.5, np.minimum(BYm, (BY1 - BY0) - BYm))
scuff = banner * T.smooth(0.55, 0.85, BXm / (BX1 - BX0)) * T.smooth(0.85, 0.2, BYm) * T.smooth(0.6, 0.75, T.noise(7, 3, 47)) * (0.5 + 0.5 * T.noise(70, 2, 48))
sunfade = banner * T.smooth(0.4, 1.36, BYm)
fade = banner * T.smooth(0.3, 1.0, T.noise(4, 2, 42))
# galvanised steel: spangle (crystal patches), white rust, scuffs
spang = T.noise(60, 2, 43); patches = T.noise(8, 3, 44)
whiterust = (tubes | post) * T.smooth(0.72, 0.85, T.noise(20, 3, 45))
PY = VV / 0.24 * POST_H
band = post * (T.smooth(1.60, 1.602, PY) * T.smooth(1.76, 1.758, PY))
band_red = band * (((PY - 1.60) // 0.04) % 2 == 0)
postdirt = post * T.smooth(0.45, 0.0, PY) * (0.5 + 0.5 * T.noise(14, 3, 46))

h = np.zeros((S, S), np.float32)
h += banner * 0.0004 * weave + 0.0012 * eyelet + 0.0006 * hem + 0.003 * crease - 0.008 * sag
h -= 0.0008 * eyehole
h += (tubes | post) * 0.0002 * spang
du_m = np.where(banner, (BX1 - BX0) / S, np.where(post, 2 * math.pi * PR / (0.5 * S), 2 * math.pi * TR / (0.5 * S)))
dv_m = np.where(banner, (BY1 - BY0) / (0.70 * S), np.where(post, POST_H / (0.24 * S), 4.6 / (0.24 * S)))
normal = T.normal_from_height(h, du_m, dv_m)

ao = T.bake_ao(lod0, 0.3)
def lin(hx): return np.array([((hx >> s & 255) / 255) ** 2.2 for s in (16, 8, 0)], np.float32)
RED, WHITE, GALV, DARKG, WRUST, DIRT, RUB, METAL = lin(0xc8231d), lin(0xeceae4), lin(0x9ea3a6), lin(0x6e7377), lin(0xd6d6cc), lin(0x5a4d40), lin(0x1a1a1a), lin(0xb8bbbe)
col = np.zeros((S, S, 3), np.float32)
ban = RED[None, None, :] * (0.92 + 0.12 * fade[..., None])
ban = ban * (1 - chev[..., None]) + WHITE[None, None, :] * 0.9 * chev[..., None]
ban = ban * (1 - 0.25 * hem[..., None])
ban = ban * (0.9 + 0.1 * weave[..., None])
ban = ban * (1 + 0.18 * sunfade[..., None])                     # (the top paler: the sun)
ban = ban * (1 - dirtB[..., None] * 0.7) + DIRT[None, None, :] * 0.7 * dirtB[..., None]
ban = ban * (1 - scuff[..., None] * 0.85) + RUB[None, None, :] * 0.85 * scuff[..., None]
ban = ban * (1 - eyelet[..., None]) + METAL[None, None, :] * eyelet[..., None]
ban = ban * (1 - eyehole[..., None]) + RUB[None, None, :] * eyehole[..., None]   # (the zip tie through it: black)
steel = GALV[None, None, :] * (0.82 + 0.2 * spang[..., None]) * (0.85 + 0.25 * patches[..., None])
steel = steel * (1 - whiterust[..., None] * 0.5) + WRUST[None, None, :] * 0.5 * whiterust[..., None]
steel = np.where(band[..., None], np.where(band_red[..., None], RED[None, None, :], WHITE[None, None, :]), steel)
steel = steel * (1 - postdirt[..., None] * 0.6) + DIRT[None, None, :] * 0.6 * postdirt[..., None]
col = np.where(banner[..., None], ban, np.where(rubber[..., None], RUB[None, None, :], steel))
col = col * (0.6 + 0.4 * ao[..., None])
rough = np.where(banner, 0.75 + 0.1 * dirtB - 0.35 * eyelet - 0.15 * scuff, np.where(rubber, 0.85, np.where(band, 0.3, 0.45 + 0.15 * whiterust + 0.1 * patches + 0.3 * postdirt)))
metal = np.where(banner, eyelet, np.where(rubber | (band > 0.5), 0.0, 1.0 - 0.6 * whiterust - 0.8 * postdirt))
arm = np.stack([ao, np.clip(rough, 0, 1), np.clip(metal, 0, 1)], -1)
imgC = T.save("gate_color", col, True); imgN = T.save("gate_normal", normal, False); imgA = T.save("gate_arm", arm, False)

T.export((lod0, lod1, lod2), "gate")

if not T.NOPREVIEW:
    mat = T.material("Gate", imgC, imgN, imgA)
    for o in (lod0, lod1, lod2): o.data.materials.append(mat)
    scn, cam = T.preview_scene()
    # the pair across a road, as obstacles.js places them (hinged at ±W, the right one turned round), one swung open
    lod0.location = (-W, 0, 0)
    g2 = lod0.copy(); scn.collection.objects.link(g2); g2.location = (W, 0, 0); g2.rotation_euler = (0, 0, math.pi - 0.5)
    lod1.location = (-W, 8, 0); lod2.location = (2, 8, 0)
    T.shoot(scn, cam, "gate_wide", (1.5, -9.5, 2.4), (0, 0, 0.9))
    T.shoot(scn, cam, "gate_close", (-1.2, -2.6, 1.4), (-0.6, 0, 0.9))
    T.shoot(scn, cam, "gate_post", (-3.4, -1.6, 1.3), (-4.3, 0, 0.9))
print("DONE")
