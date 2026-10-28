"""THUNDERLINE — THE START / FINISH ARCH as a KIT (2026-10-28, user: "the start and finish arch gantry … they are floating
and look very cheap"). The road is 4, 8 or 24 m half-wide (kit.js SECTIONS) on a 0.7-1.1 m slab, in the air: one model
cannot fit, so these are PARTS that gateMesh.js assembles to the road it stands on —

  ArchLeg     a box-truss tower (0.6 m, 4 chords), y −1.5 → 8.8, one beside each edge of the deck
  ArchBay     2 m of the top truss (y 7.7-8.7, z ±0.3), tiled across from leg to leg
  ArchBeam    2 m of the I-beam UNDER the deck, tiled from leg to leg: the frame closes round the road (nothing floats)
  ArchHead    1 m of the header (y 7.05-9.35, z ±0.62): a bevelled profile round its two LED faces, tiled
  ArchCap     the header's end plate (x 0 → 0.12; the other end its mirror)
  ArchPod     the start lights' pod (3.6 × 1.0 m, three lamp hoods, two hangers); the lenses are the game's

each as LOD0 / LOD1 / LOD2 (e.g. ArchLegLOD1). Coordinates: x across the road, y up from the deck, z along the travel
(the car comes from −z). Two TILING materials, UVs in metres (1 m a repeat): aluminium (leg, bay, beam) and black powder
coat (head, cap, pod) — textures arch_alu_* and arch_coat_*, 512² each.
"""
import sys, os, math
sys.path.append(os.path.dirname(__file__))
import bpy, bmesh
import numpy as np
from mathutils import Vector
import thunderKit as T

T.reset()
T.S = 512
S = T.S

def G(x, y, z): return Vector((x, -z, y))   # game → Blender

class Mesh:
    """Geometry in game coordinates with UVs (metres)."""
    def __init__(self): self.bm = bmesh.new(); self.uv = self.bm.loops.layers.uv.new("UV")
    def face(self, pts, uvs):
        vs = [self.bm.verts.new(G(*p)) for p in pts]
        f = self.bm.faces.new(vs)
        for l, t in zip(f.loops, uvs): l[self.uv].uv = t
        return f
    def tube(self, a, b, r, n, caps=True, u0=0.0):
        A, B = Vector(a), Vector(b); d = B - A; L = d.length; d.normalize()
        ref = Vector((0, 1, 0)) if abs(d.y) < 0.9 else Vector((1, 0, 0))
        e1 = d.cross(ref).normalized(); e2 = d.cross(e1)
        ring = lambda P, k: P + (e1 * math.cos(2 * math.pi * k / n) + e2 * math.sin(2 * math.pi * k / n)) * r
        C = 2 * math.pi * r
        # (v along the tube in metres from its start along x/y/z — continuous across tiles when a tube starts at a tile edge)
        v0 = a[0] if abs(d.x) > 0.9 else a[1] if abs(d.y) > 0.9 else a[2]
        for k in range(n):
            p = [ring(A, k), ring(A, k + 1), ring(B, k + 1), ring(B, k)]
            ua, ub = u0 + C * k / n, u0 + C * (k + 1) / n
            self.face([tuple(q) for q in p], [(ua, v0), (ub, v0), (ub, v0 + L), (ua, v0 + L)])
        if caps:
            for P, s in ((A, -1), (B, 1)):
                c = tuple(P)
                for k in range(n):
                    p1, p2 = tuple(ring(P, k)), tuple(ring(P, k + 1))
                    self.face([p1, p2, c] if s > 0 else [p2, p1, c], [(0, 0), (0.02, 0), (0.01, 0.02)])
    def box(self, x0, x1, y0, y1, z0, z1, skip=()):
        X, Y, Z = (x0, x1), (y0, y1), (z0, z1)
        for ax, sgn, name in ((0, -1, "-x"), (0, 1, "+x"), (1, -1, "-y"), (1, 1, "+y"), (2, -1, "-z"), (2, 1, "+z")):
            if name in skip: continue
            c = [X, Y, Z]; fixed = c[ax][0 if sgn < 0 else 1]
            o = [i for i in range(3) if i != ax]
            quad = [(0, 0), (1, 0), (1, 1), (0, 1)]
            if sgn < 0: quad = quad[::-1]
            if ax == 1: quad = quad[::-1]   # (keep every face's winding outward)
            pts, uvs = [], []
            for i, j in quad:
                p = [0, 0, 0]; p[ax] = fixed; p[o[0]] = c[o[0]][i]; p[o[1]] = c[o[1]][j]
                pts.append(tuple(p)); uvs.append((p[o[0]], p[o[1]]))
            self.face(pts, uvs)
    def bevel(self, offset, seg):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)   # (box faces are made apart: weld them first)
        bmesh.ops.bevel(self.bm, geom=list(self.bm.edges), offset=offset, offset_type="OFFSET", segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    def obj(self, name):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name); self.bm.normal_update()
        for f in self.bm.faces: f.smooth = True
        self.bm.to_mesh(me); self.bm.free()
        o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
        me.set_sharp_from_angle(angle=math.radians(40))
        return o

OBJS = []
SEG = {0: 10, 1: 6, 2: 4}
# ── THE LEG: a box truss, 0.6 m between chord axes ──────────────────────────────────────────────────────────────────
LY0, LY1, LC = -1.5, 8.8, 0.3
for lod in (0, 1, 2):
    m = Mesh(); n = SEG[lod]
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.tube((sx * LC, LY0, sz * LC), (sx * LC, LY1, sz * LC), 0.045, n)
    if lod < 2:
        bn = 6 if lod == 0 else 4
        ys = np.arange(LY0 + 0.3, LY1 - 0.1, 1.0)
        for i, y in enumerate(ys):
            for (a, b) in (((-LC, -LC), (LC, -LC)), ((LC, -LC), (LC, LC)), ((LC, LC), (-LC, LC)), ((-LC, LC), (-LC, -LC))):
                m.tube((a[0], y, a[1]), (b[0], y, b[1]), 0.02, bn, caps=False)
                if y + 1.0 < LY1:   # the diagonal of the panel above, zig-zag
                    s, e = (a, b) if i % 2 == 0 else (b, a)
                    m.tube((s[0], y, s[1]), (e[0], y + 1.0, e[1]), 0.018, bn, caps=False)
    m.box(-0.42, 0.42, LY0 - 0.03, LY0, -0.42, 0.42)      # the foot plate
    m.box(-0.42, 0.42, LY1, LY1 + 0.03, -0.42, 0.42)      # the head plate
    if lod == 0:
        for sx in (-1, 1):
            for sz in (-1, 1):
                m.tube((sx * 0.36, LY1 + 0.03, sz * 0.36), (sx * 0.36, LY1 + 0.06, sz * 0.36), 0.025, 6)
                m.tube((sx * 0.36, LY0 - 0.06, sz * 0.36), (sx * 0.36, LY0 - 0.03, sz * 0.36), 0.025, 6)
    OBJS.append(m.obj(f"ArchLegLOD{lod}"))

# ── THE TOP TRUSS BAY: 2 m along x (x −1 → 1), chords at y 7.7 / 8.7, z ±0.3 ────────────────────────────────────────
BY0, BY1, BZ = 7.7, 8.7, 0.3
for lod in (0, 1, 2):
    m = Mesh(); n = SEG[lod]
    for y in (BY0, BY1):
        for z in (-BZ, BZ):
            m.tube((-1.0, y, z), (1.0, y, z), 0.045, n, caps=False)
    if lod < 2:
        bn = 6 if lod == 0 else 4
        # the frame at the bay's start (the next bay brings the next one)
        for z in (-BZ, BZ): m.tube((-1.0, BY0, z), (-1.0, BY1, z), 0.02, bn, caps=False)
        for y in (BY0, BY1): m.tube((-1.0, y, -BZ), (-1.0, y, BZ), 0.02, bn, caps=False)
        # diagonals: the two sides (a V), top and bottom
        for z in (-BZ, BZ):
            m.tube((-1.0, BY0, z), (0.0, BY1, z), 0.018, bn, caps=False); m.tube((0.0, BY1, z), (1.0, BY0, z), 0.018, bn, caps=False)
        for y in (BY0, BY1):
            m.tube((-1.0, y, -BZ), (1.0, y, BZ), 0.018, bn, caps=False)
    OBJS.append(m.obj(f"ArchBayLOD{lod}"))

# ── THE BEAM UNDER THE DECK: 2 m of I-beam (x −1 → 1), its top at y 0 (the game sets it under the slab) ─────────────
for lod in (0, 1, 2):
    m = Mesh()
    m.box(-1.0, 1.0, -0.025, 0.0, -0.16, 0.16, skip=("-x", "+x"))
    m.box(-1.0, 1.0, -0.32, -0.295, -0.16, 0.16, skip=("-x", "+x"))
    m.box(-1.0, 1.0, -0.295, -0.025, -0.008, 0.008, skip=("-x", "+x", "-y", "+y"))
    if lod == 0:   # a stiffener plate each metre
        for x in (-0.5, 0.5):
            for sz in (-1, 1): m.box(x - 0.006, x + 0.006, -0.295, -0.025, sz * 0.008, sz * 0.15) if sz > 0 else m.box(x - 0.006, x + 0.006, -0.295, -0.025, -0.15, -0.008)
    OBJS.append(m.obj(f"ArchBeamLOD{lod}"))

# ── THE HEADER: a 1 m slice (x −0.5 → 0.5) of a bevelled profile round the two LED faces ───────────────────────────
HY0, HY1, HZ, LZ, LIP = 7.05, 9.35, 0.62, 0.55, 0.2   # outside; the LED face's z; the bezel band's height
def arc(cz, cy, r, a0, a1, k):
    return [(cz + r * math.cos(a0 + (a1 - a0) * i / k), cy + r * math.sin(a0 + (a1 - a0) * i / k)) for i in range(k + 1)]
def head_profile(k):
    r = 0.06
    bottom = [(-LZ, HY0 + LIP), (-HZ, HY0 + LIP)] + arc(-HZ + r, HY0 + r, r, math.pi, 1.5 * math.pi, k) + arc(HZ - r, HY0 + r, r, 1.5 * math.pi, 2 * math.pi, k) + [(HZ, HY0 + LIP), (LZ, HY0 + LIP)]
    top = [(LZ, HY1 - LIP), (HZ, HY1 - LIP)] + arc(HZ - r, HY1 - r, r, 0, 0.5 * math.pi, k) + arc(-HZ + r, HY1 - r, r, 0.5 * math.pi, math.pi, k) + [(-HZ, HY1 - LIP), (-LZ, HY1 - LIP)]
    return [bottom, top]
for lod in (0, 1, 2):
    m = Mesh(); k = {0: 3, 1: 1, 2: 0}[lod]
    for prof in head_profile(max(k, 1) if lod < 2 else 1):
        if lod == 2: prof = [prof[0], prof[1], prof[2], prof[-3], prof[-2], prof[-1]] if len(prof) > 6 else prof
        s = 0.0
        for (z0, y0), (z1, y1) in zip(prof, prof[1:]):
            L = math.hypot(z1 - z0, y1 - y0)
            m.face([(-0.5, y0, z0), (0.5, y0, z0), (0.5, y1, z1), (-0.5, y1, z1)], [(-0.5, s), (0.5, s), (0.5, s + L), (-0.5, s + L)])
            s += L
    OBJS.append(m.obj(f"ArchHeadLOD{lod}"))
# the end plate (x 0 → 0.12), a little proud of the profile all round, bevelled
for lod in (0, 1, 2):
    m = Mesh()
    m.box(0.0, 0.12, HY0 - 0.04, HY1 + 0.04, -HZ - 0.04, HZ + 0.04)
    if lod < 2: m.bevel(0.03, 3 if lod == 0 else 1)
    OBJS.append(m.obj(f"ArchCapLOD{lod}"))

# ── THE START LIGHTS' POD: a box under the header, three lamp hoods on its front (−z), two hangers up ───────────────
PY, PW, PH, PD = 6.3, 3.6, 1.0, 0.45
LAMP_X, LAMP_R = (-1.2, 0.0, 1.2), 0.36
for lod in (0, 1, 2):
    m = Mesh()
    m.box(-PW / 2, PW / 2, PY - PH / 2, PY + PH / 2, -PD / 2, PD / 2)
    n = {0: 24, 1: 12, 2: 8}[lod]
    for x in LAMP_X:
        if lod == 2: break
        # a hood: an open ring (outer + inner wall + the front rim), cut away below (a visor)
        r0, r1, z0, z1 = LAMP_R + 0.04, LAMP_R + 0.07, -PD / 2, -PD / 2 - 0.28
        for kk in range(n):
            a0, a1 = 2 * math.pi * kk / n, 2 * math.pi * (kk + 1) / n
            if math.sin((a0 + a1) / 2) < -0.35: continue   # (the visor's open bottom)
            p = lambda r, a, z: (x + r * math.cos(a), PY + r * math.sin(a), z)
            m.face([p(r1, a0, z0), p(r1, a1, z0), p(r1, a1, z1), p(r1, a0, z1)][::-1], [(a0, 0), (a1, 0), (a1, 0.28), (a0, 0.28)])
            m.face([p(r0, a0, z0), p(r0, a1, z0), p(r0, a1, z1), p(r0, a0, z1)], [(a0, 0), (a1, 0), (a1, 0.28), (a0, 0.28)])
            m.face([p(r0, a0, z1), p(r0, a1, z1), p(r1, a1, z1), p(r1, a0, z1)], [(a0, 0), (a1, 0), (a1, 0.03), (a0, 0.03)])
    for x in (-1.1, 1.1):
        m.tube((x, PY + PH / 2, 0), (x, HY0 + 0.2, 0), 0.04, SEG[lod])
    o = m.obj(f"ArchPodLOD{lod}")
    if lod == 0:
        pass
    OBJS.append(o)
for o in OBJS: print("TRIS", o.name, T.tris(o))

# ── THE TEXTURES: two tiling sets, 1 m a repeat ─────────────────────────────────────────────────────────────────────
VV, UU = T.grid()
def lin(hx): return np.array([((hx >> s & 255) / 255) ** 2.2 for s in (16, 8, 0)], np.float32)
def periodic_1d(n, scale, seed):
    """Smooth periodic noise along one axis (S samples): sums of sines with random phases."""
    rng = np.random.default_rng(seed); x = np.arange(S) / S; acc = np.zeros(S, np.float32)
    for f in range(1, scale + 1):
        acc += rng.normal() / f * np.sin(2 * math.pi * (f * x + rng.random()))
    return (acc - acc.min()) / (acc.max() - acc.min() + 1e-6)
# ALUMINIUM: brushed along the tubes (v), a few scuffs and grey road grime, slightly anodised-satin
brush = np.tile(periodic_1d(S, 180, 5)[None, :], (S, 1)) * 0.6 + np.tile(periodic_1d(S, 40, 6)[None, :], (S, 1)) * 0.4
blot = T.noise(3, 3, 61); scuff = T.smooth(0.72, 0.85, T.noise(10, 3, 62))
ALU, GRIME = lin(0xb9bec4), lin(0x55504a)
col = ALU[None, None, :] * (0.86 + 0.14 * brush[..., None]) * (0.9 + 0.1 * blot[..., None])
grime = T.smooth(0.55, 0.85, blot) * 0.35
col = col * (1 - grime[..., None]) + GRIME[None, None, :] * grime[..., None]
col = col * (1 - 0.15 * scuff[..., None])
rough = np.clip(0.32 + 0.12 * brush + 0.3 * grime + 0.12 * scuff, 0, 1)
arm = np.stack([np.ones((S, S), np.float32), rough, np.clip(1 - 0.7 * grime, 0, 1)], -1)
nrm = T.normal_from_height((brush * 0.00004 + scuff * 0.00003).astype(np.float32), 1 / S, 1 / S)
iAc = T.save("arch_alu_color", col, True); iAn = T.save("arch_alu_normal", nrm, False); iAa = T.save("arch_alu_arm", arm, False)
# POWDER COAT: black satin, orange peel, faint dust
peel = T.noise(40, 2, 71); dust = T.smooth(0.6, 0.85, T.noise(4, 3, 72)) * 0.3
COAT, DUST = lin(0x1c1e21), lin(0x6b5d4c)
col = COAT[None, None, :] * (0.88 + 0.24 * peel[..., None])
col = col * (1 - dust[..., None]) + DUST[None, None, :] * dust[..., None]
rough = np.clip(0.48 + 0.1 * peel + 0.35 * dust, 0, 1)
arm = np.stack([np.ones((S, S), np.float32), rough, np.zeros((S, S), np.float32)], -1)
nrm = T.normal_from_height((peel * 0.00008).astype(np.float32), 1 / S, 1 / S)
iCc = T.save("arch_coat_color", col, True); iCn = T.save("arch_coat_normal", nrm, False); iCa = T.save("arch_coat_arm", arm, False)

T.export(OBJS, "arch")

if not T.NOPREVIEW:
    def tiled(mat_imgs, name):
        mat = T.material(name, *mat_imgs)
        return mat
    alu, coat = tiled((iAc, iAn, iAa), "Alu"), tiled((iCc, iCn, iCa), "Coat")
    # assemble an 8 m half-wide arch for the preview, as gateMesh.js does
    hw = 8.0; lx = hw + 1.6
    def put(src, x, y=0.0, sx=1.0, mat=alu):
        o = src.copy(); o.data = src.data.copy(); bpy.context.scene.collection.objects.link(o)
        o.data.materials.clear(); o.data.materials.append(mat)
        o.location = G(x, y, 0); o.scale = (sx, 1, 1); o.hide_render = False
        return o
    byname = {o.name: o for o in OBJS}
    for o in OBJS: o.hide_render = True
    for sx in (-1, 1): put(byname["ArchLegLOD0"], sx * lx)
    nb = math.ceil(2 * lx / 2.0); bw = 2 * lx / nb
    for i in range(nb):
        put(byname["ArchBayLOD0"], -lx + bw * (i + 0.5), sx=bw / 2.0)
        put(byname["ArchBeamLOD0"], -lx + bw * (i + 0.5), y=-0.9, sx=bw / 2.0)
    wh = 2 * hw + 2; nh = round(wh)
    for i in range(nh): put(byname["ArchHeadLOD0"], -wh / 2 + (i + 0.5) * wh / nh, sx=wh / nh, mat=coat)
    put(byname["ArchCapLOD0"], wh / 2, mat=coat); put(byname["ArchCapLOD0"], -wh / 2, sx=-1, mat=coat)
    put(byname["ArchPodLOD0"], 0, mat=coat)
    # a deck to stand on (the slab, 0.9 m)
    bpy.ops.mesh.primitive_cube_add(size=1); d = bpy.context.active_object; d.scale = (2 * hw + 1.4, 30, 0.9); d.location = (0, 0, -0.45)
    scn, cam = T.preview_scene()
    for o in scn.objects:
        if o.type == "MESH" and o.name.startswith("Plane"): o.location.z = -12
    T.shoot(scn, cam, "arch_front", (6, -24, 3.0), (0, 0, 5.0))
    T.shoot(scn, cam, "arch_leg", (12.5, -6, 1.2), (9.6, 0, 3.0))
    T.shoot(scn, cam, "arch_under", (4, -10, -3.5), (8, 0, -0.5))
print("DONE")
