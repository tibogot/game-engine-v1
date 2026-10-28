"""THUNDERLINE — THE CHEVRON SIGN (2026-10-28, user: "it should have bevel; and the chevron itself should be with digital
dots … my old assets in the old car game … cool dotted digital … same concept but better assets"). A trackside LED cabinet
at the old panel's size (obstacles.js PANEL: 3.4 × 4.6 × 0.35 m, its foot 1 m under the road): a bevelled black
powder-coated housing, a front bezel framing two LED modules (the dots are the game's shader: v3 ledMatrix.js, chevron
mode, on the ChevronLED quads), a sun hood over each module, a hazard-taped foot bar, bolts; at the back a service door
with vents and hinges; a galvanised arm back under the road's edge. Authored as the RIGHT side's sign (the arm and the
chevrons toward −x, the road); the left side's is its mirror (made in the game).

  ChevronLOD0  everything                       ChevronLOD1  no bolts / vents / hinges / flange bolts
  ChevronLOD2  plain boxes: housing, hoods, arm  ChevronLED   the two LED faces (UV 0..1 each, u toward the road)

The texture is baked from LOD0 (masks from Cycles: material, position, 3D noises, an edge mask → painted in numpy);
LOD1 is LOD0 less its small parts (the same UVs), LOD2 takes LOD0's UVs by nearest-face transfer.
"""
import sys, os, math
sys.path.append(os.path.dirname(__file__))
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix
import thunderKit as T

T.reset()
S = T.S
W, H, D = 3.4, 4.6, 0.35                  # the panel (physics: obstacles.js PANEL)
Y0 = -1.0                                 # its foot, under the road's level
ZB, ZF = -0.175, 0.115                    # the housing's back, its front (the bezel stands to +0.175)
ZBZ = 0.175
OX0, OX1 = -W / 2 + 0.17, W / 2 - 0.17    # the openings
OY = [(Y0 + 0.20, Y0 + 2.20), (Y0 + 2.34, Y0 + 4.34)]   # the two modules (2.0 m each), the mullion between
LEDZ = ZF + 0.012                         # the LED faces: 12 mm in front of the housing, 48 mm behind the bezel
MATS = ["coat", "galv", "tape", "bolt"]
mats = [bpy.data.materials.new(n) for n in MATS]

def G(x, y, z): return Vector((x, -z, y))   # game (x right, y up, z toward the car) → Blender

PARTS = []   # (object, small)

def block(x0, x1, y0, y1, z0, z1, mat, bev=0.0, seg=1, small=False, rot=None, pivot=None, front_mat=None):
    """A box in game coordinates, bevelled (bev m, seg segments); rot: (axis 'x'|'y'|'z', radians) about pivot."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        gx = (x0 + x1) / 2 + v.co.x * (x1 - x0); gy = (y0 + y1) / 2 + v.co.y * (y1 - y0); gz = (z0 + z1) / 2 + v.co.z * (z1 - z0)
        v.co = Vector((gx, gy, gz))   # (game coordinates for now)
    if bev > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bev, offset_type="OFFSET", segments=seg, profile=0.5, affect="EDGES", clamp_overlap=True)
    for f in bm.faces: f.material_index = MATS.index(mat)
    if front_mat:
        bm.normal_update()
        for f in bm.faces:
            if f.normal.z > 0.99: f.material_index = MATS.index(front_mat)
    if rot:
        ax, a = rot; P = Vector(pivot)
        R = Matrix.Rotation(a, 4, ax.upper())
        for v in bm.verts: v.co = P + (R @ (v.co - P).to_4d()).to_3d()
    for v in bm.verts: v.co = G(*v.co)
    return _obj(bm, small)

def cyl(cx, cy, cz, r, h, axis, mat, n=8, small=True):
    """A cylinder (game coordinates), its axis 'x' | 'y' | 'z', centred on (cx, cy, cz)."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=n, radius1=r, radius2=r, depth=h)
    for v in bm.verts:
        x, y, z = v.co   # (axis along z)
        if axis == "z": g = (cx + x, cy + y, cz + z)
        elif axis == "y": g = (cx + x, cy + z, cz + y)
        else: g = (cx + z, cy + y, cz + x)
        v.co = G(*g)
    for f in bm.faces: f.material_index = MATS.index(mat)
    return _obj(bm, small)

def _obj(bm, small):
    me = bpy.data.meshes.new("P"); bm.normal_update(); bm.to_mesh(me); bm.free()
    for m in mats: me.materials.append(m)
    o = bpy.data.objects.new("P", me); bpy.context.scene.collection.objects.link(o)
    PARTS.append((o, small))
    return o

# ── THE HOUSING ───────────────────────────────────────────────────────────────────────────────────────────────────
block(-W / 2, W / 2, Y0, Y0 + H, ZB, ZF, "coat", bev=0.05, seg=3)
# the bezel: top / foot bars, the sides, the mullion (standing 60 mm proud of the housing)
block(-W / 2, W / 2, OY[1][1], Y0 + H, ZF - 0.01, ZBZ, "coat", bev=0.022, seg=2)
block(-W / 2, W / 2, Y0, OY[0][0], ZF - 0.01, ZBZ, "coat", bev=0.022, seg=2, front_mat="tape")   # (hazard tape on its face)
for x0, x1 in ((-W / 2, OX0), (OX1, W / 2)):
    block(x0, x1, OY[0][0] - 0.01, OY[1][1] + 0.01, ZF - 0.01, ZBZ, "coat", bev=0.022, seg=2)
block(OX0 - 0.01, OX1 + 0.01, OY[0][1], OY[1][0], ZF - 0.01, ZBZ, "coat", bev=0.022, seg=2)
# the sun hoods: a plate out from each module's top, sloping down 12°, a cheek at each end
for (y0, y1) in OY:
    block(OX0, OX1, y1 - 0.014, y1, ZBZ - 0.02, ZBZ + 0.24, "coat", bev=0.004, seg=1, rot=("x", math.radians(12)), pivot=(0, y1, ZBZ))
    for x in (OX0 + 0.004, OX1 - 0.004):
        block(x - 0.006, x + 0.006, y1 - 0.12, y1, ZBZ - 0.02, ZBZ + 0.2, "coat", bev=0.002, seg=1)
# bolts round the bezel (hex heads)
for x in (-W / 2 + 0.085, 0.0, W / 2 - 0.085):
    for y in (Y0 + 0.10, (OY[0][1] + OY[1][0]) / 2, Y0 + H - 0.13):
        if x == 0.0 and y == (OY[0][1] + OY[1][0]) / 2: continue
        cyl(x, y, ZBZ + 0.006, 0.02, 0.012, "z", "bolt", n=6)
for y in (Y0 + 1.2, Y0 + 2.27, Y0 + 3.35):
    for x in (-W / 2 + 0.085, W / 2 - 0.085): cyl(x, y, ZBZ + 0.006, 0.02, 0.012, "z", "bolt", n=6)

# ── THE BACK: a service door (20 mm proud), its vents, hinges, the lock ──────────────────────────────────────────────
DX0, DX1, DY0, DY1 = -W / 2 + 0.2, W / 2 - 0.2, Y0 + 0.2, Y0 + H - 0.2
block(DX0, DX1, DY0, DY1, ZB - 0.02, ZB + 0.005, "coat", bev=0.008, seg=2)
for yv in (DY0 + 0.25, DY1 - 0.55):
    for k in range(7):
        y = yv + k * 0.045
        block(-0.6, 0.6, y, y + 0.012, ZB - 0.07, ZB - 0.015, "coat", bev=0.0, seg=1, small=True, rot=("x", math.radians(-35)), pivot=(0, y, ZB - 0.02))
for y in (DY0 + 0.4, (DY0 + DY1) / 2, DY1 - 0.4):
    cyl(DX0 - 0.01, y, ZB - 0.035, 0.022, 0.2, "y", "galv", n=8)
block(DX1 - 0.16, DX1 - 0.06, (DY0 + DY1) / 2 - 0.08, (DY0 + DY1) / 2 + 0.08, ZB - 0.05, ZB - 0.015, "galv", bev=0.006, seg=1, small=True)

# ── THE ARM back under the road's edge (galvanised box section, a flange plate each end) ─────────────────────────────
AY = -0.6
AX1 = -W / 2 - 1.35                       # (0.15 m under the deck's edge: obstacles.js PANEL.gap 1.2)
block(AX1, -W / 2 - 0.02, AY - 0.13, AY + 0.13, -0.1, 0.1, "galv", bev=0.012, seg=2)
for x in (-W / 2 - 0.02, AX1):
    block(x - 0.012, x + 0.012, AY - 0.22, AY + 0.22, -0.2, 0.2, "galv", bev=0.004, seg=1)
    for dy in (-0.16, 0.16):
        for dz in (-0.14, 0.14):
            cyl(x - 0.025 if x > AX1 else x + 0.025, AY + dy, dz, 0.016, 0.03, "x", "bolt", n=6)
# a gusset under the arm (a triangle plate, as a thin wedge)
bm = bmesh.new()
tri = [(-W / 2 - 0.02, AY - 0.13), (-W / 2 - 0.02, AY - 0.5), (-W / 2 - 0.42, AY - 0.13)]
vs = [bm.verts.new(G(x, y, z)) for z in (-0.008, 0.008) for (x, y) in tri]
bm.faces.new((vs[0], vs[1], vs[2])); bm.faces.new((vs[5], vs[4], vs[3]))
for a, b in ((0, 1), (1, 2), (2, 0)): bm.faces.new((vs[a], vs[a + 3], vs[b + 3], vs[b]))
for f in bm.faces: f.material_index = MATS.index("galv")
_obj(bm, False)

# ── JOIN → LOD0 (small parts tagged), UNWRAP ─────────────────────────────────────────────────────────────────────────
def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active; o.name = name; o.data.name = name
    return o

for o, small in PARTS:
    a = o.data.attributes.new("small", "INT", "FACE")
    a.data.foreach_set("value", [1 if small else 0] * len(o.data.polygons))
lod0 = join([o for o, _ in PARTS], "ChevronLOD0")
lod0.data.set_sharp_from_angle(angle=math.radians(40))
bpy.context.view_layer.objects.active = lod0; lod0.select_set(True)
bpy.ops.object.mode_set(mode="EDIT"); bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004, area_weight=0.0, scale_to_bounds=False)
bpy.ops.object.mode_set(mode="OBJECT")

# LOD1: LOD0 less its small parts (the same UVs)
lod1 = lod0.copy(); lod1.data = lod0.data.copy(); lod1.name = lod1.data.name = "ChevronLOD1"
bpy.context.scene.collection.objects.link(lod1)
bm = bmesh.new(); bm.from_mesh(lod1.data)
lay = bm.faces.layers.int.get("small")
bmesh.ops.delete(bm, geom=[f for f in bm.faces if f[lay] == 1], context="FACES")
bm.to_mesh(lod1.data); bm.free()

# LOD2: plain boxes (housing, the bezel as one slab, hoods, arm); UVs from LOD0's nearest face
PARTS.clear()
block(-W / 2, W / 2, Y0, Y0 + H, ZB, ZF, "coat")
for (y0, y1) in OY:
    block(OX0, OX1, y1 - 0.014, y1, ZBZ - 0.02, ZBZ + 0.24, "coat", rot=("x", math.radians(12)), pivot=(0, y1, ZBZ))
block(-W / 2, W / 2, Y0, OY[0][0], ZF - 0.01, ZBZ, "coat", front_mat="tape")
block(-W / 2, W / 2, OY[1][1], Y0 + H, ZF - 0.01, ZBZ, "coat")
for x0, x1 in ((-W / 2, OX0), (OX1, W / 2)): block(x0, x1, OY[0][0], OY[1][1], ZF - 0.01, ZBZ, "coat")
block(OX0, OX1, OY[0][1], OY[1][0], ZF - 0.01, ZBZ, "coat")
block(AX1, -W / 2, AY - 0.13, AY + 0.13, -0.1, 0.1, "galv")
lod2 = join([o for o, _ in PARTS], "ChevronLOD2")
lod2.data.uv_layers.new(name="UVMap")
dt = lod2.modifiers.new("UV", "DATA_TRANSFER"); dt.object = lod0
dt.use_loop_data = True; dt.data_types_loops = {"UV"}; dt.loop_mapping = "POLYINTERP_NEAREST"
bpy.context.view_layer.objects.active = lod2; bpy.ops.object.modifier_apply(modifier="UV")
lod2.data.set_sharp_from_angle(angle=math.radians(40))

# THE LED FACES: one quad per module, UV 0..1, u running toward the road (−x: u = 1 at the inner edge)
me = bpy.data.meshes.new("ChevronLED"); bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UV")
for (y0, y1) in OY:
    vs = [bm.verts.new(G(x, y, LEDZ)) for (x, y) in ((OX0, y0), (OX1, y0), (OX1, y1), (OX0, y1))]
    f = bm.faces.new(vs)
    for loop in f.loops:
        x, y = loop.vert.co.x, loop.vert.co.z
        loop[uvl].uv = (1 - (x - OX0) / (OX1 - OX0), (y - y0) / (y1 - y0))
bm.normal_update(); bm.to_mesh(me); bm.free()
led = bpy.data.objects.new("ChevronLED", me); bpy.context.scene.collection.objects.link(led)
for o in (lod0, lod1, lod2, led): print("TRIS", o.name, T.tris(o))

# ── THE TEXTURE: masks baked from LOD0 by Cycles, painted here ──────────────────────────────────────────────────────
def bake_emit(o, build):
    """Bake an emission (built per material by build(nt, mat_name) → a colour socket) into a float S×S×3."""
    scn = bpy.context.scene; scn.render.engine = "CYCLES"; scn.cycles.samples = 4; scn.cycles.device = "CPU"
    img = bpy.data.images.new("M", S, S, float_buffer=True)
    for m in mats:
        m.use_nodes = True; nt = m.node_tree; nt.nodes.clear()
        out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission")
        nt.links.new(build(nt, m.name), em.inputs["Color"]); nt.links.new(em.outputs[0], out.inputs["Surface"])
        tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img; nt.nodes.active = tex
    others = [x for x in scn.objects if x is not o and not x.hide_render]
    for x in others: x.hide_render = True
    bpy.ops.object.select_all(action="DESELECT"); o.select_set(True); bpy.context.view_layer.objects.active = o
    bpy.ops.object.bake(type="EMIT", margin=6, use_clear=True)
    for x in others: x.hide_render = False
    return np.array(img.pixels[:], np.float32).reshape(S, S, 4)[..., :3]

def obj_co(nt):
    tc = nt.nodes.new("ShaderNodeTexCoord"); return tc.outputs["Object"]

def noise3(nt, scale, stretch=(1, 1, 1), detail=4.0, seed_off=0.0):
    co = obj_co(nt)
    vm = nt.nodes.new("ShaderNodeVectorMath"); vm.operation = "MULTIPLY"; vm.inputs[1].default_value = stretch
    nt.links.new(co, vm.inputs[0])
    va = nt.nodes.new("ShaderNodeVectorMath"); va.operation = "ADD"; va.inputs[1].default_value = (seed_off, seed_off * 1.7, seed_off * 2.3)
    nt.links.new(vm.outputs[0], va.inputs[0])
    n = nt.nodes.new("ShaderNodeTexNoise"); n.inputs["Scale"].default_value = scale; n.inputs["Detail"].default_value = detail
    nt.links.new(va.outputs[0], n.inputs["Vector"])
    return n.outputs["Fac"]

def combine(nt, r, g, b):
    c = nt.nodes.new("ShaderNodeCombineColor")
    for i, s in enumerate((r, g, b)):
        if isinstance(s, float): c.inputs[i].default_value = s
        else: nt.links.new(s, c.inputs[i])
    return c.outputs[0]

def edges(nt, radius=0.012):
    """1 − N·N_bevel: ~0 on a flat face, rising on a rounded edge (pointiness is per vertex: a big flat triangle
    interpolates its corners' and read as an edge all over)."""
    g = nt.nodes.new("ShaderNodeNewGeometry"); b = nt.nodes.new("ShaderNodeBevel"); b.samples = 8; b.inputs["Radius"].default_value = radius
    d = nt.nodes.new("ShaderNodeVectorMath"); d.operation = "DOT_PRODUCT"
    nt.links.new(g.outputs["Normal"], d.inputs[0]); nt.links.new(b.outputs["Normal"], d.inputs[1])
    m = nt.nodes.new("ShaderNodeMath"); m.operation = "SUBTRACT"; m.inputs[0].default_value = 1.0
    nt.links.new(d.outputs["Value"], m.inputs[1])
    return m.outputs[0]

lod0.hide_render = False
POS = bake_emit(lod0, lambda nt, m: obj_co(nt))                                            # Blender object coords
NZ = bake_emit(lod0, lambda nt, m: combine(nt, noise3(nt, 1.5), noise3(nt, 2.0, (40, 40, 1.2), 2.0, 3.0), noise3(nt, 30.0, (1, 1, 1), 2.0, 7.0)))
IDP = bake_emit(lod0, lambda nt, m: combine(nt, MATS.index(m) / 4.0 + 0.01, edges(nt), noise3(nt, 6.0, (1, 1, 1), 3.0, 11.0)))
ao = T.bake_ao(lod0, 0.25)
for m in mats: lod0.data.materials.append(m)   # (bake_ao cleared the slots: put them back for the export's face indices)

mid = np.clip(np.floor(IDP[..., 0] * 4 + 0.001).astype(int), 0, 3)
coat, galv, tape, bolt = (mid == 0), (mid == 1), (mid == 2), (mid == 3)
gx, gy, gz = POS[..., 0], POS[..., 2], -POS[..., 1]          # game coordinates
blot, streakN, fine = NZ[..., 0], NZ[..., 1], NZ[..., 2]
point, chipN = IDP[..., 1], IDP[..., 2]
def lin(hx): return np.array([((hx >> s & 255) / 255) ** 2.2 for s in (16, 8, 0)], np.float32)
COAT, ALU, DUST, GALV, YEL, BLK, RUST = lin(0x1d1f22), lin(0xa9adb1), lin(0x6b5d4c), lin(0x9ea3a6), lin(0xf2b705), lin(0x161616), lin(0x6a3a1e)

# dust and road grime: thick at the foot (the road's spray), patches up the face; pale dust streaks down from ledges
foot = T.smooth(0.2, -1.0, gy) * (0.55 + 0.45 * blot)
patch = T.smooth(0.55, 0.75, blot) * 0.35
streak = T.smooth(0.62, 0.8, streakN) * T.smooth(Y0 + H, Y0 + 2.0, gy) * 0.45
dirt = np.clip(foot + patch + streak, 0, 1)
# edge wear: the coat chipped to aluminium on the edges, in clusters
chip = coat * T.smooth(0.02, 0.08, point) * T.smooth(0.5, 0.65, chipN)
# hazard tape: yellow / black stripes at 45°, scuffed
stripe = ((gx + gy) / 0.16 % 1.0) < 0.5
tapewear = tape * T.smooth(0.6, 0.8, fine) * 0.6

col = np.zeros((S, S, 3), np.float32)
c_coat = COAT[None, None, :] * (0.85 + 0.3 * fine[..., None])
c_coat = c_coat * (1 - chip[..., None]) + ALU[None, None, :] * chip[..., None]
c_tape = np.where(stripe[..., None], YEL[None, None, :], BLK[None, None, :]) * (0.85 + 0.15 * fine[..., None])
c_tape = c_tape * (1 - tapewear[..., None]) + COAT[None, None, :] * tapewear[..., None]
c_galv = GALV[None, None, :] * (0.8 + 0.25 * fine[..., None]) * (0.85 + 0.25 * blot[..., None])
c_bolt = GALV[None, None, :] * 0.8
col = np.where(coat[..., None], c_coat, np.where(tape[..., None], c_tape, np.where(galv[..., None], c_galv, c_bolt)))
rustm = (bolt | galv) * T.smooth(0.7, 0.85, chipN) * 0.5
col = col * (1 - rustm[..., None]) + RUST[None, None, :] * rustm[..., None]
col = col * (1 - 0.75 * dirt[..., None]) + DUST[None, None, :] * 0.75 * dirt[..., None]
col = col * (0.55 + 0.45 * ao[..., None])
rough = np.where(coat, 0.5 + 0.12 * fine - 0.15 * chip, np.where(tape, 0.38 + 0.3 * tapewear, np.where(galv, 0.42 + 0.15 * blot, 0.4)))
rough = np.clip(rough + 0.4 * dirt + 0.2 * rustm, 0, 1)
metal = np.where(coat, chip, np.where(tape, 0.0, 1.0 - 0.6 * rustm)) * (1 - 0.85 * dirt)
arm = np.stack([ao, rough, np.clip(metal, 0, 1)], -1)
# the normal: orange peel on the coat, spangle on the galvanising (tiny: a texel is ~6 mm here)
h = (coat * 0.00015 * fine + (galv | bolt) * 0.0003 * fine + tape * 0.0002 * fine).astype(np.float32)
normal = T.normal_from_height(h, 1 / 170, 1 / 170)
imgC = T.save("chevron_color", col, True); imgN = T.save("chevron_normal", normal, False); imgA = T.save("chevron_arm", arm, False)

T.export((lod0, lod1, lod2, led), "chevron")

if not T.NOPREVIEW:
    mat = T.material("Chevron", imgC, imgN, imgA)
    for o in (lod0, lod1, lod2):
        o.data.materials.clear(); o.data.materials.append(mat)
    # the LED faces for the preview: amber dots, chevrons pointing to u = 1 (the road)
    N = 512; v, u = np.meshgrid((np.arange(N) + 0.5) / N, (np.arange(N) + 0.5) / N, indexing="ij")
    cols, rows = 36, 24
    cu, cv = (np.floor(u * cols) + 0.5) / cols, (np.floor(v * rows) + 0.5) / rows
    dots = np.hypot((u * cols % 1 - 0.5) * (OX1 - OX0) / cols / ((OY[0][1] - OY[0][0]) / rows), v * rows % 1 - 0.5) < 0.36
    lit = ((cu * 2 + np.abs(cv - 0.5) * 1.4) % 1.0) < 0.45
    px = np.zeros((N, N, 4), np.float32); px[..., 3] = 1
    px[..., 0] = dots * (0.03 + lit * 1.0); px[..., 1] = dots * (0.012 + lit * 0.35)
    li = bpy.data.images.new("LED", N, N, float_buffer=True); li.pixels.foreach_set(px.ravel())
    lm = bpy.data.materials.new("LED"); lm.use_nodes = True; nt = lm.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial"); em = nt.nodes.new("ShaderNodeEmission"); em.inputs["Strength"].default_value = 6
    tx = nt.nodes.new("ShaderNodeTexImage"); tx.image = li; tx.interpolation = "Closest"
    nt.links.new(tx.outputs[0], em.inputs["Color"]); nt.links.new(em.outputs[0], out.inputs["Surface"])
    led.data.materials.append(lm)
    scn, cam = T.preview_scene()
    for o in (lod0, led): o.location = (0, 0, 1.0)
    lod1.location = (6, 4, 1.0); lod2.location = (-6, 4, 1.0)
    T.shoot(scn, cam, "chevron_front", (2.5, -9.0, 2.8), (0, 0, 2.6))
    T.shoot(scn, cam, "chevron_close", (-0.4, -2.4, 3.6), (-1.0, 0, 3.2))
    T.shoot(scn, cam, "chevron_back", (-4.5, 6.5, 2.0), (-1.4, 0, 1.4))
print("DONE")
