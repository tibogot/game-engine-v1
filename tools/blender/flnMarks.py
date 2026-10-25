"""THE FLN'S MARKS IN BLENDER (2026-10-25, you, in the lab: the mine marker "looks very cheap, same for the FLN lookout —
we should make way better"). Two small pieces of the maquis, in the sangar's dry stone (drystone.py: split limestone
blocks, the scanned surface, the close-up detail):

  LOOKOUT    a watcher's perch on a spur (rtsAlgeria buildLookout's place and size): a dry-stone parapet in a C,
             waist-high, open at the back; a seat stone inside, a flat ledge at the front to lean on; a brush shade
             on four forked poles; the watcher's few things — a goatskin water bag (guerba) on a pole, a folded
             blanket on the seat, a clay jar in the shade.
                DAMAGED  the shade fallen in (poles leaning, brush on the ground), the parapet's front breached
                RUIN     the parapet down to a scatter of stones, charred poles
  MINEMARK   where the ALN laid a mine (rtsAlgeria buildMineMarker's place and size): a patch of turned earth, the
             three-stone cairn its fighters marked their own mines with, knee-high, and a dry thorn branch stuck in
             the mound — the cairn alone vanished at play zoom.
                DAMAGED  the cairn knocked over, the branch down
                RUIN     the mine gone off: a scorched crater, the stones thrown

  BUILD ORDER (COLOR_0): the stones course by course, the poles, the brush, the things last (algSangar's site material).

Real metres (the game ×1.3); the lookout's front (the view) at -Z, as the old piece.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/flnMarks.py -- <out dir> [--quick]

Writes <out>/flnmarks.glb (MarkLookout_*, MarkMinemark_* — Intact / Damaged / Ruin + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy
from mathutils import Vector
import house
from house import buildKit
from bkit import B, srgb, dust, flat, wood
import drystone
from drystone import stone, tag

def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    c = nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
    return dust(nb, c, 0.3, 0.3)
def earth(nb):   # (turned earth: darker and moister than the ground round it — the tell of a fresh hole)
    c = nb.mix(nb.noise(2.5, 5), srgb(0x7a5c40), srgb(0x5a4430))
    return nb.mix(nb.mr(nb.noise(12.0, 4), 0.58, 0.68), c, srgb(0x4a3828))
def skin(nb):    # the goatskin: brown leather, its hair worn in patches
    c = nb.mix(nb.noise(6.0, 4), srgb(0x6a4a30), srgb(0x4a3020))
    return dust(nb, c, 0.3, 0.5)
def blanket(nb): # a striped wool blanket (the Aurès' red and black)
    s = nb.mr(nb.noise(1.5, 2), 0.45, 0.55)
    return dust(nb, nb.mix(s, srgb(0x6a2a22), srgb(0x2a2220)), 0.4, 0.6)
MATDEF = dict(house.MATDEF)
MATDEF.update(drystone.STONE_MATS)
MATDEF.update({
    "fmEarth": (1.0, earth), "fmPole": (0.9, wood(0x8a7a62)), "fmCharred": (0.95, charred),
    "fmSkin": (0.8, skin), "fmBlanket": (0.95, blanket), "fmJar": (0.9, flat(srgb(0xa8644a), 0.3)),
    "fmDark": (1.0, flat(srgb(0x15120f), 0.0)),
})

# ── THE LOOKOUT ─────────────────────────────────────────────────────────────────
LR = 1.25          # the parapet's radius
LH = 0.78          # its height (waist-high, seated: the shoulders over it)
OPEN = (0.3, 0.3)  # the back's gap: from +z, ±0.3 of a turn's half (the watcher climbs in from behind)

def parapet(K, R, state):
    """The C of dry stone, course by course; damaged: the front breached; ruin: a ring of scattered stones."""
    top = LH if state != "ruin" else 0.0
    k, c, y = 0, 0, 0.0
    a0, a1 = math.pi / 2 + OPEN[0] * math.pi, math.pi / 2 + (2 - OPEN[1]) * math.pi   # (the gap at +z)
    while y < top - 0.05:
        ch = R.uniform(0.2, 0.26)
        circ = (a1 - a0) * LR
        s = 0.04 if c % 2 else 0.2
        while s < circ - 0.05:
            w = R.uniform(0.32, 0.5)
            a = a0 + (s + w / 2) / LR
            s += w + R.uniform(0.0, 0.02)
            front = abs(math.atan2(math.sin(a + math.pi / 2), math.cos(a + math.pi / 2))) < 0.55   # (toward -z)
            if state == "damaged" and front and c >= 1: continue
            x, z = math.cos(a) * LR, math.sin(a) * LR
            stone(K, f"P{k}", (x, y + ch / 2, z), (w * 0.55, ch * 0.62, 0.26 * R.uniform(0.9, 1.1)), R, 0.12 + 0.5 * (c + s / circ) / 4, yaw=-a + math.pi / 2)
            k += 1
        y += ch * 0.9
        c += 1
    if state == "ruin" or state == "damaged":   # thrown stones
        for i in range(20 if state == "ruin" else 7):
            a, r = R.uniform(0, 6.283), LR + R.uniform(-0.3, 1.1)
            if state == "damaged": a = -math.pi / 2 + R.uniform(-0.6, 0.6)
            s_ = R.uniform(0.13, 0.24)
            stone(K, f"Ps{i}", (math.cos(a) * r, s_ * 0.45, math.sin(a) * r), (s_ * 1.3, s_ * 0.55, s_), R, 0.2)
    if state != "ruin":
        # the ledge at the front, flat, to lean on and rest the rifle; the seat stone inside, at the back
        if state == "damaged":   # (the front breached: the ledge fell with it — at full height it hung over the gap)
            stone(K, "Ledge", (0.25, 0.05, -LR - 0.55), (0.36, 0.05, 0.2), R, 0.62, "sgCap", yaw=0.6)
        else:
            stone(K, "Ledge", (0, y + 0.01, -LR), (0.36, 0.05, 0.2), R, 0.62, "sgCap", yaw=0)
        stone(K, "Seat", (0, 0.13, 0.3), (0.3, 0.13, 0.22), R, 0.1, "sgCap", yaw=0.1)

def shade(K, R, state):
    """Four forked poles, two rails, brush laid across — higher at the front (the view out under it)."""
    posts = [(-0.95, -0.55, 1.95), (0.95, -0.55, 1.95), (-0.95, 0.85, 1.6), (0.95, 0.85, 1.6)]
    if state == "ruin":
        for i in range(5):
            a = (R.uniform(-1.4, 1.4), 0.05, R.uniform(-1.2, 1.2)); d = R.uniform(0, 6.283)
            tag(K.rod(f"Pole{i}", a, (a[0] + math.cos(d) * 1.3, 0.07, a[2] + math.sin(d) * 1.3), 0.04, "fmCharred", "h", n=6), 0.7)
        return
    fallen = state == "damaged"
    tops = []
    for i, (x, z, h) in enumerate(posts):
        if fallen and i < 2:   # the front posts knocked, leaning back into the ring
            top = (x * 0.8, h * 0.55, z + 1.0)
        else:
            top = (x + R.uniform(-0.04, 0.04), h, z + R.uniform(-0.03, 0.03))
        tag(K.rod(f"Post{i}", (x, -0.1, z), top, 0.045, "fmPole", "h", n=6), 0.68)
        # its fork: two short tines at the top (the rail sits in it)
        for s in (-1, 1):
            tag(K.rod(f"Fork{i}{s}", top, (top[0] + s * 0.08, top[1] + 0.16, top[2]), 0.025, "fmPole", "h", n=5), 0.69)
        tops.append(top)
    # the rails, front and back, across the forks
    for j, (a, b) in enumerate(((tops[0], tops[1]), (tops[2], tops[3]))):
        tag(K.rod(f"Rail{j}", (a[0] - 0.2, a[1] + 0.06, a[2]), (b[0] + 0.2, b[1] + 0.06, b[2]), 0.04, "fmPole", "h", n=6), 0.72)
    # THE BRUSH: overlapping clumps of cut brush laid along the rails, each at the rails' height where it lies (high at
    # the front, low at the back) — a shade of brush is a tangle; slats with gaps read as a pergola (the first try)
    nx, nz = 4, 3   # (the far level the SAME clumps: a coarser set shades another shape — glbLodShadingCheck)
    for ix in range(nx):
        for iz in range(nz):
            u, v = ix / (nx - 1), iz / (nz - 1)
            x, z = -0.95 + 1.9 * u + R.uniform(-0.08, 0.08), -0.62 + 1.55 * v + R.uniform(-0.06, 0.06)
            if fallen:
                y = 0.15 + R.uniform(0, 0.12); x, z = x * 0.8, z * 0.7 + 0.2
            else:
                y = tops[0][1] + (tops[2][1] - tops[0][1]) * v + 0.16
            # (whole clumps — flatten 50: no flat underside; flat ones at the same height lay in one plane, z-fighting)
            tag(K.lump(f"Brush{ix}{iz}", (x, y + R.uniform(-0.03, 0.03), z), (0.42, 0.13, 0.4), "sgBrush", "h",
                       seed=40 + ix * 7 + iz, rough=0.55, sub=2, flatten=50.0), 0.8 + 0.004 * (ix * nz + iz))
    # a few branches sticking out at its front and back edges (the tangle's ends)
    for i in range(10 if not drystone.LOW else 0):   # (the far level's saving: the branches and twigs)
        side = -1 if i % 2 else 1
        x = -1.0 + 2.0 * (i // 2) / 4 + R.uniform(-0.1, 0.1)
        z0 = -0.6 if side > 0 else 0.85
        y0 = (tops[0][1] if side > 0 else tops[2][1]) + 0.15
        if fallen: y0 = 0.25
        a = (x, y0, z0); b = (x + R.uniform(-0.2, 0.2), y0 + R.uniform(-0.12, 0.08), z0 - side * R.uniform(0.3, 0.5))
        tag(K.rod(f"Br{i}", a, b, 0.018, "sgBrush", "h", n=3), 0.86)

def things(K, R, state):
    """The watcher's things: the guerba hanging on the back-right post, the blanket on the seat, the jar."""
    if state == "ruin": return
    if state == "intact":
        tag(K.lump("Guerba", (0.98, 1.05, 0.85), (0.16, 0.24, 0.13), "fmSkin", "h", seed=11, rough=0.15, sub=2, flatten=0.0), 0.95)
        tag(K.rod("GuerbaCord", (0.96, 1.28, 0.85), (0.95, 1.5, 0.85), 0.008, "fmPole", "h", n=4), 0.95)
        tag(K.box("Blanket", -0.25, 0.25, 0.4, 0.46, 0.18, 0.52, "fmBlanket", "h", 0.02), 0.96)
    else:
        tag(K.lump("Guerba", (0.6, 0.12, 0.3), (0.2, 0.1, 0.16), "fmSkin", "h", seed=11, rough=0.15, sub=2, flatten=0.4), 0.95)
    tag(K.cyl("Jar", (-0.75, 0.0, 0.55), 0.14, 0.36, "fmJar", "h", 10, 0.08), 0.94)   # (one shape at both levels)

def buildLookout(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    parapet(K, random.Random(seed + 1), state)
    shade(K, random.Random(seed + 2), state)
    things(K, random.Random(seed + 3), state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

# ── THE MINE MARKER ─────────────────────────────────────────────────────────────
MX, MZ = 0.75, 0.35   # the cairn, beside the mound (the old piece's place)

def buildMinemark(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    if state == "ruin":   # gone off: a scorched crater, the cairn's stones thrown
        # (the scorch OVER the thrown earth — under it, the rim hid it: a dirt patch, not a blast)
        tag(K.lump("Rim", (0.0, -0.08, 0.0), (1.3, 0.12, 1.15), "fmEarth", "h", seed=8, rough=0.35, sub=2, flatten=0.0), 0.04)
        tag(K.lump("Crater", (0.0, -0.02, 0.0), (0.85, 0.09, 0.75), "fmCharred", "h", seed=7, rough=0.3, sub=2, flatten=0.0), 0.05)
        for i in range(6):
            a, r = R.uniform(0, 6.283), R.uniform(1.2, 2.3)
            s_ = R.uniform(0.14, 0.24)
            stone(K, f"Thrown{i}", (math.cos(a) * r, s_ * 0.4, math.sin(a) * r), (s_ * 1.3, s_ * 0.55, s_), R, 0.1)
    else:
        # the turned earth: a low, lumpy patch, darker than the ground
        tag(K.lump("Mound", (0.0, 0.0, 0.0), (0.7, 0.2, 0.55), "fmEarth", "h", seed=5, rough=0.45, sub=2, flatten=0.0), 0.05)
        for i in range(5):   # clods thrown out of the hole (the far level the same: a lump is cheap, another shape shades apart)
            a, r = R.uniform(0, 6.283), R.uniform(0.75, 1.05)
            tag(K.lump(f"Clod{i}", (math.cos(a) * r, 0.02, math.sin(a) * r * 0.8), (0.1, 0.06, 0.08), "fmEarth", "h", seed=30 + i, rough=0.4, sub=1, flatten=0.0), 0.06)
        if state == "intact":
            # the cairn: three stones stacked knee-high, the biggest at the foot
            for i, (w, h, d, y) in enumerate(((0.5, 0.28, 0.42, 0.14), (0.4, 0.24, 0.34, 0.38), (0.28, 0.2, 0.24, 0.58))):
                stone(K, f"Cairn{i}", (MX + R.uniform(-0.03, 0.03), y, MZ + R.uniform(-0.03, 0.03)), (w * 0.55, h * 0.55, d * 0.55), R, 0.3 + 0.2 * i, "sgCap" if i == 2 else "sgStone", yaw=R.uniform(0, 3))
            # the thorn branch stuck in the mound, leaning: its twigs
            base, tip = Vector((-0.2, 0.0, -0.1)), Vector((-0.45, 1.05, 0.05))
            tag(K.rod("Branch", tuple(base), tuple(tip), 0.022, "fmPole", "h", n=5), 0.9)
            if not drystone.LOW:
                for j in range(5):   # (leaning up and out, as a cut thorn's side shoots — straight across read as an aerial)
                    m = base.lerp(tip, R.uniform(0.35, 0.95))
                    d = Vector((R.uniform(-0.16, 0.16), R.uniform(0.12, 0.26), R.uniform(-0.16, 0.16)))
                    tag(K.rod(f"Thorn{j}", tuple(m), tuple(m + d), 0.009, "sgBrush", "h", n=3), 0.92)
        else:   # knocked over: the cairn's stones about, the branch down
            for i in range(3):
                s_ = (0.5, 0.4, 0.28)[i]
                stone(K, f"Cairn{i}", (MX + R.uniform(-0.6, 0.6), s_ * 0.22, MZ + R.uniform(-0.4, 0.6)), (s_ * 0.55, s_ * 0.3, s_ * 0.45), R, 0.4, yaw=R.uniform(0, 3))
            tag(K.rod("Branch", (-0.6, 0.03, 0.2), (0.3, 0.05, -0.4), 0.022, "fmPole", "h", n=5), 0.9)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farLookout = lambda K, name, spec, state, seed: buildLookout(K, name, spec, state, seed, far=True)
farMinemark = lambda K, name, spec, state, seed: buildMinemark(K, name, spec, state, seed, far=True)
COMMON = dict(atlas=1024, normalAtlas=512, aoDist=0.3, smoothAngle=45, weighted=False, normals=True)
TYPES = {
    # (its far level DECIMATED from the near — kit.far, the houses' way: the far builder's half-outline stones shaded 4.3 %
    # off the near, over the gate's 4)
    "lookout": dict(builder=buildLookout, farRatio=0.5, **COMMON),
    "minemark": dict(builder=buildMinemark, farBuilder=farMinemark, **COMMON),
}

exported = buildKit(TYPES, MATDEF, "flnmarks.glb", prefix="Mark", seed0=1998, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1000, 700
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cd.lens = 40; cam.location = B(-1.5, 4.0, -5.5); cam.rotation_euler = (B(0, 0.5, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
