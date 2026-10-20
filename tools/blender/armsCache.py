"""THE ARMS CACHE IN BLENDER (2026-10-21, the asset pass: "the small buildables"). The ALN's cache as the old piece
planned it (rtsAlgeria buildArmsCache): a MATMORA — the Aurès' underground grain pit, stone-lined, its flat lid stone
slid aside, the crates brought up — beside a GOURBI, the guard's dry-stone hut roofed with poles, brush and earth.
The same stone as the sangar (drystone.py: split limestone blocks, the scanned surface, the close-up detail).

    INTACT    the hut whole, the pit open, crates and sacks up, three rifles stacked in a tripod, a water jar
    DAMAGED   shelled: the roof fallen in (poles down inside, the earth gone), the front corner breached, the crates
              thrown about, the rifles down
    RUIN      blown up: the hut down to a low ring of scattered stones, charred poles, the pit a blackened crater,
              burnt crates

  BUILD ORDER  the pit's ring, the hut's courses one by one, the lintel, the roof poles, the brush, the earth, then the
               crates, sacks and rifles brought up (COLOR_0 — algSangar.js's site material reveals them in order)

Real metres (the game ×1.3); the hut's door toward -Z (the camera's side, as the old piece).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/armsCache.py -- <out dir> [--quick]

Writes <out>/armscache.glb (CacheArms_Intact … _Ruin + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
import house
from house import buildKit
from bkit import B, srgb, dust, flat, wood
import drystone
from drystone import stone, tag

# the hut (gourbi): its centre, outer size, wall height and thickness, the door on its front (-z) side
GX, GZ, GW, GD, GH, GT = -1.6, 1.2, 3.2, 2.6, 1.55, 0.55
DOOR = (GX - 0.45, GX + 0.45)
# the pit (matmora)
MX, MZ, MR = 1.9, -0.9, 0.62

def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    c = nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
    return dust(nb, c, 0.3, 0.3)
def earth(nb):
    c = nb.mix(nb.noise(2.5, 5), srgb(0x8a6c4e), srgb(0x66503a))           # packed earth (pale + dust read as a disc)
    c = nb.mix(nb.mr(nb.noise(12.0, 4), 0.58, 0.68), c, srgb(0x55432f))     # clods
    return c
def burlap(nb):
    c = nb.mix(1.0, nb.img("build/hessian_230/hessian_230_diff_1k.jpg", 2.2), srgb(0xd8c49c), "MULTIPLY")
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.8, 1.12)), 0.5, 0.9)
MATDEF = dict(house.MATDEF)
MATDEF.update(drystone.STONE_MATS)
MATDEF.update({
    "acDark": (1.0, flat(srgb(0x15120f), 0.0)), "acEarth": (1.0, earth), "acPole": (0.9, wood(0x8a7a62)),
    "acCrate": (0.85, wood(0x76704e)), "acBurlap": (0.95, burlap), "acCharred": (0.95, charred),
    "acSteel": (0.5, flat(srgb(0x2a2b2a), 0.0)), "acStock": (0.8, wood(0x6e4a30)), "acJar": (0.9, flat(srgb(0xa8644a), 0.3)),
})

def segs(state):
    """The hut's wall lines (x0, z0, x1, z1), clockwise from the door's right post; the door a gap in the front."""
    x0, x1, z0, z1 = GX - GW / 2 + GT / 2, GX + GW / 2 - GT / 2, GZ - GD / 2 + GT / 2, GZ + GD / 2 - GT / 2
    return [(DOOR[1], z0, x1, z0), (x1, z0, x1, z1), (x1, z1, x0, z1), (x0, z1, x0, z0), (x0, z0, DOOR[0], z0)]

def hut(K, R, state):
    top = {"intact": GH, "damaged": GH, "ruin": 0.45}[state]
    lines = segs(state)
    total = sum(math.hypot(b - a, d - c) for a, c, b, d in lines)
    y, c, k = 0.0, 0, 0
    while y < top - 0.06:
        ch = R.uniform(0.2, 0.27)
        d = GT / 2 - (y / GH) * 0.06
        run = 0.0
        for si, (ax, az, bx, bz) in enumerate(lines):
            L = math.hypot(bx - ax, bz - az); ux, uz = (bx - ax) / L, (bz - az) / L
            yaw = math.atan2(-uz, ux)
            nx, nz = -uz, ux                                                    # the wall's normal (outward for clockwise)
            for face in (-1, 1):
                s = 0.07 if (c + face) % 2 else 0.0
                while s < L - 0.04:
                    w = R.uniform(0.3, 0.48) if R.random() < 0.8 else R.uniform(0.48, 0.62)
                    sm = min(s + w / 2, L - 0.05)
                    jit = (R.uniform(0.55, 0.66), R.random(), R.uniform(-0.03, 0.03))
                    s += w + R.uniform(0.0, 0.015)
                    x, z = ax + ux * sm, az + uz * sm
                    gone = (state == "damaged" and si == 0 and sm > L - 1.1 and c >= 2) or (state == "ruin" and jit[1] < 0.35)
                    if gone: continue
                    t = 0.16 + 0.52 * (c + (run + sm) / total) / 7
                    stone(K, f"H{k}", (x + nx * face * d * 0.6 + nx * jit[2], y + ch / 2, z + nz * face * d * 0.6 + nz * jit[2]), (w * 0.55, ch * 0.62, d * jit[0]), R, t, yaw=yaw)
                    k += 1
            run += L
        y += ch * 0.9
        c += 1
    if state == "ruin":
        for i in range(26):   # scattered
            a, r = R.uniform(0, 6.283), R.uniform(0.3, 1.4)
            x, z = GX + math.cos(a) * (GW / 2 + r * 0.6), GZ + math.sin(a) * (GD / 2 + r * 0.6)
            s_ = R.uniform(0.12, 0.22)
            stone(K, f"Hs{i}", (x, s_ * 0.45, z), (s_ * 1.3, s_ * 0.55, s_), R, 0.2)
        return y
    # the lintel over the door: one long stone
    stone(K, "Lintel", (GX, top + 0.07, GZ - GD / 2 + GT / 2), (0.75, 0.09, GT * 0.46), R, 0.7, "sgCap", yaw=0)
    # the dark inside (seen through the door)
    tag(K.box("Inside", GX - GW / 2 + GT, GX + GW / 2 - GT, 0.01, 0.03, GZ - GD / 2 + GT, GZ + GD / 2 - GT, "acDark", "h", 0), 0.15)
    return top

def roof(K, R, state, top):
    """Poles across (along x), brush on them, earth over the middle — or, damaged, fallen in; ruin, charred stubs."""
    x0, x1 = GX - GW / 2 + 0.12, GX + GW / 2 - 0.12
    n = 8
    for i in range(n):
        x = x0 + (x1 - x0) * i / (n - 1) + R.uniform(-0.04, 0.04)
        r = R.uniform(0.045, 0.06)
        if state == "intact":
            a, b = (x, top + 0.05, GZ - GD / 2 - 0.25), (x + R.uniform(-0.05, 0.05), top + 0.05, GZ + GD / 2 + 0.25)
            tag(K.rod(f"Pole{i}", a, b, r, "acPole", "h", n=6), 0.72 + 0.06 * i / n)
        elif state == "damaged":
            if R.random() < 0.35:
                a, b = (x, top + 0.05, GZ + GD / 2 + 0.2), (x + R.uniform(-0.3, 0.3), R.uniform(0.15, 0.5), GZ - GD / 2 + R.uniform(0.6, 1.2))
            else:
                a, b = (x, top + 0.05, GZ - GD / 2 - 0.2), (x + R.uniform(-0.2, 0.2), top + 0.05, GZ + GD / 2 + 0.2)
            tag(K.rod(f"Pole{i}", a, b, r, "acPole", "h", n=6), 0.72 + 0.06 * i / n)
        elif R.random() < 0.6:
            a = (x + R.uniform(-0.6, 0.6), 0.06, GZ + R.uniform(-1.4, 1.4))
            d = (R.uniform(-1, 1), 0.02, R.uniform(-1, 1))
            tag(K.rod(f"Pole{i}", a, (a[0] + d[0] * 0.9, a[1] + d[1], a[2] + d[2] * 0.9), r, "acCharred", "h", n=6), 0.72)
    if state != "intact": return
    # brush laid on the poles, sticking out at the EAVES all round (the earth hides the rest)
    hw, hd = GW / 2, GD / 2
    for i in range(18 if not drystone.LOW else 8):
        a = i / (18 if not drystone.LOW else 8) * 6.283 + R.uniform(-0.15, 0.15)
        ex, ez = math.cos(a), math.sin(a)
        k = 1 / max(abs(ex) / hw, abs(ez) / hd)                               # to the roof's edge
        base = Vector((GX + ex * k * 0.78, top + 0.13, GZ + ez * k * 0.78))
        for j in range(6 if not drystone.LOW else 3):
            d = Vector((ex + R.uniform(-0.5, 0.5), R.uniform(-0.12, 0.05), ez + R.uniform(-0.5, 0.5))).normalized()
            tag(K.rod(f"Br{i}_{j}", tuple(base), tuple(base + d * R.uniform(0.45, 0.75)), 0.016 if not drystone.LOW else 0.026, "sgBrush", "h", n=3), 0.82 + 0.004 * i)
    # the EARTH packed over it all: a low dome over the whole roof, lumpy
    tag(K.lump("Earth", (GX, top + 0.1, GZ), (GW / 2 - 0.05, 0.24, GD / 2 - 0.05), "acEarth", "h", seed=3, rough=0.32, sub=3 if not drystone.LOW else 2, flatten=0.0), 0.9)

def pit(K, R, state):
    """The matmora's ring of stones round its dark mouth; the lid slid aside — a crater when blown up."""
    if state == "ruin":
        tag(K.lump("Crater", (MX, -0.06, MZ), (1.0, 0.1, 0.9), "acCharred", "h", seed=7, rough=0.3, sub=2 if not drystone.LOW else 1), 0.05)
        for i in range(8):
            a = R.uniform(0, 6.283); r = MR + R.uniform(0.3, 1.0)
            s_ = R.uniform(0.12, 0.2)
            stone(K, f"Pr{i}", (MX + math.cos(a) * r, s_ * 0.45, MZ + math.sin(a) * r), (s_ * 1.3, s_ * 0.55, s_), R, 0.05)
        return
    tag(K.cyl("Mouth", (MX, -0.03, MZ), MR - 0.05, 0.06, "acDark", "h", 18 if not drystone.LOW else 9, w=0), 0.02)
    n = 11
    for i in range(n):
        a = i / n * 6.283
        stone(K, f"Ring{i}", (MX + math.cos(a) * MR, 0.09, MZ + math.sin(a) * MR), (0.22, 0.12, 0.15), R, 0.03 + 0.1 * i / n, yaw=-a + math.pi / 2)
    # the lid, slid off toward +x, -z (a big flat stone)
    stone(K, "Lid", (MX + 0.95, 0.08, MZ - 0.5), (0.5, 0.07, 0.44), R, 0.14, "sgCap", yaw=0.5)

def crate(K, nm, at, yaw, size, t, mat="acCrate", tilt=0.0):
    x, y, z = size
    o = K.box(nm, -x / 2, x / 2, 0, y, -z / 2, z / 2, mat, "h", 0.01)
    o.rotation_mode = "XYZ"; o.rotation_euler = (tilt, 0, yaw); o.location = B(*at)
    tag(o, t)
    if drystone.LOW or mat == "acCharred": return
    for s in (-1, 1):   # end battens
        b = K.box(nm + f"B{s}", -0.03, 0.03, 0.02, y - 0.02, -z / 2 - 0.012, z / 2 + 0.012, mat, "h", 0.004)
        b.rotation_mode = "XYZ"; b.rotation_euler = (tilt, 0, yaw)
        ox = s * (x / 2 - 0.07)                                             # (Blender's Z turn = three.js rotation.y)
        b.location = B(*at) + Vector((ox * math.cos(yaw), ox * math.sin(yaw), 0))
        tag(b, t)

def rifle(K, nm, foot, top, t, mat="acSteel"):
    tag(K.rod(nm + "Barrel", top, tuple(Vector(foot) + (Vector(top) - Vector(foot)) * 0.45), 0.012, mat, "h", n=5), t)
    tag(K.rod(nm + "Stock", tuple(Vector(foot) + (Vector(top) - Vector(foot)) * 0.45), foot, 0.028, "acStock" if mat == "acSteel" else mat, "h", n=5), t)

def props(K, R, state):
    burnt = state == "ruin"
    # crates brought up from the pit (toward +z of it), sacks beside them
    spots = [(MX - 0.25, MZ + 1.05, 0.3, (0.9, 0.36, 0.5)), (MX - 0.15, MZ + 1.62, 0.22, (0.9, 0.39, 0.5)), (MX + 0.85, MZ + 1.25, -0.4, (0.66, 0.42, 0.46))]
    for i, (x, z, yw, size) in enumerate(spots):
        if state == "intact":
            crate(K, f"Crate{i}", (x, 0, z), yw, size, 0.92 + 0.015 * i, "acBurlap" if i == 2 else "acCrate")
        elif state == "damaged":
            crate(K, f"Crate{i}", (x + R.uniform(-0.4, 0.6), 0, z + R.uniform(0.0, 0.6)), yw + R.uniform(-1, 1), size, 0.92, "acBurlap" if i == 2 else "acCrate", tilt=R.uniform(-0.25, 0.25))
        elif R.random() < 0.7:
            crate(K, f"Crate{i}", (x, 0, z), yw, (size[0], size[1] * 0.4, size[2]), 0.92, "acCharred")
    if state == "intact":
        crate(K, "Crate3", (MX - 0.2, 0.37, MZ + 1.05), 0.5, (0.8, 0.3, 0.46), 0.97)          # one on top
        # three rifles in a tripod, muzzles together
        top = Vector((MX - 1.1, 1.25, MZ - 0.4))
        for i in range(3):
            a = i / 3 * 6.283 + 0.3
            rifle(K, f"Rifle{i}", (top.x + math.cos(a) * 0.42, 0.02, top.z + math.sin(a) * 0.42), (top.x + math.cos(a) * 0.04, top.y, top.z + math.sin(a) * 0.04), 0.98)
        tag(K.cyl("Jar", (GX + GW / 2 + 0.35, 0.0, GZ + GD / 2 - 0.25), 0.16, 0.4, "acJar", "h", 12 if not drystone.LOW else 7, 0.1), 0.96)
    elif state == "damaged":
        for i in range(3):   # the rifles knocked down
            x, z, a = MX - 1.1 + R.uniform(-0.5, 0.5), MZ - 0.4 + R.uniform(-0.5, 0.5), R.uniform(0, 6.283)
            rifle(K, f"Rifle{i}", (x, 0.03, z), (x + math.cos(a) * 1.1, 0.04, z + math.sin(a) * 1.1), 0.98)

def buildCache(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    R = random.Random(seed)
    pit(K, random.Random(seed + 1), state)
    top = hut(K, random.Random(seed + 2), state)
    roof(K, random.Random(seed + 3), state, top)
    props(K, random.Random(seed + 4), state)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farCache = lambda K, name, spec, state, seed: buildCache(K, name, spec, state, seed, far=True)
TYPES = {"arms": dict(builder=buildCache, farBuilder=farCache, atlas=2048, aoDist=0.35, smoothAngle=45, weighted=False, normals=True)}

exported = buildKit(TYPES, MATDEF, "armscache.glb", prefix="Cache", seed0=1959, colors=True)

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
    cd.lens = 40; cam.location = B(-1.0, 7.5, -10.0); cam.rotation_euler = (B(0, 0.6, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
