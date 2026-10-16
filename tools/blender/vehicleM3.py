"""THE M3 HALF-TRACK IN BLENDER (2026-10-16, the pilot: you, "make better assets with Blender — start with
the M3; if you're not confident it'll look better, we waste time"). Built from the reference photos
(assets-src/refs/m3/) and the real dimensions — 6.2 m with the roller, 1.96 m wide over the body, the
body's top at 1.75 m (the procedural one stood 2.05 m: too tall, boxy). Run headless:

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \
      --python tools/blender/vehicleM3.py -- public/models/vehicles

  ARMOUR    the open-topped body (plates 4 cm thick to read, bevelled edges), the cab's front armour with
            its vision flaps, door outlines, the rear door; the bonnet; the radiator's LOUVRED armour,
            angled; the curved FENDERS sweeping back into the running boards; the bumper and roller
  RUNNING   the front wheels (8.25-20 tyres, hubs, lugs); each TRACK UNIT: the drive sprocket in front, the
            rear idler, the two bogies of two road wheels, two return rollers, the rubber band track
            looped round them with its grousers
  KIT       jerrycans, the tarpaulin rolled on the rack, the camouflage net on the fender, headlights and
            brush guards, the .50 on its pulpit over the cab (a separate object: it turns)
  BAKE      one texture: olive drab × baked ambient occlusion, dust and mud from the ground up, worn
            paint on the sharp edges, darker rubber and steel — the CoH read, no normal map needed
Writes <out>/m3.glb (Hull, Gear, Mount; +Z forward, real metres — the game scales ×1.3) and previews
<out>/../../../assets-src/refs/m3/blender_*.png beside the photos.
"""
import bpy, bmesh, sys, os, math, random
from mathutils import Vector, Matrix

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "public/models/vehicles")
os.makedirs(out, exist_ok=True)
REFS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "assets-src", "refs", "m3"))
random.seed(3)
bpy.ops.object.select_all(action="SELECT"); bpy.ops.object.delete()

# Coordinates: F forward (metres, + to the front), X across (+ his left), U up from the ground.
# Blender: forward is -Y (the glTF export turns it to +Z).
def V(F, X, U): return Vector((X, -F, U))

def obj(name, bm, mat=None, smooth=False):
    m = bpy.data.meshes.new(name); bm.to_mesh(m); bm.free()
    o = bpy.data.objects.new(name, m); bpy.context.scene.collection.objects.link(o)
    if mat: o.data.materials.append(MAT[mat])
    for p in o.data.polygons: p.use_smooth = smooth
    return o
def bevel(o, w=0.012, seg=2, angle=40):
    b = o.modifiers.new("B", "BEVEL"); b.width = w; b.segments = seg; b.limit_method = "ANGLE"; b.angle_limit = math.radians(angle)
    b.harden_normals = False
    return o
def box(name, f0, f1, x0, x1, u0, u1, mat="paint", w=0.012):
    bm = bmesh.new()
    vs = [bm.verts.new(V(f, x, u)) for f in (f0, f1) for x in (x0, x1) for u in (u0, u1)]
    bmesh.ops.convex_hull(bm, input=vs)
    return bevel(obj(name, bm, mat), w)
def hull_of(name, pts, mat="paint", w=0.012):
    """A convex solid through points (F, X, U)."""
    bm = bmesh.new()
    vs = [bm.verts.new(V(*p)) for p in pts]
    bmesh.ops.convex_hull(bm, input=vs)
    return bevel(obj(name, bm, mat), w)
def cyl(name, F, X, U, r, length, axis="X", segs=24, mat="paint", w=0.008, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segs, radius1=r, radius2=r2 if r2 is not None else r, depth=length)
    rot = {"X": Matrix.Rotation(math.pi / 2, 4, "Y"), "F": Matrix.Rotation(math.pi / 2, 4, "X"), "U": Matrix.Identity(4)}[axis]
    bmesh.ops.transform(bm, matrix=Matrix.Translation(V(F, X, U)) @ rot, verts=bm.verts)
    return bevel(obj(name, bm, mat, smooth=True), w, 2, 30)

def mat(name, rgb, rough=0.8, metal=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1); b.inputs["Roughness"].default_value = rough; b.inputs["Metallic"].default_value = metal
    return m
def srgb(h): return tuple(((h >> s & 255) / 255) ** 2.2 for s in (16, 8, 0))
MAT = {
    "paint": mat("Paint", srgb(0x4f5236)),       # olive drab, a little faded
    "dark": mat("DarkSteel", srgb(0x2a2b25), 0.6),
    "rubber": mat("Rubber", srgb(0x1c1b19), 0.95),
    "canvas": mat("Canvas", srgb(0x6b6448), 0.95),
    "net": mat("Net", srgb(0x4a4630), 1.0),
    "glass": mat("Lens", srgb(0xb8b6a8), 0.2),
}

parts = {"hull": [], "gear": [], "mount": []}
H = parts["hull"].append; G = parts["gear"].append; M = parts["mount"].append

# ── THE BODY: open-topped armour, cab and crew compartment ──────────────────
BF0, BF1 = 1.22, -3.02          # body front (the cab's front plate) and rear
BW = 0.98                       # half width over the plates
BU0, BU1 = 0.78, 1.75           # its bottom and the top of its sides
T = 0.035                       # plate thickness (real ~6 mm: drawn up to read)
H(box("Floor", BF1, BF0, -BW, BW, BU0, BU0 + 0.06))
for s in (-1, 1):
    # the side: the cab's door section lower (its folding armour down), the compartment full height
    H(box(f"SideRear{s}", BF1, 0.32, s * BW - T, s * BW, BU0, BU1))
    H(box(f"SideCab{s}", 0.32, BF0, s * BW - T, s * BW, BU0, 1.58))
    # door outline: a raised frame + hinge strips
    H(box(f"DoorEdge{s}", 0.36, 0.40, s * BW, s * (BW + 0.008), 0.95, 1.55, "paint", 0.004))
    H(box(f"DoorEdgeF{s}", 1.14, 1.18, s * BW, s * (BW + 0.008), 0.95, 1.55, "paint", 0.004))
    for u in (1.05, 1.42):
        H(box(f"Hinge{s}{u}", 1.08, 1.2, s * BW, s * (BW + 0.014), u, u + 0.04, "dark", 0.004))
    # the rolled top edge of the compartment side (a lip)
    H(box(f"Lip{s}", BF1, 0.32, s * (BW - T - 0.012), s * (BW + 0.006), BU1 - 0.02, BU1 + 0.012, "paint", 0.006))
    # rivet rows along the plates' joints
    for f in [BF1 + 0.1 + i * 0.32 for i in range(11)]:
        if f > 0.3: continue
        H(cyl(f"Rv{s}{f:.2f}", f, s * (BW + 0.004), BU1 - 0.06, 0.012, 0.012, "X", 6, "paint", 0.002))
        H(cyl(f"Rb{s}{f:.2f}", f, s * (BW + 0.004), BU0 + 0.06, 0.012, 0.012, "X", 6, "paint", 0.002))
H(box("Rear", BF1, BF1 + T, -BW, BW, BU0, BU1))
H(box("RearDoor", BF1 - 0.01, BF1, -0.32, 0.32, 0.86, 1.62, "paint", 0.006))
H(box("RearDoorHandle", BF1 - 0.04, BF1 - 0.01, 0.18, 0.26, 1.2, 1.24, "dark", 0.004))
H(box("Seatback", -0.05, 0.05, -BW + T, BW - T, BU0, 1.35))         # the seats' backs behind the cab
# the cab's FRONT armour: the windshield plate, leaning back, with two vision flaps
H(hull_of("Windshield", [(BF0, -BW, 1.40), (BF0, BW, 1.40), (BF0 - 0.06, -BW, 1.96), (BF0 - 0.06, BW, 1.96),
                         (BF0 - T, -BW, 1.40), (BF0 - T, BW, 1.40), (BF0 - 0.06 - T, -BW, 1.96), (BF0 - 0.06 - T, BW, 1.96)]))
for x in (-0.45, 0.45):
    H(box(f"Flap{x}", BF0 + 0.005, BF0 + 0.022, x - 0.3, x + 0.3, 1.62, 1.72, "dark", 0.004))
    H(box(f"FlapHinge{x}", BF0 - 0.03, BF0 + 0.02, x - 0.32, x + 0.32, 1.74, 1.78, "paint", 0.004))
H(box("CabCowl", BF0 - 0.02, BF0 + 0.1, -BW, BW, 1.32, 1.42))

# ── THE BONNET and the RADIATOR armour ──────────────────────────────────────
NF = 2.48                        # the bonnet's front
H(hull_of("Bonnet", [(BF0, -0.52, 0.8), (BF0, 0.52, 0.8), (BF0, -0.5, 1.4), (BF0, 0.5, 1.4),
                     (NF, -0.48, 0.8), (NF, 0.48, 0.8), (NF, -0.46, 1.33), (NF, 0.46, 1.33)], w=0.02))
H(box("BonnetHinge", BF0, NF, -0.012, 0.012, 1.39, 1.425, "paint", 0.005))
# the louvred armour: leaning forward-out at the bottom
LF0, LF1, LU0, LU1 = NF, NF + 0.16, 0.74, 1.33
H(hull_of("LouvreFrame", [(LF1, -0.5, LU0), (LF1, 0.5, LU0), (NF, -0.5, LU1), (NF, 0.5, LU1),
                          (LF1 - 0.04, -0.5, LU0), (LF1 - 0.04, 0.5, LU0), (NF - 0.04, -0.5, LU1), (NF - 0.04, 0.5, LU1)], w=0.01))
for i in range(5):
    u = LU0 + 0.08 + i * 0.11
    f = LF1 + (NF - LF1) * (u - LU0) / (LU1 - LU0)
    H(hull_of(f"Louvre{i}", [(f + 0.03, -0.44, u), (f + 0.03, 0.44, u), (f - 0.03, -0.44, u + 0.05), (f - 0.03, 0.44, u + 0.05),
                             (f + 0.045, -0.44, u + 0.012), (f + 0.045, 0.44, u + 0.012), (f - 0.015, -0.44, u + 0.062), (f - 0.015, 0.44, u + 0.062)],
                  "dark", 0.004))
# headlights on their brush guards, either side of the radiator
for s in (-1, 1):
    H(cyl(f"Lamp{s}", NF + 0.08, s * 0.6, 1.2, 0.085, 0.1, "F", 16, "dark", 0.006))
    H(cyl(f"Lens{s}", NF + 0.135, s * 0.6, 1.2, 0.07, 0.01, "F", 16, "glass", 0.002))
    bm = bmesh.new()
    # the guard: a bent bar loop over the lamp
    pts = [V(NF + 0.02, s * 0.5, 1.05), V(NF + 0.2, s * 0.5, 1.2), V(NF + 0.2, s * 0.72, 1.32), V(NF + 0.05, s * 0.72, 1.36)]
    o = bpy.data.curves.new(f"Guard{s}", "CURVE"); o.dimensions = "3D"; o.bevel_depth = 0.012; o.bevel_resolution = 2
    sp = o.splines.new("POLY"); sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts): sp.points[i].co = (*p, 1)
    co = bpy.data.objects.new(f"Guard{s}", o); bpy.context.scene.collection.objects.link(co); co.data.materials.append(MAT["dark"])
    bm.free()
    H(co)

# ── FENDERS and RUNNING BOARDS ───────────────────────────────────────────────
WF, WR, WX = 2.22, 0.485, 0.815  # the front axle, the tyre radius, the wheel's track half-width
for s in (-1, 1):
    # THE MUDGUARD, a deep solid panel (the photos: a thin arc read as a wire): its profile — an arc over
    # the wheel from low in front, its crown, then sweeping down and back into the step at the cab — swept
    # across the wheel's width, with a deep OUTER SKIRT turned down along its whole length.
    prof = []
    for k in range(13):
        a = math.radians(15 + k * 10)              # 15° (front-low) → 135° (behind the crown)
        prof.append((WF + math.cos(a) * 0.58, WR + 0.06 + math.sin(a) * 0.58))
    # then sloping smoothly down and back to the step (ending the arc low made a V-kink behind the wheel)
    prof += [(WF - 0.62, 0.93), (BF0 + 0.12, 0.88), (BF0 - 0.04, 0.87)]
    X0, X1 = s * 0.6, s * 1.04
    bm = bmesh.new()
    top = [[bm.verts.new(V(f, x, u)) for f, u in prof] for x in (X0, X1)]
    skirt = [bm.verts.new(V(f, X1, u - 0.2)) for f, u in prof]   # (deep: it hides the tyre's top as the photos)
    under = [[bm.verts.new(V(f, x, u - 0.018)) for f, u in prof] for x in (X0, X1 - s * 0.018)]
    n = len(prof)
    for i in range(n - 1):
        bm.faces.new((top[0][i], top[0][i + 1], top[1][i + 1], top[1][i]))          # top
        bm.faces.new((top[1][i], top[1][i + 1], skirt[i + 1], skirt[i]))            # the skirt's outside
        bm.faces.new((under[0][i + 1], under[0][i], under[1][i], under[1][i + 1]))  # underside
        bm.faces.new((under[1][i + 1], under[1][i], skirt[i], skirt[i + 1]))        # the skirt's inside
        bm.faces.new((top[0][i + 1], top[0][i], under[0][i], under[0][i + 1]))      # inner edge
    for i in (0, n - 1):                                                             # the ends closed
        bm.faces.new((top[0][i], top[1][i], skirt[i], under[1][i], under[0][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    f_ = obj(f"Fender{s}", bm, "paint", smooth=True)
    H(bevel(f_, 0.008, 2, 40))
    # the running board / step along the body to the track
    H(box(f"Board{s}", -0.2, BF0 - 0.05, s * BW, s * 1.08, 0.82, 0.86, "paint", 0.006))

# the BUMPER and the ROLLER
H(box("Bumper", NF + 0.25, NF + 0.38, -0.98, 0.98, 0.5, 0.66, "paint", 0.015))
for s in (-1, 1):
    H(box(f"BumperArm{s}", NF - 0.1, NF + 0.3, s * 0.5, s * 0.6, 0.5, 0.64, "paint", 0.01))
    H(box(f"Hook{s}", NF + 0.37, NF + 0.45, s * 0.75, s * 0.8, 0.52, 0.62, "dark", 0.006))
H(cyl("Roller", NF + 0.55, 0, 0.6, 0.16, 1.24, "X", 24, "paint", 0.012))
for s in (-1, 1):
    H(box(f"RollerArm{s}", NF + 0.36, NF + 0.6, s * 0.62, s * 0.68, 0.5, 0.7, "paint", 0.008))

# ── FRONT WHEELS (the Gear: they turn) ──────────────────────────────────────
for s in (-1, 1):
    G(cyl(f"Tyre{s}", WF, s * WX, WR - 0.012, WR - 0.012, 0.26, "X", 32, "rubber", 0.05))
    for k in range(28):          # the tread blocks, alternating across (the military 8.25-20 pattern)
        a = k / 28 * math.tau; off = 0.055 if k % 2 else -0.055
        # (built about its own centre, turned to the tyre's surface, then placed: turned about the world
        # origin they flew off round the scene)
        tb = box(f"Tread{s}{k}", -0.03, 0.03, off - 0.055, off + 0.055, -0.009, 0.009, "rubber", 0.004)
        tb.matrix_world = Matrix.Translation(V(WF + math.cos(a) * (WR - 0.004), s * WX, WR + math.sin(a) * (WR - 0.004))) @ Matrix.Rotation(a - math.pi / 2, 4, "X")
        G(tb)
    G(cyl(f"Rim{s}", WF, s * (WX + 0.11), WR, 0.29, 0.06, "X", 24, "dark", 0.01))
    G(cyl(f"Hub{s}", WF, s * (WX + 0.15), WR, 0.11, 0.08, "X", 12, "dark", 0.01))
    for k in range(8):
        a = k / 8 * math.tau
        G(cyl(f"Lug{s}{k}", WF + math.cos(a) * 0.18, s * (WX + 0.145), WR + math.sin(a) * 0.18, 0.018, 0.03, "X", 6, "dark", 0.002))
    H(box(f"Axle{s}", WF - 0.05, WF + 0.05, s * 0.2, s * WX, WR - 0.05, WR + 0.05, "dark", 0.01))

# ── THE TRACK UNITS ──────────────────────────────────────────────────────────
TX0, TX1 = 0.70, 1.0              # inner/outer edge of the track (each side)
SPR = (-0.32, 0.43, 0.30)         # drive sprocket (F, U, r)
IDL = (-2.42, 0.38, 0.27)         # rear idler
ROAD = [(-0.92, 0.15), (-1.22, 0.15), (-1.58, 0.15), (-1.88, 0.15)]   # road wheels (F, r) on the ground
RET = [(-0.95, 0.70, 0.065), (-1.75, 0.70, 0.065)]
for s in (-1, 1):
    xm = s * (TX0 + TX1) / 2
    G(cyl(f"Sprocket{s}", SPR[0], xm, SPR[1], SPR[2], 0.24, "X", 24, "dark", 0.01))
    for k in range(10):          # its teeth
        a = k / 10 * math.tau
        G(box(f"Tooth{s}{k}", SPR[0] + math.cos(a) * SPR[2] - 0.02, SPR[0] + math.cos(a) * SPR[2] + 0.02, xm - 0.03, xm + 0.03,
              SPR[1] + math.sin(a) * SPR[2] - 0.02, SPR[1] + math.sin(a) * SPR[2] + 0.02, "dark", 0.003))
    G(cyl(f"Idler{s}", IDL[0], xm, IDL[1], IDL[2], 0.24, "X", 24, "dark", 0.01))
    G(cyl(f"IdlerHub{s}", IDL[0], s * (TX1 + 0.01), IDL[1], 0.09, 0.04, "X", 12, "dark", 0.004))
    for i, (f, r) in enumerate(ROAD):
        G(cyl(f"Road{s}{i}", f, xm, r + 0.02, r, 0.24, "X", 20, "rubber", 0.012))
        G(cyl(f"RoadHub{s}{i}", f, s * (TX1 + 0.005), r + 0.02, r * 0.55, 0.03, "X", 12, "dark", 0.004))
    for i, (f, u, r) in enumerate(RET):
        G(cyl(f"Ret{s}{i}", f, xm, u, r, 0.22, "X", 12, "dark", 0.006))
    # the bogie frames (two wheels each) and the suspension spring
    for i in (0, 2):
        f = (ROAD[i][0] + ROAD[i + 1][0]) / 2
        H(box(f"Bogie{s}{i}", f - 0.24, f + 0.24, s * (TX1 - 0.02), s * (TX1 + 0.03), 0.12, 0.36, "dark", 0.012))
        H(cyl(f"Spring{s}{i}", f, s * (TX1 + 0.01), 0.48, 0.05, 0.18, "U", 10, "dark", 0.005))
    H(box(f"TrackFrame{s}", IDL[0], SPR[0], s * (TX0 + 0.04), s * (TX1 - 0.04), 0.5, 0.62, "dark", 0.01))
    # THE TRACK: a closed loop round the sprocket, the idler and under the road wheels, 0.3 m wide, grousers
    loop = []
    for k in range(13):          # over the sprocket's front-top
        a = math.radians(-60 + k * 10)
        loop.append((SPR[0] + math.cos(a) * (SPR[2] + 0.03), SPR[1] + math.sin(a) * (SPR[2] + 0.03)))
    loop += [(-1.2, 0.80), ]     # the top run, sagging a little onto the return rollers
    for k in range(13):          # round the idler's back
        a = math.radians(70 + k * 12)
        loop.append((IDL[0] + math.cos(a) * (IDL[2] + 0.03), IDL[1] + math.sin(a) * (IDL[2] + 0.03)))
    loop += [(-2.15, 0.005), (-1.9, 0.0), (-0.95, 0.0), (-0.62, 0.02)]
    # resample evenly
    pts = [Vector(p) for p in loop]; pts.append(pts[0])
    L = sum((pts[i + 1] - pts[i]).length for i in range(len(pts) - 1))
    N = 165; step = L / N; even = []; acc = 0.0; i = 0; cur = pts[0].copy()
    seg_left = (pts[1] - pts[0]).length
    for k in range(N):
        even.append(cur.copy())
        d = step
        while d > 0:
            seg = pts[i + 1] - cur; sl = seg.length
            if sl >= d: cur = cur + seg.normalized() * d; d = 0
            else: d -= sl; i += 1; cur = pts[i].copy()
            if i >= len(pts) - 1: break
    bm = bmesh.new(); ring = []
    cen = sum(even, Vector((0, 0))) / len(even)
    for k, p in enumerate(even):
        nrm = (p - cen).normalized()
        g = 0.012 if k % 3 == 0 else 0.0     # grousers: a low cleat every third link
        out_ = p + nrm * g
        ring.append([bm.verts.new(V(q.x, x, q.y)) for q in (p - nrm * 0.035, out_) for x in (s * TX0, s * TX1)])
    for k in range(N):
        a, b = ring[k], ring[(k + 1) % N]
        bm.faces.new((a[1], b[1], b[3], a[3]))    # outer face
        bm.faces.new((a[0], a[2], b[2], b[0]))    # inner face
        bm.faces.new((a[0], b[0], b[1], a[1]))    # inner edge (x0)
        bm.faces.new((a[2], a[3], b[3], b[2]))    # outer edge (x1)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    G(obj(f"Track{s}", bm, "rubber"))

# ── KIT ──────────────────────────────────────────────────────────────────────
def jerry(name, F, X, U, rot=0.0):
    o = box(name, F - 0.17, F + 0.17, X - 0.08, X + 0.08, U, U + 0.47, "paint", 0.02)
    o.rotation_euler.z = rot
    return o
for s in (-1, 1):
    H(jerry(f"Jerry{s}", -2.4, s * (BW + 0.1), 1.1))
    H(box(f"JerryRack{s}", -2.62, -2.18, s * (BW + 0.005), s * (BW + 0.02), 1.08, 1.5, "dark", 0.005))
    # the mine rack boxes along the compartment's side
    H(box(f"MineRack{s}", -1.8, -0.3, s * (BW + 0.005), s * (BW + 0.12), 1.0, 1.22, "paint", 0.012))
# the tarpaulin rolled across the rear, the net heaped on the left fender
H(cyl("Tarp", -2.85, 0, 1.86, 0.14, 1.7, "X", 16, "canvas", 0.03))
for k in range(3):
    H(cyl(f"Strap{k}", -2.85, -0.6 + k * 0.6, 1.86, 0.148, 0.04, "X", 16, "dark", 0.003))
bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=3, radius=1.0)
for v in bm.verts: v.co = V(1.72 + v.co.x * 0.4, 0.84 + v.co.y * 0.16, 1.07 + max(-0.15, v.co.z) * 0.06)   # (a heap draped flat on the fender's crown)
for v in bm.verts: v.co += Vector((random.uniform(-1, 1) * 0.02, random.uniform(-1, 1) * 0.02, random.uniform(-1, 1) * 0.02))
H(obj("Net", bm, "net", smooth=True))

# ── THE .50 ON ITS PULPIT (the Mount: it turns about its ring) ──────────────
MP = (0.6, 0.45, 2.42)             # pivot (F, X, U)
M(cyl("Ring", MP[0], MP[1], MP[2] - 0.05, 0.36, 0.05, "U", 32, "dark", 0.006))
M(cyl("RingInner", MP[0], MP[1], MP[2] - 0.05, 0.32, 0.06, "U", 32, "dark", 0.006))
M(box("Cradle", MP[0] - 0.08, MP[0] + 0.2, MP[1] - 0.06, MP[1] + 0.06, MP[2] - 0.02, MP[2] + 0.12, "dark", 0.008))
M(box("Receiver", MP[0] - 0.25, MP[0] + 0.3, MP[1] - 0.06, MP[1] + 0.06, MP[2] + 0.08, MP[2] + 0.22, "dark", 0.008))
M(cyl("Barrel", MP[0] + 0.85, MP[1], MP[2] + 0.15, 0.03, 1.1, "F", 12, "dark", 0.004))
M(cyl("Jacket", MP[0] + 0.5, MP[1], MP[2] + 0.15, 0.045, 0.4, "F", 12, "dark", 0.004))
M(box("AmmoBox", MP[0] - 0.05, MP[0] + 0.2, MP[1] + 0.07, MP[1] + 0.2, MP[2] + 0.02, MP[2] + 0.18, "paint", 0.008))
# the pulpit (fixed): its posts from the cab
for x in (MP[1] - 0.3, MP[1] + 0.3):
    H(box(f"Pulpit{x:.2f}", MP[0] - 0.03, MP[0] + 0.03, x - 0.03, x + 0.03, 1.4, MP[2] - 0.08, "dark", 0.006))

# ── Join each group, apply modifiers ─────────────────────────────────────────
dg = bpy.context.evaluated_depsgraph_get()
def join(name, objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        if o.type == "CURVE":
            bpy.context.view_layer.objects.active = o; o.select_set(True); bpy.ops.object.convert(target="MESH"); o.select_set(False)
    for o in objs:
        bpy.context.view_layer.objects.active = o
        for m in list(o.modifiers): bpy.ops.object.modifier_apply(modifier=m.name)
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    j = bpy.context.view_layer.objects.active; j.name = name
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return j
hull = join("Hull", parts["hull"]); gear = join("Gear", parts["gear"]); mount = join("Mount", parts["mount"])
def tris(o): return sum(len(p.vertices) - 2 for p in o.data.polygons)
print("TRIS", {o.name: tris(o) for o in (hull, gear, mount)})
for o in (hull, gear, mount):
    for p in o.data.polygons:
        if len(p.vertices) > 4 or o is not hull: pass
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(35))

# ── THE BAKE: one texture per piece — paint × ambient occlusion, dust from the ground up, worn edges ──
# Each material's colour becomes a node tree: its base, darkened toward the ground by dust and mud
# (position Z), brightened to bare steel on sharp edges (Cycles' pointiness), then Cycles bakes it
# (DIFFUSE colour) and the AO, multiplied into the texture. No normal map: the shading is in the colour.
scn = bpy.context.scene
scn.render.engine = "CYCLES"; scn.cycles.device = "CPU"; scn.cycles.samples = 64
scn.render.bake.margin = 6
DUST = srgb(0x6b5a40)
for m in MAT.values():
    nt = m.node_tree; N_ = nt.nodes; L_ = nt.links
    bsdf = N_["Principled BSDF"]; base = tuple(bsdf.inputs["Base Color"].default_value)
    geo = N_.new("ShaderNodeNewGeometry"); sep = N_.new("ShaderNodeSeparateXYZ"); L_.new(geo.outputs["Position"], sep.inputs[0])
    # dust: full at the ground, gone by 0.9 m (and a little everywhere: 0.15)
    dz = N_.new("ShaderNodeMapRange"); dz.inputs["From Min"].default_value = 0.05; dz.inputs["From Max"].default_value = 0.9
    dz.inputs["To Min"].default_value = 0.75; dz.inputs["To Max"].default_value = 0.12; L_.new(sep.outputs["Z"], dz.inputs["Value"])
    noise = N_.new("ShaderNodeTexNoise"); noise.inputs["Scale"].default_value = 6.0; noise.inputs["Detail"].default_value = 8
    mul = N_.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; L_.new(dz.outputs["Result"], mul.inputs[0]); L_.new(noise.outputs["Fac"], mul.inputs[1])
    mul2 = N_.new("ShaderNodeMath"); mul2.operation = "MULTIPLY"; mul2.inputs[1].default_value = 1.6; L_.new(mul.outputs[0], mul2.inputs[0])
    mixd = N_.new("ShaderNodeMix"); mixd.data_type = "RGBA"; mixd.clamp_factor = True
    mixd.inputs["A"].default_value = base; mixd.inputs["B"].default_value = (*DUST, 1)
    L_.new(mul2.outputs[0], mixd.inputs["Factor"])
    # worn edges: pointiness → bare dark steel peeking through on the paint (not on rubber/canvas)
    cur = mixd.outputs["Result"]
    if m.name in ("Paint",):
        pr = N_.new("ShaderNodeMapRange"); pr.inputs["From Min"].default_value = 0.53; pr.inputs["From Max"].default_value = 0.6
        L_.new(geo.outputs["Pointiness"], pr.inputs["Value"])
        n2 = N_.new("ShaderNodeTexNoise"); n2.inputs["Scale"].default_value = 30.0
        wm = N_.new("ShaderNodeMath"); wm.operation = "MULTIPLY"; L_.new(pr.outputs["Result"], wm.inputs[0]); L_.new(n2.outputs["Fac"], wm.inputs[1])
        mixw = N_.new("ShaderNodeMix"); mixw.data_type = "RGBA"; mixw.clamp_factor = True
        L_.new(cur, mixw.inputs["A"]); mixw.inputs["B"].default_value = (*srgb(0x7c7a68), 1)
        L_.new(wm.outputs[0], mixw.inputs["Factor"]); cur = mixw.outputs["Result"]
        # faded paint: a large soft variation over the plates
        n3 = N_.new("ShaderNodeTexNoise"); n3.inputs["Scale"].default_value = 1.5
        mixf = N_.new("ShaderNodeMix"); mixf.data_type = "RGBA"; mixf.blend_type = "OVERLAY"; mixf.inputs["Factor"].default_value = 0.25
        L_.new(cur, mixf.inputs["A"]); L_.new(n3.outputs["Color"], mixf.inputs["B"]); cur = mixf.outputs["Result"]
    L_.new(cur, bsdf.inputs["Base Color"])
import numpy as np
SIZE = {"Hull": 2048, "Gear": 1024, "Mount": 512}
for o in (hull, gear, mount):
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.006)
    bpy.ops.object.mode_set(mode="OBJECT")
    S_ = SIZE[o.name]
    imgs = {}
    for kind in ("col", "ao"):
        img = bpy.data.images.new(f"{o.name}_{kind}", S_, S_, alpha=False)
        for m in o.data.materials:
            tn = m.node_tree.nodes.get("BakeTarget") or m.node_tree.nodes.new("ShaderNodeTexImage")
            tn.name = "BakeTarget"; tn.image = img; m.node_tree.nodes.active = tn
        if kind == "col":
            scn.render.bake.use_pass_direct = False; scn.render.bake.use_pass_indirect = False; scn.render.bake.use_pass_color = True
            bpy.ops.object.bake(type="DIFFUSE")
        else:
            bpy.ops.object.bake(type="AO")
        imgs[kind] = img
    c = np.array(imgs["col"].pixels[:]).reshape(-1, 4); a = np.array(imgs["ao"].pixels[:]).reshape(-1, 4)
    ao = 0.38 + 0.62 * a[:, :1]                     # (softened: the game lights it too)
    c[:, :3] *= ao
    out_img = bpy.data.images.new(f"{o.name}_tex", S_, S_, alpha=False)
    out_img.pixels = c.ravel().tolist()
    out_img.filepath_raw = os.path.join(REFS, f"m3_{o.name.lower()}.png"); out_img.file_format = "PNG"; out_img.save()
    # one plain material carrying the baked texture
    bm_ = bpy.data.materials.new(f"M3_{o.name}"); bm_.use_nodes = True
    tn = bm_.node_tree.nodes.new("ShaderNodeTexImage"); tn.image = out_img
    pb = bm_.node_tree.nodes["Principled BSDF"]; pb.inputs["Roughness"].default_value = 0.85
    bm_.node_tree.links.new(tn.outputs["Color"], pb.inputs["Base Color"])
    o.data.materials.clear(); o.data.materials.append(bm_)
    print("BAKED", o.name, S_)
bpy.ops.object.select_all(action="DESELECT")
for o in (hull, gear, mount): o.select_set(True)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, "m3.glb"), use_selection=True, export_yup=True, export_materials="EXPORT", export_image_format="JPEG")
print("GLB", os.path.join(out, "m3.glb"))

# ── Previews (workbench, materials) ─────────────────────────────────────────
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"; sh.show_cavity = True; sh.cavity_type = "BOTH"
scn.render.resolution_x, scn.render.resolution_y = 1100, 700
cd = bpy.data.cameras.new("C"); cam = bpy.data.objects.new("C", cd); scn.collection.objects.link(cam); scn.camera = cam
def shot(name, frm, tgt=(0.0, 0.0, 0.95), lens=40):
    cd.lens = lens; cam.location = Vector(frm); cam.rotation_euler = (Vector(tgt) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(REFS, f"blender_{name}.png"); bpy.ops.render.render(write_still=True)
shot("side", V(0.0, 9.5, 1.3))                      # like m3_1 (his left side)
shot("front34", V(6.5, 5.5, 2.4), lens=38)          # like m3_2 / m3_7
shot("rear34", V(-6.5, -5.0, 3.0), lens=38)
shot("rts", V(-9.0, 12.0, 15.0), lens=45)

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "m3.blend"))
print("DONE")
