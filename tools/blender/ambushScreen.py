"""THE AMBUSH SCREEN IN BLENDER (2026-10-21, the asset pass): the ALN's hide beside a track — cut scrub stood up in a
low dry-stone footing between two boulders, 7 m long, gaps to fire through; behind it the men's things. This file
makes the STONE (drystone.py — the sangar's split limestone); the SCRUB is the engine's procedural broom and juniper
(the hedges' lesson: plants from the plant generator, not Blender sticks), stood along the footing by the game
(algSangar.js SCREEN_PLANTS — the same line, SCREEN_LINE below, both sides).

    INTACT    the footing whole, two courses; the boulders; behind: an ammunition box, a water jar, a goatskin
    DAMAGED   the footing's middle knocked apart, its stones thrown forward (the game drops part of the scrub)
    RUIN      the footing scattered (the boulders stay)

  BUILD ORDER  the boulders, the footing course by course along its length, then the things behind (COLOR_0).

Real metres (the game ×1.3); its length along X, the track's side (the front) at -Z, the men behind at +Z.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/ambushScreen.py -- <out dir> [--quick]

Writes <out>/ambushscreen.glb (ScreenAmbush_Intact … _Ruin + _Far) — then tools/optimizeGlb.mjs.
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

L, FH, FD = 3.5, 0.5, 0.5          # half length, footing height and depth
def SCREEN_LINE(x): return 0.22 * math.sin(0.9 * x + 0.7)   # the footing's centre line (algSangar.js: the same)

def leather(nb):
    c = nb.mix(nb.noise(5.0, 4), srgb(0x5a4030), srgb(0x3e2c20))
    return dust(nb, c, 0.4, 0.6)
MATDEF = dict(house.MATDEF)
MATDEF.update(drystone.STONE_MATS)
MATDEF.update({"asBox": (0.7, wood(0x5f6a46)), "asJar": (0.9, flat(srgb(0xa8644a), 0.3)), "asSkin": (0.8, leather)})

def footing(K, R, state):
    k = 0
    y, c = 0.0, 0
    while y < FH - 0.06:
        ch = R.uniform(0.2, 0.26)
        d = FD / 2 - (y / FH) * 0.05
        for face in (-1, 1):
            x = -L + (0.08 if (c + face) % 2 else 0.0)
            while x < L - 0.04:
                w = R.uniform(0.3, 0.48) if R.random() < 0.8 else R.uniform(0.48, 0.6)
                xm = min(x + w / 2, L - 0.05)
                jit = (R.uniform(0.55, 0.66), R.random(), R.uniform(-0.03, 0.03), R.uniform(-1, 1))
                x += w + R.uniform(0.0, 0.015)
                z = SCREEN_LINE(xm)
                dz = 0.198 * math.cos(0.9 * xm + 0.7)                   # the line's slope: the stones turn with it
                yaw = -math.atan(dz)
                if state == "damaged" and abs(xm) < 1.2 and (c >= 1 or jit[1] < 0.5):
                    # thrown forward (to -z), tumbled
                    stone(K, f"T{k}", (xm + jit[3] * 0.4, 0.12, z - R.uniform(0.6, 1.6)), (w * 0.5, ch * 0.55, d * jit[0]), R, 0.3)
                    k += 1; continue
                if state == "ruin" and jit[1] < 0.6:
                    stone(K, f"T{k}", (xm + jit[3] * 0.5, 0.11, z + R.choice((-1, 1)) * R.uniform(0.5, 1.4)), (w * 0.5, ch * 0.55, d * jit[0]), R, 0.3)
                    k += 1; continue
                t = 0.12 + 0.55 * (c + (xm + L) / (2 * L)) / 2
                stone(K, f"F{k}", (xm, y + ch / 2, z + face * d * 0.6 + jit[2]), (w * 0.55, ch * 0.62, d * jit[0]), R, t, yaw=yaw)
                k += 1
        y += ch * 0.9
        c += 1

def boulders(K, R, state):
    """The two rocks the screen runs between (big split blocks, sunk a little)."""
    # (rounded and weathered, sunk a third: the clean split blocks read as dice)
    for i, (x, w, h) in enumerate(((-L - 0.95, 1.1, 0.85), (L + 0.85, 0.95, 0.66))):
        stone(K, f"Boulder{i}", (x, h * 0.55, SCREEN_LINE(x) + 0.1), (w, h, w * 0.85), R, 0.02 + 0.03 * i, box=0.85)
        stone(K, f"BoulderB{i}", (x + (0.6 if i else -0.55), h * 0.25, SCREEN_LINE(x) + 0.55), (w * 0.45, h * 0.4, w * 0.4), R, 0.04, box=0.8)

def things(K, R, state):
    if state == "ruin": return
    o = K.box("Box", -0.2, 0.2, 0, 0.22, -0.13, 0.13, "asBox", "h", 0.01)
    o.rotation_euler.z = 0.5; o.location = B(0.8, 0, 0.95); tag(o, 0.9)
    if state == "intact":
        tag(K.cyl("Jar", (-1.6, 0.0, 0.85), 0.15, 0.36, "asJar", "h", 12 if not drystone.LOW else 7, 0.09), 0.92)
        tag(K.lump("Skin", (-0.9, 0.09, 1.05), (0.28, 0.1, 0.17), "asSkin", "h", seed=5, rough=0.25, sub=2 if not drystone.LOW else 1), 0.94)

def buildScreen(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    boulders(K, random.Random(seed), state)
    footing(K, random.Random(seed + 1), state)
    things(K, random.Random(seed + 2), state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farScreen = lambda K, name, spec, state, seed: buildScreen(K, name, spec, state, seed, far=True)
TYPES = {"ambush": dict(builder=buildScreen, farBuilder=farScreen, atlas=2048, normalAtlas=1024, aoDist=0.3, smoothAngle=45, weighted=False, normals=True)}

exported = buildKit(TYPES, MATDEF, "ambushscreen.glb", prefix="Screen", seed0=1961, colors=True)

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
    cd.lens = 35; cam.location = B(-1.5, 5.0, -8.0); cam.rotation_euler = (B(0, 0.3, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
