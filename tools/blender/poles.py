"""THE TELEGRAPH POLE IN BLENDER (2026-10-30, you: "for telegraph poles if you think you could do them better in blender
then go ahead"). The PTT line along the pistes, late 1950s Algeria, as the real poles were built (the old one was a
7-sided cylinder, a box and four little cylinders):

  POLE        a peeled pine trunk ~7 m, tapering, TARRED black up its foot (creosote against rot and termites), grey and
              checked by the weather above (long splits down the grain); its top cut on a slant under a ZINC CAP
  CROSSARM    a squared timber across the top, through-bolted, two flat STEEL BRACES down to the pole
  INSULATORS  four white PORCELAIN insulators (the double-skirted telegraph kind) on bent steel pins — the wires hang
              from their tops: the old piece's four points (rtsAlgeria buildTelegraphPole userData.wires), kept
  FOOT        the stones packed round it when it was set; a small enamel NUMBER PLATE at eye height

One state (felled is the game's: the instance laid over — algPoles setStanding). Real metres (the game x1.3), the line
along x, the crossarm's face toward -Z (the old piece's).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/poles.py -- <out dir> [--quick]

  or: node tools/blenderKit.mjs poles [--quick]

Writes <out>/poles.glb (PolePole_Intact + _Far).
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit, previews
from bkit import B, srgb, dust
import drystone
from drystone import stone

H, ARM_Y = 7.0, 6.55                        # the pole's height, the crossarm's (the old piece's: its wires' anchors)
INS = [-0.62, -0.22, 0.22, 0.62]            # the insulators along the arm (the old piece's)
ARM_Z = 0.13                                # the arm's centre, in front of the pole

# ── Materials ────────────────────────────────────────────────────────────────
def poleWood(nb):
    """The trunk: grey weathered pine checked along the grain, TARRED black up its foot (a ragged edge where the brush
    stopped), a darker band at the ground where it stays damp."""
    grain = nb.noise(14.0, 4, 0.6, stretch=(1, 1, 0.08))                       # (long checks down the trunk)
    c = nb.mix(nb.mr(nb.noise(2.0, 4), 0.35, 0.7), srgb(0x6e6658), srgb(0x8f8676))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(grain, 0.6, 0.7), 0.7), c, srgb(0x3f3a33))
    tar = nb.mr(nb.math("ADD", nb.gy, nb.math("MULTIPLY", nb.noise(3.0, 3), 0.25)), 1.75, 1.45)   # (0 above ~1.6 m, 1 below)
    c = nb.mix(tar, c, nb.mix(nb.noise(6.0, 3), srgb(0x17140f), srgb(0x2a241d)))
    return dust(nb, c, 0.6, 0.6)
def armWood(nb):
    c = nb.mix(nb.noise(10.0, 4, 0.6, stretch=(0.1, 1, 1)), srgb(0x5d5446), srgb(0x7e735f))
    return dust(nb, c, 0.2, 0.2)
def porcelain(nb):   # (glazed white, dust and soot in its skirts)
    return nb.mix(nb.mr(nb.noise(8.0, 3), 0.55, 0.7), srgb(0xe8e6df), srgb(0x9c9a92))
def zinc(nb):
    return nb.mix(nb.noise(6.0, 4), srgb(0x77797a), srgb(0x9a9c9b))
def steel(nb):   # (the braces and pins: galvanised gone dull, rust at the bolts)
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.5, 0.7), srgb(0x55575a), srgb(0x6e4a32))
def enamel(nb):   # (the PTT number plate: blue enamel, chipped)
    return nb.mix(nb.mr(nb.noise(20.0, 3), 0.62, 0.7), srgb(0x2c4a7a), srgb(0xd8d4c8))
MATDEF = dict(house.MATDEF)
MATDEF.update({"poleWood": (0.9, poleWood), "armWood": (0.9, armWood), "porcelain": (0.25, porcelain), "zinc": (0.5, zinc),
               "poleSteel": (0.6, steel), "enamel": (0.4, enamel), "footRock": (0.95, drystone.stoneMat(0xb8a080))})

def lathe(K, nm, prof, c, mat, n=14):
    """A turned shape: the profile [(r, y)] spun round the vertical through c (x, y, z); its ends closed."""
    bm = bmesh.new(); rings = []
    for r, y in prof:
        rings.append([bm.verts.new(B(c[0] + r * math.cos(2 * math.pi * i / n), c[1] + y, c[2] + r * math.sin(2 * math.pi * i / n))) for i in range(n)] if r > 1e-4 else [bm.verts.new(B(c[0], c[1] + y, c[2]))])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            if len(a) == 1: bm.faces.new((a[0], b[j], b[i]))
            elif len(b) == 1: bm.faces.new((a[i], a[j], b[0]))
            else: bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, "h", smooth=True)

def buildPole(K, name, spec, state, seed):
    R = random.Random(seed); G = "h"
    # THE TRUNK: tapering, its top rounded under the zinc cap
    # (one straight taper: rings at 0, 2 and 4.5 m left neighbouring faces all but one plane — the coplanar gate)
    prof = [(0.0, -0.6), (0.125, -0.6), (0.088, H - 0.12), (0.082, H), (0.0, H + 0.04)]
    lathe(K, "Trunk", prof, (0.0, 0.0, 0.0), "poleWood", n=12)
    lathe(K, "Cap", [(0.0, H - 0.03), (0.098, H - 0.03), (0.098, H + 0.0), (0.06, H + 0.07), (0.0, H + 0.1)], (0.0, 0.0, 0.0), "zinc", n=12)
    # THE CROSSARM: squared timber, through-bolted; its two braces
    arm = K.box("Arm", -0.8, 0.8, ARM_Y - 0.05, ARM_Y + 0.05, ARM_Z - 0.05, ARM_Z + 0.05, "armWood", G, 0.012)
    K.rod("Bolt", (0.0, ARM_Y, -0.1), (0.0, ARM_Y, ARM_Z + 0.08), 0.012, "poleSteel", G, 6)
    for s in (-1, 1):
        K.member(f"Brace{s}", (0.0, ARM_Y - 0.62, 0.095), (s * 0.48, ARM_Y - 0.06, ARM_Z), [(-0.018, -0.004), (0.018, -0.004), (0.018, 0.004), (-0.018, 0.004)], "poleSteel", G)
    K.rod("BraceBolt", (0.0, ARM_Y - 0.62, -0.1), (0.0, ARM_Y - 0.62, 0.11), 0.011, "poleSteel", G, 6)
    # THE INSULATORS: a bent steel pin up from the arm, the double-skirted porcelain on it — its top at ARM_Y + 0.2
    for k, x in enumerate(INS):
        K.rod(f"Pin{k}", (x, ARM_Y + 0.04, ARM_Z), (x, ARM_Y + 0.1, ARM_Z), 0.011, "poleSteel", G, 6)
        lathe(K, f"Ins{k}", [(0.0, 0.0), (0.05, 0.0), (0.052, 0.02), (0.034, 0.035), (0.042, 0.06), (0.044, 0.075), (0.03, 0.09), (0.026, 0.11),
                             (0.03, 0.125), (0.022, 0.135), (0.024, 0.145), (0.0, 0.15)], (x, ARM_Y + 0.05, ARM_Z), "porcelain", n=12)
    # THE NUMBER PLATE at eye height, toward the piste (-Z)
    K.box("Plate", -0.06, 0.06, 2.15, 2.24, -0.13, -0.115, "enamel", G, 0.003)
    # THE FOOT: stones packed round it, half sunk
    for k in range(7):
        a = k / 7 * 6.283 + R.uniform(-0.3, 0.3); r = R.uniform(0.2, 0.3)
        stone(K, f"Foot{k}", (math.cos(a) * r, R.uniform(-0.04, 0.02), math.sin(a) * r), (R.uniform(0.1, 0.15), R.uniform(0.06, 0.09), R.uniform(0.08, 0.12)), R, 0.0, "footRock", box=0.55)

TYPES = {"pole": dict(builder=buildPole, atlas=512, states=["intact"], farRatio=0.85,   # (0.6: the far folded the long trunk into slivers — the gate)
                        aoDist=0.3, smoothAngle=40, weighted=False)}

exported = buildKit(TYPES, MATDEF, "poles.glb", prefix="Pole", seed0=1962)
previews(TYPES, exported, prefix="Pole", tag="poles_", spacing=3, frame=0.8)
print("DONE")
