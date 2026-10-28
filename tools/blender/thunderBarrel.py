"""THUNDERLINE'S OIL DRUM (2026-10-28, the obstacles' second asset, after the tyre; real motorsport). A 200 L steel drum
at the physics' size — the old game's BARREL_HEIGHT 1.5 m, a real drum's proportions ×1.7 ("at true scale it reads as
street furniture beside the car"): a closed cylinder 0.99 m across, the pivot at its centre. Red paint over steel: the
rolled rims (chimes) top and bottom, two rolling hoops, a recessed lid with its two bung caps, the weld seam, a few
dents; the paint chipped where a drum gets knocked (rims and hoops first) — bare steel, rust; rust run down from the top
rim, grime at the foot; a white stencil and a worn product label.

THE MESH, three levels, axis = game Y, centred on the body's pivot:
  BarrelLOD0  ~4k triangles: the side turned (64 steps) with the dents in it, the lid and the bottom, the bung caps
  BarrelLOD1  ~1k: 32 steps, the rims and hoops kept, the dents
  BarrelLOD2  ~0.15k: 16 steps, a can
TEXTURES (1024²): barrel_color · barrel_normal · barrel_arm (R occlusion, G roughness, B metalness)
UV: the side one turn round, u 0..1, v 0..0.60 bottom → top by its arc length; the lid in [0.02, 0.38] × [0.63, 0.99],
the bottom in [0.42, 0.78] × [0.63, 0.99].

  node tools/thunderObstacles.mjs barrel [--quick]
"""
import sys, os, math
sys.path.append(os.path.dirname(__file__))
import bpy, bmesh
import numpy as np
from mathutils import Vector
import thunderKit as T

T.reset()
H, R = 1.5, 0.495                      # the physics' cylinder (BARREL_HEIGHT, its 0.66 × H width)
ZT = H / 2
CH = 0.022                             # the chime's depth: the lid and the bottom sit this far in
RL = R - 0.012                         # the lid's radius
HOOPS = (-0.25, 0.25)                  # the rolling hoops (a real drum's at a third of its height)
S = T.S

def hoop(z0, lod):
    if lod >= 2: return []
    w = 0.022
    return [(R, z0 - w - 0.008), (R + 0.006, z0 - w), (R + 0.014, z0 - w * 0.4), (R + 0.014, z0 + w * 0.4), (R + 0.006, z0 + w), (R, z0 + w + 0.008)] if lod == 0 else \
           [(R, z0 - w - 0.006), (R + 0.014, z0 - w * 0.3), (R + 0.014, z0 + w * 0.3), (R, z0 + w + 0.006)]
def side_profile(lod):
    """(r, z) from the bottom disc's edge up the side to the lid's edge."""
    bot = [(RL, -ZT + CH), (R - 0.006, -ZT), (R + 0.006, -ZT), (R + 0.008, -ZT + 0.015), (R + 0.003, -ZT + 0.028), (R, -ZT + 0.04)] if lod < 2 else [(RL, -ZT + CH), (R, -ZT), (R, -ZT + 0.03)]
    top = [(r, -z) for (r, z) in reversed(bot)]
    body = []
    rows = {0: 0.10, 1: 0.2}.get(lod, None)
    def span(z0, z1):
        if rows is None: return []
        n = max(1, int(round((z1 - z0) / rows)))
        return [(R, z0 + (z1 - z0) * i / n) for i in range(1, n)]
    zs = [-ZT + 0.04] + [h for h in HOOPS] + [ZT - 0.04]
    prof = list(bot)
    prof += span(-ZT + 0.04, HOOPS[0] - 0.03) + hoop(HOOPS[0], lod) + span(HOOPS[0] + 0.03, HOOPS[1] - 0.03) + hoop(HOOPS[1], lod) + span(HOOPS[1] + 0.03, ZT - 0.04)
    prof += top
    return prof
def arc(prof):
    s, acc = [0.0], 0.0
    for a, b in zip(prof, prof[1:]): acc += math.hypot(b[0] - a[0], b[1] - a[1]); s.append(acc)
    return s, acc
PROF0 = side_profile(0)
S0, ACC0 = arc(PROF0)
def v_of_z(z):
    """The side's texture v at height z (the LOD0 section's arc length: every level samples the same texture)."""
    zs = [p[1] for p in PROF0]
    for i in range(len(zs) - 1):
        if zs[i] <= z <= zs[i + 1] or i == len(zs) - 2:
            f = (z - zs[i]) / max(zs[i + 1] - zs[i], 1e-9); f = min(max(f, 0), 1)
            return 0.60 * (S0[i] + f * (S0[i + 1] - S0[i])) / ACC0
    return 0.0

# THE DENTS: (angle °, z, radius m, depth m) — soft, inward, none on the rims (a rim is stiff)
DENTS = [(35, 0.42, 0.20, 0.030), (155, -0.05, 0.16, 0.022), (250, 0.55, 0.13, 0.018), (300, -0.45, 0.22, 0.026), (95, 0.08, 0.10, 0.012)]
def dent(theta, z):
    d = 0.0
    for (a, zc, rho, dep) in DENTS:
        da = math.radians(((theta - a + 180) % 360) - 180) * R
        d += dep * math.exp(-(da * da + (z - zc) ** 2) / (rho * rho))
    stiff = min(1.0, abs(abs(z) - ZT) / 0.08) * min(1.0, min(abs(z - h) for h in HOOPS) / 0.06)
    return d * stiff

def drum(name, steps, lod):
    prof = side_profile(lod)
    me = bpy.data.meshes.new(name); bm = bmesh.new(); uv = bm.loops.layers.uv.new("UV")
    rows = []
    for (r, z) in prof:
        row = []
        for k in range(steps):
            th = 360.0 * k / steps
            rr = r - (dent(th, z) if lod < 2 and abs(r - R) < 0.002 else 0.0)
            t = math.radians(th); row.append(bm.verts.new((rr * math.cos(t), rr * math.sin(t), z)))
        rows.append(row)
    vs = [v_of_z(z) for (_, z) in prof]
    for j in range(len(prof) - 1):
        for k in range(steps):
            k2 = (k + 1) % steps
            f = bm.faces.new((rows[j][k], rows[j][k2], rows[j + 1][k2], rows[j + 1][k]))
            u0, u1 = k / steps, (k + 1) / steps
            for loop, (uu, vv) in zip(f.loops, ((u0, vs[j]), (u1, vs[j]), (u1, vs[j + 1]), (u0, vs[j + 1]))): loop[uv].uv = (uu, vv)
    # the bottom and the lid: discs (a centre vertex), planar UV into their squares
    for ring, z, (u0, v0), top in ((rows[0], -ZT + CH, (0.42, 0.63), False), (rows[-1], ZT - CH, (0.02, 0.63), True)):
        c = bm.verts.new((0, 0, z))
        for k in range(steps):
            a, b = ring[k], ring[(k + 1) % steps]
            f = bm.faces.new((c, b, a) if not top else (c, a, b))
            for loop in f.loops:
                x, y = loop.vert.co.x, loop.vert.co.y
                loop[uv].uv = (u0 + (x / RL * 0.5 + 0.5) * 0.36, v0 + (y / RL * 0.5 + 0.5) * 0.36)
    if lod == 0:
        # THE BUNG CAPS on the lid: a 2" and a ¾" (×1.7), short cylinders
        for (bx, by, br, bh) in ((0.30, 0.0, 0.062, 0.016), (-0.30, 0.0, 0.034, 0.012)):
            n = 16
            lo = [bm.verts.new((bx + br * math.cos(2 * math.pi * i / n), by + br * math.sin(2 * math.pi * i / n), ZT - CH)) for i in range(n)]
            hi = [bm.verts.new((bx + br * math.cos(2 * math.pi * i / n), by + br * math.sin(2 * math.pi * i / n), ZT - CH + bh)) for i in range(n)]
            cap = bm.faces.new(hi)
            for i in range(n):
                bm.faces.new((lo[i], lo[(i + 1) % n], hi[(i + 1) % n], hi[i]))
            for f in [cap] + [f for f in bm.faces if f.verts[0] in lo]:
                for loop in f.loops:
                    x, y = loop.vert.co.x, loop.vert.co.y
                    loop[uv].uv = (0.02 + (x / RL * 0.5 + 0.5) * 0.36, 0.63 + (y / RL * 0.5 + 0.5) * 0.36)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces: f.smooth = True
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    me.set_sharp_from_angle(angle=math.radians(35))
    return o

lod0, lod1, lod2 = drum("BarrelLOD0", 64, 0), drum("BarrelLOD1", 32, 1), drum("BarrelLOD2", 16, 2)
for o in (lod0, lod1, lod2): print("TRIS", o.name, T.tris(o))

# ── THE TEXTURE, from the geometry's own numbers ────────────────────────────────────────────────────────────────────
VV, UU = T.grid()
side = VV < 0.605
lid = (VV >= 0.62) & (UU < 0.40)
bottom = (VV >= 0.62) & (UU >= 0.40) & (UU < 0.80)
zt = np.array([p[1] for p in PROF0]); vt = np.array([v_of_z(z) for z in zt])
Z = np.interp(VV, vt, zt)                                         # the side's height at each texel
TH = UU * 360.0
near_rim = np.clip(1 - np.minimum(np.abs(Z - ZT), np.abs(Z + ZT)) / 0.07, 0, 1)
near_hoop = np.clip(1 - np.minimum(np.abs(Z - HOOPS[0]), np.abs(Z - HOOPS[1])) / 0.045, 0, 1)
edges = np.maximum(near_rim, near_hoop) * side
# the lid / bottom: radius in their squares
def disc_r(u0):
    x = (UU - u0) / 0.36 * 2 - 1; y = (VV - 0.63) / 0.36 * 2 - 1
    return np.sqrt(x * x + y * y) * RL
RD = np.where(lid, disc_r(0.02), np.where(bottom, disc_r(0.42), 0))
# chips: knocked off where a drum is hit (the rims, the hoops), a few elsewhere
n1, n2 = 0.6 * T.noise(70, 3, 1) + 0.4 * T.noise(150, 2, 14), T.noise(9, 3, 2)   # (fine and broken: flakes, not blobs)
chip_k = 0.62 + 0.22 * (1 - edges) + 0.1 * (1 - n2)
chips = T.smooth(chip_k - 0.025, chip_k + 0.01, n1) * (side | lid)
rust_in_chip = T.smooth(0.45, 0.65, T.noise(18, 2, 3))           # (a chip: bare steel, or rusted)
# rust run down from the top rim: thin streaks fading downward
# (thin, soft drips: 256 columns smoothed across, each its own length, broken along its run)
cols = np.random.default_rng(5).random(256); cols = np.clip((cols - 0.82) / 0.18, 0, 1)
cols = np.convolve(np.tile(cols, 3), np.hanning(7) / np.hanning(7).sum(), "same")[256:512]
cols = np.interp(np.linspace(0, 256, S, endpoint=False), np.arange(256), cols)[None, :]
length = np.interp(np.linspace(0, 256, S, endpoint=False), np.arange(256), np.random.default_rng(15).random(256))[None, :]
streak = cols * T.smooth(ZT - 0.2 - 0.6 * length, ZT - 0.04, Z) * side * (0.5 + 0.5 * T.noise(48, 2, 4))
# grime at the foot, and on the bottom
grime = (T.smooth(-ZT + 0.45, -ZT + 0.02, Z) * side * (0.5 + 0.5 * T.noise(14, 3, 6))) + bottom * 0.7
# the lettering: a stencil on one face, a paper label on the other (u per v: the texel aspect, one turn vs the height)
xs = (1 / (2 * math.pi * R)) / (0.60 / ACC0)
txt = T.render_text([
    ("MOTOR OIL", 0.75, v_of_z(0.08), 0.60 / ACC0 * 0.15, xs, False),
    ("208 L", 0.75, v_of_z(-0.10), 0.60 / ACC0 * 0.11, xs, False),
], font=T.STENCIL)
stencil = np.clip(txt * (0.75 + 0.25 * T.smooth(0.3, 0.6, T.noise(30, 3, 7))), 0, 1) * side
# (the label at u = 0.25: away from the texture's wrap seam at u = 0; its torn edge soft, not a stair of texels)
LU = 0.25
lab_u = np.abs(UU - LU)
edge_u = 0.072 - 0.010 * T.noise(60, 2, 9)
edge_z = 0.205 - 0.012 * T.noise(55, 2, 10)
label = T.smooth(0.003, -0.003, lab_u - edge_u) * T.smooth(0.006, -0.006, np.abs(Z) - edge_z) * side
ltxt = T.render_text([
    ("ENGINE OIL", LU, v_of_z(0.12), 0.60 / ACC0 * 0.055, xs, False),
    ("SAE 10W-40", LU, v_of_z(0.04), 0.60 / ACC0 * 0.04, xs, False),
    ("208 L  55 GAL", LU, v_of_z(-0.06), 0.60 / ACC0 * 0.035, xs, False),
    ("KEEP FROM HEAT", LU, v_of_z(-0.14), 0.60 / ACC0 * 0.025, xs, False),
])
ltxt = ltxt * label

# the relief (m): the weld seam, the paint's edge round each chip, the lid's pressed rings, the label's paper edge
h = np.zeros((S, S), np.float32)
seam = np.abs(((UU - 0.37 + 0.5) % 1.0) - 0.5) * 2 * math.pi * R
h += side * 0.0018 * T.smooth(0.005, 0.0, seam)
h -= 0.0004 * chips
h += 0.0006 * label
ring = lambda r0, w, a: a * T.smooth(w, 0, np.abs(RD - r0))
h += (lid | bottom) * (ring(0.40, 0.012, 0.004) + ring(0.30, 0.008, -0.003) + ring(0.18, 0.006, 0.002))
du_m = np.where(side, 2 * math.pi * R / S, 2 * RL / (0.36 * S)); dv_m = np.where(side, ACC0 / (0.60 * S), 2 * RL / (0.36 * S))
normal = T.normal_from_height(h, du_m, dv_m)

ao = T.bake_ao(lod0, 0.15)
def lin(hx): return np.array([((hx >> s & 255) / 255) ** 2.2 for s in (16, 8, 0)], np.float32)
PAINT, STEEL, RUST, DIRT, WHITE, PAPER, INK = lin(0xa3201b), lin(0x8a8d90), lin(0x6b3a1e), lin(0x5a4a3a), lin(0xe8e6e0), lin(0xd8cfb4), lin(0x2a2622)
paint = PAINT[None, None, :] * (0.88 + 0.24 * T.noise(5, 3, 11)[..., None])
col = paint.copy()
col = col * (1 - stencil[..., None]) + WHITE[None, None, :] * 0.85 * stencil[..., None]
col = col * (1 - label[..., None]) + PAPER[None, None, :] * (0.8 + 0.2 * T.noise(20, 2, 12)[..., None]) * label[..., None]
col = col * (1 - ltxt[..., None]) + INK[None, None, :] * ltxt[..., None]
bare = np.where(rust_in_chip[..., None] > 0.5, RUST[None, None, :], STEEL[None, None, :])
col = col * (1 - chips[..., None]) + bare * chips[..., None]
col = col * (1 - 0.7 * streak[..., None]) + RUST[None, None, :] * 0.7 * streak[..., None]
g = np.clip(grime, 0, 0.85)[..., None]
col = col * (1 - g) + DIRT[None, None, :] * g
col = col * (0.6 + 0.4 * ao[..., None])
steel = chips * (1 - (rust_in_chip > 0.5))
rough = 0.42 + 0.06 * T.noise(12, 2, 13) + 0.4 * chips * (rust_in_chip > 0.5) + 0.35 * np.clip(grime, 0, 1) + 0.3 * streak + 0.35 * label
arm = np.stack([ao, np.clip(rough, 0, 1), np.clip(steel, 0, 1)], -1)
imgC = T.save("barrel_color", col, True); imgN = T.save("barrel_normal", normal, False); imgA = T.save("barrel_arm", arm, False)

T.export((lod0, lod1, lod2), "barrel")

if not T.NOPREVIEW:
    mat = T.material("Barrel", imgC, imgN, imgA)
    for o in (lod0, lod1, lod2): o.data.materials.append(mat)
    scn, cam = T.preview_scene()
    lod0.location = (0, 0, ZT); lod0.rotation_euler = (0, 0, math.radians(-90))
    b2 = lod0.copy(); scn.collection.objects.link(b2); b2.location = (1.25, 0.5, ZT); b2.rotation_euler = (0, 0, math.radians(110))
    b3 = lod0.copy(); scn.collection.objects.link(b3); b3.location = (-1.0, 1.4, R); b3.rotation_euler = (math.radians(90), 0, math.radians(20))
    lod1.location = (2.8, 1.8, ZT); lod2.location = (4.0, 2.6, ZT)
    T.shoot(scn, cam, "barrel_wide", (1.6, -5.6, 2.0), (0.4, 0.6, 0.8))
    T.shoot(scn, cam, "barrel_close", (0.4, -2.1, 1.2), (0, 0, 0.75))
    T.shoot(scn, cam, "barrel_top", (0.3, -1.0, 2.6), (0, 0, 1.5))
print("DONE")
