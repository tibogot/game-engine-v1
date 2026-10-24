"""THE RUBBLE OF A HOUSE THAT CAME DOWN (2026-10-24 — building damage B, you: "the building damage and collapse … we
already worked on some of them, we should use them"). A town house collapsing (games/alg-rts/algTownDamage.js) swaps
to its ruin model; what was missing is the COLLAPSE — the masonry thrown out of its walls and the heaps it leaves at
their foot (CoH: a ruin is surrounded by its own rubble, soft cover). Built from the houses' own materials (house.py
MATDEF: the plaster, the stone, the rubble, the beams), baked the same way, so a heap sits against its ruin as one.

  HEAPS   three slumped piles — "wide" (3.2 x 2 m, low), "tall" (2.4 x 1.8 m, a snapped beam out of it), "spill"
          (4 m along a wall, 1.4 m out): a mound of rubble earth under split stones and plaster slabs, fallen
          biggest first (the big blocks low, the small on top), a beam or two.
  CHUNKS  four loose pieces (a plaster slab, a stone, a block of wall with its plaster, a beam end) — the debris the
          game throws out of the walls when a house comes down; they land and stay.

Real metres; the game draws the kits at ×1.3. One atlas, near + far (the heaps' far decimated, gated by
tools/glbLodShadingCheck.mjs).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/rubble.py -- <out dir> [--quick]

Writes <out>/rubble.glb (Rubble<Type>_Intact + _Far) — then tools/optimizeGlb.mjs --etc1s.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy
import house
from house import buildKit
import drystone
from drystone import stone, tag

MATDEF = dict(house.MATDEF)
# (the plaster of the heaps: the houses' plain render — the game tints it to the house it fell from)
SLAB, CORE, FILL, BEAM = "renderPlain", "stone", "rubble", "woodDark"

def mound(K, nm, R, cx, cz, ax, az, h, n, t=0.5, beams=0):
    """A heap: a rubble-earth mound (ax, az half extents, h high) under n stones and plaster slabs settled on it."""
    K.lump(nm + "Fill", (cx, h * 0.12, cz), (ax * 0.92, h * 0.78, az * 0.92), FILL, "h", seed=R.randint(0, 999), rough=0.45, sub=3 if not drystone.LOW else 1, flatten=50)   # (sub 2 left big flat facets on the mound; flatten off: its clamped underside folded triangles onto one plane 8 cm up — z-fighting; the lower half sits under the ground)
    surf = lambda x, z: max(0.0, h * (1 - (((x - cx) / ax) ** 2 + ((z - cz) / az) ** 2)))
    picks = sorted(([R.uniform(-1, 1), R.uniform(-1, 1), R.uniform(0.05, 0.2) * (1.3 if R.random() < 0.15 else 1.0)] for _ in range(n)), key=lambda p: -p[2])
    for k, (u, v, s) in enumerate(picks):
        if u * u + v * v > 1: u, v = u * 0.7, v * 0.7
        x, z = cx + u * ax * 0.9, cz + v * az * 0.9
        slab = R.random() < 0.4
        size = (s * 1.4, s * 0.35, s * 1.0) if slab else (s, s * 0.75, s * 0.85)
        y = surf(x, z) + size[1] * 0.4 - s * 0.25                      # half sunk in the heap
        # (+ a jitter: stones clamped to one height had their flat bottoms in one plane — z-fighting)
        stone(K, f"{nm}S{k}", (x, max(size[1] * 0.4, y) + R.uniform(0.004, 0.03), z), size, R, t, mat=SLAB if slab else CORE, box=0.4 if slab else 0.3)   # (angular: broken masonry, not pebbles)
    for b in range(beams):   # a snapped beam out of the heap, one end in the rubble, the other up
        a = R.uniform(0, 6.283); L = R.uniform(0.9, 1.5)
        x0, z0 = cx + math.cos(a) * ax * 0.2, cz + math.sin(a) * az * 0.2
        x1, z1 = x0 + math.cos(a + 0.4) * L, z0 + math.sin(a + 0.4) * L
        tag(K.rod(f"{nm}Beam{b}", (x0, surf(x0, z0) * 0.6, z0), (x1, R.uniform(0.15, 0.5), z1), 0.07, BEAM, "h", n=6), t)

def heap(kind):
    def f(K, tname, spec, state, seed):
        R = random.Random(seed)
        if kind == "wide": mound(K, "Heap", R, 0, 0, 1.6, 1.0, 0.85, 60, beams=1)
        elif kind == "tall": mound(K, "Heap", R, 0, 0, 1.2, 0.9, 1.15, 52, beams=2)
        else: mound(K, "Heap", R, 0, 0, 2.0, 0.7, 0.65, 64, beams=1)   # spill: long and low along a wall
    return f

def chunk(kind):
    def f(K, tname, spec, state, seed):
        R = random.Random(seed)
        if kind == "slab": stone(K, "C", (0, 0.06, 0), (0.32, 0.06, 0.22), R, 0, mat=SLAB, box=0.6)
        elif kind == "stone": stone(K, "C", (0, 0.13, 0), (0.18, 0.13, 0.15), R, 0, mat=CORE)
        elif kind == "block":   # a lump of wall: stone core with its plaster skin on one face
            stone(K, "C", (0, 0.16, 0), (0.28, 0.16, 0.2), R, 0, mat=CORE)
            stone(K, "P", (0, 0.17, 0.17), (0.27, 0.15, 0.035), R, 0, mat=SLAB, box=0.6)
        else: tag(K.rod("C", (-0.45, 0.07, 0), (0.45, 0.07, 0.04), 0.07, BEAM, "h", n=6), 0)
    return f

TYPES = {
    "wide": dict(builder=heap("wide"), atlas=1024, aoDist=0.35, smoothAngle=30, weighted=False, states=["intact"], farRatio=0.4),
    "tall": dict(builder=heap("tall"), atlas=1024, aoDist=0.35, smoothAngle=30, weighted=False, states=["intact"], farRatio=0.4),
    "spill": dict(builder=heap("spill"), atlas=1024, aoDist=0.35, smoothAngle=30, weighted=False, states=["intact"], farRatio=0.4),
    **{f"chunk{k.capitalize()}": dict(builder=chunk(k), atlas=256, aoDist=0.08, smoothAngle=50, weighted=False, states=["intact"], farRatio=1.0 if k == "beam" else 0.5)   # (a 20-triangle beam: whole)
       for k in ("slab", "stone", "block", "beam")},
}
exported = buildKit(TYPES, MATDEF, "rubble.glb", prefix="Rubble", seed0=2024)

# previews (scratch: the refs folder)
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 600, 450
from bkit import B
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far"): continue
    o.hide_render = False
    big = "Chunk" not in o.name
    cam.location = B(2.6, 2.4, -3.4) if big else B(0.8, 0.7, -1.0)
    cam.rotation_euler = (B(0, 0.3 if big else 0.08, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
