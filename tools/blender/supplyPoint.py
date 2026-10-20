"""THE REQUISITION POINT IN BLENDER (2026-10-20, you: "the requisition point doesn't look AAA at all, and it still
uses my old sandbags — we check every asset now"; PIECES_INVENTORY.md "fuel depot, ammo dump: REDO in Blender").
The whole supply point as ONE piece — the mast at the origin, the depot beside it — two kinds, three states:

  MAST      a guyed steel pole of three telescoped sections (collars at the joints), a ball finial, the halyard
            pulley and its line down to a cleat; a concrete footing with its base plate and bolts; three cables
            from 70 % up (turnbuckles near the foot) to steel pickets, each held by a sandbag — fanned BEHIND the
            mast, away from the depot. The game's cloth flag runs up it (algPointFlags.js: 9 m, the top at 8.85)
  FUEL      200-litre drums on a duckboard (rolling hoops, chimes, bungs), two on timber chocks, a hand pump
            and its hose, a stack of jerrycans (the pressed X, three handles), the fire point (red bucket and
            extinguisher), the board "DEPOT ESSENCE" (the default font has no accents)
  MUN       olive-painted ammunition crates on pallets (planks, end battens, rope handles, stencilled lots), a
            canvas tarp draped over one stack, steel ammo boxes, an open crate showing its brass, "MUNITIONS"
  SANDBAGS  the CLOTH-SIMULATED bags (public/models/alg/sandbags.glb, tools/blender/sandbagSim.py) laid in bonded
            courses: an L of blast wall behind and beside the depot
  STATES    INTACT · DAMAGED (shelled: drums down and rolled, the top crates thrown off, the tarp half gone, the
            wall breached, the board leaning) · RUIN (burnt out: charred, ruptured drums, crates down to black
            heaps, the wall scattered) — the mast stands in all three (the point is still a point)

Game frame: x toward the depot (the CAMERA's side — the game turns the piece so), y up; metres as the game (the
field adds it at scale 1). Far level: the same code with every detail switch down (farBuilder), the same atlas.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/supplyPoint.py -- <out dir> [--quick]

Writes <out>/points.glb (PointFuel_Intact … PointMun_Ruin + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector, Matrix, Euler
import house
from house import buildKit, previews
from bkit import B, gv, srgb, dust, flat, wood, paintedWood, ROOT

DX = {"fuel": 4.5, "mun": 4.8}          # the depot's centre on +x (algPointFlags: its footprint's hx + 2.6)
MAST = 9.0
LOW = False                             # the far level: every detail switch down
STENCIL = "C:/Windows/Fonts/ariblk.ttf"  # (a bold face for the painted words; Blender's own if missing)

# ── materials ──────────────────────────────────────────────────────────────────
def steel(base, rusty=0.3, top=0.55):
    def f(nb):
        c = nb.mix(nb.noise(1.5, 4), srgb(base), tuple(v * 0.75 for v in srgb(base)))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(5.0, 7), 0.7 - rusty * 0.12, 0.76 - rusty * 0.1), 0.9), c, srgb(0x6a3d22))
        wear = nb.math("MULTIPLY", nb.mr(nb.point(), 0.52, 0.6), nb.noise(25.0, 3))
        c = nb.mix(nb.math("MULTIPLY", wear, 1.6), c, srgb(0x8a7a66))
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.85, 1.12))
        return dust(nb, c, top, 0.8)
    return f
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    c = nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))       # ash
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(5.0, 6), 0.6, 0.66), 0.8), c, srgb(0x6a3820))   # burnt rust
    return dust(nb, c, 0.3, 0.2)   # (0.6: the burnt boards, 7 cm up, read SANDY — the dust of the ground hid the char)
def burlap(nb):
    c = nb.mix(1.0, nb.img("build/hessian_230/hessian_230_diff_1k.jpg", 2.2), srgb(0xd8c49c), "MULTIPLY")
    c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.78, 1.12))                 # every bag its own sun and age
    return dust(nb, c, 0.5, 0.9)
def canvas(nb):
    c = nb.mix(nb.noise(2.0, 5), srgb(0x5c5e3e), srgb(0x474a30))
    c = nb.mix(nb.mr(nb.noise(6.0, 4), 0.6, 0.7), c, srgb(0x7a7652))        # sun-faded
    return dust(nb, c, 1.4, 0.7)
def crateWood(paint):
    def f(nb):
        w = nb.mix(1.0, nb.img("build/raw_plank_wall/raw_plank_wall_diff_1k.jpg", 1.2), srgb(0xa59784), "MULTIPLY")
        p = nb.mix(nb.noise(3.0, 4), srgb(paint), tuple(v * 0.82 for v in srgb(paint)))
        peel = nb.math("MAXIMUM", nb.mr(nb.noise(6.0, 8, 0.65), 0.66, 0.69), nb.math("MULTIPLY", nb.mr(nb.point(), 0.53, 0.6), nb.noise(20.0, 3)))
        c = nb.mix(peel, p, w)
        c = nb.scale(c, nb.mr(nb.island(), 0, 1, 0.86, 1.1))
        return dust(nb, c, 0.8)
    return f
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "mast": (0.6, steel(0x5d6052, 0.35, 0.6)), "darkSteel": (0.6, steel(0x2f312d, 0.3)), "cable": (0.6, flat(srgb(0x2a2a27), 0.0)),
    "rope": (0.9, flat(srgb(0x9a8a68), 0.0)),
    "concrete": (0.95, flat(srgb(0xa59c8c), 0.4)),
    "drumOlive": (0.7, steel(0x535a3a, 0.5)), "drumBlue": (0.65, steel(0x34495c, 0.45)), "drumRed": (0.7, steel(0x8a3826, 0.6)),
    "jerry": (0.7, steel(0x56603a, 0.25)), "redPaint": (0.6, steel(0xb02a1e, 0.25)), "brass": (0.4, steel(0xb39048, 0.1, 0.2)),
    "ammoBox": (0.6, steel(0x4a5236, 0.3)),
    "crate": (0.85, crateWood(0x56603e)), "crateBare": (0.9, wood(0xb3a184)), "pallet": (0.9, wood(0x9c8b70)),
    "canvas": (0.95, canvas), "burlap": (0.95, burlap), "charred": (0.95, charred),
    "board": (0.85, paintedWood(0x3c4a34)), "paintWhite": (0.8, flat(srgb(0xe6e0cc), 0.0)), "paintYellow": (0.8, flat(srgb(0xd8b04a), 0.0)),
})

# ── geometry helpers (game coordinates) ────────────────────────────────────────
def frame(d):
    d = d.normalized(); up = gv(0, 1, 0) if abs(d.y) < 0.95 else gv(1, 0, 0)
    u = d.cross(up).normalized(); v = u.cross(d).normalized()
    return d, u, v
def cylA(K, nm, a, d, r, h, mat, n=20, r2=None, w=0.006, caps=True):
    """A cylinder from a (game) along d, h long; r2: the far end's radius."""
    if LOW: n = max(6, n // 2)
    a = gv(*a); d, u, v = frame(gv(*d)); rr = r if r2 is None else r2
    bm = bmesh.new()
    rb = [bm.verts.new(B(*(a + (u * math.cos(t) + v * math.sin(t)) * r))) for t in (2 * math.pi * i / n for i in range(n))]
    rt = [bm.verts.new(B(*(a + d * h + (u * math.cos(t) + v * math.sin(t)) * rr))) for t in (2 * math.pi * i / n for i in range(n))]
    for i in range(n):
        j = (i + 1) % n; bm.faces.new((rb[i], rb[j], rt[j], rt[i]))
    if caps: bm.faces.new(rb); bm.faces.new(list(reversed(rt)))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.bevel(K.obj(nm, bm, mat, "h", smooth=True), w, 2, 50)
def torusA(K, nm, c, d, R_, r, mat, n=24, m=6):
    if LOW: return None
    c = gv(*c); d, u, v = frame(gv(*d)); bm = bmesh.new(); grid = []
    for i in range(n):
        t = 2 * math.pi * i / n; rad = u * math.cos(t) + v * math.sin(t)
        grid.append([bm.verts.new(B(*(c + rad * (R_ + r * math.cos(p)) + d * (r * math.sin(p))))) for p in (2 * math.pi * k / m for k in range(m))])
    for i in range(n):
        for k in range(m):
            bm.faces.new((grid[i][k], grid[(i + 1) % n][k], grid[(i + 1) % n][(k + 1) % m], grid[i][(k + 1) % m]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, "h", smooth=True)
def place(o, at, rot=(0, 0, 0)):
    """Move an object built round the origin to `at`, turned by game (pitch about x, yaw about y, roll about z)."""
    if o is None: return None
    o.rotation_mode = "YXZ"
    o.rotation_euler = Euler((rot[0], -rot[2], rot[1]), "YXZ")   # (game y = Blender z, game z = Blender -y)
    o.location = B(*at)
    return o
def rotm(rot): return Euler((rot[0], -rot[2], rot[1]), "YXZ").to_matrix().to_4x4()
def move(parts, at, rot=(0, 0, 0)):
    """Carry parts built round a local origin to `at`, turned by rot — each keeps its own offset and turn."""
    M = Matrix.Translation(B(*at)) @ rotm(rot)
    for p in parts:
        if p is not None: p.matrix_basis = M @ p.matrix_basis
def boxC(K, nm, size, at, rot=(0, 0, 0), mat="crate", w=0.012):
    """A box of size (x, y, z) standing on its bottom centre at `at`."""
    x, y, z = size
    o = K.box(nm, -x / 2, x / 2, 0, y, -z / 2, z / 2, mat, "h", w)
    return place(o, at, rot)
def text(K, nm, body, at, size, mat, yaw=math.pi / 2, depth=0.0):
    """Painted letters standing at `at`, facing +z turned by yaw (pi/2: facing +x, the camera's side)."""
    if LOW: return None
    cu = bpy.data.curves.new(nm, "FONT"); cu.body = body; cu.size = size; cu.extrude = depth / 2
    cu.align_x = "CENTER"; cu.align_y = "CENTER"
    if os.path.exists(STENCIL): cu.font = bpy.data.fonts.load(STENCIL, check_existing=True)
    o = bpy.data.objects.new(nm, cu); bpy.context.scene.collection.objects.link(o)
    o.rotation_euler = (math.radians(90), 0, yaw); o.location = B(*at)
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.view_layer.objects.active
    # FLAT paint, no extrusion, in a BOLD face, triangulated here: Blender's own font lost strokes in the game
    # ("ESSEN E", then "MUN IONS" — the thin straight stems: long collinear outlines that the export triangulated
    # into slivers; extruded, some letters also came out inward)
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="EAR_CLIP")
    bm.to_mesh(o.data); bm.free()
    o.data.materials.clear(); o.data.materials.append(K.mat(mat))
    K.groups["h"].append(o)
    return o

# ── the simulated sandbags ─────────────────────────────────────────────────────
BAGS = None
def bags():
    global BAGS
    if BAGS is None:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, "public", "models", "alg", "sandbags.glb"))
        BAGS = {"ground": [], "valley": []}
        for o in set(bpy.data.objects) - before:
            if o.type != "MESH": continue
            o.location = (0, 0, 0); o.hide_render = True; o.hide_set(True)
            BAGS["valley" if "valley" in o.name else "ground"].append(o)
        for v in BAGS.values(): v.sort(key=lambda o: o.name)
    return BAGS
def bag(K, nm, kind, k, at, yaw=0.0, tilt=(0.0, 0.0), mat="burlap"):
    src = bags()[kind][k % len(bags()[kind])]
    o = src.copy(); o.data = src.data.copy(); o.name = nm
    bpy.context.scene.collection.objects.link(o)
    o.hide_render = False; o.hide_set(False)
    o.data.materials.clear(); o.data.materials.append(K.mat(mat))
    d = o.modifiers.new("D", "DECIMATE"); d.ratio = 0.22 if LOW else 0.6
    K.groups["h"].append(o)
    return place(o, at, (tilt[0], yaw, tilt[1]))
def bagWall(K, R, nm, a, b, courses, gone=None, mat="burlap"):
    """Bonded courses from a to b (game xz): the ground course end to end, each above across the joints.
    gone(t, course) → True: that bag is missing (a breach)."""
    ax, az = a; bx, bz = b
    L = math.hypot(bx - ax, bz - az); ux, uz = (bx - ax) / L, (bz - az) / L
    yaw = math.atan2(-uz, ux)
    n = max(2, round(L / 0.7)); step = L / n
    for c in range(courses):
        m = n if c % 2 == 0 else n - 1
        for i in range(m):
            t = (i + 0.5) * step if c % 2 == 0 else (i + 1) * step
            jit = (R.uniform(-0.04, 0.04), R.uniform(-0.04, 0.04), R.uniform(-0.12, 0.12), R.randrange(6))
            if gone and gone(t / L, c): continue
            x, z = ax + ux * (t + jit[0]), az + uz * (t + jit[0])
            bag(K, f"{nm}{c}_{i}", "ground" if c == 0 else "valley", jit[3], (x - uz * jit[1], 0.155 * c, z + ux * jit[1]), yaw + jit[2])

# ── the mast ───────────────────────────────────────────────────────────────────
def mast(K, R, state):
    boxC(K, "Footing", (0.9, 0.42, 0.9), (0, -0.25, 0), mat="concrete", w=0.03)
    boxC(K, "BasePlate", (0.42, 0.03, 0.42), (0, 0.17, 0), mat="darkSteel", w=0.004)
    if not LOW:
        for sx in (-1, 1):
            for sz in (-1, 1):
                cylA(K, f"Bolt{sx}{sz}", (sx * 0.16, 0.19, sz * 0.16), (0, 1, 0), 0.018, 0.05, "darkSteel", 6, w=0)
    secs = [(0.2, 3.6, 0.085, 0.078), (3.6, 6.6, 0.068, 0.062), (6.6, MAST, 0.052, 0.045)]
    for i, (y0, y1, r0, r1) in enumerate(secs):
        cylA(K, f"Pole{i}", (0, y0, 0), (0, 1, 0), r0, y1 - y0, "mast", 16, r1, w=0)
        if i: cylA(K, f"Collar{i}", (0, y0 - 0.06, 0), (0, 1, 0), secs[i - 1][3] + 0.012, 0.14, "mast", 16, w=0.004)
    cylA(K, "Finial", (0, MAST, 0), (0, 1, 0), 0.07, 0.14, "mast", 12, 0.02, w=0)
    # the halyard: a pulley under the finial, the line down to a cleat at chest height (on the camera's side)
    torusA(K, "Pulley", (0.09, MAST - 0.12, 0), (0, 0, 1), 0.05, 0.015, "darkSteel", 12, 4)
    if not LOW:
        cylA(K, "Halyard", (0.13, MAST - 0.12, 0), (0, -1, 0), 0.005, MAST - 1.4, "rope", 4, w=0, caps=False)
        boxC(K, "Cleat", (0.04, 0.16, 0.05), (0.1, 1.2, 0), mat="darkSteel", w=0.004)
    # the guys: from 70 % up to pickets 3.6 m out, fanned BEHIND the mast (-x)
    top = gv(0, MAST * 0.7, 0)
    for k, ang in enumerate((math.pi - 1.15, math.pi, math.pi + 1.15)):
        foot = gv(math.cos(ang) * 3.6, 0.1, math.sin(ang) * 3.6)
        d = foot - top
        snapped = state == "ruin" and k == 1
        if snapped:   # (one cable cut by the blast: it lies coiled on the ground)
            cylA(K, f"GuyCut{k}", tuple(foot), (0.4, 0, 0.9), 0.009, 2.2, "cable", 4, w=0, caps=False)
        else:
            cylA(K, f"Guy{k}", tuple(top), tuple(d), 0.009 if not LOW else 0.016, d.length - 0.55, "cable", 4, w=0, caps=False)
            tb = top + d.normalized() * (d.length - 0.55)
            cylA(K, f"Buckle{k}", tuple(tb), tuple(d), 0.018, 0.3, "darkSteel", 6, w=0)
            cylA(K, f"GuyLow{k}", tuple(tb + d.normalized() * 0.3), tuple(d), 0.009 if not LOW else 0.016, 0.25, "cable", 4, w=0, caps=False)
        cylA(K, f"Picket{k}", tuple(foot + gv(0, -0.25, 0)), (math.cos(ang) * 0.4, 1, math.sin(ang) * 0.4), 0.02, 0.55, "darkSteel", 6, w=0)
        boxC(K, f"Anchor{k}", (0.32, 0.16, 0.32), tuple(foot + gv(math.cos(ang) * 0.12, -0.1, math.sin(ang) * 0.12)), (0, -ang, 0), "concrete", 0.02)   # (a cast deadman: the bags are the game's walls)
    # a cleared, trampled patch is the game's (a decal); a few loose stones round the footing
    for k in range(4 if not LOW else 0):
        a = R.uniform(0, 6.28)
        K.lump(f"Stone{k}", (math.cos(a) * R.uniform(0.6, 1.0), 0.02, math.sin(a) * R.uniform(0.6, 1.0)), (0.08, 0.05, 0.07), "concrete", "h", seed=k, sub=1)

# ── the fuel depot ─────────────────────────────────────────────────────────────
def drum(K, nm, at, mat, rot=(0, 0, 0), dent=0.0, burnt=False):
    """A 200-litre drum, its base at `at` (rot: tilt it; pi/2 roll = on its side)."""
    m = "charred" if burnt else mat
    parts = [cylA(K, nm, (0, 0.01, 0), (0, 1, 0), 0.29, 0.86 * (1 - dent), m, 24, w=0.01)]
    if not burnt:
        parts += [torusA(K, nm + f"Rim{h}", (0, h, 0), (0, 1, 0), 0.287, 0.012, m, 20, 4) for h in (0.012, 0.87 * (1 - dent))]
        parts += [torusA(K, nm + f"Hoop{h}", (0, h, 0), (0, 1, 0), 0.292, 0.015, m, 20, 4) for h in (0.29, 0.58)]
        if not LOW:
            parts.append(cylA(K, nm + "Bung", (0.17, 0.865 * (1 - dent), 0.05), (0, 1, 0), 0.032, 0.016, "darkSteel", 8, w=0.002))
            parts.append(cylA(K, nm + "Vent", (-0.15, 0.865 * (1 - dent), -0.1), (0, 1, 0), 0.018, 0.012, "darkSteel", 6, w=0))
    else:   # ruptured: the lid torn, a jagged split
        parts.append(cylA(K, nm + "Lip", (0, 0.86 * (1 - dent), 0), (0.3, 1, 0.1), 0.3, 0.06, "charred", 10, 0.34, w=0, caps=False))
    move(parts, at, rot)
def jerry(K, nm, at, yaw, burnt=False):
    m = "charred" if burnt else "jerry"
    parts = [boxC(K, nm, (0.165, 0.47, 0.345), (0, 0, 0), mat=m, w=0.022)]
    if not LOW and not burnt:
        for s in (-1, 1):   # the pressed X on each face
            for a in (0.62, -0.62):
                # (centred on the face: a box turns round its FOOT — pivoted there, the strips poked out over the can;
                # the two strips apart: crossed in one plane they z-fought)
                h = 0.5
                parts.append(boxC(K, nm + f"X{s}{a}", (0.008, h, 0.03), (s * (0.084 + (0.006 if a > 0 else 0)), 0.235 - h / 2 * math.cos(a), -h / 2 * math.sin(a)), (a, 0, 0), m, 0))
        for k in (-0.08, 0, 0.08):
            parts.append(cylA(K, nm + f"H{k}", (0, 0.47, k - 0.0), (0, 1, 0), 0.012, 0.05, m, 6, w=0))
        parts.append(cylA(K, nm + "Cap", (0, 0.47, 0.13), (0, 1, 0.4), 0.022, 0.05, m, 8, w=0))
    move(parts, at, (0, yaw, 0))
def firePoint(K, at, state):
    x, z = at
    if state == "ruin":
        cylA(K, "FireBucket", (x, 0, z), (0.9, 0.3, 0), 0.11, 0.26, "charred", 12, 0.14, w=0)
        return
    cylA(K, "FirePost", (x, 0, z), (0, 1, 0), 0.04, 1.3 if state == "intact" else 1.1, "pallet", 6, w=0)
    cylA(K, "FireBucket", (x + 0.12, 0.62, z), (0, 1, 0), 0.08, 0.26, "redPaint", 14, 0.12, w=0.003)
    cylA(K, "Extinguisher", (x + 0.22, 0.0, z + 0.25), (0, 1, 0), 0.075, 0.55, "redPaint", 12, w=0.01)
    cylA(K, "ExtTop", (x + 0.22, 0.55, z + 0.25), (0, 1, 0), 0.03, 0.08, "darkSteel", 8, w=0)
def board(K, R, words, at, state):
    """The depot's board on two posts, painted, facing the camera (+x)."""
    x, z = at
    if state == "ruin":
        cylA(K, "BoardStump", (x, 0, z - 0.45), (0, 1, 0), 0.05, 0.35, "charred", 6, w=0)
        return
    lean = 0.0 if state == "intact" else 0.35
    parts = []
    for s in (-1, 1): parts.append(cylA(K, f"BoardPost{s}", (0, -0.2, s * 0.45), (0, 1, 0), 0.045, 1.6, "pallet", 6, w=0))
    parts.append(boxC(K, "Board", (0.04, 0.42, 1.15), (0.05, 1.0, 0), mat="board", w=0.008))
    for i, w in enumerate(words):
        parts.append(text(K, f"Word{i}", w, (0.077, 1.3 - i * 0.19, 0), 0.15, "paintYellow" if i == 0 else "paintWhite"))
    move(parts, (x, 0, z), (0, 0, -lean))
# ── what is where (2026-10-21, you: "there is a shader issue — check no z-fighting"): two lying drums laid END TO
# END overlapped 16 cm, the same radius in the same place — they z-fought; jerrycans stood inside a duckboard plank,
# the chocks ran into the boards, the tarp lay 1 cm off the crates' tops… Every piece now TAKES its place: a
# capsule on the ground (a segment and a radius) and a height range. Fixed pieces are laid clear of each other;
# a scattered one (shelled, burnt) tries its spots in turn and takes the first free one, or is left out.
def _segd(a, b, c, d):
    """Least distance between segments ab and cd (xz)."""
    def pt(p, q, r):
        qx, qz = q[0] - p[0], q[1] - p[1]; L = qx * qx + qz * qz
        t = 0.0 if L < 1e-9 else max(0.0, min(1.0, ((r[0] - p[0]) * qx + (r[1] - p[1]) * qz) / L))
        return math.hypot(r[0] - p[0] - qx * t, r[1] - p[1] - qz * t)
    def cross(o, p, q): return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0: return 0.0
    return min(pt(a, b, c), pt(a, b, d), pt(c, d, a), pt(c, d, b))
class Spots:
    def __init__(s): s.items = []
    def hit(s, it):
        for o in s.items:
            if it[5] < o[6] and o[5] < it[6] and _segd(it[0:2], it[2:4], o[0:2], o[2:4]) < it[4] + o[4]: return True
        return False
    def take(s, it): s.items.append(it); return it
    def first(s, cands):
        for c in cands:
            if not s.hit(c[0]): s.take(c[0]); return c
        return None
def cap(x0, z0, x1, z1, r, y0, y1): return ((x0, z0), (x1, z1), r, y0, y1)
def spot(it): return (it[0][0], it[0][1], it[1][0], it[1][1], it[2], it[3], it[4])
def dot_(x, z, r, y0, y1): return spot(cap(x, z, x, z, r, y0, y1))
def along(x, z, yaw, half, r, y0, y1):
    """A capsule along the piece's local x turned by yaw (three.js rotation.y)."""
    ux, uz = math.cos(yaw), -math.sin(yaw)
    return spot(cap(x - ux * half, z - uz * half, x + ux * half, z + uz * half, r, y0, y1))
def lyingDrum(x, y, z, yaw):
    """A drum on its side from its base at (x, y, z), its axis along (sin yaw, 0, cos yaw) — drum()'s pitch pi/2."""
    return spot(cap(x, z, x + math.sin(yaw) * 0.86, z + math.cos(yaw) * 0.86, 0.3, y - 0.3, y + 0.3))

def fuel(K, R, state):
    cx = DX["fuel"]
    burnt = state == "ruin"
    S = Spots()
    # the duckboard under the drums: x cx-1.35 .. cx+1.15, z -1.03 .. 1.05
    for k in range(7):   # (the boards ON their rails, 7 cm up: flush with the ground they z-fought, the piece sunk 5 cm)
        z = -0.95 + k * 0.32
        boxC(K, f"Duck{k}", (2.5, 0.05, 0.16), (cx - 0.1, 0.07, z), mat="charred" if burnt else "pallet", w=0.006)
        S.take(along(cx - 0.1, z, 0, 1.17, 0.09, 0.0, 0.12))
    for k in range(3): boxC(K, f"DuckRail{k}", (0.08, 0.07, 2.1), (cx - 1.1 + k * 1.0, 0.0, 0.0), mat="pallet", w=0.004)
    mats = ("drumOlive", "drumOlive", "drumRed", "drumOlive", "drumBlue", "drumOlive", "drumOlive", "drumRed")
    # two lying side by side on chocks in front (the camera's side), clear of the boards: x cx+1.55 / cx+2.2
    LY = [(cx + 1.55, -0.43), (cx + 2.2, -0.43)]
    for zc in (-0.25, 0.25):
        boxC(K, f"Chock{zc}", (1.2, 0.12, 0.12), (cx + 1.87, 0.0, zc), mat="charred" if burnt else "pallet", w=0.006)
    for k, (x, z0) in enumerate(LY):
        S.take(lyingDrum(x, 0.41, z0, 0.0))
        if state != "ruin" or k == 0:
            drum(K, f"Lying{k}", (x, 0.41, z0), "drumOlive", (math.pi / 2, 0, 0), burnt=burnt)
    S.take(along(cx + 1.87, -0.25, 0, 0.6, 0.08, 0, 0.12)); S.take(along(cx + 1.87, 0.25, 0, 0.6, 0.08, 0, 0.12))
    # the fire point and the board (fixed)
    S.take(dot_(cx + 1.8, -1.2, 0.32, 0, 1.4))
    S.take(along(cx + 2.4, 1.3, math.pi / 2, 0.5, 0.08, 0, 1.6))
    # the jerrycans: a stack of two rows beyond the boards (z +)
    JZ = (1.32, 1.7)
    for k in range(10):
        row, i = divmod(k, 5)
        S.take(dot_(cx - 0.9 + i * 0.2, JZ[row], 0.1, 0, 0.5)) if state == "intact" else None
    # the standing drums on the boards (their spots taken first in every state: the shelled ones stand among them)
    grid = [(cx - 1.05 + (k % 4) * 0.62, -0.5 + (k // 4) * 0.64) for k in range(8)]
    for k in range(8):
        r = (R.uniform(-0.03, 0.03), R.uniform(-0.03, 0.03), R.uniform(0, 6.28), R.random())
        cand = [(R.uniform(0.4, 1.5), R.uniform(-1.6, 1.6), R.uniform(0, 6.28)) for _ in range(6)]
        x, z = grid[k][0] + r[0], grid[k][1] + r[1]
        if state == "intact" or (state == "damaged" and r[3] >= 0.5):
            S.take(dot_(x, z, 0.3, 0.12, 1.0))
            drum(K, f"Drum{k}", (x, 0.12, z), mats[k], (0 if state == "intact" else R.uniform(-0.05, 0.05), r[2], 0),
                 dent=0.03 if state == "damaged" and r[3] > 0.8 else 0)
        elif state == "damaged" and r[3] < 0.35:   # knocked over and rolled off the boards
            got = S.first([(lyingDrum(cx + 1.15 + dx, 0.3, dz, yw), dx, dz, yw) for dx, dz, yw in cand])
            if got: drum(K, f"Drum{k}", (cx + 1.15 + got[1], 0.3, got[2]), mats[k], (math.pi / 2, got[3], 0), dent=0.06)
        elif state == "ruin" and r[3] >= 0.3:      # burnt: split, slumped, some down
            down = r[3] < 0.6
            # (ON the boards, 12 cm up: set on the ground their height overlapped the boards' and every spot was taken —
            # the burnt depot came out bare; small shifts round their places)
            sh = lambda dx, dz: ((dx - 0.95) * 0.4, dz * 0.12)
            got = S.first([((lyingDrum(x + sh(dx, dz)[0], 0.42, z + sh(dx, dz)[1], yw) if down else dot_(x + sh(dx, dz)[0], z + sh(dx, dz)[1], 0.3, 0.12, 0.95)), dx, dz, yw) for dx, dz, yw in cand])
            if got:
                d_ = R.uniform(0.15, 0.4)
                ox, oz = sh(got[1], got[2])
                if down: drum(K, f"Drum{k}", (x + ox, 0.42, z + oz), mats[k], (math.pi / 2, got[3], 0), dent=d_, burnt=True)
                else: drum(K, f"Drum{k}", (x + ox, 0.12, z + oz), mats[k], (0, got[3], R.uniform(-0.15, 0.15)), dent=d_, burnt=True)
    # the hand pump on the back corner drum, its hose down toward the fire point (clear of the lying drums)
    if state != "ruin":
        px, pz = grid[3]
        cylA(K, "Pump", (px + 0.15, 0.95, pz + 0.05), (0, 1, 0), 0.035, 0.6, "darkSteel", 10, w=0.004)
        cylA(K, "PumpHandle", (px + 0.15, 1.43, pz + 0.05), (0.8, 0.45, 0), 0.014, 0.4, "darkSteel", 6, w=0)
        cylA(K, "PumpSpout", (px + 0.15, 1.45, pz + 0.05), (1, -0.2, 0), 0.02, 0.28, "darkSteel", 8, w=0)
        if not LOW:
            pts = [gv(px + 0.42, 1.39, pz + 0.05), gv(px + 0.55, 1.0, pz - 0.35), gv(px + 0.62, 0.45, pz - 0.6), gv(px + 0.7, 0.04, pz - 0.75)]
            for i in range(len(pts) - 1):
                cylA(K, f"Hose{i}", tuple(pts[i]), tuple(pts[i + 1] - pts[i]), 0.018, (pts[i + 1] - pts[i]).length, "darkSteel", 6, w=0, caps=False)
    # the jerrycans
    for k in range(10):
        r = (R.uniform(-0.02, 0.02), R.uniform(-0.05, 0.05), R.random())
        cand = [(R.uniform(-0.6, 1.4), R.uniform(-0.3, 0.6), R.uniform(-3, 3)) for _ in range(5)]
        row, i = divmod(k, 5)
        x, z = cx - 0.9 + i * 0.2 + r[0], JZ[row]
        if state == "intact": jerry(K, f"Jerry{k}", (x, 0, z), r[1]); continue
        if state == "damaged" and 0.3 <= r[2] < 0.85:
            if not S.hit(dot_(x, z, 0.1, 0, 0.5)): S.take(dot_(x, z, 0.1, 0, 0.5)); jerry(K, f"Jerry{k}", (x, 0, z), r[1])
            continue
        if (state == "damaged" and r[2] < 0.3) or (state == "ruin" and r[2] < 0.5):
            got = S.first([(dot_(x + dx, z + dz, 0.2, 0, 0.5), dx, dz, yw) for dx, dz, yw in cand])
            if got: jerry(K, f"Jerry{k}", (x + got[1], 0, z + got[2]), got[3], burnt=state == "ruin")
    firePoint(K, (cx + 1.8, -1.2), state)
    board(K, R, ("DEPOT", "ESSENCE"), (cx + 2.4, 1.3), state)

# ── the ammunition dump ────────────────────────────────────────────────────────
def crate(K, nm, size, at, yaw=0.0, rot=(0, 0, 0), mat="crate", stencil=None):
    x, y, z = size
    parts = [boxC(K, nm, size, (0, 0, 0), mat=mat, w=0.012)]
    if not LOW and mat != "charred":
        for s in (-1, 1):   # end battens
            parts.append(boxC(K, nm + f"Bat{s}", (0.05, y - 0.04, z + 0.024), (s * (x / 2 - 0.06), 0.02, 0), mat=mat, w=0.004))
            parts.append(torusA(K, nm + f"Rope{s}", (s * (x / 2 + 0.02), y * 0.6, 0), (1, 0, 0), 0.05, 0.008, "rope", 8, 4))
    if stencil and not LOW and mat != "charred":   # on its +x end (the camera's), between the battens
        parts.append(text(K, nm + "St", stencil, (x / 2 + 0.03, y * 0.5, 0), 0.07, "paintYellow"))
    move(parts, at, (rot[0], yaw + rot[1], rot[2]))
def tarp(K, R, cx, cz, w, d, top, state):
    """A canvas sheet thrown over a stack: a grid draped on the stack's box, the skirt hanging, wind-rucked."""
    if state == "ruin": return
    n = 10 if LOW else 22
    bm = bmesh.new(); vs = {}
    W2, D2 = w / 2 + 0.35, d / 2 + 0.35
    for i in range(n + 1):
        for j in range(n + 1):
            u, v = -W2 + 2 * W2 * i / n, -D2 + 2 * D2 * j / n
            if state == "damaged" and u > 0.15 * W2: continue   # half torn away
            out = max(0.0, abs(u) - w / 2, abs(v) - d / 2)
            y = top + 0.02 - out * 2.2 + 0.03 * math.sin(u * 9 + v * 5) + R.uniform(-0.012, 0.012)
            vs[(i, j)] = bm.verts.new(B(cx + u, max(0.05, y), cz + v))
    for i in range(n):
        for j in range(n):
            q = [vs.get(k) for k in ((i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1))]
            if all(q): bm.faces.new(q)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0: f.normal_flip()
    o = K.obj("Tarp", bm, "canvas", "h", smooth=True)
    s = o.modifiers.new("S", "SOLIDIFY"); s.thickness = 0.012
def openCrate(K, nm, at, yaw, mat="crateBare"):
    """A crate with its lid off: a floor and four walls (the shells stand inside, not through a closed top)."""
    x, y, z, t = 0.55, 0.28, 0.42, 0.022
    parts = [boxC(K, nm + "F", (x, t, z), (0, 0, 0), mat=mat, w=0.004)]
    for s_ in (-1, 1):
        parts.append(boxC(K, nm + f"Wx{s_}", (t, y, z), (s_ * (x / 2 - t / 2), 0, 0), mat=mat, w=0.004))
        parts.append(boxC(K, nm + f"Wz{s_}", (x - 2 * t, y, t), (0, 0, s_ * (z / 2 - t / 2)), mat=mat, w=0.004))
    if not LOW:
        for k in range(6):
            parts.append(cylA(K, f"{nm}Shell{k}", ((k % 3 - 1) * 0.15, t, (k // 3 - 0.5) * 0.17), (0, 1, 0), 0.05, 0.36, "brass", 10, 0.03, w=0))
    move(parts, at, (0, yaw, 0))
def mun(K, R, state):
    cx = DX["mun"]
    burnt = state == "ruin"
    S = Spots()
    # two pallets, crates stacked on each: x cx-1.0 .. cx+0.3
    PZ = (-0.6, 0.75)
    for p, pz in enumerate(PZ):
        for k in range(5):
            boxC(K, f"Pal{p}{k}", (1.3, 0.025, 0.12), (cx - 0.35, 0.1, pz - 0.45 + k * 0.225), mat="charred" if burnt else "pallet", w=0.004)
        for k in range(3):
            boxC(K, f"PalB{p}{k}", (1.3, 0.1, 0.09), (cx - 0.35, 0.0, pz - 0.42 + k * 0.42), mat="charred" if burnt else "pallet", w=0.004)
        S.take(along(cx - 0.35, pz - 0.3, 0, 0.6, 0.35, 0.0, 1.2)); S.take(along(cx - 0.35, pz + 0.3, 0, 0.6, 0.35, 0.0, 1.2))
    S.take(along(cx + 2.4, -1.4, math.pi / 2, 0.5, 0.08, 0, 1.6))        # the board
    # loose (FIRST: the scattered crates must find their spots taken): square shell cases by the stack (the camera's side)
    for k in range(3):
        r = (R.uniform(-0.1, 0.1), R.uniform(-0.3, 0.3), R.random())
        x, z = cx + 1.1 + r[0], -0.95 + k * 0.62
        if burnt:
            if r[2] < 0.5: S.take(dot_(x, z, 0.32, 0, 0.3)); boxC(K, f"Sq{k}", (0.5, 0.18, 0.4), (x, 0, z), (0, r[1], 0.15), "charred", 0.01)
            continue
        S.take(dot_(x, z, 0.33, 0, 0.4))
        crate(K, f"Sq{k}", (0.55, 0.36, 0.42), (x, 0, z), r[1], mat="crateBare" if k == 1 else "crate", stencil=None)
    if state == "intact":
        S.take(dot_(cx + 1.2, 1.15, 0.36, 0, 0.4)); openCrate(K, "Open", (cx + 1.2, 0, 1.15), 0.4)
        S.take(dot_(cx + 1.95, 0.75, 0.32, 0, 0.3)); boxC(K, "Lid", (0.55, 0.025, 0.42), (cx + 1.95, 0.13, 0.75), (0.0, 0.9, 0.45), "crateBare", 0.006)
    for k in range(5):
        r = (R.uniform(-0.04, 0.04), R.uniform(-0.2, 0.2), R.random())
        x, z = cx + 0.45 + (k % 3) * 0.33 + r[0], 1.75 + (k // 3) * 0.26
        if state != "intact" and r[2] < 0.4: continue
        if S.hit(dot_(x, z, 0.16, 0, 0.2)): continue
        S.take(dot_(x, z, 0.16, 0, 0.2))
        boxC(K, f"AmmoBox{k}", (0.29, 0.18, 0.15), (x, 0, z), (0, r[1], 0), "charred" if burnt else "ammoBox", 0.008)
        if not LOW and not burnt:
            boxC(K, f"AmmoH{k}", (0.12, 0.02, 0.02), (x, 0.185, z), (0, r[1], 0), "darkSteel", 0)
    for p, pz in enumerate(PZ):
        if burnt:   # burnt to a low black heap
            for k in range(5):
                boxC(K, f"Heap{p}{k}", (R.uniform(0.4, 0.9), R.uniform(0.08, 0.2), R.uniform(0.25, 0.4)), (cx - 0.35 + R.uniform(-0.5, 0.5), 0.12 + k * 0.004, pz + R.uniform(-0.4, 0.4)), (R.uniform(-0.2, 0.2), R.uniform(0, 3), R.uniform(-0.2, 0.2)), "charred", 0.01)
            continue
        layers = 3 if p == 0 else 2
        for L in range(layers):
            for k in range(3 - (L == 2)):
                r = (R.uniform(-0.02, 0.02), R.uniform(-0.03, 0.03), R.random())
                cand = [(R.uniform(0.9, 1.8), R.uniform(-1.2, 1.2), R.uniform(-1.5, 1.5)) for _ in range(6)]
                y = 0.125 + L * 0.31
                at = (cx - 0.35 + r[0], y, pz - 0.4 + k * 0.4 + 0.2 * (L == 2) + r[1] * 0.3)
                if state == "damaged" and L == layers - 1 and r[2] < 0.7:   # the top ones thrown off
                    got = S.first([(along(cx + dx, pz + dz, yw, 0.4, 0.2, 0, 0.45), dx, dz, yw) for dx, dz, yw in cand])
                    if got: crate(K, f"C{p}{L}{k}", (1.15, 0.3, 0.36), (cx + got[1], 0.0, pz + got[2]), got[3], (0, 0, R.uniform(-0.12, 0.12)))
                    continue
                crate(K, f"C{p}{L}{k}", (1.15, 0.3, 0.36), at, r[1], stencil=("7,5 MAS" if (L + k) % 2 else "LOT 57") if k == 2 - (L == 2) else None)
    if state == "intact":   # the tarp: wider than the stack, 6 cm over its top
        tarp(K, R, cx - 0.35, -0.6, 1.32, 1.46, 0.125 + 3 * 0.31 + 0.04, state)
    elif state == "damaged":   # blown off with the top crates: torn, crumpled on the ground behind the stack
        if not S.hit(dot_(cx - 0.6, 1.9, 0.42, 0, 0.2)): S.take(dot_(cx - 0.6, 1.9, 0.42, 0, 0.2)); tarp(K, R, cx - 0.6, 1.9, 0.8, 0.55, 0.12, state)
    board(K, R, ("DEPOT", "MUNITIONS"), (cx + 2.4, -1.4), state)

# ── the piece ──────────────────────────────────────────────────────────────────
def depotWall(K, R, kind, state):
    cx = DX[kind]
    gone = None
    if state == "damaged": gone = lambda t, c: (0.35 < t < 0.62 and c >= 1) or (c == 4 and t > 0.7)   # a breach, the top course knocked off
    if state == "ruin": gone = lambda t, c: (c >= 2) or (c == 1 and (t * 7) % 1 < 0.5)
    m = "burlap"
    x0 = cx - 1.75
    bagWall(K, R, "WB", (x0, -1.9), (x0, 2.0), 5, gone, m)            # behind the depot (toward the mast): chest-high
    bagWall(K, R, "WS", (x0 + 0.5, -1.95), (cx + 1.3, -1.95), 3, gone, m)   # along its left side
    if state != "intact":   # thrown bags
        for k in range(5 if state == "damaged" else 9):
            a = R.uniform(0, 6.28)
            bag(K, f"Thrown{k}", "ground", k, (x0 + R.uniform(0.3, 1.2), 0.0, R.uniform(-1.5, 1.5)), a, (R.uniform(-0.2, 0.2), R.uniform(-0.2, 0.2)), "charred" if state == "ruin" and k % 2 else m)

def buildPoint(K, name, spec, state, seed, far=False):
    global LOW
    LOW = far; K.low = far
    R = random.Random(seed)
    mast(K, random.Random(seed + 1), state)
    (fuel if name == "fuel" else mun)(K, random.Random(seed + 2), state)
    LOW = False; K.low = False

farPoint = lambda K, name, spec, state, seed: buildPoint(K, name, spec, state, seed, far=True)
TYPES = {t: dict(builder=buildPoint, farBuilder=farPoint, atlas=2048, aoDist=0.6) for t in ("fuel", "mun")}

exported = buildKit(TYPES, MATDEF, "points.glb", prefix="Point", seed0=1957)
# previews from the CAMERA's side (+x, high, as the RTS camera), each state on its own
scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1100, 800
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far") and "--farpreview" not in sys.argv: continue
    o.hide_render = False
    cd.lens = 45; cam.location = B(15, 11, -5); cam.rotation_euler = (B(2.6, 1.4, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
