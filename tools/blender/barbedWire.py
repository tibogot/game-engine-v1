"""THE BARBED WIRE IN BLENDER (2026-10-21, the asset pass): a 6 m run of the French double-apron fence — angle-iron
pickets with their guy pickets out to each side, strands along the top and down both aprons, twisted with BARBS (near
level only: sub-pixel beyond), and ONE continuous concertina coil along the front, stretched, out of round, squashed
where it sits on the ground.

    INTACT    as above
    DAMAGED   CUT: a gap through the middle — the strands cut and sprung back, hanging; the coil cut and its ends
              recoiled; one picket pushed over
    RUIN      CRUSHED (a vehicle drove over it): the pickets bent flat, the strands and the coil trampled into the
              ground in a tangle

  BUILD ORDER (COLOR_0): the pickets one after the other along the run, their guy pickets, the strands (the top,
  then the aprons), the coil last — unrolled along the front.

Real metres (the game ×1.3); the run along X, the front (the coil) at -Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/barbedWire.py -- <out dir> [--quick]

Writes <out>/barbedwire.glb (WireBarbed_Intact … _Ruin + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
import house
from house import buildKit
from bkit import B, gv, srgb, dust
import drystone
from drystone import tag

LN, H, A = 6.0, 1.2, 1.3            # the run's length, the picket's height, the apron's reach
CR, PITCH = 0.45, 0.3               # the coil's radius and its stretch a turn

def rusty(base, rust):
    def f(nb):
        c = nb.mix(nb.noise(2.0, 4), srgb(base), tuple(v * 0.75 for v in srgb(base)))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(6.0, 6), 0.68 - rust * 0.25, 0.74 - rust * 0.2), 0.9), c, srgb(0x6a3a20))
        return dust(nb, c, 0.5, 0.7)
    return f
MATDEF = dict(house.MATDEF)
MATDEF.update({"bwPicket": (0.7, rusty(0x4a4d44, 0.4)), "bwWire": (0.6, rusty(0x5c5a52, 0.7))})
LOW = lambda: drystone.LOW

def tube(K, nm, pts, r, mat, t, n=None):
    """A tube along the points (game), r its radius; n sides."""
    n = n or (5 if not LOW() else 3)
    bm = bmesh.new(); rings = []
    for i, p in enumerate(pts):
        p = gv(*p)
        d = (gv(*pts[min(i + 1, len(pts) - 1)]) - gv(*pts[max(i - 1, 0)])).normalized()
        up = gv(0, 1, 0) if abs(d.y) < 0.9 else gv(1, 0, 0)
        u = d.cross(up).normalized(); v = u.cross(d).normalized()
        rings.append([bm.verts.new(B(*(p + (u * math.cos(a) + v * math.sin(a)) * r))) for a in (2 * math.pi * k / n for k in range(n))])
    for i in range(len(rings) - 1):
        for k in range(n):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % n], rings[i + 1][(k + 1) % n], rings[i + 1][k]))
    return tag(K.obj(nm, bm, mat, "h", smooth=True), t)

def picket(K, nm, foot, top, t, mat="bwPicket"):
    """An angle-iron picket: two thin flanges at a right angle, from foot to top."""
    a, b = gv(*foot), gv(*top)
    d = (b - a); L_ = d.length; d.normalize()
    up = gv(0, 0, 1) if abs(d.z) < 0.9 else gv(1, 0, 0)
    u = d.cross(up).normalized(); v = u.cross(d).normalized()
    w, th = 0.045, 0.006
    for k, (e1, e2) in enumerate(((u, v), (v, u))):
        bm = bmesh.new()
        vs = [bm.verts.new(B(*(a + d * s + e1 * x + e2 * y))) for s in (0, L_) for x in (0, w) for y in (0, th)]
        bmesh.ops.convex_hull(bm, input=vs)
        tag(K.obj(f"{nm}F{k}", bm, mat, "h"), t)

def strand(K, nm, a, b, t, sag=0.03, cut=None, R=None):
    """A strand from a to b, sagging a little, BARBED every ~0.22 m (near). `cut`: (fraction, hang) — cut there, the
    two ends sprung back and hanging down."""
    a, b = gv(*a), gv(*b)
    segs = max(4, int((a - b).length / 0.5)) if not LOW() else 3
    pts = [a.lerp(b, i / segs) + gv(0, -sag * math.sin(math.pi * i / segs), 0) for i in range(segs + 1)]
    pieces = [pts]
    if cut is not None:
        f, hang = cut
        k = max(1, min(segs - 1, int(segs * f)))
        left = pts[:k] + [pts[k - 1].lerp(pts[k], 0.6) + gv(0.05, -hang, 0.04)]
        right = [pts[k].lerp(pts[k + 1] if k + 1 <= segs else pts[k], 0.3) + gv(-0.05, -hang * 0.8, -0.04)] + pts[k + 1:]
        pieces = [left, right]
    for j, pp in enumerate(pieces):
        if len(pp) < 2: continue
        tube(K, f"{nm}_{j}", [tuple(p) for p in pp], 0.009 if not LOW() else 0.014, "bwWire", t)
        if LOW(): continue
        # the barbs: a short twist across the strand every ~0.22 m
        total = sum((pp[i + 1] - pp[i]).length for i in range(len(pp) - 1))
        s, i, acc = 0.11, 0, 0.0
        while s < total and i < len(pp) - 1:
            seg = (pp[i + 1] - pp[i]).length
            if acc + seg < s: acc += seg; i += 1; continue
            p = pp[i].lerp(pp[i + 1], (s - acc) / max(seg, 1e-6))
            d = (pp[i + 1] - pp[i]).normalized()
            q = d.cross(gv(0, 1, 0)).normalized() if abs(d.y) < 0.9 else gv(1, 0, 0)
            r2 = d.cross(q).normalized()
            for e in (q + r2 * 0.4, r2 - q * 0.4):
                e = e.normalized() * 0.025
                tube(K, f"{nm}B{j}_{int(s * 100)}_{e.x:.2f}", [tuple(p - e), tuple(p + e)], 0.004, "bwWire", t, n=3)
            s += 0.22
    return pieces

def coil(K, nm, x0, x1, z0, t0, t1, R, crush=False, gap=None):
    """The concertina: ONE continuous coil from x0 to x1 (game), its axis along x at z0, out of round, squashed where
    it sits on the ground. `gap`: (xa, xb) cut out — its ends recoiled. Built in pieces so it unrolls in turn."""
    turns = max(2, round((x1 - x0) / PITCH))
    per = 14 if not LOW() else 6
    jit = [(R.uniform(-0.04, 0.04), R.uniform(-0.03, 0.03)) for _ in range(turns + 2)]
    pts = []
    for i in range(turns * per + 1):
        u = i / per; k = min(turns - 1, int(u)); f = u - k
        jr = jit[k][0] + (jit[k + 1][0] - jit[k][0]) * f; jz = jit[k][1] + (jit[k + 1][1] - jit[k][1]) * f
        a = u * 2 * math.pi; r = CR + jr
        y = CR + math.cos(a) * r
        y = y if y > 0.12 else 0.12 + (y - 0.12) * 0.25
        if crush: y = 0.04 + y * 0.12
        x = x0 + (x1 - x0) * u / turns
        pts.append((x, y, z0 + jz + math.sin(a) * r * (1.25 if crush else 1)))
    # pieces of ~2 turns, each its moment (unrolled along the front)
    step = per * 2
    for s in range(0, len(pts) - 1, step):
        piece = pts[s:s + step + 1]
        if gap and all(gap[0] < p[0] < gap[1] for p in piece): continue
        if gap: piece = [p for p in piece if not (gap[0] < p[0] < gap[1])]
        if len(piece) < 2: continue
        tube(K, f"{nm}{s}", piece, 0.012 if not LOW() else 0.018, "bwWire", t0 + (t1 - t0) * s / len(pts))

def buildWire(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    n = round(LN / 2)
    xs = [-LN / 2 + k * LN / n for k in range(n + 1)]
    top = H - 0.05
    if state == "ruin":
        # crushed: the pickets bent flat along the track's direction, everything trampled
        for k, x in enumerate(xs):
            a = R.uniform(-0.4, 0.4)
            picket(K, f"P{k}", (x, 0.02, 0), (x + math.cos(a) * H * 0.9, 0.08, math.sin(a) * H * 0.9 - 0.3), 0.05 + 0.1 * k / n)
        for j in range(5):
            z = R.uniform(-A, A)
            strand(K, f"S{j}", (-LN / 2, 0.05, z), (LN / 2, 0.05, z + R.uniform(-0.5, 0.5)), 0.5, sag=-0.02)
        coil(K, "C", -LN / 2 + 0.2, LN / 2 - 0.2, -A - 0.4, 0.7, 0.95, R, crush=True)
    else:
        gap = (-0.55, 0.65) if state == "damaged" else None
        for k, x in enumerate(xs):
            t = 0.04 + 0.3 * k / n
            if state == "damaged" and k == n // 2:
                picket(K, f"P{k}", (x, 0, 0), (x + 0.5, 0.75, -0.6), t)          # pushed over
            else:
                lean = R.uniform(-0.03, 0.03)
                picket(K, f"P{k}", (x, -0.15, 0), (x + lean, H, lean), t)
            for sz in (-1, 1):
                picket(K, f"G{k}{sz}", (x + 0.03, -0.1, sz * A), (x + 0.03, 0.35, sz * A * 0.94), t + 0.02)
                strand(K, f"Y{k}{sz}", (x, top, 0), (x + 0.03, 0.33, sz * A * 0.95), 0.45 + 0.1 * k / n, sag=0.0)
        cut = (0.5, 0.35) if state == "damaged" else None
        strand(K, "Top", (-LN / 2, top, 0), (LN / 2, top, 0), 0.5, cut=cut)
        for sz in (-1, 1):
            for j, f in enumerate((0.3, 0.6, 0.9)):
                y = top - (top - 0.4) * f
                strand(K, f"A{sz}{j}", (-LN / 2, y, sz * A * f), (LN / 2, y, sz * A * f), 0.55 + 0.05 * j, cut=cut)
        coil(K, "C", -LN / 2 + 0.2, LN / 2 - 0.2, -A - 0.5, 0.72, 0.98, R, gap=gap)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farWire = lambda K, name, spec, state, seed: buildWire(K, name, spec, state, seed, far=True)
TYPES = {"barbed": dict(builder=buildWire, farBuilder=farWire, atlas=1024, aoDist=0.3, smoothAngle=60, weighted=False)}

exported = buildKit(TYPES, MATDEF, "barbedwire.glb", prefix="Wire", seed0=1960, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1000, 600
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cd.lens = 35; cam.location = B(-2.5, 4.0, -7.5); cam.rotation_euler = (B(0, 0.4, -0.5) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
