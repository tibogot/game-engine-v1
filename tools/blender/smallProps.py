"""THE SMALL PROPS IN BLENDER (2026-10-22 — you: "the grenade … if we keep it don't you think we need to make one"):
the hand-held kit of the HUD's icons (and, later, close-ups in the game), built and baked like the buildings so the
icons are one set. Today:

  GRENADE   the F1 defensive grenade the French army carried (1950s): a cast-iron ovoid cut into 48 raised blocks
            (8 columns × 6 rings), olive paint worn off the blocks' edges to the iron, the brass fuze body on top, its
            steel collar, the spoon-shaped lever down the side hugging the body, the split pin through the fuze and
            its pull ring.

Real metres (tiny: 9 cm); the props are not scaled by the kit's 1.3 — houseMesh(type, state, 1).

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/smallProps.py -- <out dir> [--quick]

Writes <out>/smallprops.glb (Prop<Type>_<State> + _Far) — then tools/optimizeGlb.mjs.
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
from mathutils import Vector
import house
from house import buildKit
from bkit import B, srgb
import drystone
from drystone import tag

def paintWorn(base, metal):
    """Olive paint over iron: worn through where the "wear" attribute is high (the blocks' edges), a little rust in
    the grooves (low), dirt."""
    def f(nb):
        at = nb.N.new("ShaderNodeAttribute"); at.attribute_name = "wear"
        sep = nb.N.new("ShaderNodeSeparateColor"); nb.L.new(at.outputs["Color"], sep.inputs[0])
        w, groove = sep.outputs["Red"], sep.outputs["Green"]
        paint = nb.mix(nb.noise(60.0, 4), srgb(base), tuple(v * 0.82 for v in srgb(base)))
        chip = nb.math("MULTIPLY", nb.mr(w, 0.55, 0.9, 0.0, 1.0), nb.mr(nb.noise(220.0, 3), 0.42, 0.6, 0.0, 1.0))
        c = nb.mix(chip, paint, nb.mix(nb.noise(300.0, 2), srgb(metal), tuple(v * 0.7 for v in srgb(metal))))
        c = nb.mix(nb.math("MULTIPLY", groove, 0.55), c, srgb(0x3a2a1c))
        return nb.mix(nb.mr(nb.noise(25.0, 5), 0.58, 0.72, 0.0, 0.25), c, srgb(0x5a4a36))
    return f
def flatC(rgb, n=0.85):
    return lambda nb: nb.mix(nb.noise(120.0, 3), srgb(rgb), tuple(v * n for v in srgb(rgb)))
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "spBody": (0.55, paintWorn(0x4d5536, 0x6e6c66)), "spBrass": (0.32, flatC(0xb38a46, 0.8)),
    "spSteel": (0.38, flatC(0x8e8d86, 0.8)), "spDark": (0.45, flatC(0x2e2f2b, 0.85)),
})
LOW = lambda: drystone.LOW

H0, H1 = -0.045, 0.045           # the body's foot and top (m)
def bodyR(y):
    t = (y - H0) / (H1 - H0)
    return 0.0275 * max(0.0, math.sin(math.pi * min(1.0, max(0.0, t)))) ** 0.7

def body(K):
    """The ovoid as rings of verts; the GROOVES between 8 columns and 6 rings pressed in; "wear" (R: how near a
    block's edge, G: in a groove) written per vertex."""
    nu, nv = (96, 72) if not LOW() else (24, 18)
    bm = bmesh.new(); rings = []; wear = {}
    for j in range(nv + 1):
        y = H0 + (H1 - H0) * j / nv
        r = bodyR(y)
        ring = []
        for i in range(nu):
            a = 2 * math.pi * i / nu
            ru = (j / nv) * 6.0                                   # 6 rings of blocks over the height
            cu = (a / (2 * math.pi)) * 8.0                        # 8 columns round
            dv, du = abs(ru - round(ru)), abs(cu - round(cu))     # distance to a groove (0 on it, 0.5 at a block's centre)
            g = min(dv, du)
            k = 1.0 if g > 0.09 else 0.86 + 0.14 * (g / 0.09)     # the groove's depth
            if j in (0, nv) or not (0.06 < j / nv < 0.94): k = 1.0
            v = bm.verts.new(B(r * k * math.cos(a), y, r * k * math.sin(a)))
            wear[v] = (max(0.0, 1.0 - g / 0.2), 1.0 if k < 0.95 else 0.0)
            ring.append(v)
        rings.append(ring)
    for j in range(nv):
        for i in range(nu):
            i2 = (i + 1) % nu
            bm.faces.new((rings[j][i], rings[j][i2], rings[j + 1][i2], rings[j + 1][i]))
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    vals = [wear.get(v, (0.0, 0.0)) for v in bm.verts]
    o = K.obj("Body", bm, "spBody", "h", smooth=True)
    a = o.data.color_attributes.new("wear", "FLOAT_COLOR", "POINT")
    for d, (w, g) in zip(a.data, vals): d.color = (w, g, 0.0, 1.0)
    return tag(o, 0.5)

def rod(K, nm, a, b, r, mat, n=12):
    return tag(K.rod(nm, a, b, r, mat, "h", n=n if not LOW() else max(5, n // 2)), 0.5)
def cyl(K, nm, y0, y1, r0, r1, mat, n=24):
    return tag(K.cyl(nm, (0, y0, 0), r0, y1 - y0, mat, "h", n if not LOW() else max(8, n // 3), r2=r1, w=0.0006), 0.5)

def buildGrenade(K, name, spec, state, seed, far=False):
    drystone.setLow(K, far)
    body(K)
    # the fuze: its collar on the body's neck, the brass body, the striker's cap
    cyl(K, "Collar", H1 - 0.004, H1 + 0.002, 0.0105, 0.0105, "spSteel")
    cyl(K, "Fuze", H1 + 0.002, H1 + 0.024, 0.0085, 0.0075, "spBrass")
    cyl(K, "Cap", H1 + 0.024, H1 + 0.029, 0.0062, 0.005, "spDark")
    # THE LEVER (the spoon): from over the fuze, out and down the body's side 3 mm off it, to below its middle
    pts = []
    for k in range(14):
        y = H1 + 0.026 - (H1 + 0.026 - (-0.008)) * k / 13
        x = max(0.0095, bodyR(min(y, H1)) + 0.0032) if y < H1 + 0.004 else 0.004 + 0.0055 * (H1 + 0.026 - y) / 0.022
        pts.append((x, y))
    bm = bmesh.new(); prev = None; hw = 0.0045
    for x, y in pts:
        a = bm.verts.new(B(x, y, -hw)); b = bm.verts.new(B(x, y, hw))
        if prev: bm.faces.new((prev[0], prev[1], b, a))
        prev = (a, b)
    lever = K.obj("Lever", bm, "spSteel", "h", smooth=True)
    so = lever.modifiers.new("S", "SOLIDIFY"); so.thickness = 0.0012; so.offset = 0
    tag(lever, 0.5)
    # the pin through the fuze (across, x = 0) and its ring, hanging toward the viewer\x27s side
    rod(K, "Pin", (-0.002, H1 + 0.016, -0.012), (-0.002, H1 + 0.016, 0.012), 0.0009, "spSteel", 6)
    n = 28 if not LOW() else 10
    ring = [(-0.002 + 0.0115 * math.cos(2 * math.pi * k / n) * 0.35, H1 + 0.016 - 0.0115 + 0.0115 * math.sin(2 * math.pi * k / n), -0.0125 - 0.0115 * (1 + math.cos(2 * math.pi * k / n)) * 0.47) for k in range(n)]
    for k in range(n): rod(K, f"Ring{k}", ring[k], ring[(k + 1) % n], 0.0011, "spSteel", 6)
    drystone.writeBuildOrder(K)
    drystone.setLow(K, False)

farGrenade = lambda K, n, s, st, sd: buildGrenade(K, n, s, st, sd, far=True)
TYPES = {"grenade": dict(builder=buildGrenade, farBuilder=farGrenade, atlas=1024, aoDist=0.01, smoothAngle=60, weighted=False, normals=True, normalAtlas=1024)}
exported = buildKit(TYPES, MATDEF, "smallprops.glb", prefix="Prop", seed0=1940, colors=True)

scn = bpy.context.scene
scn.render.engine = "BLENDER_WORKBENCH"
sh = scn.display.shading; sh.light = "STUDIO"; sh.color_type = "TEXTURE"
scn.render.resolution_x, scn.render.resolution_y = 700, 700
cd = bpy.data.cameras.new("PC"); cam = bpy.data.objects.new("PC", cd); scn.collection.objects.link(cam); scn.camera = cam
for o in scn.objects:
    if o.type == "MESH": o.hide_render = True
for o in exported:
    if o.name.endswith("_Far") or not o.name.endswith("_Intact"): continue
    o.hide_render = False
    cd.lens = 50; cam.location = B(0.12, 0.06, -0.24)
    cam.rotation_euler = (B(0, 0.005, 0) - cam.location).to_track_quat("-Z", "Y").to_euler()
    scn.render.filepath = os.path.join(house.REFS, f"preview_{o.name}.png"); bpy.ops.render.render(write_still=True)
    o.hide_render = True
print("DONE")
