"""THE FARMSTEAD IN BLENDER (2026-10-25, you, in the lab: the farm "looks cheap", its burnt version "very cheap" — "do the
farmstead"). The Aurès' lone farm, as the old kit laid it (rtsAlgVillage buildFarmstead — ONE fixed layout now, FARM
below, the same numbers there: its cover, its navigation and its yard's spots match this model):

  THE HOUSE   along the back, one storey of the farmers' brown stone, a low earth parapet (no crenels), the joists'
              ends, a plank door, small windows, hay and pots on the roof (house.py's build, its `plain` parapet)
  THE BYRE    down the left side, lower, its wide door toward the yard
  THE YARD    a stone wall with an earth cap from the byre round to the house, a timber gate (one leaf open)
  THE PEN     out to the right: the zeriba's ring of cut thorn (you prefer it to the Blender branch ring)
  THE THINGS  NOT in the model: the oven, hay, woodpile, jars and the pen's trough are the village props kit, dressed
              by the game on the yard's spots (algPenProps) — every farm the same optimised props
  STATES      INTACT · DAMAGED (shelled: the walls breached, rubble) · RUIN = BURNT (the burnt farm of the map: the walls
              standing and blackened, the roofs burnt away, charred beams fallen in, ash, the gate and half the fence gone)

Real metres (the game ×1.3); the yard's gate toward -Z (the camera's side).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/farmstead.py -- <out dir> [--quick]

Writes <out>/farmstead.glb (FarmFarm_Intact / _Damaged / _Ruin + _Far) — then tools/optimizeGlb.mjs --etc1s.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy
from mathutils import Matrix
import house
from house import buildKit
from bkit import B, srgb, wood

# THE LAYOUT — the same numbers as rtsAlgVillage buildFarmstead (FARM): change both together
W, D, H, PAR = 8.2, 5.0, 2.9, 3.35                    # the house's width, depth, roof, parapet
HX, HZ = 0.6, 3.2                                      # its centre (its front, the door, at -Z)
BW, BD, BH, BPAR = 5.5, 3.8, 2.2, 2.55                 # the byre (its length along z)
BX, BZ = -W / 2 - BD / 2 - 0.2, -1.4                   # its centre
YX0, YX1, YZ, GATE = -W / 2 + 0.2, W / 2 + 1.2, -5.6, 1.3   # the yard wall's corners, the gate's centre
PX, PZ, PR = YX1 + 6.5, -1.5, 3.6                      # the pen

def sooted(nb):
    """The stone blackened by the fire: soot in patches, heaviest up the walls (where the roof burnt)."""
    # (an even darkening, soft wide patches over it — small sharp blotches read as camouflage, seen in the lab)
    c = nb.mix(0.55, house.stone(nb), srgb(0x2a241e))
    return nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(0.8, 2), 0.4, 0.75), 0.5), c, srgb(0x141110))
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
def ash(nb):
    return nb.mix(nb.noise(4.0, 4), srgb(0x5e5a54), srgb(0x2e2a26))
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "stoneBurnt": (0.95, sooted), "fsCharred": (0.95, charred), "fsAsh": (1.0, ash),
    "penWood": (0.92, wood(0x8a8272)), "capEarth": (1.0, house.MATDEF["earth"][1]),
})

def house_spec(burnt):
    rend = "stoneBurnt" if burnt else "stone"
    return dict(render=rend, shutter="shutterBlue", door=(-0.55, 0.55, "woodDark"), plain=True,
                main=(-W / 2, W / 2, -D / 2, D / 2), floors=[], roof=H, par=PAR,
                wins=[("f", -3.0, -2.2, 1.0, 1.8, "shut"), ("f", 2.0, 2.8, 1.0, 1.8, "void"), ("b", -1.2, -0.5, 1.5, 2.1, "void"), ("l", -0.6, 0.2, 1.0, 1.7, "void")],
                dmg=[((2.4, 1.5, -D / 2), (0.85, 0.85, 0.7)), ((W / 2, 1.3, 0.6), (0.6, 0.9, 0.9))],
                ruin=(1.6, 0.8), life=[] if burnt else ["hay", "pottery"], ground=[])
def byre_spec(burnt):
    rend = "stoneBurnt" if burnt else "stone"
    return dict(render=rend, shutter="shutterBlue", door=(-1.0, 1.0, "woodDark"), plain=True,
                main=(-BW / 2, BW / 2, -BD / 2, BD / 2), floors=[], roof=BH, par=BPAR,
                wins=[("b", -0.4, 0.3, 1.3, 1.8, "void")],
                dmg=[((1.6, 1.2, -BD / 2), (0.7, 0.8, 0.6))], ruin=(1.2, 0.6), life=[] if burnt else ["hay"], ground=[])

def building(K, spec, state, seed, x, z, yaw):
    """One house.py building in its OWN group (its booleans cut only itself), its modifiers applied, then carried to
    (x, z) turned by yaw (the game's rotation.y), a stone socle under it for a slope."""
    outer = K.groups["h"]; K.groups["h"] = []
    house.build(K, "farm", spec, "damaged" if state == "ruin" else state, seed)
    X0, X1, Z0, Z1 = spec["main"]
    K.box("Socle", X0 - 0.05, X1 + 0.05, -0.8, 0.03, Z0 - 0.05, Z1 + 0.05, spec["render"], "h", 0)
    made = K.groups["h"]; K.groups["h"] = outer
    if state == "ruin":   # (the sills and steps sooted too: pale stone read new in a burnt shell)
        for o in made:
            for i, m in enumerate(o.data.materials):
                if m and m.name in ("sill", "capEarth", "earth"): o.data.materials[i] = K.mat("stoneBurnt")
    if state == "ruin":   # BURNT: the roof, its joists and the doors burnt away (the doorways left dark)
        gone = ("Roof", "Joist", "Door", "Lintel", "W0Sh", "W0Op", "RubHeap", "Rub", "Hay", "Pot", "Jar", "Basket", "Mat")
        for o in list(made):
            if o.name.startswith(gone):
                made.remove(o); bpy.data.objects.remove(o, do_unlink=True)
    M = Matrix.Translation(B(x, 0, z)) @ Matrix.Rotation(yaw, 4, "Z")
    for o in made:
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
        o.matrix_world = M @ o.matrix_world
        outer.append(o)
    return made

def burnt_inside(K, R, x0, x1, z0, z1, h, cx, cz, yaw):
    """Charred beams fallen across the room, an ash heap, a few against the walls (piece-local, then turned)."""
    c, s = math.cos(yaw), math.sin(yaw)
    P = lambda lx, y, lz: (cx + lx * c + lz * s, y, cz - lx * s + lz * c)
    for k in range(5):
        lx = x0 + 0.8 + (x1 - x0 - 1.6) * k / 4
        a = P(lx + R.uniform(-0.3, 0.3), h - R.uniform(0.2, 0.9), z1 - 0.5)
        b = P(lx + R.uniform(-0.6, 0.6), 0.1, z0 + R.uniform(0.8, 1.8))
        K.rod(f"Beam{cx:.0f}{k}", a, b, 0.07, "fsCharred", "h", 6)
    K.lump(f"Ash{cx:.0f}", P((x0 + x1) / 2, 0.0, (z0 + z1) / 2), ((x1 - x0) * 0.33, 0.35, (z1 - z0) * 0.33), "fsAsh", "h", seed=int(abs(cx) * 10) + 3, rough=0.45)

def yard(K, R, state):
    """The yard wall (stone, an earth cap), round from the byre's corner to the house; the timber gate."""
    pts = [(YX0, YZ), (GATE - 1.3, YZ), None, (GATE + 1.3, YZ), (YX1, YZ), (YX1, HZ - D / 2 - 0.3)]
    T = 0.5
    cap = "stoneBurnt" if state == "ruin" else "capEarth"   # (burnt: the caps sooted too — pale, they read new)
    for k in range(len(pts) - 1):
        a, b = pts[k], pts[k + 1]
        if not a or not b: continue
        L = math.hypot(b[0] - a[0], b[1] - a[1]); n = max(1, round(L / 2.2))
        for i in range(n):
            u0, u1 = i / n, (i + 1) / n
            x0, z0 = a[0] + (b[0] - a[0]) * u0, a[1] + (b[1] - a[1]) * u0
            x1, z1 = a[0] + (b[0] - a[0]) * u1, a[1] + (b[1] - a[1]) * u1
            h = 1.25 + R.uniform(-0.08, 0.06)
            if state == "damaged" and k == 3 and i == 1: h = 0.45   # (a shell took the wall by the pen)
            # (every second segment 2 cm thicker: neighbours' sides never in one plane; the caps not past a segment's
            # ends — overrunning they overlapped their neighbour's, a z-fight at the far level)
            t = T / 2 + 0.01 * (i % 2)
            if abs(x1 - x0) > abs(z1 - z0):
                lo, hi = min(x0, x1), max(x0, x1)
                K.bevel(K.box(f"Yard{k}{i}", lo, hi, -0.5, h, z0 - t, z0 + t, "stoneBurnt" if state == "ruin" else "stone", "h", 0), 0.03, 2, 30)
                K.box(f"Cap{k}{i}", lo + 0.01, hi - 0.01, h, h + 0.09, z0 - t - 0.03, z0 + t + 0.03, cap, "h", 0.02)
            else:
                lo, hi = min(z0, z1), max(z0, z1)
                K.bevel(K.box(f"Yard{k}{i}", x0 - t, x0 + t, -0.5, h, lo, hi, "stoneBurnt" if state == "ruin" else "stone", "h", 0), 0.03, 2, 30)
                K.box(f"Cap{k}{i}", x0 - t - 0.03, x0 + t + 0.03, h, h + 0.09, lo + 0.01, hi - 0.01, cap, "h", 0.02)
    if state == "damaged":
        K.lump("YardRubble", (YX1 + 0.3, 0.0, (YZ + HZ - D / 2) / 2), (0.9, 0.35, 0.6), "rubble", "h", seed=17)
    # the gate: two plank leaves between stone posts — one shut, one swung in; burnt: gone
    for sx in (-1, 1):
        K.bevel(K.box(f"GatePost{sx}", GATE + sx * 1.3 - 0.22, GATE + sx * 1.3 + 0.22, -0.5, 1.6, YZ - 0.3, YZ + 0.3, "stoneBurnt" if state == "ruin" else "stone", "h", 0), 0.03, 2, 30)
    if state == "ruin": return
    K.box("GateL", GATE - 1.06, GATE - 0.02, 0.05, 1.45, YZ - 0.03, YZ + 0.03, "woodDark", "h", 0.008)
    leaf = K.box("GateR", 0.0, 1.04, 0.05, 1.45, -0.03, 0.03, "woodDark", "h", 0.008)
    leaf.matrix_world = Matrix.Translation(B(GATE + 1.06, 0, YZ)) @ Matrix.Rotation(math.radians(110), 4, "Z") @ Matrix.Translation(B(-1.04, 0, 0)) @ leaf.matrix_world

def pen(K, R, state, low):
    """The zeriba's fence (rtsAlgVillage zeribaFence, the same recipe): per 55 cm, branches leaning every way and
    branches laid along it; its gap toward -Z. Damaged: a stretch flattened; burnt: half of it gone, the rest charred."""
    n = round(2 * math.pi * PR / 0.55)
    for k in range(n):
        a = k / n * 2 * math.pi
        if abs(math.atan2(math.sin(a + math.pi / 2), math.cos(a + math.pi / 2))) < 0.2: continue   # the gap
        flat = state == "damaged" and 0.4 < a < 1.3
        if state == "ruin" and R.random() < 0.5: continue
        mat = "fsCharred" if state == "ruin" else "penWood"
        rr = PR + R.uniform(-0.17, 0.17); x, z = PX + math.cos(a) * rr, PZ + math.sin(a) * rr
        tx, tz = -math.sin(a), math.cos(a)
        for q in range(2 if low else 4):
            along, out, up = R.uniform(-0.8, 0.8), R.uniform(-0.45, 0.45), R.uniform(0.5, 1.5)
            if flat: up *= 0.15
            bx, bz = x + tx * R.uniform(-0.2, 0.2), z + tz * R.uniform(-0.2, 0.2)
            K.rod(f"Pen{k}_{q}", (bx, -0.05, bz), (bx + tx * along + math.cos(a) * out, up, bz + tz * along + math.sin(a) * out), R.uniform(0.022, 0.04), mat, "h", 4)
        for hgt in ((0.35, 0.7, 1.05) if not low else (0.5, 0.95)):
            if flat and hgt > 0.4: continue
            l = R.uniform(0.9, 1.5); y1, y2 = hgt + R.uniform(-0.12, 0.12), hgt + R.uniform(-0.17, 0.17)
            K.rod(f"PenL{k}_{hgt}", (x - tx * l / 2, y1, z - tz * l / 2), (x + tx * l / 2, y2, z + tz * l / 2), 0.03, mat, "h", 4)

def buildFarm(K, name, spec, state, seed):
    R = random.Random(seed)
    burnt = state == "ruin"
    building(K, house_spec(burnt), state, seed, HX, HZ, 0.0)
    building(K, byre_spec(burnt), state, seed + 1, BX, BZ, -math.pi / 2)   # (its door toward the yard, +x)
    if burnt:
        burnt_inside(K, R, -W / 2 + 0.45, W / 2 - 0.45, -D / 2 + 0.45, D / 2 - 0.45, H, HX, HZ, 0.0)
        burnt_inside(K, R, -BW / 2 + 0.45, BW / 2 - 0.45, -BD / 2 + 0.45, BD / 2 - 0.45, BH, BX, BZ, -math.pi / 2)
    yard(K, random.Random(seed + 2), state)
    pen(K, random.Random(seed + 3), state, False)

TYPES = {"farm": dict(builder=buildFarm, states=("intact", "damaged", "ruin"), farRatio=0.35, atlas=2048, aoDist=1.2)}

exported = buildKit(TYPES, MATDEF, "farmstead.glb", prefix="Farm", seed0=1970)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1200, 750
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    cd.lens = 32; cam.location = B(4.0, 18.0, -22.0); cam.rotation_euler = (B(2.0, 0.5, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
