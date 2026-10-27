"""THE MECHTA — the Aurès stone hamlet's houses (2026-10-27, games/alg-rts/MECHTA_PLAN.md; you: "ok go ahead"). The
Chaouia house of the mountain villages (Ghoufi, Menaa, Tighanimine), for the NEW maps only (the old Aurès keeps its
runtime hamlet, algMasonry): house.py's builder (one description, three states, one atlas a type, a far level) with
the mechta's own features:

    STONE          rough local stone, ochre-grey as the ground (the game tiles the dry-stone photo over it)
    TIMBER COURSES flat bands of juniper logs in the walls, on the bigger houses (Ghoufi) — cut at the openings
    ROOF           a flat terrace of packed clay, the beams' ends through the walls, a LOW UNEVEN LIP (no crenels),
                   a wooden spout; hay, pots, baskets on it
    OPENINGS       one low plank door, a few small holes high up
    UPPER ROOM     (etage) set back on the roof, open on a LOGGIA of wooden posts
    STATES         intact / damaged (breached, the lip shot away) / ruin (stumps, the upper room fallen, beams in)

  "C:/Program Files/Blender Foundation/Blender 5.0/blender.exe" -b --factory-startup \\
      --python tools/blender/mechta.py -- <out dir> [--quick] [--only petite]

Writes <out>/mechta.glb (Mechta<Type>_<State> + _Far) — then tools/optimizeGlb.mjs --etc1s. Previews in
assets-src/refs/house/preview_mechta_<type>.png. Game coordinates, real metres (the game x1.3), FRONT at -Z.
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit, previews, REFS, T
from bkit import B, srgb, dust, wood

# ── Materials ────────────────────────────────────────────────────────────────
def mechtaStone(nb):
    """The Aurès' rough stone: the ruined-wall photo pulled to the ground's ochre-grey, every stone its own shade."""
    c = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
    c = nb.mix(0.55, c, srgb(0xb08a60))   # (0.35 of 0xb4946c: the photo's grey won — lilac-grey walls in the lab)
    c = nb.scale(c, nb.mr(nb.noise(1.1, 4), 0.3, 0.7, 0.82, 1.06))
    # a darker foot (splash, damp) and paler streaks under the lip
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.gy, 0.7, 0.0), 0.3), c, srgb(0x7a6247))
    return dust(nb, c, 1.3, 0.9)
def clay(nb):
    """The terrace's packed clay (and the lip's top): the clay plaster photo, earth brown, cracked dry in patches."""
    c = nb.img("build/clay_plaster/clay_plaster_diff_1k.jpg", 0.5)
    c = nb.mix(0.9, c, srgb(0x7a5c40))   # (0.7 of 0xa58462, then 0x957352: still cream in the lab — a terrace takes the full sun, so it is darker than the ground it reads as)
    c = nb.scale(c, nb.mr(nb.noise(0.7, 5), 0.3, 0.7, 0.85, 1.05))
    return dust(nb, c, 1.6, 1.0)

MATDEF = dict(house.MATDEF)
def mechtaRubble(nb):
    """Fallen stone and clay (the whitewashed kit's rubble has its lime render in it)."""
    s = nb.mix(0.55, nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9), srgb(0xa8855c))
    c = nb.mix(nb.mr(nb.noise(3.0, 5, 0.6), 0.5, 0.58), s, srgb(0x8f7152))
    return dust(nb, nb.scale(c, nb.mr(nb.island(), 0, 1, 0.75, 1.05)), 2.0, 1.2)

MATDEF.update({
    "stone": (0.95, mechtaStone), "rubble": (0.95, mechtaRubble),   # (house.build's breaches and heaps: this stone, no lime)
    "stoneMechta": (0.95, mechtaStone),    # (class 2: "stone" in its name — the game's dry-stone photo)
    "renderClay": (0.95, clay),            # (class 1: the M'zab's mud render photo — algHouse SURFACE_KITS)
    "timberCourse": (0.9, wood(0x6b5741)), # (class 3)
})

# ── THE TYPES (real metres; front at -Z) — house.py's description (plain parapet), plus:
#   courses: [heights] of the timber bands; upper: (x0 x1 z0 z1 h) the loggia room on the roof; spouts: [x];
#   ladder: a ladder up the front
TYPES = {
    # ONE ROOM, one storey, a ladder to its roof — the hamlet's commonest house
    "petite": dict(render="stoneMechta", shutter="woodDark", door=(-1.5, -0.62, "woodDark"), plain=True,
        main=(-2.6, 2.6, -2.1, 2.1), floors=[], roof=2.55, par=3.02, courses=[], spouts=[0.6], ladder=1.6,
        wins=[("f", 0.75, 1.15, 1.65, 2.0, "void"), ("r", -0.25, 0.15, 1.7, 2.05, "void")],
        dmg=[((0.95, 0.8, -2.1), (0.7, 0.7, 0.6)), ((2.6, 0.95, 1.15), (0.55, 0.75, 0.7))],   # (clear of the openings: a window's dark and sill left floating in a hole)
        ruin=(1.4, 0.7), life=["hay", "pottery"], ground=["jars"]),
    # TWO ROOMS, timber courses, the UPPER ROOM on the back-left of the roof, open on its loggia (Ghoufi)
    "etage": dict(render="stoneMechta", shutter="woodDark", door=(-0.5, 0.42, "woodDark"), plain=True,
        main=(-3.6, 3.6, -2.8, 2.8), floors=[], roof=3.0, par=3.48, courses=[0.95, 2.05], spouts=[2.2],
        upper=(-3.27, 0.55, -1.0, 2.47, 2.3),   # (its back and side 12 cm INTO the parapet: never one plane with its face)
        wins=[("f", -2.6, -2.15, 1.9, 2.32, "void"), ("f", 2.0, 2.42, 1.9, 2.32, "void"), ("l", 0.4, 0.82, 1.9, 2.3, "void"), ("b", -1.0, -0.58, 2.0, 2.4, "void")],
        dmg=[((1.2, 0.9, -2.8), (0.7, 0.75, 0.65)), ((-3.6, 0.9, 0.8), (0.6, 0.75, 0.8)), ((0.55, 4.3, 0.9), (0.6, 0.7, 0.8))],   # (clear of the openings and the loggia's posts)
        ruin=(1.9, 0.9), life=["hay", "pottery", "baskets"], ground=["jars", "firewood", "sacks"]),
    # THE HILLSIDE HOUSE (Ghoufi): two storeys — the byre below behind its wide door, the living storey above reached by
    # an OUTSIDE STAIR up its right side to a side door. The game cuts its pad into the slope at the LOWEST ground
    # (algGame: the hill rises behind it, as a house built into the hillside)
    "pente": dict(render="stoneMechta", shutter="woodDark", door=(-0.75, 0.75, "woodDark"), plain=True,
        main=(-3.4, 3.4, -2.8, 2.8), floors=[2.7], roof=5.5, par=5.98, courses=[2.55, 4.2], spouts=[-1.6],
        outStair=(-4.0, -1.0, 0.1, 2.92), bevel=0.06,   # (its foot z, the landing's z0 z1, the landing's height; the bevel: 9 cm overlapped itself round the side door)
        wins=[("f", 2.0, 2.35, 1.5, 1.8, "void"), ("f", -2.4, -1.95, 3.8, 4.25, "void"), ("f", 0.6, 1.05, 3.8, 4.25, "void"),
              ("r", -0.85, -0.1, 3.0, 4.72, "shut"), ("l", -0.4, 0.05, 3.9, 4.3, "void"), ("b", 0.3, 0.75, 4.0, 4.4, "void")],
        dmg=[((1.4, 0.8, -2.8), (0.55, 0.6, 0.6)), ((-3.4, 4.0, 1.3), (0.6, 0.8, 0.7)), ((-0.65, 4.6, -2.8), (0.6, 0.55, 0.6))],
        ruin=(2.6, 1.1), life=["hay", "pottery", "laundry"], ground=["firewood"]),
}

def stairMass(K, nm, x0, x1, zFoot, zLand0, zLand1, yTop, n, mat):
    """An outside stair as ONE solid (steps as separate boxes share faces — z-fighting): its stepped profile along z, from
    its foot at zFoot up to a LANDING zLand0..zLand1 at yTop, extruded across x0..x1."""
    run, rise = (zLand0 - zFoot) / n, yTop / n
    prof = [(zFoot, 0.0)]
    for k in range(n):
        prof += [(zFoot + run * k, rise * (k + 1)), (zFoot + run * (k + 1), rise * (k + 1))]
    prof += [(zLand1, yTop), (zLand1, 0.0)]
    bm = bmesh.new()
    a = [bm.verts.new(B(x0, y, z)) for z, y in prof]
    b = [bm.verts.new(B(x1, y, z)) for z, y in prof]
    bm.faces.new(a); bm.faces.new(list(reversed(b)))
    m = len(prof)
    for i in range(m):
        j = (i + 1) % m
        bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, "h")

def buildMechta(K, name, spec, state, seed):
    R = random.Random(seed + 101)
    G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    X0, X1, Z0, Z1 = spec["main"]; ROOF, PAR = spec["roof"], spec["par"]
    house.build(K, name, dict(spec, life=[]), state, seed)   # (the roof's life below: the upper room kept clear)
    made = list(K.groups[G])
    main = made[0]
    # SOFTER CORNERS (2026-10-27, you: "you said you can do better"): the shell's bevel 3.5 cm -> 9 (dry stone has no arris)
    for md in main.modifiers:
        if md.type == "BEVEL": md.width, md.segments = spec.get("bevel", 0.09), 2
    # THE RUIN'S ROOF fallen IN (not house.py's one flat slab — it read as a plank floor): its earth heaped inside, the
    # reed layer and the beams broken into it
    if ruin:
        for o in [o for o in made if o.name.startswith("Fallen")]:
            K.groups[G].remove(o); bpy.data.objects.remove(o, do_unlink=True)
        made = list(K.groups[G])
        cx, cz = (X0 + X1) / 2, (Z0 + Z1) / 2
        K.lump("RoofMound", (cx + 0.25, 0.0, cz - 0.2), ((X1 - X0) * 0.36, 0.85, (Z1 - Z0) * 0.33), "renderClay", G, seed=seed + 61, rough=0.4)
        for k in range(9):
            a = R.uniform(0, 6.28); r0, r1 = R.uniform(0.2, 0.6), R.uniform(1.1, 1.9)
            y = R.uniform(0.45, 0.75)
            K.rod(f"Reed{k}", (cx + math.cos(a) * r0, y + 0.15, cz + math.sin(a) * r0 * 0.8), (cx + math.cos(a) * r1, y - 0.35, cz + math.sin(a) * r1 * 0.8), 0.025, "woodDark", G, 5)
        for k in range(3):
            x = X0 + 1.0 + k * (X1 - X0 - 2.0) / 2
            K.rod(f"RoofBeam{k}", (x + R.uniform(-0.3, 0.3), 0.35, cz + R.uniform(-0.6, 0.6)), (x + R.uniform(-0.5, 0.5), spec["ruin"][0] * 0.8, Z1 - T - 0.1), 0.09, "woodDark", G, 6)
    # the mechta's surfaces: a clay terrace, timber sills, stone steps
    for o in made:
        if o.name == "Roof": o.data.materials[0] = K.mat("renderClay")
        elif o.name.endswith("Sill"): o.data.materials[0] = K.mat("timberCourse")
        elif o.name.startswith("Step"): o.data.materials[0] = K.mat(spec["render"])
        # a window's DARK panel 1 cm inside its opening on every side (house.py's fills it exactly: its top in one plane
        # with the opening's, overlapping once the far level merged them — the hillside house, the coplanar gate)
        elif o.name.endswith("Dark"):
            vs = o.data.vertices
            for a in range(3):
                lo, hi = min(v.co[a] for v in vs), max(v.co[a] for v in vs)
                if hi - lo < 0.1: continue   # (its depth: kept)
                for v in vs: v.co[a] = lo + 0.01 if v.co[a] - lo < 1e-4 else (hi - 0.01 if hi - v.co[a] < 1e-4 else v.co[a])
    # a stone SOCLE under it (a house on a slope: its foot never floats)
    K.box("Socle", X0 - 0.05, X1 + 0.05, -0.8, 0.03, Z0 - 0.05, Z1 + 0.05, spec["render"], G, 0)
    extras = []
    # THE LOW UNEVEN LIP: the shell's top broken a little (no crenels, no straight edge)
    # (cut BEFORE the bevel: after the 9 cm bevel the exact boolean failed on the hillside house — the whole shell gone)
    if not ruin:
        md = K.boolean(main, K.skyline(X0 - 1, X1 + 1, Z0 - 1, Z1 + 1, PAR - 0.06, 0.08, seed=seed + 40, mat="renderClay"))
        bev = next((i for i, m in enumerate(main.modifiers) if m.type == "BEVEL"), None)
        if bev is not None: main.modifiers.move(len(main.modifiers) - 1, bev)
    # THE TIMBER COURSES: a band of logs round the walls at each height, cut at the openings it crosses
    holes = [("f", spec["door"][0], spec["door"][1], 0.0, 2.3)] + [w[:5] for w in spec["wins"]]
    for ci, y in enumerate(spec.get("courses", [])):
        y1 = y + 0.14
        faces = {"f": K.box(f"Course{ci}f", X0 - 0.04, X1 + 0.04, y, y1, Z0 - 0.04, Z0 + 0.06, "timberCourse", G, 0.01),
                 "b": K.box(f"Course{ci}b", X0 - 0.04, X1 + 0.04, y, y1, Z1 - 0.06, Z1 + 0.04, "timberCourse", G, 0.01),
                 # (the sides stop short of the front and back bands: no shared corner volume, no coplanar tops)
                 "l": K.box(f"Course{ci}l", X0 - 0.035, X0 + 0.06, y, y1, Z0 + 0.07, Z1 - 0.07, "timberCourse", G, 0.01),
                 "r": K.box(f"Course{ci}r", X1 - 0.06, X1 + 0.035, y, y1, Z0 + 0.07, Z1 - 0.07, "timberCourse", G, 0.01)}
        for f, a0, a1, h0, h1 in holes:
            if h1 < y or h0 > y1: continue
            a0, a1 = a0 - 0.02, a1 + 0.02   # (2 cm wider than the opening: its cut ends never in one plane with the opening's sides)
            # (and the band's WHOLE height: it stops at the opening — a 4 cm strip left over a window had its underside in
            # the opening's top plane, the coplanar gate)
            h0, h1 = y - 0.05, y1 + 0.05
            if f in ("f", "b"):
                z = Z0 if f == "f" else Z1
                K.boolean(faces[f], K.cutter(a0, a1, h0, h1, z - 0.2, z + 0.2))
            else:
                x = X0 if f == "l" else X1
                K.boolean(faces[f], K.cutter(x - 0.2, x + 0.2, h0, h1, a0, a1))
        extras += faces.values()
    # THE SPOUTS: a split log out of the lip at roof level, throwing the rain off the front
    for k, x in enumerate(spec.get("spouts", [])):
        extras.append(K.rod(f"Spout{k}", (x, ROOF + 0.32, Z0 + 0.15), (x, ROOF + 0.24, Z0 - 0.55), 0.07, "woodDark", G, 6))
    # THE OUTSIDE STAIR up the right side to the upper door (the hillside house), its landing at the top
    if "outStair" in spec:
        zf, zl0, zl1, yl = spec["outStair"]
        extras.append(stairMass(K, "OutStair", X1 + 0.03, X1 + 0.95, zf, zl0, zl1, yl, 12, spec["render"]))
    # THE UPPER ROOM on its loggia (not in a ruin: fallen in)
    upperRect = None
    if "upper" in spec and not ruin:
        ux0, ux1, uz0, uz1, uh = spec["upper"]
        y0 = ROOF + 0.24
        up = K.box("Upper", ux0, ux1, y0 - 0.02, y0 + uh + 0.42, uz0, uz1, spec["render"], G, 0)
        K.boolean(up, K.cutter(ux0 + 0.4, ux1 - 0.4, y0 + 0.04, y0 + uh + 1.0, uz0 + 0.4, uz1 - 0.4))
        lo0, lo1, lt = ux0 + 0.55, ux1 - 0.55, y0 + uh - 0.4                 # the loggia's opening, across the front
        K.boolean(up, K.cutter(lo0, lo1, y0 + 0.3, lt, uz0 - 0.2, uz0 + 0.6))
        K.boolean(up, K.cutter(ux1 - 0.6, ux1 + 0.2, y0 + 1.0, y0 + 1.4, uz0 + 1.3, uz0 + 1.7))   # a hole on its side
        K.boolean(up, K.skyline(ux0 - 1, ux1 + 1, uz0 - 1, uz1 + 1, y0 + uh + 0.36, 0.07, seed=seed + 41))
        K.bevel(up, 0.035, 2, 30)
        extras.append(up)
        extras.append(K.box("UpperRoof", ux0 + 0.38, ux1 - 0.38, y0 + uh, y0 + uh + 0.22, uz0 + 0.38, uz1 - 0.38, "renderClay", G, 0))
        # its posts and their beam in the opening's depth, the beams' ends over it
        n = max(3, round((lo1 - lo0) / 1.0))   # (two posts at least: one read thin)
        for k in range(1, n):
            x = lo0 + (lo1 - lo0) * k / n
            extras.append(K.rod(f"Post{k}", (x, y0 + 0.3, uz0 + 0.22), (x, lt, uz0 + 0.22), 0.085, "timberCourse", G, 7))
        extras.append(K.box("LoggiaBeam", lo0 - 0.1, lo1 + 0.1, lt - 0.15, lt + 0.02, uz0 + 0.1, uz0 + 0.34, "timberCourse", G, 0.01))
        for k in range(5):
            x = ux0 + 0.5 + k * (ux1 - ux0 - 1.0) / 4
            extras.append(K.box(f"UJoist{k}", x - 0.07, x + 0.07, y0 + uh - 0.16, y0 + uh - 0.03, uz0 - 0.28, uz0 + 0.02, "woodDark", G, 0.01))
        upperRect = (ux0, ux1, uz0, uz1)
    # A LADDER up the front to the roof (the one-room house)
    if spec.get("ladder") and not dmg:   # (damaged: knocked down)
        lx = spec["ladder"]
        for s in (-0.22, 0.22):
            extras.append(K.rod(f"LadRail{s}", (lx + s, 0.0, Z0 - 0.75), (lx + s, PAR + 0.4, Z0 - 0.05), 0.035, "woodDark", G, 6))
        for k in range(8):
            f = (k + 0.6) / 8.6
            y, z = (PAR + 0.4) * f, Z0 - 0.75 + 0.7 * f
            extras.append(K.rod(f"LadRung{k}", (lx - 0.22, y, z), (lx + 0.22, y, z), 0.022, "woodDark", G, 5))
    # FIREWOOD on the roof now and then (the oven's)
    if not ruin and R.random() < 0.7:
        fx = (X0 + X1) / 2 + (1.2 if upperRect else 0.0); fz = Z1 - T - 0.55
        for k in range(6):
            extras.append(K.rod(f"RoofWood{k}", (fx - 0.6, ROOF + 0.3 + (k % 2) * 0.09, fz - 0.25 + k * 0.09), (fx + 0.6, ROOF + 0.3 + (k % 2) * 0.09, fz - 0.2 + k * 0.08), 0.045, "woodDark", G, 6))
    # THE ROOF'S LIFE (house.py's), the upper room's corner kept clear
    if not ruin:
        house.roofLife(K, R, X0 + T + 0.3, X1 - T - 0.3, Z0 + T + 0.3, Z1 - T - 0.3, ROOF + 0.24, spec["life"], upperRect, PAR, Z0)
    # the house's DAMAGE on these parts too: the same breaches, 4 % bigger, the same broken top 3 cm lower (a band in the
    # wall cut by the very same shape left its cut faces in one plane with the wall's — 55 z-fighting pairs, the gate)
    if dmg:
        for k, (c, sz) in enumerate(spec["dmg"]):
            cut = K.breach(c, tuple(v * 1.04 for v in sz), seed=seed * 7 + k, mat="stone")
            for o in extras: K.boolean(o, cut)
    if ruin:
        h, amp = spec["ruin"]
        top = K.skyline(X0 - 1.5, X1 + 1.5, Z0 - 5.0, Z1 + 1.5, h - 0.03, amp, seed=seed, mat="stone")
        for o in extras: K.boolean(o, top)
    # (the shell triangulated HERE, the beauty way: the exporter's own cut a cut wall's concave faces into slivers that
    # overlapped — the hillside house's side door, the coplanar gate)
    tri = main.modifiers.new("Tri", "TRIANGULATE"); tri.quad_method = "BEAUTY"; tri.ngon_method = "BEAUTY"
    K.batter = BATTER   # (the lean: on the JOINED house — batteredJoin below)

# THE BATTER: the walls lean in as they rise (~1 % a metre), the whole house — applied to the JOINED mesh, every vertex by
# the same rule (x, z scaled by 1 + BATTER·y about the house's axis), so the openings, beams, bands, roof and things on it
# all follow the wall they are in. (Not Blender's SimpleDeform taper per part: it took each part's own bounds — the
# hillside house's 1 cm laundry line thrown 17 m out each side, its roof slab sunk and shrunk inside its walls — you,
# 2026-10-27: "a weird black line above the house", "the roof is not right neither".)
BATTER = -0.011
_join = house.bkit.Kit.join
def batteredJoin(self, name, objs):
    j = _join(self, name, objs)
    # (and every merged piece rid of its zero-area triangles: a ruin's cuts left one, the coplanar gate)
    bm = bmesh.new(); bm.from_mesh(j.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges)
    bm.to_mesh(j.data); bm.free()
    f = getattr(self, "batter", 0.0)
    if f:
        self.batter = 0.0   # (this house's far level is decimated from this mesh: leant once)
        for v in j.data.vertices:
            s = 1 + f * v.co.z   # (Blender: z up — the game's y)
            v.co.x *= s; v.co.y *= s
        j.data.update()
    return j
house.bkit.Kit.join = batteredJoin

# ── THE HAMLET'S SMALLER PIECES (2026-10-27, MECHTA_PLAN.md: the lean-to, the yard, the oven) ─────────────────────────
# Each its own builder (no house.py shell); real metres, front at -Z (toward the camera, as the houses). The game places
# them in the town's PROPS: no garrison, no sight box — their walls hard cover and the nav's (algHouse MECHTA_PROPS).
def wallRun(K, nm, x0, x1, z0, z1, h, seed, mat="stoneMechta"):
    """A dry-stone wall block, its top broken a little, its arrises worn."""
    w = K.box(nm, x0, x1, -0.4, h, z0, z1, mat, "h", 0)
    K.boolean(w, K.skyline(x0 - 1, x1 + 1, z0 - 1, z1 + 1, h - 0.07, 0.09, seed=seed, mat=mat))
    K.bevel(w, 0.06, 2, 30)
    return w

def tabouna(K, R, x, z, seed, state, nm="Oven"):
    """THE TABOUNA: a domed clay oven, its dark mouth toward -Z, a flat stone before it."""
    G = "h"
    made = [K.lump(f"{nm}Dome", (x, 0.0, z), (0.72, 0.78, 0.72), "renderClay", G, seed=seed, rough=0.07)]
    if state != "ruin":
        made.append(K.box(f"{nm}Mouth", x - 0.17, x + 0.17, 0.06, 0.36, z - 0.74, z - 0.64, "dark", G, 0))
    made.append(K.box(f"{nm}Slab", x - 0.4, x + 0.4, 0.0, 0.07, z - 1.12, z - 0.78, "stoneMechta", G, 0.02))
    if state == "damaged":
        K.boolean(made[0], K.breach((x + 0.45, 0.55, z + 0.1), (0.35, 0.3, 0.35), seed=seed, mat="renderClay"))
    if state == "ruin":   # (the dome fallen in: a low broken ring, its ash)
        K.boolean(made[0], K.skyline(x - 2, x + 2, z - 2, z + 2, 0.32, 0.1, seed=seed, mat="renderClay"))
        K.lump(f"{nm}Ash", (x, 0.0, z), (0.5, 0.18, 0.5), "rubble", G, seed=seed + 1, rough=0.3)
    return made

def buildTabouna(K, name, spec, state, seed):
    R = random.Random(seed)
    tabouna(K, R, 0.0, 0.1, seed, state)
    if state != "ruin":   # its firewood beside it
        for k in range(5): K.rod(f"Wood{k}", (0.7, 0.07 + (k % 2) * 0.09, -0.5 + k * 0.1), (1.5, 0.07 + (k % 2) * 0.09, -0.35 + k * 0.1), 0.045, "woodDark", "h", 6)

def buildLeanTo(K, name, spec, state, seed):
    """THE LEAN-TO (the goats' shed): a stone back wall, low dry-stone sides, the front open on two posts and a beam,
    a roof of poles sloping to the front with branches laid across; hay inside. Damaged: half its roof fallen in;
    ruin: the walls' stumps, the poles burnt on the ground."""
    R = random.Random(seed); G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    hb, hf = 2.35, 1.85                                   # the roof's back and front
    walls = [wallRun(K, "Back", -1.8, 1.8, 1.15, 1.6, hb - 0.02, seed),
             # (the sides 4 cm in from the back wall's ends, into it: no shared face)
             wallRun(K, "SideL", -1.76, -1.32, -1.45, 1.2, 1.25, seed + 1), wallRun(K, "SideR", 1.32, 1.76, -1.45, 1.2, 1.2, seed + 2)]
    K.box("Floor", -1.25, 1.25, 0.0, 0.025, -1.4, 1.1, "earth", G, 0)
    parts = []
    if not ruin:
        for s in (-1, 1): parts.append(K.rod(f"Post{s}", (s * 1.55, 0.0, -1.48), (s * 1.55, hf, -1.48), 0.075, "timberCourse", G, 7))
        parts.append(K.rod("Beam", (-1.78, hf - 0.04, -1.48), (1.78, hf - 0.04, -1.48), 0.075, "timberCourse", G, 7))
        for k in range(14):
            x = -1.7 + k * 3.4 / 13 + R.uniform(-0.04, 0.04)
            if dmg and 5 <= k <= 10:   # (damaged: these fallen in, lying across the floor)
                parts.append(K.rod(f"Fallen{k}", (x + R.uniform(-0.3, 0.3), 0.08, -1.2), (x + R.uniform(-0.5, 0.5), 0.5 + R.uniform(0, 0.6), 1.0), 0.055, "woodDark", G, 6))
                continue
            parts.append(K.rod(f"Pole{k}", (x, hf + 0.05, -1.7), (x + R.uniform(-0.06, 0.06), hb + 0.05, 1.62), 0.055, "woodDark", G, 6))
        # THE THATCH under the poles: a mat of reeds and brush (the poles alone read as a pergola in the lab), holed when damaged
        th = K.member("Thatch", (0.0, hf - 0.01, -1.72), (0.0, hb - 0.01, 1.64), [(-1.86, -0.04), (1.86, -0.04), (1.86, 0.035), (-1.86, 0.035)], "hay", G)
        parts.append(th)
        if dmg: K.boolean(th, K.breach((0.1, (hf + hb) / 2, 0.0), (1.0, 0.6, 1.1), seed=seed + 9, mat="hay"))
        for k in range(5):                                # branches laid across the poles
            z = -1.3 + k * 0.62; y = hf + 0.12 + (hb - hf) * (z + 1.7) / 3.32
            if dmg and k in (2, 3): continue
            parts.append(K.rod(f"Branch{k}", (-1.8, y + R.uniform(-0.02, 0.03), z + R.uniform(-0.1, 0.1)), (1.8, y + R.uniform(-0.02, 0.03), z + R.uniform(-0.1, 0.1)), 0.03, "woodDark", G, 5))
        K.spots.append((0.25, 0.03, 0.2, R.uniform(0, 6.28)))   # (hay inside: the game's straw-card pile)
    else:
        for k in range(6):
            x = R.uniform(-1.4, 1.4)
            parts.append(K.rod(f"Burnt{k}", (x, 0.06, R.uniform(-1.5, -0.6)), (x + R.uniform(-0.8, 0.8), 0.07, R.uniform(0.3, 1.0)), 0.05, "fsCharred", G, 6))
        parts.append(K.rod("Stump", (-1.55, 0.0, -1.48), (-1.52, 0.9, -1.46), 0.075, "fsCharred", G, 7))
    if dmg:
        K.boolean(walls[2], K.breach((1.55, 0.9, -0.4), (0.4, 0.45, 0.55), seed=seed, mat="stone"))
        K.lump("Fall", (2.3, 0.0, -0.4), (0.55, 0.25, 0.6), "rubble", G, seed=seed + 3)
    if ruin:
        top = K.skyline(-3, 3, -3, 3, 0.75, 0.35, seed=seed, mat="stone")
        for w in walls: K.boolean(w, top)

YARD_W, YARD_D = 4.0, 3.0   # (the yard's half width and half depth — algHouse MECHTA_PROPS: change both together)
def buildYard(K, name, spec, state, seed):
    """THE YARD behind a house: dry-stone walls on its sides and back, OPEN at its front (-Z: against the house's back),
    a gap in the right wall closed with thorn branches (the zeriba's way); a tabouna and its firewood, jars, hay inside.
    Damaged: a stretch of the back wall knocked down; ruin: the walls' stumps, the oven fallen in."""
    R = random.Random(seed); G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    W, D, t, h = YARD_W, YARD_D, 0.5, 1.4
    walls = [wallRun(K, "YardBack", -W, W, D - t, D, h, seed),
             wallRun(K, "YardL", -W + 0.03, -W + t + 0.03, -D, D - t + 0.05, h - 0.05, seed + 1),
             # the right wall in two, the gap between them (z -0.7 .. 0.7)
             wallRun(K, "YardR0", W - t - 0.03, W - 0.03, -D, -0.7, h + 0.03, seed + 2),
             wallRun(K, "YardR1", W - t - 0.03, W - 0.03, 0.7, D - t + 0.05, h - 0.02, seed + 3)]
    if not ruin:   # the gap closed with cut thorn branches
        for k in range(18):   # (7 read as a few sticks in the lab: a barrier needs a tangle)
            z0, z1 = R.uniform(-0.75, -0.2), R.uniform(0.2, 0.75)
            K.rod(f"Thorn{k}", (W - 0.25 + R.uniform(-0.22, 0.22), R.uniform(0.05, 1.1), z0), (W - 0.25 + R.uniform(-0.22, 0.22), R.uniform(0.05, 1.1), z1), R.uniform(0.018, 0.032), "woodDark", G, 4)
    tabouna(K, R, -W + 1.4, D - 1.4, seed + 7, state)
    if not ruin:
        for k in range(6): K.rod(f"YardWood{k}", (0.6, 0.07 + (k % 2) * 0.09, D - 0.9 + k * 0.03), (2.2, 0.07 + (k % 2) * 0.09, D - 0.75 + k * 0.03), 0.045, "woodDark", G, 6)
        for k in range(3): K.cyl(f"YardJar{k}", (W - 1.0 - k * 0.45, 0.0, -D + 0.9), 0.22 - k * 0.03, 0.58 - k * 0.08, "jar", G, 12, r2=0.1)
        K.spots.append((0.3, 0.0, -0.4, R.uniform(0, 6.28)))
    if dmg:
        K.boolean(walls[0], K.breach((0.6, 1.2, D - t / 2), (1.2, 0.8, 0.6), seed=seed, mat="stone"))
        K.lump("YardFall", (0.6, 0.0, D + 0.8), (1.3, 0.35, 0.6), "rubble", G, seed=seed + 5)
    if ruin:
        top = K.skyline(-W - 2, W + 2, -D - 2, D + 2, 0.6, 0.3, seed=seed, mat="stone")
        for w in walls: K.boolean(w, top)

TYPES["appentis"] = dict(builder=buildLeanTo, atlas=1024, farRatio=0.45)
TYPES["enclos"] = dict(builder=buildYard, atlas=1024, farRatio=0.7)   # (0.45: the ruin's broken tops shaded off its near — the gate)
TYPES["tabouna"] = dict(builder=buildTabouna, atlas=512, farRatio=0.5)
MATDEF.update({"fsCharred": (0.95, lambda nb: nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e)))})

for spec in TYPES.values():
    spec.setdefault("builder", buildMechta); spec.setdefault("farRatio", 0.38)   # (0.3: the loggia house's far ruin shaded off its near — the gate)

exported = buildKit(TYPES, MATDEF, "mechta.glb", prefix="Mechta", seed0=1957, surfaces=True)
previews(TYPES, exported, prefix="Mechta", tag="mechta_", spacing=13, frame=0.8)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "mechta.blend"))
print("DONE")
