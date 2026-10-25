"""THE SAS POST IN BLENDER (2026-10-25, you: "make it the best looking for my AAA RTS, Company of Heroes — it shouldn't look
cheap"). A Section Administrative Spécialisée: the French army's civil-military post IN a village — the school, the free
clinic, the officer who ran the douar, a few harkis on guard. The old piece's layout (rtsAlgeria buildSasPost — its
footprint, cover, nav, the flag's mount and the night lamp stay valid), every part redone:

  THE YARD     a whitewashed wall on a rubble-stone socle, its coping; the gate between two pillars with caps, a double
               plank gate (one leaf swung in), the tricolour board on its crossbar; the notice board by the gate
  THE HOUSE    12 x 6 m, rendered and limewashed over rubble stone, a blue band at its foot (house.py's render); a
               gable roof of CANAL TILES (rows of half-round tiles down the slope, a ridge course), the eaves
               overhanging on rafter ends; two doors (school left, clinic right) with lintels, windows with sills,
               open shutters, grilles on the clinic's; a chimney
  THE VERANDA  along the front: a concrete floor and steps, four rendered columns with plinths and capitals, a timber
               beam, a tiled lean-to roof on visible rafters; "S.A.S." on a board over the steps, "ECOLE" and
               "INFIRMERIE" (a red cross) over the doors — painted DECALS (the stencil sheet)
  THE YARD'S   the well (rubble stone, its timber frame, pulley, bucket), the water tank on its braced steel stand
  LIFE         with its ladder, the flag's stepped plinth, benches, the officer's table and chairs under the veranda,
               a blackboard on its easel by the school, a stretcher by the clinic, jerrycans and crates by the tank,
               the radio mast on the roof, guyed; lamps over the doors
  THE BAGS     the sandbagged corner is YOUR simulated wall (sandbagWall.py "sas") — the game adds it (algSangar)
  STATES       INTACT · DAMAGED (a shell through the clinic's wall, a hole in the roof and its tiles fallen, a veranda
               column down and its roof sagging, the yard wall breached by the well, rubble) · RUIN (burnt out: the
               walls broken down, the roofs gone, charred beams, tile heaps, the tank down)

Real (kit) metres, the game x1.3; the gate toward -Z. Old layout: yard half-sizes WX 11, WZ 8; the house at z 2.2.

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/sasPost.py -- <out dir> [--quick]

Writes <out>/saspost.glb (SasSas_Intact / _Damaged / _Ruin + _Far) — then tools/optimizeGlb.mjs --etc1s.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Matrix, Vector
import house
from house import buildKit
from bkit import B, srgb, dust, flat, wood, paintedWood
import props
import drystone

# ── THE LAYOUT (the old piece's) ──────────────────────────────────────────────────
WX, WZ, WT, WH = 11.0, 8.0, 0.4, 1.7          # the yard's half-sizes, its wall's thickness and height
G = 1.75                                      # half the gate
BW, BD, BH, BZ = 12.0, 6.0, 3.6, 2.2          # the house: width (x), depth (z), wall height, centre z
RISE, EAVE, GEND = 1.4, 0.5, 0.35             # the roof's rise, the eaves' overhang, the gable overhang
FZ = BZ - BD / 2                              # the house's front face
VD = 2.6                                      # the veranda's depth
VZ0 = FZ - VD                                 # its front edge
T = 0.42                                      # the house's walls
STENCIL = "C:/Windows/Fonts/ariblk.ttf"

def tile(nb):     # terracotta canal tiles, sun-bleached: tile-sized patches of shade, dark in the pans, lichen, dust
    c = nb.mix(nb.noise(7.0, 2), srgb(0x9a5a3e), srgb(0x7a4532))
    c = nb.scale(c, nb.mr(nb.noise(2.6, 1, 0.3), 0.3, 0.7, 0.82, 1.12))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(1.2, 4), 0.58, 0.72), 0.55), c, srgb(0x8a8268))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.point(), 0.45, 0.53), 0.5), c, srgb(0x4a2c20))   # (the pans' hollows darker)
    return dust(nb, c, 0.7, 1.0)
def concrete(nb):
    c = nb.mix(nb.noise(5.0, 5), srgb(0xb8b0a0), srgb(0x968e80))
    return dust(nb, c, 1.0, 0.9)
def steel(nb):    # the tank and its stand: grey-green paint, rust runs
    return props.drum_paint(0x5e6352, 0.7)(nb)
def charred(nb):
    c = nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))
    return nb.mix(nb.mr(nb.noise(9.0, 4), 0.62, 0.7), c, srgb(0x6b6258))
def sooted(nb):
    return nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(0.8, 2), 0.35, 0.75), 0.55), house.MATDEF["renderBlue"][1](nb), srgb(0x1a1612))
MATDEF = dict(house.MATDEF)
MATDEF.update(props.PROP_MATS)
MATDEF.update({
    "stone": (0.95, house.limestone), "rubble": (0.95, house.limestoneRubble),   # (limestone, as the bordj: the houses' mossy slate read as camouflage, baked sharp)
    "sasTile": (0.85, tile), "sasConcrete": (0.95, concrete), "sasSteel": (0.55, steel), "sasCharred": (0.95, charred),
    "sasSooted": (0.95, sooted), "sasBoard": (0.85, paintedWood(0xe8e2d2)), "sasBlack": (0.9, flat(srgb(0x22262a), 0.2)),
    "sasPaintBlue": (0.8, flat(srgb(0x1f3f78), 0.0)), "sasPaintRed": (0.8, flat(srgb(0xb02020), 0.0)),
    "sasFlagBlue": (0.8, flat(srgb(0x1f3f8f), 0.3)), "sasFlagWhite": (0.8, flat(srgb(0xece8de), 0.3)), "sasFlagRed": (0.8, flat(srgb(0xc0282a), 0.3)),
    "sasGlass": (0.2, flat(srgb(0x2a3238), 0.0)), "sasCanvas": (0.95, flat(srgb(0x8a8466))), "sasJerry": (0.6, props.drum_paint(0x4a5236, 0.35)),
    "sasCrate": (0.85, wood(0x76704e)),
})

LOW = False
def mk(K):
    return lambda n, bm, m: K.obj(n, bm, m, "h", smooth=True)

def text(K, nm, body, at, size, mat, yaw=math.pi):
    """Painted letters standing at `at` facing -Z (the road: yaw pi — the curve's face turned 90° about x faces +Z) — a
    DECAL (bkit.stencils): 8 mm off its board, never exported."""
    if LOW: return None
    cu = bpy.data.curves.new(nm, "FONT"); cu.body = body; cu.size = size
    cu.align_x = "CENTER"; cu.align_y = "CENTER"
    if os.path.exists(STENCIL): cu.font = bpy.data.fonts.load(STENCIL, check_existing=True)
    o = bpy.data.objects.new(nm, cu); bpy.context.scene.collection.objects.link(o)
    o.rotation_euler = (math.radians(90), 0, yaw); o.location = B(*at)
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.convert(target="MESH")
    o = bpy.context.view_layer.objects.active
    bm = bmesh.new(); bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(1), verts=bm.verts, edges=bm.edges)
    bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="EAR_CLIP")
    bm.to_mesh(o.data); bm.free()
    o.data.materials.clear(); o.data.materials.append(K.mat(mat))
    o["stencil"] = body; K.decals.append(o)
    return o

def prism(K, nm, pts, mat):
    """A convex solid from its corner points (game coords)."""
    bm = bmesh.new(); vs = [bm.verts.new(B(*p)) for p in pts]
    bmesh.ops.convex_hull(bm, input=vs)
    return K.obj(nm, bm, mat, "h")

# ── THE YARD WALL ────────────────────────────────────────────────────────────────
def yard(K, R, state):
    burnt = state == "ruin"
    rend = "sasSooted" if burnt else "renderBlue"
    # each run: (x0, z0, x1, z1); the front's two halves either side of the gate
    runs = [(-WX, -WZ, -G - 0.3, -WZ), (G + 0.3, -WZ, WX, -WZ), (WX, -WZ, WX, WZ), (WX, WZ, -WX, WZ), (-WX, WZ, -WX, -WZ)]
    cuts = []
    if state == "damaged": cuts.append(((-6.4, 0.9, -WZ), (1.1, 0.95, 0.7)))                 # a shell by the well
    for i, (x0, z0, x1, z1) in enumerate(runs):
        along_x = abs(x1 - x0) > abs(z1 - z0)
        t = WT / 2 + (0.0 if i % 2 else 0.012)      # (alternate runs a hair thicker: their corners never in one plane)
        h = WH * (R.uniform(0.35, 0.75) if burnt else 1.0)
        lo, hi = (min(x0, x1), max(x0, x1)) if along_x else (min(z0, z1), max(z0, z1))
        if along_x: lo, hi = lo - (t if i > 1 else 0), hi + (t if i > 1 else 0)
        if along_x:
            w = K.box(f"Wall{i}", lo, hi, -0.4, h, z0 - t, z0 + t, rend, "h", 0)
            sock = K.box(f"Socle{i}", lo - 0.04, hi + 0.04, -0.4, 0.42, z0 - t - 0.05, z0 + t + 0.05, "stone", "h", 0)
            cop = None if burnt else K.box(f"Cope{i}", lo - 0.03, hi + 0.03, h, h + 0.1, z0 - t - 0.05, z0 + t + 0.05, "sill", "h", 0.02)
        else:
            w = K.box(f"Wall{i}", x0 - t, x0 + t, -0.4, h, lo, hi, rend, "h", 0)
            sock = K.box(f"Socle{i}", x0 - t - 0.05, x0 + t + 0.05, -0.4, 0.42, lo - 0.04, hi + 0.04, "stone", "h", 0)
            cop = None if burnt else K.box(f"Cope{i}", x0 - t - 0.05, x0 + t + 0.05, h, h + 0.1, lo - 0.03, hi + 0.03, "sill", "h", 0.02)
        K.bevel(w, 0.03, 2, 30)
        for c, sz in cuts:   # (each part its own cutter: one cutter through the wall and its socle left their cut faces in one surface)
            for j, o in enumerate((w, sock, cop)):
                if o is not None: K.boolean(o, K.breach(c, (sz[0] * (1 + 0.06 * j), sz[1] * (1 + 0.06 * j), sz[2]), seed=31 + i + 7 * j, mat="stone"))
    # the gate: pillars and their caps, the crossbar with the tricolour board
    for sx in (-1, 1):
        p = K.box(f"Pillar{sx}", sx * (G + 0.3) - 0.32, sx * (G + 0.3) + 0.32, -0.4, 2.4, -WZ - 0.32, -WZ + 0.32, rend, "h", 0)
        K.bevel(p, 0.03, 2, 30)
        if not burnt:
            K.box(f"PillarCap{sx}", sx * (G + 0.3) - 0.4, sx * (G + 0.3) + 0.4, 2.4, 2.52, -WZ - 0.4, -WZ + 0.4, "sill", "h", 0.02)
            K.box(f"PillarTop{sx}", sx * (G + 0.3) - 0.22, sx * (G + 0.3) + 0.22, 2.52, 2.66, -WZ - 0.22, -WZ + 0.22, "sill", "h", 0.02)
    if burnt: return
    K.box("GateBar", -G - 0.1, G + 0.1, 2.9, 3.02, -WZ - 0.05, -WZ + 0.05, "iron", "h", 0.01)
    for sx in (-1, 1): K.rod(f"GateStay{sx}", (sx * (G + 0.15), 2.5, -WZ), (sx * (G + 0.15), 3.0, -WZ), 0.035, "iron", "h", 6)
    for k, (mat, x) in enumerate((("sasFlagBlue", 0.5), ("sasFlagWhite", 0.0), ("sasFlagRed", -0.5))):   # (blue on the left seen from the road, -Z: +x)
        K.box(f"Tricolour{k}", x - 0.25, x + 0.25, 3.05, 3.65, -WZ - 0.03, -WZ + 0.03, mat, "h", 0.006)
    # the gate's leaves: planks on a frame; the left shut, the right swung in
    for side, (a0, a1) in enumerate(((-G + 0.05, -0.02), (0.02, G - 0.05))):
        leaf = []
        w = a1 - a0
        for k in range(6):
            u = k * w / 6
            leaf.append(K.box(f"Plank{side}{k}", u + 0.006, u + w / 6 - 0.006, 0.08, 1.9, -0.035, 0.035, "woodDark", "h", 0.006))
        for y in (0.35, 1.55): leaf.append(K.box(f"Rail{side}{y}", 0.05, w - 0.05, y - 0.07, y + 0.07, 0.035, 0.085, "woodDark", "h", 0.006))
        M = Matrix.Translation(B(a0 if side == 0 else a1, 0, -WZ)) @ (Matrix.Identity(4) if side == 0 else Matrix.Rotation(math.radians(-105), 4, "Z") @ Matrix.Translation(B(-w, 0, 0)))
        for o in leaf: o.matrix_world = M @ o.matrix_world
    # the notice board by the gate: two posts, a board, the notices pinned
    nx = -G - 2.2
    for sx in (-1, 1): K.rod(f"NbPost{sx}", (nx + sx * 0.55, 0, -WZ + 0.55), (nx + sx * 0.55, 1.9, -WZ + 0.55), 0.04, "woodDark", "h", 6)
    K.box("NbBoard", nx - 0.62, nx + 0.62, 1.0, 1.85, -WZ + 0.5, -WZ + 0.54, "sasBoard", "h", 0.008)
    for k in range(5):
        x, y = nx - 0.45 + (k % 3) * 0.42 + R.uniform(-0.04, 0.04), 1.2 + (k // 3) * 0.35 + R.uniform(-0.03, 0.03)
        K.box(f"Notice{k}", x - 0.13, x + 0.13, y - 0.16, y + 0.16, -WZ + 0.488, -WZ + 0.496, "sill", "h", 0)

# ── THE HOUSE ─────────────────────────────────────────────────────────────────────
DOORS = (-3.0, 3.0)                            # the school's, the clinic's (their centres)
WINS = (-5.1, -1.0, 1.0, 5.1)                  # the front's windows
BACKWINS = (-3.6, 0.0, 3.6)

def house_body(K, R, state):
    burnt = state == "ruin"
    rend = "sasSooted" if burnt else "renderBlue"
    x0, x1, z0, z1 = -BW / 2, BW / 2, FZ, FZ + BD
    top = BH if not burnt else BH  # (the skyline cuts the ruin below)
    sh = K.box("House", x0, x1, -0.4, top, z0, z1, rend, "h", 0)
    K.boolean(sh, K.cutter(x0 + T, x1 - T, 0.1, top + 1, z0 + T, z1 - T, rend))
    for x in DOORS: K.boolean(sh, K.cutter(x - 0.6, x + 0.6, 0.18, 2.35, z0 - 0.3, z0 + T + 0.3, rend))
    for x in WINS: K.boolean(sh, K.cutter(x - 0.45, x + 0.45, 1.05, 2.35, z0 - 0.3, z0 + T + 0.3, rend))
    for x in BACKWINS: K.boolean(sh, K.cutter(x - 0.4, x + 0.4, 1.2, 2.3, z1 - T - 0.3, z1 + 0.3, rend))
    for z in (z0 + 1.6, z1 - 1.6): K.boolean(sh, K.cutter(x1 - T - 0.3, x1 + 0.3, 1.2, 2.3, z - 0.4, z + 0.4, rend))
    K.bevel(sh, 0.035, 2, 30)
    shells = [sh]
    # the stone socle round its foot, the floor inside, the dark rooms behind the openings
    K.box("HSocle", x0 - 0.06, x1 + 0.06, -0.4, 0.35, z0 - 0.06, z1 + 0.06, "stone", "h", 0)
    K.box("Floor", x0 + T, x1 - T, 0.1, 0.16, z0 + T, z1 - T, "sasConcrete", "h", 0)
    K.box("Partition", -0.12, 0.12, 0.16, top - 0.02, z0 + T, z1 - T, rend, "h", 0)
    # the gables: a triangle on each end, over the wall's top
    for sx in (-1, 1):
        xa, xb = (x0, x0 + T) if sx < 0 else (x1 - T, x1)
        g = prism(K, f"Gable{sx}", [(xa, top, z0), (xb, top, z0), (xa, top, z1), (xb, top, z1), (xa, top + RISE - 0.08, BZ), (xb, top + RISE - 0.08, BZ)], rend)
        shells.append(g)
    return shells

def openings(K, R, state):
    """Doors, lintels, windows (sills, the dark, shutters, grilles), the lamps over the doors."""
    burnt = state == "ruin"
    z0 = FZ
    for k, x in enumerate(DOORS):
        K.box(f"Lintel{k}", x - 0.75, x + 0.75, 2.31, 2.52, z0 - 0.05, z0 + 0.12, "sasConcrete", "h", 0.01)   # (4 cm into the opening: at 2.35, its top, one plane)
        K.box(f"Step{k}", x - 0.75, x + 0.75, 0.12, 0.2, z0 - 0.3, z0 + 0.02, "sill", "h", 0.01)
        if burnt:
            K.box(f"DoorDark{k}", x - 0.58, x + 0.58, 0.18, 2.33, z0 + T - 0.05, z0 + T - 0.03, "dark", "h", 0)
            continue
        # double leaves, the school's open, the clinic's shut; their panels
        for s, (a, b) in enumerate(((x - 0.58, x - 0.008), (x + 0.008, x + 0.58))):
            open_ = k == 0
            leaf = [K.box(f"Door{k}{s}", 0.0, b - a, 0.2, 2.33, -0.03, 0.03, "doorBlue", "h", 0.008)]
            for y in (0.7, 1.7): leaf.append(K.box(f"Panel{k}{s}{y}", 0.07, b - a - 0.07, y - 0.32, y + 0.32, -0.055, -0.03, "doorBlue", "h", 0.005))
            hinge = a if s == 0 else b
            rot = Matrix.Rotation(math.radians(-80 if s == 0 else 80), 4, "Z") if open_ else Matrix.Identity(4)
            M = Matrix.Translation(B(hinge, 0, z0 + T * 0.5)) @ rot @ Matrix.Translation(B(0 if s == 0 else -(b - a), 0, 0))
            for o in leaf: o.matrix_world = M @ o.matrix_world
        K.box(f"DoorDark{k}", x - 0.58, x + 0.58, 0.18, 2.33, z0 + T + 0.1, z0 + T + 0.12, "dark", "h", 0)
        # the lamp over the door: a bracket and an enamel shade
        K.rod(f"LampArm{k}", (x, 2.75, z0), (x, 2.75, z0 - 0.35), 0.012, "iron", "h", 6)
        K.cyl(f"LampShade{k}", (x, 2.62, z0 - 0.38), 0.17, 0.12, "sasBoard", "h", 14, r2=0.03)
    for k, x in enumerate(WINS):
        K.box(f"Sill{k}", x - 0.55, x + 0.55, 0.99, 1.08, z0 - 0.08, z0 + 0.1, "sill", "h", 0.01)   # (its top 3 cm over the opening's floor)
        K.box(f"WinDark{k}", x - 0.45, x + 0.45, 1.05, 2.35, z0 + T - 0.1, z0 + T - 0.08, "sasGlass" if not burnt else "dark", "h", 0)
        if burnt: continue
        if x > 0:   # the clinic's: an iron grille
            for b in range(5): K.rod(f"Grille{k}{b}", (x - 0.36 + b * 0.18, 1.05, z0 + 0.05), (x - 0.36 + b * 0.18, 2.35, z0 + 0.05), 0.012, "iron", "h", 6)
        for s in (-1, 1):   # the shutters open flat against the wall
            K.box(f"Shutter{k}{s}", x + s * 0.47 + (0 if s > 0 else -0.46), x + s * 0.47 + (0.46 if s > 0 else 0), 1.08, 2.32, z0 - 0.07, z0 - 0.025, "shutterBlue", "h", 0.006)
    for k, x in enumerate(BACKWINS):
        K.box(f"BSill{k}", x - 0.5, x + 0.5, 1.14, 1.23, FZ + BD - 0.1, FZ + BD + 0.08, "sill", "h", 0.01)
        K.box(f"BDark{k}", x - 0.4, x + 0.4, 1.2, 2.3, FZ + BD - T + 0.08, FZ + BD - T + 0.1, "dark", "h", 0)

def tiles(K, nm, xa, xb, top, bot, R, gaps=(), droop=None):
    """CANAL TILES (2026-10-25, you: the first roof "doesn't look so good" — rods side by side read as pipes, as corrugated
    sheet): the roof's surface as COURSES of tiles down the slope from `top` (y, z) to `bot` (y, z) between xa and xb —
    each course a strip waving across (the caps convex, the pans concave, 0.34 a pair), its lower edge lifted 3 cm onto
    the course below, so every course casts its little step of shadow; the courses a hair askew, each its own island
    (its shade: the material's). `gaps`: x ranges left bare (a shell's hole); `droop(x)`: the sag of a broken roof."""
    PAIR, AMP, LC, STEP, LIFT = 0.34, 0.045, 0.44, 0.37, 0.032
    (yt, zt), (yb, zb) = top, bot
    L = math.hypot(yb - yt, zb - zt); dy, dz = (yb - yt) / L, (zb - zt) / L
    ny, nz = -dz, dy
    if ny < 0: ny, nz = -ny, -nz
    nc = max(1, math.ceil((L - LC) / STEP) + 1)
    cols = max(8, int((xb - xa) / (PAIR / (6 if not LOW else 3))))
    bm = bmesh.new()
    for c in range(nc):
        s0 = min(c * STEP, L - LC); jit = R.uniform(-0.012, 0.012)
        rows = []
        for u in (0.0, 1.0):
            s_ = s0 + u * LC
            row = []
            for i in range(cols + 1):
                x = xa + (xb - xa) * i / cols
                h = 0.012 + LIFT * u + AMP * (1 + math.sin(2 * math.pi * (x - xa) / PAIR)) + jit * u
                if droop: h -= droop(x) * (s_ / L)
                row.append(bm.verts.new(B(x, yt + dy * s_ + ny * h, zt + dz * s_ + nz * h)))
            rows.append(row)
        for i in range(cols):
            xm = xa + (xb - xa) * (i + 0.5) / cols
            if any(g0 < xm < g1 for g0, g1 in gaps): continue
            f = bm.faces.new((rows[0][i], rows[0][i + 1], rows[1][i + 1], rows[1][i]))
    for v in [v for v in bm.verts if not v.link_faces]: bm.verts.remove(v)   # (a gap's corners)
    for f in bm.faces:   # (every face up, out of the roof: Blender's up is +Z)
        f.normal_update()
        if f.normal.z < 0: f.normal_flip()
    o = K.obj(nm, bm, "sasTile", "h", smooth=True)
    return o

def roof(K, R, state):
    """The gable roof: its deck, the canal tiles in rows down each slope, the ridge, the rafter ends under the eaves;
    damaged: a hole by the clinic (its tiles fallen, broken rafters); ruin: gone."""
    if state == "ruin": return
    x0, x1 = -BW / 2 - GEND, BW / 2 + GEND
    zs = (FZ - EAVE, FZ + BD + EAVE)
    hole = (2.2, 4.6) if state == "damaged" else None           # x range of the hole, on the front slope
    for side, ze in ((-1, zs[0]), (1, zs[1])):
        # the deck: a 12 cm slab from the ridge line down to the eave line — the tiles' bed (its top the pan tiles)
        ye = BH - EAVE * RISE / (BD / 2)                         # the eave's height (the slope carried past the wall)
        yr = BH + RISE                                           # the ridge
        for (a, b) in ([(x0, hole[0]), (hole[1], x1)] if hole and side < 0 else [(x0, x1)]):
            prism(K, f"Deck{side}{a:.1f}", [(a, yr, BZ), (b, yr, BZ), (a, ye, ze), (b, ye, ze),
                                           (a, yr - 0.14, BZ), (b, yr - 0.14, BZ), (a, ye - 0.14, ze), (b, ye - 0.14, ze)], "woodDark")
        # the tiles: courses down the slope, on the deck (canal tiles — `tiles`)
        tiles(K, f"Tiles{side}", x0, x1, (yr, BZ), (ye, ze), R, gaps=[(hole[0] - 0.05, hole[1] + 0.05)] if hole and side < 0 else ())
    # the ridge: half-round ridge tiles set in mortar along it — a collar at each tile's joint
    K.rod("Ridge", (x0 - 0.05, BH + RISE + 0.07, BZ), (x1 + 0.05, BH + RISE + 0.07, BZ), 0.13, "sasTile", "h", 8)
    K.box("RidgeMortar", x0, x1, BH + RISE - 0.04, BH + RISE + 0.03, BZ - 0.17, BZ + 0.17, "sill", "h", 0.01)
    if not LOW:
        for k in range(int((x1 - x0) / 0.42)):
            x = x0 + 0.21 + k * 0.42
            K.rod(f"RidgeJoint{k}", (x - 0.035, BH + RISE + 0.07, BZ), (x + 0.035, BH + RISE + 0.07, BZ), 0.142, "sasTile", "h", 8)
    # the rafter ends under the eaves, front and back
    if not LOW:
        for side, ze in ((-1, zs[0]), (1, zs[1])):
            for i in range(13):
                x = -BW / 2 + 0.3 + i * (BW - 0.6) / 12
                if hole and side < 0 and hole[0] < x < hole[1]: continue
                zw = FZ if side < 0 else FZ + BD
                K.box(f"Rafter{side}{i}", x - 0.05, x + 0.05, BH - 0.18, BH - 0.06, min(zw, ze + side * -0.05), max(zw, ze + side * -0.05), "woodDark", "h", 0.008)
    # the chimney, off the ridge toward the school's end
    K.box("Chimney", -4.4, -3.8, BH + 0.6, BH + RISE + 0.95, BZ + 0.3, BZ + 0.9, "renderBlue", "h", 0.02)
    K.box("ChimneyCap", -4.5, -3.7, BH + RISE + 0.95, BH + RISE + 1.03, BZ + 0.2, BZ + 1.0, "sill", "h", 0.01)
    if hole:   # the hole's broken rafters and fallen tiles below, inside
        for k in range(3):
            x = hole[0] + 0.5 + k * 0.8
            K.rod(f"Broken{k}", (x, BH + RISE * 0.5, BZ - 1.2), (x + R.uniform(-0.3, 0.3), 0.3, FZ + 0.8 + R.uniform(0, 0.8)), 0.06, "woodDark", "h", 6)
        K.lump("TileHeap", ((hole[0] + hole[1]) / 2, 0.1, FZ + 1.4), (1.0, 0.3, 0.7), "sasTile", "h", seed=12, rough=0.5)

def veranda(K, R, state):
    burnt = state == "ruin"
    z1 = FZ
    K.box("VFloor", -BW / 2 - 0.3, BW / 2 + 0.3, -0.4, 0.22, VZ0, z1 - 0.01, "sasConcrete", "h", 0.02)
    for k in range(2):   # the steps, in front of the middle
        K.box(f"VStep{k}", -1.4 - 0.06 * k, 1.4 + 0.06 * k, -0.3, 0.22 - (k + 1) * 0.11 + 0.02, VZ0 - 0.32 * (k + 1), VZ0 - 0.32 * k + (0.02 if k else 0), "sasConcrete", "h", 0.015)
    cols = (-5.9, -2.1, 2.1, 5.9)
    beamY = 2.95
    fallen = 2 if state == "damaged" else (None if not burnt else -1)
    for k, x in enumerate(cols):
        if burnt and k in (1, 3):
            K.box(f"ColStump{k}", x - 0.17, x + 0.17, 0.22, 0.22 + R.uniform(0.4, 1.0), VZ0 + 0.2, VZ0 + 0.54, "sasSooted", "h", 0.02)
            continue
        if k == fallen:   # knocked down, lying across the steps
            c = K.box(f"Col{k}", -0.15, 0.15, 0, 2.6, -0.15, 0.15, "renderBlue", "h", 0.02)
            c.matrix_world = Matrix.Translation(B(x - 0.6, 0.38, VZ0 - 0.2)) @ Matrix.Rotation(math.radians(85), 4, "Y") @ Matrix.Rotation(math.radians(-80), 4, "X") @ c.matrix_world
            continue
        K.box(f"ColBase{k}", x - 0.24, x + 0.24, 0.22, 0.42, VZ0 + 0.13, VZ0 + 0.61, "sill", "h", 0.02)
        K.bevel(K.box(f"Col{k}", x - 0.16, x + 0.16, 0.42, beamY - 0.18, VZ0 + 0.21, VZ0 + 0.53, "sasSooted" if burnt else "renderBlue", "h", 0), 0.025, 2, 30)
        K.box(f"ColCap{k}", x - 0.24, x + 0.24, beamY - 0.18, beamY - 0.06, VZ0 + 0.13, VZ0 + 0.61, "sill", "h", 0.02)
    if burnt:
        for k in range(4):   # the veranda's roof burnt down: charred timbers across the floor
            K.rod(f"VBurnt{k}", (-5 + k * 3 + R.uniform(-0.5, 0.5), 0.3, VZ0 + 0.3), (-4 + k * 3 + R.uniform(-0.8, 0.8), 0.25, z1 - 0.3), 0.07, "sasCharred", "h", 6)
        return
    sag = state == "damaged"
    # the beam on the columns; the lean-to roof from the wall (3.35) down onto it, rafters under it, tiles on it
    yb = beamY + 0.12
    K.box("VBeam", -BW / 2 - 0.4, BW / 2 + 0.4, beamY - 0.06, yb, VZ0 + 0.17, VZ0 + 0.57, "woodDark", "h", 0.01)
    yw, zw = BH - 0.25, z1
    drop = (lambda x: 0.55 * max(0, 1 - abs(x - 2.1) / 2.4)) if sag else (lambda x: 0)
    for i in range(14):
        x = -BW / 2 - 0.2 + i * (BW + 0.4) / 13
        K.rod(f"VRafter{i}", (x, yw - 0.12, zw - 0.02), (x, yb + 0.02 - drop(x), VZ0 - 0.25), 0.045, "woodDark", "h", 6)
    tiles(K, "VTiles", -BW / 2 - 0.3, BW / 2 + 0.3, (yw + 0.02, zw - 0.05), (yb + 0.11, VZ0 - 0.3), R,
          gaps=[(1.6, 2.7)] if sag else (), droop=drop if sag else None)
    # (a deck under the tiles: the underside seen from the yard)
    xa, xb = -BW / 2 - 0.3, BW / 2 + 0.3
    for (a, b) in ([(xa, 1.4), (2.9, xb)] if sag else [(xa, xb)]):   # (sagging: the deck broken where it sags)
        prism(K, f"VDeck{a:.1f}", [(a, yw + 0.02, zw - 0.05), (b, yw + 0.02, zw - 0.05), (a, yb + 0.11, VZ0 - 0.3), (b, yb + 0.11, VZ0 - 0.3),
                                  (a, yw - 0.08, zw - 0.05), (b, yw - 0.08, zw - 0.05), (a, yb + 0.01, VZ0 - 0.3), (b, yb + 0.01, VZ0 - 0.3)], "woodDark")
    if sag:   # the tiles that slid: a heap on the floor
        K.lump("VTileHeap", (2.0, 0.22, VZ0 + 0.9), (0.8, 0.22, 0.5), "sasTile", "h", seed=21, rough=0.5)

def signs(K, R, state):
    """The S.A.S. board on the beam over the steps; ECOLE and INFIRMERIE (a red cross) over the doors — decals."""
    if state == "ruin": return
    # (hung under the beam on two irons: on the beam, the veranda's eave hid it)
    K.box("SasBoard", -1.1, 1.1, 2.4, 2.84, VZ0 + 0.12, VZ0 + 0.16, "sasBoard", "h", 0.008)
    for sx in (-1, 1): K.rod(f"SasIron{sx}", (sx * 0.9, 2.82, VZ0 + 0.14), (sx * 0.9, 2.92, VZ0 + 0.3), 0.012, "iron", "h", 4)
    text(K, "SasWord", "S.A.S.", (0, 2.62, VZ0 + 0.112), 0.3, "sasPaintBlue")
    for k, (x, word) in enumerate(((DOORS[0], "ECOLE"), (DOORS[1], "INFIRMERIE"))):
        w = 1.3 if k == 0 else 1.9
        K.box(f"DoorBoard{k}", x - w / 2, x + w / 2, 2.58, 2.86, FZ - 0.04, FZ - 0.0, "sasBoard", "h", 0.006)
        text(K, f"DoorWord{k}", word, (x - (0.17 if k else 0), 2.72, FZ - 0.048), 0.17, "sasBlack")
    # the red cross on the clinic's board, at its right end — two bars on the board, 8 mm proud
    cx = DOORS[1] + 0.78
    K.box("CrossV", cx - 0.035, cx + 0.035, 2.62, 2.82, FZ - 0.05, FZ - 0.042, "sasPaintRed", "h", 0)
    K.box("CrossH", cx - 0.1, cx + 0.1, 2.685, 2.755, FZ - 0.058, FZ - 0.05, "sasPaintRed", "h", 0)

def yard_life(K, R, state):
    burnt = state == "ruin"
    make = mk(K)
    # the well: the village props kit's (a better one — you), set by the game on its spot (algPenProps; sasPost.glb's
    # `pens` — the loader reads WELL below); burnt: its stones only
    if burnt:
        K.cyl("WellRing", (-6.5, -0.3, -4.5), 0.78, 0.7, "sasCharred", "h", 18, w=0.02)
    # the water tank on its stand (game: the old piece's place)
    tx, tz, tH = 8.3, 5.3, 4.1
    legs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    if burnt:   # the stand blown: the tank down on its side, a leg left standing
        K.rod("TankLeg", (tx + 0.85, 0, tz + 0.85), (tx + 0.7, tH * 0.8, tz + 0.7), 0.06, "sasCharred", "h", 6)
        t = K.cyl("Tank", (0, 0, 0), 1.05, 1.6, "sasCharred", "h", 18, w=0.01)
        t.matrix_world = Matrix.Translation(B(tx - 1.0, 1.0, tz - 0.4)) @ Matrix.Rotation(math.pi / 2, 4, "Y") @ Matrix.Rotation(0.4, 4, "Z") @ t.matrix_world
    else:
        for sx, sz in legs:
            K.rod(f"TankLeg{sx}{sz}", (tx + sx * 0.9, -0.2, tz + sz * 0.9), (tx + sx * 0.72, tH, tz + sz * 0.72), 0.065, "sasSteel", "h", 6)
        for k, (a, b) in enumerate(zip(legs, legs[1:] + legs[:1])):   # the cross braces, two levels
            for y0, y1 in ((0.5, 2.1), (2.1, 3.7)):
                fa, fb = 1 - y0 / tH * 0.2, 1 - y1 / tH * 0.2
                K.rod(f"Brace{k}{y0}", (tx + a[0] * 0.9 * fa, y0, tz + a[1] * 0.9 * fa), (tx + b[0] * 0.9 * fb, y1, tz + b[1] * 0.9 * fb), 0.02, "sasSteel", "h", 4)
        K.box("TankDeck", tx - 1.0, tx + 1.0, tH, tH + 0.1, tz - 1.0, tz + 1.0, "sasSteel", "h", 0.01)
        K.cyl("Tank", (tx, tH + 0.1, tz), 1.02, 1.55, "sasSteel", "h", 20, w=0.01)
        K.cyl("TankLid", (tx, tH + 1.65, tz), 1.06, 0.32, "sasSteel", "h", 20, r2=0.15, w=0)
        for k in range(9):   # its ladder up the -x leg
            y = 0.4 + k * 0.42
            K.rod(f"Rung{k}", (tx - 1.0, y, tz - 0.25), (tx - 1.0, y, tz + 0.25), 0.015, "sasSteel", "h", 4)
        for sz in (-1, 1): K.rod(f"LadderRail{sz}", (tx - 1.0, 0, tz + sz * 0.25), (tx - 1.0, tH + 0.9, tz + sz * 0.25), 0.02, "sasSteel", "h", 4)
        K.rod("TankPipe", (tx + 0.4, tH, tz - 0.4), (tx + 0.4, 0.1, tz - 0.4), 0.04, "sasSteel", "h", 6)
    # the flag's stepped plinth (the game plants the flag on it: flagMount (0, 0.45, -4.2))
    K.box("Plinth0", -0.6, 0.6, -0.2, 0.22, -4.8, -3.6, "sill", "h", 0.02)
    K.box("Plinth1", -0.4, 0.4, 0.22, 0.45, -4.6, -3.8, "renderBlue" if not burnt else "sasSooted", "h", 0.02)
    if burnt:
        K.lump("Ash", (0, 0, 2.2), (3.2, 0.5, 1.8), "sasCharred", "h", seed=4, rough=0.45)
        return
    # under the veranda: the officer's table and two chairs; benches; the blackboard by the school; a stretcher by the clinic
    tz0 = FZ - 1.1
    K.box("TableTop", -1.1, 0.1, 0.92, 0.98, tz0 - 0.4, tz0 + 0.4, "wood", "h", 0.01)
    for sx in (-1, 1):
        for sz in (-1, 1): K.rod(f"TableLeg{sx}{sz}", (-0.5 + sx * 0.52, 0.22, tz0 + sz * 0.33), (-0.5 + sx * 0.52, 0.92, tz0 + sz * 0.33), 0.025, "woodDark", "h", 4)
    for k, (cx, cz, yw) in enumerate(((-0.8, tz0 + 0.65, 0.1), (-0.15, tz0 - 0.68, 3.2))):
        ch = [K.box(f"Seat{k}", -0.22, 0.22, 0.65, 0.69, -0.22, 0.22, "wood", "h", 0.008), K.box(f"Back{k}", -0.22, 0.22, 0.69, 1.12, 0.18, 0.22, "wood", "h", 0.008)]
        for sx in (-1, 1):
            for sz in (-1, 1): ch.append(K.rod(f"ChairLeg{k}{sx}{sz}", (sx * 0.19, 0.22, sz * 0.19), (sx * 0.19, 0.65, sz * 0.19), 0.02, "woodDark", "h", 4))
        for o in ch: o.matrix_world = Matrix.Translation(B(cx, 0, cz)) @ Matrix.Rotation(yw, 4, "Z") @ o.matrix_world
    K.box("Papers", -0.9, -0.5, 0.98, 0.995, tz0 - 0.2, tz0 + 0.1, "sill", "h", 0)
    for x in (-5.0, 5.0):
        K.box(f"Bench{x}", x - 0.9, x + 0.9, 0.62, 0.68, FZ - 0.5, FZ - 0.15, "wood", "h", 0.01)
        for sx in (-1, 1): K.box(f"BenchLeg{x}{sx}", x + sx * 0.75 - 0.04, x + sx * 0.75 + 0.04, 0.22, 0.62, FZ - 0.48, FZ - 0.17, "woodDark", "h", 0.005)
    bx, bz = DOORS[0] - 1.6, VZ0 - 1.2
    K.box("Blackboard", bx - 0.55, bx + 0.55, 0.95, 1.7, bz - 0.02, bz + 0.02, "sasBlack", "h", 0.008)
    for sx in (-1, 1): K.rod(f"Easel{sx}", (bx + sx * 0.5, 0, bz - 0.25), (bx + sx * 0.4, 1.85, bz + 0.03), 0.025, "wood", "h", 4)
    K.rod("EaselBack", (bx, 0, bz + 0.5), (bx, 1.8, bz + 0.05), 0.025, "wood", "h", 4)
    sx_, sz_ = DOORS[1] + 1.5, VZ0 - 1.0
    for s in (-1, 1): K.rod(f"Stretcher{s}", (sx_ - 1.0, 0.12, sz_ + s * 0.27), (sx_ + 1.0, 0.12, sz_ + s * 0.27), 0.03, "woodDark", "h", 6)
    K.box("StretcherCanvas", sx_ - 0.85, sx_ + 0.85, 0.13, 0.15, sz_ - 0.25, sz_ + 0.25, "sasCanvas", "h", 0)
    # by the tank: jerrycans and crates (the shared props)
    for k in range(4):
        props.place(props.jerry(make, f"Jerry{k}", "sasJerry", "propFittings", LOW), (6.4 + k * 0.23, 0, 6.6), math.pi / 2 + R.uniform(-0.06, 0.06))
    props.place(props.crate(make, "Crate0", "sasCrate", "propRope", 0.8, 0.42, 0.46, LOW), (6.9, 0, 4.4), 0.2)
    props.place(props.crate(make, "Crate1", "sasCrate", "propRope", 0.8, 0.42, 0.46, LOW), (6.85, 0.42 + props.CRATE_TOP + 0.003, 4.42), 0.35)

def mast(K, R, state):
    """The radio mast off the roof's back slope, guyed to the ridge and the eaves."""
    if state == "ruin": return
    mx, mz = 4.5, BZ + 1.8
    base = BH + RISE * (1 - (mz - BZ) / (BD / 2)) + 0.05
    K.rod("Mast", (mx, base, mz), (mx, base + 7.5, mz), 0.04, "iron", "h", 6)
    K.rod("MastTop", (mx - 0.6, base + 7.3, mz), (mx + 0.6, base + 7.3, mz), 0.015, "iron", "h", 4)
    for dx, dz in ((-2.6, 0.9), (2.2, 0.7), (0.3, -2.5)):
        K.rod(f"Guy{dx}", (mx, base + 6.0, mz), (mx + dx, BH + 0.4, mz + dz), 0.006, "iron", "h", 3)

def buildSas(K, name, spec, state, seed):
    R = random.Random(seed)
    global LOW
    LOW = K.low
    shells = house_body(K, R, state)
    openings(K, random.Random(seed + 1), state)
    roof(K, random.Random(seed + 2), state)
    veranda(K, random.Random(seed + 3), state)
    signs(K, R, state)
    yard(K, random.Random(seed + 4), state)
    yard_life(K, random.Random(seed + 5), state)
    mast(K, R, state)
    if state == "damaged":   # a shell through the clinic's wall by the right window: the breach, rubble out front
        cut = K.breach((5.3, 1.7, FZ), (0.95, 0.95, 0.75), seed=seed + 9, mat="stone")
        for o in shells + [o for o in K.groups["h"] if o.name.startswith(("Sill3", "WinDark3", "Shutter3", "Grille3", "HSocle"))]: K.boolean(o, cut)
        K.lump("Rubble0", (5.4, 0.1, FZ - 0.9), (0.9, 0.35, 0.6), "rubble", "h", seed=seed + 3)
        for j in range(6):
            K.lump(f"Rub{j}", (5.4 + R.uniform(-1.2, 1.2), 0.1, FZ - 0.9 + R.uniform(-0.7, 0.6)), (R.uniform(0.12, 0.28), R.uniform(0.08, 0.18), R.uniform(0.12, 0.26)), "rubble", "h", seed=seed + 40 + j, sub=1)
    if state == "ruin":   # burnt out and blown: the walls broken down to a ragged line, heaps of rubble and tiles
        top = K.skyline(-BW / 2 - 1.0, BW / 2 + 1.0, FZ - 1.0, FZ + BD + 1.0, 2.2, 1.0, seed=seed, mat="stone")
        for o in [o for o in K.groups["h"] if o.name.startswith(("House", "Gable", "Partition", "Lintel", "Sill", "WinDark", "BSill", "BDark", "DoorDark"))]: K.boolean(o, top)
        for k in range(5):
            x = -BW / 2 + 1.2 + k * 2.4
            K.rod(f"Beam{k}", (x, R.uniform(1.4, 2.2), FZ + BD - 0.6), (x + R.uniform(-0.8, 0.8), 0.25, FZ + R.uniform(0.8, 2.0)), 0.08, "sasCharred", "h", 6)
        K.lump("HeapIn", (0, 0.1, BZ), (BW * 0.3, 0.8, BD * 0.28), "rubble", "h", seed=seed + 2, rough=0.4)
        for k, (c, sz) in enumerate((((3.5, 0.1, FZ + 1.5), (1.2, 0.45, 0.8)), ((-3.0, 0.1, FZ + 3.5), (1.4, 0.5, 0.9)))):
            K.lump(f"TileHeap{k}", c, sz, "sasTile", "h", seed=seed + 30 + k, rough=0.5)
        for k in range(16):
            a = R.uniform(0, 6.28)
            K.lump(f"Rub{k}", (math.cos(a) * (BW / 2 + 1.2) * R.uniform(0.8, 1.1), 0.05, BZ + math.sin(a) * (BD / 2 + 1.2) * R.uniform(0.8, 1.1)), (R.uniform(0.12, 0.32), R.uniform(0.08, 0.2), R.uniform(0.12, 0.3)), "rubble", "h", seed=seed + k, sub=1)
    drystone.writeBuildOrder(K)   # (each face's SURFACE for the game's photo detail — algSangar surfaceMaterial; no build order: t 0)

WELL = (-6.5, -4.5)   # (the well's spot — algSangar loadSasPost dresses it with the props kit's well)
TYPES = {"sas": dict(builder=buildSas, states=("intact", "damaged", "ruin"), farRatio=0.3, atlas=2048, islandMargin=0.0005, aoDist=1.4)}

exported = buildKit(TYPES, MATDEF, "saspost.glb", prefix="Sas", seed0=1957, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 1200, 750
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far") or o.name.endswith("_Decal"): continue
    o.hide_render = False
    cd.lens = 32; cam.location = B(10.0, 17.0, -24.0); cam.rotation_euler = (B(0, 1.5, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
