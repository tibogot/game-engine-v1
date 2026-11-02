"""THE PUMP STATION IN BLENDER (2026-11-02, El Kantara — TODO MAP 3 step 3, you: "ok commit and go next"): the oil
road's station on the map's east plain, the FLN's sabotage target. Two riveted steel STORAGE TANKS (painted aluminium,
stained at the foot) inside an earth BUND, their ladders and roof rails; the PUMP HOUSE (rendered blocks, a door, two
windows, a corrugated roof, its exhaust stack); the MANIFOLD between them — pipes on concrete saddles, handwheel valves,
a meter box; spare pipes stacked, drums. And the PIPELINE itself, a 10 m length on its saddles, laid end to end.

    pompage   DAMAGED  the second tank holed (charred round the hole), a manifold pipe broken off, drums knocked over
              RUIN     the second tank burst and slumped, the first charred, the pump house roofless and broken, the
                       manifold torn, burnt drums
    tuyau     one state (a length is replaced, not repaired)

  BUILD ORDER (COLOR_0): the bund, the saddles, the tanks ring by ring, the pump house, the pipes, the valves, the stores.

Real metres (the game ×1.3); the front at -Z; autoLod (tools/lod makes and proves the far).

  node tools/blenderKit.mjs oilStation [--only pompage] [--quick]

Writes oilstation.glb (Oil<Type>_<State>).
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit
from bkit import B, srgb, dust, flat
import drystone
from drystone import tag
import milprops
import props

def tankPaint(nb):
    """Aluminium paint, chalky in the sun, rust and oil stains running down from the seams, dirt at the foot."""
    c = nb.mix(nb.noise(2.0, 4), srgb(0xa29f97), srgb(0x8e8b83))   # (dulled: the bright aluminium blew out in the desert sun, the game)
    c = nb.mix(nb.mr(nb.noise(7.0, 5, 0.6, (1, 1, 6)), 0.55, 0.7), c, srgb(0x7a5a3e))          # rust streaks, vertical
    c = nb.mix(nb.mr(nb.noise(3.0, 4), 0.5, 0.75), c, nb.scale(c, 0.8))                          # weathered patches
    c = nb.mix(nb.mr(nb.gy, 1.1, 0.1), c, nb.scale(c, 0.7))                                      # dirt at the foot
    return dust(nb, c, 0.8, 0.6)
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x5b5048))
def berm(nb):
    c = nb.mix(nb.noise(1.2, 4), srgb(0xa86e4c), srgb(0x8e5a3e))   # (the plain's red earth: pale, it read as beams of sandstone)
    return dust(nb, nb.mix(nb.mr(nb.noise(6.0, 5), 0.55, 0.7), c, nb.scale(c, 0.85)), 0.6, 0.6)
MATDEF = dict(house.MATDEF)
MATDEF.update(milprops.MILPROP_MATS)
MATDEF.update(props.PROP_MATS)
MATDEF.update({
    "osTank": (0.55, tankPaint), "osPipe": (0.5, milprops._steel(0x3c3a34, 0.45)), "osPipePaint": (0.6, milprops._steel(0x6a6250, 0.35)),
    "osValve": (0.6, flat(srgb(0x8a1e18), 0.3)), "osConcrete": (0.95, flat(srgb(0xa49c8c), 0.4)), "earthBund": (1.0, berm),
    "osRender": (0.95, house.MATDEF["renderPlain"][1] if isinstance(house.MATDEF.get("renderPlain"), tuple) else flat(srgb(0xd8ccb4), 0.3)),
    "osRoof": (0.7, milprops._steel(0x7a7468, 0.6)), "osDoor": (0.8, flat(srgb(0x4e5a3e), 0.3)), "osGlass": (0.2, flat(srgb(0x22282a), 0.0)),
    "osChar": (0.95, charred), "drumOlive": (0.6, props.drum_paint(0x4d5536, 0.4)), "drumRed": (0.6, props.drum_paint(0x7a2a1e, 0.45)),
    "drumSteel": (0.5, props.steel_paint(0x6a6a66, 0.3)),
})
G = "h"
LOW = lambda: drystone.LOW

def box(K, nm, x0, x1, y0, y1, z0, z1, mat, t, bev=0.01):
    return tag(K.box(nm, x0, x1, y0, y1, z0, z1, mat, G, bev if not LOW() else 0), t)
def rod(K, nm, a, b, r, mat, t, n=10):
    return tag(K.rod(nm, a, b, r, mat, G, n if not LOW() else max(4, n // 2)), t)
def cyl(K, nm, c, r, h, mat, t, n=32, r2=None):
    return tag(K.cyl(nm, c, r, h, mat, G, n if not LOW() else max(8, n // 2), r2=r2), t)
def make(K, t):
    return lambda n, bm, m: tag(K.obj(n, bm, m, G, smooth=True), t)

def saddle(K, nm, x, z, y, t, along="x"):
    """A concrete pipe saddle: a block with its top at the pipe's underside."""
    if along == "x": box(K, nm, x - 0.18, x + 0.18, -0.12, y, z - 0.35, z + 0.35, "osConcrete", t, 0.015)
    else: box(K, nm, x - 0.35, x + 0.35, -0.12, y, z - 0.18, z + 0.18, "osConcrete", t, 0.015)

def valve(K, nm, x, y, z, t, axis="x"):
    """A gate valve on the pipe: its body, the stem up, the red handwheel."""
    cyl(K, nm + "Body", (x, y - 0.22, z), 0.2, 0.44, "osPipePaint", t, 14)
    rod(K, nm + "Stem", (x, y + 0.2, z), (x, y + 0.62, z), 0.025, "osPipe", t, 6)
    ring = [(x + 0.2 * math.cos(2 * math.pi * k / 10), y + 0.62, z + 0.2 * math.sin(2 * math.pi * k / 10)) for k in range(11)]
    for k in range(10): rod(K, f"{nm}Wheel{k}", ring[k], ring[k + 1], 0.018, "osValve", t, 5)
    for k in range(3): rod(K, f"{nm}Spoke{k}", (x, y + 0.62, z), ring[k * 3], 0.012, "osValve", t, 4)

TANKS = [(-1.2, 4.8, 3.2, 5.4), (6.0, 4.8, 3.2, 5.4)]   # x, z, radius, height

def tank(K, R, i, state):
    x, z, r, h = TANKS[i]; t = 0.15 + i * 0.12
    burst = state == "ruin" and i == 1
    mat = "osChar" if state == "ruin" else "osTank"
    cyl(K, f"TankFoot{i}", (x, -0.12, z), r + 0.25, 0.32, "osConcrete", t)
    if burst:   # slumped: the lower ring standing, the shell torn down to it, the roof fallen in
        cyl(K, f"Tank{i}", (x, 0.18, z), r, 1.6, "osChar", t)
        for k in range(7 if not LOW() else 3):
            a = 2 * math.pi * k / 7 + R.uniform(-0.2, 0.2)
            tag(K.lump(f"TankWreck{i}{k}", (x + math.cos(a) * r * 0.75, 1.7, z + math.sin(a) * r * 0.75), (0.9, 0.35, 0.5), "osChar", G, seed=k + 3, rough=0.5, sub=1), t + 0.05)
        return
    shell = cyl(K, f"Tank{i}", (x, 0.18, z), r, h, mat, t)
    if state == "damaged" and i == 1:   # holed, the hole charred
        K.boolean(shell, K.breach((x + r * 0.7, 2.2, z - r * 0.7), (0.8, 0.9, 0.8), seed=5, mat="osChar"))
    # the riveted seams (a band at each ring) and the roof: a shallow cone, its rail
    if not LOW():
        for k, y in enumerate((1.5, 2.85, 4.2)):
            cyl(K, f"Seam{i}{k}", (x, 0.18 + y, z), r + 0.025, 0.07, mat, t + 0.01 + k * 0.01)
    cyl(K, f"Roof{i}", (x, 0.18 + h, z), r + 0.06, 0.55, mat, t + 0.05, r2=0.35)
    if state != "ruin" and not LOW():
        n = 16
        pts = [(x + (r - 0.15) * math.cos(2 * math.pi * k / n), 0.18 + h + 0.12, z + (r - 0.15) * math.sin(2 * math.pi * k / n)) for k in range(n + 1)]
        for k in range(n):
            a, b = pts[k], pts[k + 1]
            rod(K, f"Rail{i}{k}", (a[0], a[1] + 0.95, a[2]), (b[0], b[1] + 0.95, b[2]), 0.02, "osPipe", t + 0.06, 5)
            if k % 2 == 0: rod(K, f"Post{i}{k}", a, (a[0], a[1] + 0.95, a[2]), 0.018, "osPipe", t + 0.06, 5)
        # the ladder up its front-left, caged near the top
        lx, lz = x - r * 0.72, z - r * 0.72 - 0.08
        for s in (-1, 1):
            rod(K, f"LadSide{i}{s}", (lx + s * 0.2, 0.2, lz), (lx + s * 0.2, 0.18 + h + 1.0, lz), 0.02, "osPipe", t + 0.07, 5)
        for k in range(int(h / 0.32)):
            yy = 0.4 + k * 0.32
            rod(K, f"Rung{i}{k}", (lx - 0.2, yy, lz), (lx + 0.2, yy, lz), 0.014, "osPipe", t + 0.07, 4)
    # the outlet to the manifold, low on its front
    rod(K, f"Outlet{i}", (x, 0.55, z - r + 0.05), (x, 0.55, z - r - 0.9), 0.14, "osPipe", t + 0.08, 12)

def bund(K, R):
    """THE BUND: an earth bank round the tanks (a spill catch), a gap at its front for the pipes."""
    x0, x1, z0, z1, h = -5.2, 10.0, 0.6, 9.2, 0.8
    def bank(nm, a, b, nx, nz):
        (ax, az), (bx, bz) = a, b
        pts = []
        for (px, pz) in (a, b):
            # a rounded bank (a heaped earth profile, not a trapezoid): wider, its crest soft
            for off, y in ((-1.5, -0.15), (-1.0, 0.32), (-0.55, 0.62), (0.0, h), (0.55, 0.62), (1.0, 0.32), (1.5, -0.15)):
                pts.append((px + nx * off, y, pz + nz * off))
        bm = bmesh.new(); vs = [bm.verts.new(B(*p)) for p in pts]
        bmesh.ops.convex_hull(bm, input=vs)
        for v in [v for v in bm.verts if not v.link_faces]: bm.verts.remove(v)
        tag(K.obj(nm, bm, "earthBund", G, smooth=True), 0.04)
    bank("BundBack", (x0, z1), (x1, z1), 0, 1)
    bank("BundL", (x0, z0 + 0.6), (x0, z1 - 0.6), 1, 0)
    bank("BundR", (x1, z0 + 0.6), (x1, z1 - 0.6), 1, 0)
    bank("BundF1", (x0 + 0.6, z0), (0.4, z0), 0, 1)       # (the gap: x 0.4 → 3.4, where the outlets cross)
    bank("BundF2", (3.4, z0), (x1 - 0.6, z0), 0, 1)

def pumpHouse(K, R, state):
    """THE PUMP HOUSE, front left: rendered block walls on a plinth, a steel door, two windows, a corrugated roof, its
    exhaust stack."""
    x0, x1, z0, z1, h = -9.0, -4.0, -4.6, -0.6, 3.1
    ruin, dmg = state == "ruin", state != "intact"
    top = h if not ruin else 1.6
    box(K, "PHPlinth", x0 - 0.1, x1 + 0.1, -0.15, 0.35, z0 - 0.1, z1 + 0.1, "osConcrete", 0.5)
    walls = box(K, "PHWalls", x0, x1, 0.33, top, z0, z1, "osRender", 0.52, 0.02)
    K.boolean(walls, K.cutter(x0 + 0.25, x1 - 0.25, 0.4, top + 1, z0 + 0.25, z1 - 0.25, "osRender"))   # hollow (its inside seen when broken)
    K.boolean(walls, K.cutter(-6.0, -5.0, 0.36, 2.4, z0 - 0.3, z0 + 0.3, "osRender"))                # the door
    for wx in (-8.2, -4.9):
        if not ruin: K.boolean(walls, K.cutter(wx - 0.4, wx + 0.4, 1.4, 2.3, z0 - 0.3, z0 + 0.3, "osRender"))
    if ruin:
        K.boolean(walls, K.skyline(x0 - 1, x1 + 1, z0 - 1, z1 + 1, 1.2, 0.6, seed=9, mat="osChar"))
        for k in range(5 if not LOW() else 2):
            tag(K.lump(f"PHRub{k}", (R.uniform(x0, x1), 0.4, R.uniform(z0 - 1.2, z1)), (0.45, 0.25, 0.35), "osRender", G, seed=k + 20, rough=0.4, sub=1), 0.55)
        return
    box(K, "PHDoor", -5.98, -5.02, 0.36, 2.38, z0 + 0.12, z0 + 0.16, "osDoor", 0.6)
    for k, wx in enumerate((-8.2, -4.9)):
        box(K, f"PHGlass{k}", wx - 0.38, wx + 0.38, 1.42, 2.28, z0 + 0.14, z0 + 0.17, "osGlass", 0.6, 0)
        box(K, f"PHSill{k}", wx - 0.48, wx + 0.48, 1.32, 1.4, z0 - 0.08, z0 + 0.1, "osConcrete", 0.6)
    # the roof: a sheet laid a little forward (to the front), its overhang
    if not dmg:
        hull(K, "PHRoof", [(xx, yy, zz) for xx in (x0 - 0.3, x1 + 0.3) for (yy, zz) in ((h + 0.35, z1 + 0.3), (h + 0.43, z1 + 0.3), (h + 0.05, z0 - 0.4), (h + 0.13, z0 - 0.4))], "osRoof", 0.62)
    else:   # half its sheets blown off
        hull(K, "PHRoof", [(xx, yy, zz) for xx in (x0 - 0.3, -6.2) for (yy, zz) in ((h + 0.35, z1 + 0.3), (h + 0.43, z1 + 0.3), (h + 0.05, z0 - 0.4), (h + 0.13, z0 - 0.4))], "osRoof", 0.62)
    rod(K, "Stack", (-4.6, h - 0.5, -1.2), (-4.6, h + 2.4, -1.2), 0.11, "osPipe", 0.63, 10)

def hull(K, nm, pts, mat, t):
    bm = bmesh.new(); vs = [bm.verts.new(B(*p)) for p in pts]
    bmesh.ops.convex_hull(bm, input=vs)
    for v in [v for v in bm.verts if not v.link_faces]: bm.verts.remove(v)
    return tag(K.obj(nm, bm, mat, G), t)

def manifold(K, R, state):
    """THE MANIFOLD: the tanks' outlets into a header along the front, to the pump house and out east as the pipeline,
    on saddles; a valve on each outlet and on the line out; the meter box."""
    Y = 0.55; zH = -1.4
    ruin, dmg = state == "ruin", state != "intact"
    for i, (x, z, r, h) in enumerate(TANKS):
        rod(K, f"Riser{i}", (x, Y, z - r - 0.9), (x, Y, zH), 0.14, "osPipe", 0.7, 12)
        saddle(K, f"SadR{i}", x, z - r - 1.6 if z - r - 1.6 > zH + 0.3 else zH + 0.5, Y - 0.14, 0.68, "z")
        valve(K, f"VOut{i}", x, Y, zH + 0.9, 0.74)
    # the header along the front: from the pump house's wall to the pipeline's start
    segs = [(-4.0, -1.2), (-1.2, 6.0), (6.0, 11.0)]
    for k, (a, b) in enumerate(segs):
        if (dmg and k == 2) or (ruin and k == 1): continue        # broken off
        rod(K, f"Header{k}", (a, Y, zH), (b, Y, zH), 0.16, "osPipe", 0.72, 12)
    if dmg:   # the broken end, bent down, a dark pool of oil under it
        rod(K, "HeaderBroken", (6.0, Y, zH), (7.4, 0.12, zH - 0.3), 0.16, "osPipe", 0.72, 12)
    for k, sx in enumerate((-3.0, 0.8, 4.0, 8.0, 10.4)):
        saddle(K, f"SadH{k}", sx, zH, Y - 0.16, 0.66)
    if not ruin: valve(K, "VLine", 9.0, Y, zH, 0.75)
    # the meter box on its legs
    box(K, "Meter", 2.2, 3.0, 0.9, 1.6, zH - 0.95, zH - 0.55, "osPipePaint", 0.78, 0.01)
    for sx in (2.3, 2.9): rod(K, f"MeterLeg{sx}", (sx, -0.1, zH - 0.75), (sx, 0.92, zH - 0.75), 0.03, "osPipe", 0.78, 5)

def stores(K, R, state):
    """Spare pipes stacked on timbers, drums by the pump house."""
    ruin = state == "ruin"
    for k in range(2): box(K, f"Bearer{k}", 11.2 + k * 2.6, 11.5 + k * 2.6, -0.1, 0.18, -6.2, -3.4, "osChar" if ruin else "osDoor", 0.85)
    n = 0
    for row, ys in enumerate((0.33, 0.6)):
        for k in range(4 - row):
            zc = -5.7 + k * 0.32 + row * 0.16
            rod(K, f"Spare{n}", (10.6, ys, zc), (14.6, ys, zc), 0.15, "osChar" if ruin else "osPipePaint", 0.88, 12); n += 1
    for k in range(5):
        x, z = -9.6 + (k % 3) * 0.7, -6.0 - (k // 3) * 0.7
        mk = make(K, 0.9)
        if ruin:
            props.place(props.drum(mk, f"Drum{k}", "osChar", "drumSteel", low=LOW(), burnt=True, seed=k, dent=0.4), (x + R.uniform(-0.6, 0.6), 0.29, z + R.uniform(-0.6, 0.6)), R.uniform(0, 6), math.pi / 2 if k % 2 else 0.0)
        elif state == "damaged" and k == 2:
            props.place(props.drum(mk, f"Drum{k}", "drumRed", "drumSteel", low=LOW(), seed=k, dent=0.5), (x + 0.6, 0.29, z - 0.4), R.uniform(0, 6), math.pi / 2)
        else:
            props.place(props.drum(mk, f"Drum{k}", "drumOlive" if k % 2 else "drumRed", "drumSteel", low=LOW(), seed=k), (x, 0.0, z), R.uniform(0, 6))

def buildStation(K, name, spec, state, seed, far=False):
    R = random.Random(seed)
    # (THE BUND is the TERRAIN's, not the model's — the map raises it round the tanks, app.raiseBerm: as a mesh it read
    # as beams, then half-pipes, lying on the sand; maps/kantara.js. bund() kept for a lab view without a terrain.)
    for i in range(2): tank(K, random.Random(seed + i), i, state)
    pumpHouse(K, random.Random(seed + 5), state)
    manifold(K, random.Random(seed + 6), state)
    stores(K, random.Random(seed + 7), state)
    bpy.context.view_layer.update()
    drystone.writeBuildOrder(K)

def buildPipe(K, name, spec, state, seed, far=False):
    """A 10 m length of the PIPELINE along X on two saddles, its two flanged joints, a valve marker post at one end."""
    Y = 0.55
    rod(K, "Pipe", (-5.0, Y, 0.0), (5.0, Y, 0.0), 0.16, "osPipe", 0.4, 12)
    for k, x in enumerate((-4.85, 4.85)):
        cyl(K, f"Flange{k}", (x, Y - 0.24, 0.0), 0.24, 0.12, "osPipePaint", 0.45, 16)   # (a short drum on the pipe: a flange read)
    for k, x in enumerate((-2.5, 2.5)): saddle(K, f"Sad{k}", x, 0.0, Y - 0.16, 0.2)
    rod(K, "MarkPost", (-4.4, -0.1, -0.6), (-4.4, 1.2, -0.6), 0.04, "osPipe", 0.6, 6)
    box(K, "MarkPlate", -4.62, -4.18, 0.9, 1.2, -0.66, -0.63, "osValve", 0.62, 0)
    drystone.writeBuildOrder(K)

TYPES = {"pompage": dict(builder=buildStation, autoLod=True, atlas=2048, aoDist=0.8, smoothAngle=40),
         "tuyau": dict(builder=buildPipe, states=["intact"], atlas=512, smoothAngle=40)}   # (668 triangles: one level — simplified, its round pipe read 2 % off at the switch)
exported = buildKit(TYPES, MATDEF, "oilstation.glb", prefix="Oil", seed0=1958, colors=True)
