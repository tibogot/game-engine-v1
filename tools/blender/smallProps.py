"""THE SMALL PROPS IN BLENDER (2026-10-22 — you: "the grenade … if we keep it don't you think we need to make one"):
the hand-held kit of the HUD's icons (and, later, close-ups in the game), built and baked like the buildings so the
icons are one set. Today:

  GRENADE   the F1 defensive grenade the French army carried (1950s): a cast-iron ovoid cut into 48 raised blocks
            (8 columns × 6 rings), olive paint worn off the blocks' edges to the iron, the brass fuze body on top, its
            steel collar, the spoon-shaped lever down the side hugging the body, the split pin through the fuze and
            its pull ring.

Real metres (tiny: 9 cm); the props are not scaled by the kit's 1.3 — houseMesh(type, state, 1).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/smallProps.py -- <out dir> [--quick]

Writes <out>/smallprops.glb (Prop<Type>_<State> + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
import house
from house import buildKit
from bkit import B, srgb
import drystone
from drystone import tag
import milprops

def paintWorn(base, metal):
    """Olive paint over iron: worn through where the "wear" attribute is high (the blocks' edges), a little rust in
    the grooves (low), dirt."""
    def f(nb):
        at = nb.N.new("ShaderNodeAttribute"); at.attribute_name = "wear"
        sep = nb.N.new("ShaderNodeSeparateColor"); nb.L.new(at.outputs["Color"], sep.inputs[0])
        w, groove = sep.outputs["Red"], sep.outputs["Green"]
        paint = nb.mix(nb.noise(60.0, 4), srgb(base), tuple(v * 0.82 for v in srgb(base)))
        chip = nb.math("MULTIPLY", nb.mr(w, 0.55, 0.9, 0.0, 1.0), nb.mr(nb.noise(220.0, 3), 0.42, 0.6, 0.0, 1.0))
        c = nb.mix(chip, paint, nb.mix(nb.noise(300.0, 2), srgb(metal), tuple(v * 0.7 for v in srgb(metal))))
        c = nb.mix(nb.math("MULTIPLY", groove, 0.55), c, srgb(0x3a2a1c))
        return nb.mix(nb.mr(nb.noise(25.0, 5), 0.58, 0.72, 0.0, 0.25), c, srgb(0x5a4a36))
    return f
def flatC(rgb, n=0.85):
    return lambda nb: nb.mix(nb.noise(120.0, 3), srgb(rgb), tuple(v * n for v in srgb(rgb)))
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "spBody": (0.55, paintWorn(0x4d5536, 0x6e6c66)), "spBrass": (0.32, flatC(0xb38a46, 0.8)),
    "spSteel": (0.38, flatC(0x8e8d86, 0.8)), "spDark": (0.45, flatC(0x2e2f2b, 0.85)),
})
LOW = lambda: drystone.LOW

H0, H1 = -0.045, 0.045           # the body's foot and top (m)
def bodyR(y):
    t = (y - H0) / (H1 - H0)
    return 0.0275 * max(0.0, math.sin(math.pi * min(1.0, max(0.0, t)))) ** 0.7

def body(K):
    """The ovoid as rings of verts; the GROOVES between 8 columns and 6 rings pressed in; "wear" (R: how near a
    block's edge, G: in a groove) written per vertex."""
    nu, nv = (96, 72) if not LOW() else (24, 18)
    bm = bmesh.new(); rings = []; wear = {}
    for j in range(nv + 1):
        y = H0 + (H1 - H0) * j / nv
        r = bodyR(y)
        ring = []
        for i in range(nu):
            a = 2 * math.pi * i / nu
            ru = (j / nv) * 6.0                                   # 6 rings of blocks over the height
            cu = (a / (2 * math.pi)) * 8.0                        # 8 columns round
            dv, du = abs(ru - round(ru)), abs(cu - round(cu))     # distance to a groove (0 on it, 0.5 at a block's centre)
            g = min(dv, du)
            k = 1.0 if g > 0.09 else 0.86 + 0.14 * (g / 0.09)     # the groove's depth
            if j in (0, nv) or not (0.06 < j / nv < 0.94): k = 1.0
            v = bm.verts.new(B(r * k * math.cos(a), y, r * k * math.sin(a)))
            wear[v] = (max(0.0, 1.0 - g / 0.2), 1.0 if k < 0.95 else 0.0)
            ring.append(v)
        rings.append(ring)
    for j in range(nv):
        for i in range(nu):
            i2 = (i + 1) % nu
            bm.faces.new((rings[j][i], rings[j][i2], rings[j + 1][i2], rings[j + 1][i]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    vals = [wear.get(v, (0.0, 0.0)) for v in bm.verts]
    o = K.obj("Body", bm, "spBody", "h", smooth=True)
    a = o.data.color_attributes.new("wear", "FLOAT_COLOR", "POINT")
    for d, (w, g) in zip(a.data, vals): d.color = (w, g, 0.0, 1.0)
    return tag(o, 0.5)

def rod(K, nm, a, b, r, mat, n=12):
    return tag(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(5, n // 2)), 0.5)
def cyl(K, nm, y0, y1, r0, r1, mat, n=24):
    return tag(K.cyl(nm, (0, y0, 0), r0, y1 - y0, mat, "h", n if not LOW() else max(8, n // 3), r2=r1, w=0.0006), 0.5)

def buildGrenade(K, *a, far=False):
    drystone.setLow(K, far)
    body(K)
    # the fuze: its collar on the body's neck, the brass body, the striker's cap
    cyl(K, "Collar", H1 - 0.004, H1 + 0.002, 0.0105, 0.0105, "spSteel")
    cyl(K, "Fuze", H1 + 0.002, H1 + 0.024, 0.0085, 0.0075, "spBrass")
    cyl(K, "Cap", H1 + 0.024, H1 + 0.029, 0.0062, 0.005, "spDark")
    # THE LEVER (the spoon): from over the fuze, out and down the body's side 3 mm off it, to below its middle
    pts = []
    for k in range(14):
        y = H1 + 0.026 - (H1 + 0.026 - (-0.008)) * k / 13
        x = max(0.0095, bodyR(min(y, H1)) + 0.0032) if y < H1 + 0.004 else 0.004 + 0.0055 * (H1 + 0.026 - y) / 0.022
        pts.append((x, y))
    bm = bmesh.new(); prev = None; hw = 0.0045
    for x, y in pts:
        a = bm.verts.new(B(x, y, -hw)); b = bm.verts.new(B(x, y, hw))
        if prev: bm.faces.new((prev[0], prev[1], b, a))
        prev = (a, b)
    lever = K.obj("Lever", bm, "spSteel", "h", smooth=True)
    so = lever.modifiers.new("S", "SOLIDIFY"); so.thickness = 0.0012; so.offset = 0
    tag(lever, 0.5)
    # the pin through the fuze (across, x = 0) and its ring, hanging toward the viewer\x27s side
    rod(K, "Pin", (-0.002, H1 + 0.016, -0.012), (-0.002, H1 + 0.016, 0.012), 0.0009, "spSteel", 6)
    n = 28 if not LOW() else 10
    ring = [(-0.002 + 0.0115 * math.cos(2 * math.pi * k / n) * 0.35, H1 + 0.016 - 0.0115 + 0.0115 * math.sin(2 * math.pi * k / n), -0.0125 - 0.0115 * (1 + math.cos(2 * math.pi * k / n)) * 0.47) for k in range(n)]
    for k in range(n): rod(K, f"Ring{k}", ring[k], ring[(k + 1) % n], 0.0011, "spSteel", 6)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

# ── THE ABILITIES' KIT (2026-10-22): each a few dozen parts, baked like the grenade ────────────────────────────────────
def T(o, t=0.5): return tag(o, t)
def box(K, nm, x0, x1, y0, y1, z0, z1, mat, w=0.002): return T(K.box(nm, x0, x1, y0, y1, z0, z1, mat, "h", w if not LOW() else 0))
def lathe(K, nm, prof, mat, n=32, at=(0, 0, 0), smooth=True):
    """A turned part: prof [(radius, height)…] from the foot up, closed at both ends."""
    if LOW(): n = max(8, n // 3)
    bm = bmesh.new()
    rings = [[bm.verts.new(B(at[0] + r * math.cos(2 * math.pi * i / n), at[1] + h, at[2] + r * math.sin(2 * math.pi * i / n))) for i in range(n)] for r, h in prof]
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n; bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(list(reversed(rings[0]))); bm.faces.new(rings[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return T(K.obj(nm, bm, mat, "h", smooth=smooth))
def rod(K, nm, a, b, r, mat, n=8): return T(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(4, n // 2)))

def buildSmoke(K, *a, far=False):
    """The smoke grenade: an olive canister, its pale band, the lever and ring on top."""
    drystone.setLow(K, far)
    lathe(K, "Can", [(0.0, 0.0), (0.029, 0.0), (0.031, 0.004), (0.031, 0.118), (0.029, 0.122), (0.0, 0.122)], "spOlive", 40)
    lathe(K, "Band", [(0.0315, 0.074), (0.0315, 0.096)], "spPale", 40)
    lathe(K, "Fuze", [(0.0, 0.122), (0.011, 0.122), (0.011, 0.142), (0.008, 0.146), (0.0, 0.146)], "spSteel", 24)
    for k in range(10):
        y0, y1 = 0.142 - k * 0.011, 0.142 - (k + 1) * 0.011
        x0 = 0.013 if y0 > 0.122 else 0.0345; x1 = 0.013 if y1 > 0.122 else 0.0345
        rod(K, f"Lever{k}", (x0, y0, 0), (x1, y1, 0), 0.0028, "spSteel", 6)
    n = 20 if not LOW() else 8
    pts = [(-0.004 + 0.009 * math.cos(2 * math.pi * k / n) * 0.3, 0.134 + 0.009 * math.sin(2 * math.pi * k / n), -0.016 - 0.009 * (1 + math.cos(2 * math.pi * k / n)) * 0.5) for k in range(n)]
    for k in range(n): rod(K, f"Ring{k}", pts[k], pts[(k + 1) % n], 0.0009, "spSteel", 5)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildFlare(K, *a, far=False):
    """The flare pistol (the 25 mm signal pistol): a fat short barrel on its frame, the hammer, the trigger in its
    guard, the wooden grip raked back, a lanyard ring."""
    drystone.setLow(K, far)
    rod(K, "Barrel", (0, 0.105, -0.17), (0, 0.105, 0.04), 0.017, "spDark", 24)
    rod(K, "Bore", (0, 0.105, -0.172), (0, 0.105, -0.16), 0.013, "spBlack", 24)
    box(K, "Frame", -0.012, 0.012, 0.08, 0.124, 0.02, 0.09, "spDark")
    box(K, "Hammer", -0.004, 0.004, 0.118, 0.14, 0.075, 0.095, "spSteel")
    bm = bmesh.new(); vs = []
    for (zz, yy) in [(0.03, 0.095), (0.09, 0.095), (0.12, 0.0), (0.075, -0.005)]:
        for xx in (-0.016, 0.016): vs.append(bm.verts.new(B(xx, yy, zz)))
    bmesh.ops.convex_hull(bm, input=vs)
    T(K.bevel(K.obj("Grip", bm, "spWood", "h"), 0.004 if not LOW() else 0, 2, 40))
    n = 14 if not LOW() else 6
    gp = [(0, 0.08 - 0.03 * math.sin(math.pi * k / n), 0.02 + 0.055 * k / n) for k in range(n + 1)]
    for k in range(n): rod(K, f"Guard{k}", gp[k], gp[k + 1], 0.0022, "spDark", 5)
    rod(K, "Trigger", (0, 0.08, 0.045), (0, 0.06, 0.052), 0.003, "spSteel", 6)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildCutters(K, *a, far=False):
    """The wire cutters: two long handles in red-brown grips, the heavy jaws, the pivot bolt."""
    drystone.setLow(K, far)
    for s in (-1, 1):
        rod(K, f"Handle{s}", (s * 0.012, 0.0, 0.06), (s * 0.05, 0.0, 0.42), 0.0085, "spSteel", 12)
        rod(K, f"Grip{s}", (s * 0.03, 0.0, 0.24), (s * 0.052, 0.0, 0.43), 0.0125, "spRed", 14)
        box(K, f"Jaw{s}", min(0, s * 0.02), max(0, s * 0.02), -0.008, 0.008, -0.07, 0.06, "spSteel", 0.003)
    rod(K, "Bolt", (0, -0.012, 0.03), (0, 0.012, 0.03), 0.009, "spDark", 16)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildMine(K, *a, far=False):
    """An anti-personnel pressure mine: a squat cast body, its fuze and three prongs."""
    drystone.setLow(K, far)
    lathe(K, "Body", [(0.0, 0.0), (0.05, 0.0), (0.055, 0.008), (0.055, 0.042), (0.048, 0.05), (0.0, 0.05)], "spOlive", 40)
    lathe(K, "Fuze", [(0.0, 0.05), (0.012, 0.05), (0.012, 0.072), (0.0, 0.072)], "spBrass", 20)
    for k in range(3):
        a = k / 3 * 2 * math.pi
        rod(K, f"Prong{k}", (0.004 * math.cos(a), 0.072, 0.004 * math.sin(a)), (0.012 * math.cos(a), 0.092, 0.012 * math.sin(a)), 0.0018, "spSteel", 5)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildHelmet(K, *a, far=False):
    """The French M51 helmet: a rounded shell over a flared brim, olive, its chin strap hanging."""
    drystone.setLow(K, far)
    prof = [(0.0, 0.17)] + [(0.13 * math.sin(math.radians(t)), 0.035 + 0.135 * math.cos(math.radians(t))) for t in range(10, 91, 8)] + [(0.142, 0.022), (0.152, 0.012), (0.148, 0.004)]
    lathe(K, "Shell", prof, "spOlive", 48)
    n = 16 if not LOW() else 6
    ang = [math.pi * 0.85 + (math.pi * 0.3) * k / n for k in range(n + 1)]
    pts = [(0.13 * math.cos(a), 0.03 - 0.05 * math.sin(math.pi * k / n), 0.13 * math.sin(a)) for k, a in enumerate(ang)]
    for k in range(n): rod(K, f"Strap{k}", pts[k], pts[k + 1], 0.004, "spLeather", 5)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildKepi(K, *a, far=False):
    """The officer's kepi (the HQ's rank): the crown, the black visor, the gold braid and the chin cord."""
    drystone.setLow(K, far)
    lathe(K, "Crown", [(0.0, 0.0), (0.095, 0.0), (0.095, 0.04), (0.087, 0.11), (0.084, 0.12), (0.0, 0.12)], "spKepi", 40)
    lathe(K, "Band", [(0.0965, 0.0), (0.0965, 0.042)], "spBlueBlack", 40)
    for k in range(3): lathe(K, f"Braid{k}", [(0.097 - k * 0.003, 0.05 + k * 0.022), (0.095 - k * 0.003, 0.056 + k * 0.022)], "spGold", 40)
    bm = bmesh.new(); n = 16; vs = []
    for i in range(n + 1):
        a = math.pi * 1.15 + (math.pi * 0.7) * i / n
        vs.append((bm.verts.new(B(0.095 * math.cos(a), 0.005, 0.095 * math.sin(a))), bm.verts.new(B(0.15 * math.cos(a), -0.012, 0.15 * math.sin(a)))))
    for i in range(n): bm.faces.new((vs[i][0], vs[i + 1][0], vs[i + 1][1], vs[i][1]))
    v = K.obj("Visor", bm, "spBlack", "h", smooth=True); so = v.modifiers.new("S", "SOLIDIFY"); so.thickness = 0.004; T(v)
    rod(K, "Cord", (-0.096, 0.02, -0.01), (0.096, 0.02, -0.01), 0.0025, "spGold", 6)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildJerrycan(K, *a, far=False):
    """The 20 l jerrycan: its pressed X on each flank, the three handles, the spout's cap."""
    drystone.setLow(K, far)
    box(K, "Can", -0.085, 0.085, 0.0, 0.47, -0.17, 0.17, "spOlive", 0.012)
    for s in (-1, 1):
        for d in (-1, 1):
            rod(K, f"X{s}{d}", (s * 0.087, 0.06, d * 0.14), (s * 0.087, 0.38, -d * 0.14), 0.006, "spOlive", 6)
    for k, z in enumerate((-0.07, 0.0, 0.07)):
        rod(K, f"Handle{k}", (-0.04, 0.47, z), (-0.04, 0.52, z), 0.007, "spOlive", 8)
        rod(K, f"HandleT{k}", (-0.04, 0.52, z), (0.04, 0.52, z), 0.007, "spOlive", 8)
    lathe(K, "Cap", [(0.0, 0.47), (0.022, 0.47), (0.022, 0.5), (0.0, 0.5)], "spSteel", 20, at=(0.045, 0, -0.12))
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildAmmoBox(K, *a, far=False):
    """An open ammunition crate full of brass: planks, rows of rounds."""
    drystone.setLow(K, far)
    W, D, H = 0.42, 0.26, 0.16
    box(K, "Bottom", -W / 2, W / 2, 0.0, 0.015, -D / 2, D / 2, "spCrate")
    for s in (-1, 1):
        box(K, f"Side{s}", -W / 2, W / 2, 0.0, H, s * D / 2 - 0.009, s * D / 2 + 0.009, "spCrate")
        box(K, f"End{s}", s * W / 2 - 0.012, s * W / 2 + 0.012, 0.0, H, -D / 2, D / 2, "spCrate")
    nx, nz = (9, 5) if not LOW() else (5, 3)
    for i in range(nx):
        for j in range(nz):
            x, z = -W / 2 + 0.03 + (W - 0.06) * i / (nx - 1), -D / 2 + 0.03 + (D - 0.06) * j / (nz - 1)
            T(K.cyl(f"Case{i}_{j}", (x, 0.09, z), 0.011, 0.055, "spBrass", "h", 10 if not LOW() else 6, w=0))
            T(K.cyl(f"Ball{i}_{j}", (x, 0.145, z), 0.0075, 0.02, "spCopper", "h", 10 if not LOW() else 6, r2=0.002, w=0))
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildDetonator(K, *a, far=False):
    """The plunger detonator: a wooden box, its T-handle up on the rod, two brass terminals, the wires out."""
    drystone.setLow(K, far)
    box(K, "Box", -0.08, 0.08, 0.0, 0.16, -0.06, 0.06, "spCrate", 0.004)
    rod(K, "Rod", (0, 0.16, 0), (0, 0.27, 0), 0.006, "spSteel", 10)
    rod(K, "Handle", (-0.08, 0.27, 0), (0.08, 0.27, 0), 0.012, "spWood", 12)
    for s in (-1, 1):
        lathe(K, f"Term{s}", [(0.0, 0.16), (0.009, 0.16), (0.009, 0.178), (0.0, 0.178)], "spBrass", 14, at=(s * 0.05, 0, 0.035))
        pts = [(s * 0.05, 0.172, 0.035), (s * 0.06, 0.13, 0.11), (s * 0.03, 0.01, 0.2), (s * -0.02, 0.005, 0.32)]
        for k in range(3): rod(K, f"Wire{s}{k}", pts[k], pts[k + 1], 0.003, "spRed" if s > 0 else "spBlack", 5)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

def buildDetector(K, *a, far=False):
    """The mine detector: the round search head on its arm, the pole, the grip, the amplifier box."""
    drystone.setLow(K, far)
    lathe(K, "Head", [(0.0, 0.0), (0.14, 0.0), (0.145, 0.012), (0.14, 0.024), (0.0, 0.024)], "spOlive", 40)
    rod(K, "Arm", (0, 0.024, 0.0), (0, 0.06, 0.06), 0.008, "spSteel", 8)
    rod(K, "Pole", (0, 0.06, 0.06), (0, 0.55, 0.62), 0.011, "spSteel", 10)
    rod(K, "Grip", (0, 0.5, 0.56), (0, 0.6, 0.68), 0.016, "spBlack", 12)
    box(K, "Amp", -0.04, 0.04, 0.3, 0.38, 0.33, 0.43, "spOlive", 0.004)
    drystone.writeBuildOrder(K); drystone.setLow(K, False)

PROPS = {"grenade": buildGrenade, "smoke": buildSmoke, "flare": buildFlare, "cutters": buildCutters, "mine": buildMine,
         "helmet": buildHelmet, "kepi": buildKepi, "jerrycan": buildJerrycan, "ammobox": buildAmmoBox,
         "detonator": buildDetonator, "detector": buildDetector}
MATDEF.update({
    "spOlive": (0.55, paintWorn(0x4d5536, 0x6e6c66)), "spPale": (0.7, flatC(0xc9c2a4)), "spBlack": (0.5, flatC(0x161614)),
    "spRed": (0.6, flatC(0x7a2a1e)), "spWood": (0.7, flatC(0x6a4628, 0.75)), "spCrate": (0.8, milprops.timberMat(0x6a6a4c)),
    "spLeather": (0.7, flatC(0x4a3424)), "spKepi": (0.75, flatC(0x6b6a50)), "spBlueBlack": (0.6, flatC(0x1c2230)),
    "spGold": (0.3, flatC(0xc9a24a, 0.75)), "spCopper": (0.3, flatC(0xa8643a, 0.8)),
})
def _near(f): return lambda K, n, s, st, sd: f(K, far=False)
def _far(f): return lambda K, n, s, st, sd: f(K, far=True)
TYPES = {k: dict(builder=_near(f), farBuilder=_far(f), atlas=1024 if k == "grenade" else 512, aoDist=0.01, smoothAngle=60,
                 weighted=False, normals=True, normalAtlas=1024 if k == "grenade" else 512, states=["intact"]) for k, f in PROPS.items()}
exported = buildKit(TYPES, MATDEF, "smallprops.glb", prefix="Prop", seed0=1940, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 700, 700
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far") or not o.name.endswith("_Intact"): continue
    o.hide_render = False
    cd.lens = 50; cam.location = B(0.5, 0.35, -0.9)
    cam.rotation_euler = (B(0, 0.005, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
