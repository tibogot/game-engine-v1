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
from bkit import B, srgb, dust, wood, flat

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
    # THE DECHRA'S MOSQUE (2026-10-27, DECHRA_PLAN.md): a plain stone prayer hall, small high windows, a squat square
    # MINARET at its back corner (the village's landmark), lime on the door's frame and the minaret's cap
    "masjid": dict(render="stoneMechta", shutter="woodDark", door=(-0.7, 0.7, "woodDark"), plain=True,
        main=(-4.5, 4.5, -3.5, 3.5), floors=[], roof=3.6, par=4.08, courses=[1.4], spouts=[-2.6, 2.6],
        tower=(5.35, 2.35, 1.1, 7.6), limeDoor=True,   # (not "minaret": house.build reads that key, the M'zab's)
        wins=[("f", -3.2, -2.7, 2.3, 2.8, "void"), ("f", 2.7, 3.2, 2.3, 2.8, "void"), ("l", -1.5, -1.0, 2.3, 2.8, "void"),
              ("l", 1.0, 1.5, 2.3, 2.8, "void"), ("b", -2.0, -1.5, 2.3, 2.8, "void")],
        dmg=[((-2.0, 1.0, -3.5), (0.7, 0.7, 0.6)), ((-4.5, 1.2, -1.6), (0.6, 0.8, 0.8)), ((5.35, 4.8, 1.25), (0.6, 0.7, 0.5))],
        ruin=(2.2, 1.0), life=["mats"], ground=["bench"]),
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

def prismX(K, nm, prof, x0, x1, mat):
    """A solid from a (z, y) PROFILE (a closed polygon, real metres) extruded across x0..x1 — one mesh (a retaining wall
    and its parapet as two boxes overlapped in one plane: the coplanar gate)."""
    bm = bmesh.new()
    a = [bm.verts.new(B(x0, y, z)) for z, y in prof]
    b = [bm.verts.new(B(x1, y, z)) for z, y in prof]
    bm.faces.new(a); bm.faces.new(list(reversed(b)))
    for i in range(len(prof)):
        j = (i + 1) % len(prof)
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
    # THE MINARET (the dechra's mosque): a squat square tower at the hall's back corner, small openings near its top,
    # a lime cap and a finial; and LIME round the mosque's door — the village's one whitewashed building
    if "tower" in spec:
        mx, mz, mh, mH = spec["tower"]
        mn = K.box("Minaret", mx - mh, mx + mh, -0.3, mH, mz - mh, mz + mh, spec["render"], G, 0)
        for k, (fx, fz) in enumerate(((0, -1), (1, 0), (0, 1), (-1, 0))):
            y0 = mH - 1.35
            if fx == 0: K.boolean(mn, K.cutter(mx - 0.18, mx + 0.18, y0, y0 + 0.55, mz + fz * mh - 0.4, mz + fz * mh + 0.4, "dark"))
            else: K.boolean(mn, K.cutter(mx + fx * mh - 0.4, mx + fx * mh + 0.4, y0, y0 + 0.55, mz - 0.18, mz + 0.18, "dark"))
        K.bevel(mn, 0.06, 2, 30)
        extras.append(mn)
        extras.append(K.box("MinaretCap", mx - mh - 0.05, mx + mh + 0.05, mH - 0.05, mH + 0.32, mz - mh - 0.05, mz + mh + 0.05, "renderPlain", G, 0.03))
        extras.append(K.cyl("Finial", (mx, mH + 0.3, mz), 0.26, 0.7, "renderPlain", G, 10, r2=0.04))
    if spec.get("limeDoor"):
        d0, d1 = spec["door"][0], spec["door"][1]
        fr = K.box("DoorLime", d0 - 0.35, d1 + 0.35, 0.2, 2.75, Z0 - 0.035, Z0 + 0.02, "renderPlain", G, 0.01)
        K.boolean(fr, K.cutter(d0, d1, 0.0, 2.3, Z0 - 0.2, Z0 + 0.2))
        extras.append(fr)
    # THE FLN's COMMAND POST: brush laid over the roof (from the air, scrub), a long-wire antenna between two poles
    if spec.get("brushRoof") and not ruin:
        extras += brushHeap(K, "RoofBrush", (0.0, ROOF + 0.24, 0.0), (X1 - T - 0.6, 0.35, Z1 - T - 0.6), seed + 31, n=9)
    if spec.get("antenna") and not ruin:
        a, b = (X0 + T + 0.3, ROOF + 0.24, Z1 - T - 0.3), (X1 - T - 0.3, ROOF + 0.24, Z0 + T + 0.3)
        for k, p in enumerate((a, b)): extras.append(K.rod(f"Mast{k}", p, (p[0], p[1] + 3.2, p[2]), 0.04, "woodDark", G, 6))
        extras.append(K.rod("Wire", (a[0], a[1] + 3.15, a[2]), (b[0], b[1] + 3.0, b[2]), 0.008, "iron", G, 4))
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
        # (over the TOWER too: the mosque's minaret stands past the hall — a 45 cm slab of it was left standing full height)
        tx1 = max(X1, spec["tower"][0] + spec["tower"][2]) if "tower" in spec else X1
        top = K.skyline(X0 - 1.5, tx1 + 1.5, Z0 - 5.0, Z1 + 1.5, h - 0.03, amp, seed=seed, mat="stone")
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

# ── THE DECHRA'S PIECES (2026-10-27, DECHRA_PLAN.md): its terraces' walls, the lanes' steps, the djemaa ─────────────────
TERRACE = 2.0   # m: a terrace's drop — the retaining wall's height, the steps' climb (the map's rows: 2.6 game m apart)
def buildRetaining(K, name, spec, state, seed):
    """A TERRACE'S RETAINING WALL, a 4 m module laid end to end: dry stone from below the lower ground up to the terrace
    (TERRACE), its back into the hill, a knee-high PARAPET along its top (cover for the row above), its top broken a
    little; drain holes at its foot. Front -Z (downhill). Damaged: its parapet breached; ruin: slumped, its stones heaped."""
    R = random.Random(seed); G = "h"; L, H, P = 2.0, TERRACE, 0.6
    # (its foot 1.5 m down: the game stands it on the terrace below without levelling the ground — never floating)
    w = prismX(K, "Retain", [(-0.3, -1.5), (-0.3, H + P), (0.1, H + P), (0.1, H), (0.65, H), (0.65, -1.5)], -L, L, "stoneMechta")
    K.boolean(w, K.skyline(-L - 1, L + 1, -1.5, 0.12, H + P - 0.07, 0.09, seed=seed, mat="stoneMechta"))   # (the parapet's top: not a ruled line)
    for k in range(2):
        x = R.uniform(-L + 0.5, L - 0.5)
        K.boolean(w, K.cutter(x - 0.1, x + 0.1, 0.25, 0.45, -0.5, -0.05, "dark"))
    if state != "intact":
        K.boolean(w, K.breach((R.uniform(-0.9, 0.9), H + P * 0.6, -0.1), (0.75, 0.45, 0.5), seed=seed, mat="stone"))
        K.lump("Fall", (R.uniform(-0.8, 0.8), 0.0, -0.9), (0.8, 0.3, 0.5), "rubble", G, seed=seed + 1)
    if state == "ruin":
        K.boolean(w, K.skyline(-L - 1, L + 1, -2, 2, H * 0.55, 0.35, seed=seed + 2, mat="stone"))
        K.lump("Heap", (0.0, 0.0, -1.0), (1.6, 0.55, 0.7), "rubble", G, seed=seed + 3, rough=0.45)
    K.bevel(w, 0.05, 2, 30)

def buildSteps(K, name, spec, state, seed):
    """THE LANE'S STEPS up a terrace (TERRACE): ten stone steps between two stepped side walls, a landing at the top on
    the upper terrace. Front -Z (the foot, downhill). Damaged: a side wall breached; ruin: the steps broken off."""
    R = random.Random(seed); G = "h"
    zf, zl0, zl1, H = -2.4, 0.5, 1.0, TERRACE
    st = stairMass(K, "Steps", -0.8, 0.8, zf, zl0, zl1, H, 10, "stoneMechta")
    # the side walls a stepped parapet over the steps (their ends 3 cm past the steps': never one plane)
    walls = [stairMass(K, f"Side{s}", x0, x1, zf - 0.03, zl0, zl1 + 0.03, H + 0.45, 5, "stoneMechta") for s, (x0, x1) in ((0, (-1.2, -0.78)), (1, (0.78, 1.2)))]
    for o in [st] + walls: K.bevel(o, 0.03, 2, 30)
    # a stone BASE under it all, 1.5 m down (the game stands the steps on the terrace below as they are: never floating)
    K.box("StepBase", -1.2, 1.2, -1.5, 0.02, -2.43, 1.03, "stoneMechta", G, 0)
    if state != "intact":
        K.boolean(walls[1], K.breach((1.0, 1.4, -0.6), (0.4, 0.5, 0.6), seed=seed, mat="stone"))
        K.lump("Fall", (1.7, 0.0, -0.8), (0.5, 0.25, 0.6), "rubble", G, seed=seed + 1)
    if state == "ruin":
        top = K.skyline(-3, 3, -4, 3, 0.9, 0.35, seed=seed, mat="stone")
        for o in [st] + walls: K.boolean(o, top)

def buildDjemaa(K, name, spec, state, seed):
    """THE DJEMAA: the elders' place on the village square — a low wall behind and to one side, stone benches along it,
    a mat and jars. Front -Z (the square). Damaged: the wall breached; ruin: its stumps."""
    R = random.Random(seed); G = "h"
    walls = [wallRun(K, "DjBack", -3.0, 3.0, 0.9, 1.4, 1.1, seed), wallRun(K, "DjSide", -2.97, -2.47, -1.5, 0.95, 1.0, seed + 1)]
    K.box("BenchBack", -2.4, 2.9, 0.0, 0.45, 0.4, 0.92, "stoneMechta", G, 0.03)
    K.box("BenchSide", -2.45, -1.97, 0.0, 0.43, -1.4, 0.42, "stoneMechta", G, 0.03)   # (2 cm lower than the back bench: their tops never one plane)
    if state != "ruin":
        K.box("Mat", -0.8, 0.8, 0.45, 0.47, 0.45, 0.85, "rug2", G, 0)
        for k in range(2): K.cyl(f"DjJar{k}", (2.4 + k * 0.4, 0.0, -0.2), 0.2 - k * 0.03, 0.52 - k * 0.08, "jar", G, 12, r2=0.09)
    if state != "intact":
        K.boolean(walls[0], K.breach((1.2, 0.8, 1.15), (0.6, 0.45, 0.5), seed=seed, mat="stone"))
    if state == "ruin":
        top = K.skyline(-4, 4, -3, 3, 0.4, 0.2, seed=seed, mat="stone")
        for w in walls: K.boolean(w, top)

# ── THE FLN CAMP'S PIECES (2026-10-27, FLN_CAMP_PLAN.md: the hidden katiba camp) ────────────────────────────────────
def brushHeap(K, nm, c, size, seed, n=7, surface=None):
    """CAMOUFLAGE: cut juniper laid over something — STRAW-CARD piles the game draws (spots "Brush": algHaystack's brush
    kind, the haystack's quality floor — 2026-10-27: the baked lumps read as faceted green blobs, "nothing cheaper"),
    spread over the area, and a few dead branches sticking out (solid). `surface(x, z)`: the height under a spot (a
    mound's); flat at c[1] without."""
    R = random.Random(seed); G = "h"; made = []
    nx, nz = max(1, round(size[0] / 0.6)), max(1, round(size[2] / 0.6))   # (a spot every ~1.2 m: 0.9 left the mound bare between clumps)
    for i in range(nx):
        for j in range(nz):
            x = c[0] + (-size[0] + (2 * i + 1) * size[0] / nx) + R.uniform(-0.25, 0.25)
            z = c[2] + (-size[2] + (2 * j + 1) * size[2] / nz) + R.uniform(-0.25, 0.25)
            K.spots.append((x, surface(x, z) if surface else c[1], z, R.uniform(0, 6.28), "Brush", R.uniform(1.1, 1.5)))
    for k in range(n):
        a = R.uniform(0, 6.28); r = R.uniform(0.3, 1.0)
        x, z = c[0] + math.cos(a) * size[0] * r, c[2] + math.sin(a) * size[2] * r
        made.append(K.rod(f"{nm}Br{k}", (x, c[1] + size[1] * 0.6, z), (x + math.cos(a) * 0.6, c[1] + size[1] * R.uniform(0.2, 1.2), z + math.sin(a) * 0.6), 0.025, "woodDark", G, 4))
    return made

def buildCasemate(K, name, spec, state, seed):
    """THE REFUGE (casemate): a room half in the ground — a dry-stone FRONT with a low door, the beams' ends over it, the
    roof an EARTH MOUND under cut brush (invisible from the spotter planes). Front -Z. Damaged: the front breached, the
    mound holed; ruin: the front down to its stumps, the mound slumped in, charred beams out of it."""
    R = random.Random(seed); G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    W = 2.3
    front = K.box("Front", -W, W, -0.6, 1.45, -1.9, -1.4, "stoneMechta", G, 0)
    K.boolean(front, K.skyline(-W - 1, W + 1, -3, -1, 1.38, 0.08, seed=seed, mat="stoneMechta"))
    K.boolean(front, K.cutter(-0.42, 0.42, -0.1, 1.2, -2.1, -1.2, "dark"))   # (the low door)
    K.bevel(front, 0.06, 2, 30)
    K.box("Inside", -0.42, 0.42, -0.05, 1.2, -1.42, -1.3, "dark", G, 0)        # (its dark room behind the door)
    mound = K.lump("Mound", (0.0, -0.3, 0.6), (W + 0.4, 1.95 if not ruin else 0.9, 1.95), "earthMound", G, seed=seed + 1, rough=0.32, sub=3)   # (behind the front: never filling the doorway)
    parts = [front]
    if not ruin:
        for k in range(6):   # the roof beams' ends over the door's wall
            x = -W + 0.5 + k * (2 * W - 1.0) / 5
            parts.append(K.rod(f"Beam{k}", (x, 1.52, -2.15), (x + R.uniform(-0.05, 0.05), 1.55, -1.1), 0.08, "woodDark", G, 6))
        mound_y = lambda x, z: -0.3 + 1.95 * math.sqrt(max(0.0, 1 - (x / (W + 0.4)) ** 2 - ((z - 0.6) / 1.95) ** 2)) - 0.08   # (the mound's surface)
        brushHeap(K, "Roof", (0.0, 1.2, 0.5), (W - 0.2, 0.55, 1.5), seed + 3, n=6, surface=mound_y)
        for k in range(2): K.cyl(f"Jerry{k}", (W - 0.5 - k * 0.45, 0.0, -2.3), 0.16, 0.45, "iron", G, 8)
    if dmg:
        K.boolean(front, K.breach((R.uniform(0.8, 1.6), 0.9, -1.65), (0.6, 0.55, 0.5), seed=seed, mat="stone"))
        K.boolean(mound, K.breach((-0.8, 1.4, 0.2), (0.9, 0.6, 0.9), seed=seed + 5, mat="earthMound"))
        K.lump("Fall", (1.2, 0.0, -2.5), (0.7, 0.3, 0.45), "rubble", G, seed=seed + 2)
    if ruin:
        K.boolean(front, K.skyline(-W - 1, W + 1, -3, -1, 0.5, 0.3, seed=seed + 7, mat="stone"))
        for k in range(4):
            parts.append(K.rod(f"Burnt{k}", (R.uniform(-1.6, 1.6), 0.3, -1.6), (R.uniform(-1.8, 1.8), 1.1, R.uniform(-0.5, 0.8)), 0.08, "fsCharred", G, 6))

def buildCaveMouth(K, name, spec, state, seed):
    """THE CAVE'S MOUTH (the game sets it into its sandstone rocks — algCave): the timber SHORING (two posts and a
    lintel), the dark of the tunnel behind, a curved dry-stone BREASTWORK across the front with a gap, brush over the
    lintel, the gear (jerrycans, crates). The mouth 3 wide × 2.4 high (algCave's), front -Z. Damaged: the breastwork
    breached, a post knocked askew; ruin = BLOWN IN: the mouth filled with fallen rock, charred timbers out of it."""
    R = random.Random(seed); G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    # (no tunnel of its own: the game sets this into its cave — algCave's rocks frame it, its tunnel is the dark;
    # a big dark box here baked pale)
    walls = [wallRun(K, "BreastL", -2.6, -0.55, -1.55, -1.05, 1.05, seed), wallRun(K, "BreastR", 0.55, 2.6, -1.5, -1.0, 1.0, seed + 1)]
    if not ruin:
        tilt = 0.35 if dmg else 0.0
        K.rod("PostL", (-1.45, -0.2, 0.0), (-1.45, 2.42, 0.0), 0.11, "woodDark", G, 7)
        K.rod("PostR", (1.45, -0.2, 0.0), (1.45 + tilt, 2.4 - tilt * 0.3, -tilt * 0.4), 0.11, "woodDark", G, 7)
        K.rod("Lintel", (-1.75, 2.48, 0.0), (1.75, 2.46 - tilt * 0.4, 0.0), 0.13, "woodDark", G, 7)
        brushHeap(K, "Hang", (0.0, 2.55, -0.15), (1.9, 0.4, 0.5), seed + 3, n=6)
        for k in range(3): K.cyl(f"Jerry{k}", (-2.2 + k * 0.42, 0.0, -0.4), 0.16, 0.45, "iron", G, 8)
        for k in range(2): K.box(f"Crate{k}", 1.7, 2.3, 0.0 + k * 0.42, 0.4 + k * 0.42, -0.5, 0.0, "woodDark", G, 0.02)
    if dmg:
        K.boolean(walls[1], K.breach((1.5, 0.7, -1.25), (0.6, 0.5, 0.5), seed=seed, mat="stone"))
        K.lump("Fall", (1.8, 0.0, -2.1), (0.6, 0.28, 0.4), "rubble", G, seed=seed + 2)
    if ruin:   # BLOWN IN
        K.lump("Rockfall", (0.0, -0.06, -0.2), (2.2, 1.9, 1.4), "rubble", G, seed=seed + 4, rough=0.45, sub=3, flatten=200)   # (its lower half left round, under the ground: so rough, a bottom clamped flat folded over itself — the coplanar gate)
        for k in range(3): K.rod(f"Burnt{k}", (R.uniform(-1.4, 1.4), 0.4, -0.9), (R.uniform(-1.6, 1.6), 1.5, R.uniform(-0.2, 0.4)), 0.1, "fsCharred", G, 6)
        top = K.skyline(-4, 4, -4, 2, 0.45, 0.25, seed=seed, mat="stone")
        for w in walls: K.boolean(w, top)

def buildFoyer(K, name, spec, state, seed):
    """THE HIDDEN FIRE: a ring of stones, its ash, a pot on three stones and a kettle, under a brush SHADE on four poles
    (no smoke seen from the air). Damaged: the shade half down; ruin: scattered, cold."""
    R = random.Random(seed); G = "h"
    for k in range(10):
        a = k / 10 * 6.283
        K.lump(f"Ring{k}", (math.cos(a) * 0.6, 0.0, math.sin(a) * 0.6), (0.15, 0.12, 0.13), "stoneMechta", G, seed=seed + k, rough=0.3, sub=1)
    K.lump("Ash", (0.0, 0.0, 0.0), (0.45, 0.08, 0.45), "fsAshM", G, seed=seed + 20, rough=0.3)
    if state != "ruin":
        K.lump("Pot", (0.05, 0.12, 0.0), (0.22, 0.28, 0.22), "iron", G, seed=seed + 30, rough=0.04)   # (a cylinder overlapped itself once bevelled)
        K.cyl("Kettle", (0.9, 0.0, 0.5), 0.12, 0.25, "iron", G, 10, r2=0.07)
        for k, (x, z) in enumerate(((-1.6, -1.3), (1.6, -1.3), (-1.6, 1.3), (1.6, 1.3))):
            if state == "damaged" and k == 3: continue
            K.rod(f"Pole{k}", (x, 0.0, z), (x, 1.9, z), 0.05, "woodDark", G, 6)
        if state == "damaged": brushHeap(K, "Shade", (0.6, 0.1, 0.9), (1.4, 0.35, 0.9), seed + 3, n=5)   # (fallen)
        else:
            for k in range(7): K.rod(f"Lath{k}", (-1.75, 1.88, -1.3 + k * 0.43), (1.75, 1.88, -1.3 + k * 0.43 + 0.05), 0.03, "woodDark", G, 5)   # (the shade's laths: the brush lies on them)
            brushHeap(K, "Shade", (0.0, 1.9, 0.0), (1.6, 0.3, 1.3), seed + 3, n=5)

def earthMound(nb):
    """The casemate's roof: dug earth, stony, its colour the slope's (the ground blend takes it to the foot)."""
    # (darker than the ground: 0x8c6c4c read as a pale blob in the lab)
    c = nb.mix(nb.noise(2.5, 5), srgb(0x6a5038), srgb(0x4f3c2b))
    c = nb.mix(nb.mr(nb.noise(9.0, 4), 0.6, 0.68), c, srgb(0x86705a))
    return dust(nb, c, 0.6, 0.5)
MATDEF.update({"brushMaquis": (0.95, house.drystone.brushMat),   # (the sangars' juniper)
               "earthMound": (1.0, earthMound), "fsAshM": (1.0, lambda nb: nb.mix(nb.noise(4.0, 4), srgb(0x5e5a54), srgb(0x2e2a26)))})
# THE COMMAND POST: the one-room house requisitioned — brush over its roof, a long-wire radio antenna between two poles
TYPES["pc"] = dict(TYPES["petite"], brushRoof=True, antenna=True, life=[], ground=["firewood"])
TYPES["casemate"] = dict(builder=buildCasemate, atlas=1024, farRatio=0.45)
TYPES["grotte"] = dict(builder=buildCaveMouth, atlas=1024, farRatio=0.5)
TYPES["foyer"] = dict(builder=buildFoyer, atlas=512, farRatio=0.6)
TYPES["soutien"] = dict(builder=buildRetaining, atlas=512, farRatio=0.5)
TYPES["escalier"] = dict(builder=buildSteps, atlas=512, farRatio=1.0)   # (1.2k triangles: the far keeps them all — decimated, its ruin and its damaged state shaded off their near, the gate)
TYPES["djemaa"] = dict(builder=buildDjemaa, atlas=512, farRatio=0.5)
TYPES["appentis"] = dict(builder=buildLeanTo, atlas=1024, farRatio=0.45)
TYPES["enclos"] = dict(builder=buildYard, atlas=1024, farRatio=0.7)   # (0.45: the ruin's broken tops shaded off its near — the gate)
TYPES["tabouna"] = dict(builder=buildTabouna, atlas=512, farRatio=0.5)
MATDEF.update({"fsCharred": (0.95, lambda nb: nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e)))})

# ── THE KOUBBA AND THE CEMETERY (2026-10-29, REMAINING.md 8 — the old procedural ones, rtsAlgVillage buildKoubba /
# buildCemetery, for the new maps) ─────────────────────────────────────────────────────────────────────────────────────
def lathe(K, nm, prof, c, mat, n=40, smooth=True, rot=0.0, G="h"):
    """A TURNED solid round (c x, c z): `prof` [(r, y)] bottom to top, r 0 at an end closes it to a point."""
    bm = bmesh.new(); rings = []
    for r, y in prof:
        if r < 1e-4: rings.append([bm.verts.new(B(c[0], y, c[1]))]); continue
        rings.append([bm.verts.new(B(c[0] + r * math.cos(rot + 2 * math.pi * i / n), y, c[1] + r * math.sin(rot + 2 * math.pi * i / n))) for i in range(n)])
    for a, b in zip(rings, rings[1:]):
        if len(a) == 1: [bm.faces.new((a[0], b[(i + 1) % n], b[i])) for i in range(n)]
        elif len(b) == 1: [bm.faces.new((a[i], a[(i + 1) % n], b[0])) for i in range(n)]
        else: [bm.faces.new((a[i], a[(i + 1) % n], b[(i + 1) % n], b[i])) for i in range(n)]
    if len(rings[0]) > 1: bm.faces.new(list(reversed(rings[0])))
    if len(rings[-1]) > 1: bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, G, smooth)

def limeWash(nb):
    """THE KOUBBA'S WHITEWASH, generations of it: off-white to cream, grey rain streaks down from the parapet, a dirty
    ochre band at the foot (splash, dust)."""
    # (the first bake read as clean white plaster in the lab, 2026-10-29: the weathering pushed — older, greyer coats in
    # patches, the streaks stronger and longer, the foot dirtier and higher)
    c = nb.mix(nb.noise(1.4, 5, 0.6), srgb(0xcfc7b5), srgb(0xeee9de))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(0.6, 3, 0.5), 0.5, 0.62), 0.55), c, srgb(0xc2b8a3))                          # (an older coat showing)
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(4.0, 4, 0.6, stretch=(1, 1, 0.07)), 0.5, 0.74), 0.75), c, srgb(0x9a907c))   # (the streaks: the noise stretched down)
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.gy, 1.3, 0.0), 0.8), c, srgb(0x8f785a))                                           # (the foot)
    return dust(nb, c, 1.1, 0.9)
MATDEF.update({"limeWash": (0.92, limeWash),
               "soot": (1.0, lambda nb: nb.mix(nb.noise(6.0, 4), srgb(0x2a221c), srgb(0x4a3c30))),
               "copper": (0.45, flat(srgb(0x8a5a32)))})

KB_W, KB_C = 2.4, 6.0   # the tomb's half width; the enclosure's reach (algHouse MECHTA_PROPS koubba: change both together)
# the enclosure's outline (real metres, front -Z): irregular, the GATE between the first two points (x -1.0 … 1.0)
# (its ends at the gateway pillars' outer faces, x ±1.45: the stones ran through the pillars — seen)
KB_HAWSH = [(1.45, -5.58), (4.9, -5.1), (5.9, -1.2), (5.5, 3.6), (2.2, 5.8), (-2.6, 5.5), (-5.6, 2.9), (-5.9, -1.9), (-4.6, -5.3), (-1.45, -5.58)]
def buildKoubba(K, name, spec, state, seed):
    """THE KOUBBA (KOUBBA_PLAN.md — new, from the real thing): one square room of rubble under thick lime, its edges soft,
    its walls leaning in; a footing of stone; a parapet with four pointed corner HORNS; an octagonal drum and a smooth,
    slightly POINTED dome, its finial three copper balls and a crescent; a round-headed door deep in a lime frame, two
    soot-blackened candle niches, small grilled windows, the visitors' bench, offerings and votive rags; the render fallen
    in patches low down. Round it a low dry-stone enclosure on an irregular outline, a gateway between whitewashed pillars,
    a family grave inside. Front -Z. Damaged: the dome holed, a horn gone, render blown off, the enclosure breached;
    ruin: the dome fallen in, the walls' stumps, white rubble."""
    R = random.Random(seed); G = "h"; W = KB_W
    dmg, ruin = state != "intact", state == "ruin"
    H = 3.9   # the walls' height to the roof
    K.batter = -0.012   # (the joined mesh leans in with height — batteredJoin)
    foot = K.box("Footing", -W - 0.22, W + 0.22, -1.5, 0.32, -W - 0.22, W + 0.22, "stoneMechta", G, 0)
    K.boolean(foot, K.skyline(-W - 1, W + 1, -W - 1, W + 1, 0.3, 0.05, seed=seed, mat="stoneMechta"))
    K.bevel(foot, 0.05, 2, 30)
    tomb = K.box("Tomb", -W, W, 0.2, H, -W, W, "limeWash", G, 0)
    if ruin: K.boolean(tomb, K.skyline(-W - 1, W + 1, -W - 1, W + 1, 1.9, 0.7, seed=seed, mat="stoneMechta"))
    # the render's SOFT ARRISES on the block itself, the openings cut after: bevelled round the openings (and the fallen
    # render's ragged edges) it left zero-area slivers — the coplanar gate (16, then 13 pairs)
    K.bevel(tomb, 0.14, 4, 30)
    # the door: round-headed, deep in the wall; its lime frame proud of it; two candle niches; two small windows
    K.boolean(tomb, K.arch(-0.5, 0.5, 0.3, 1.85, -W - 0.5, -W + 0.38, "dark"))
    for s in (-1, 1):
        K.boolean(tomb, K.arch(s * 1.3 - 0.17, s * 1.3 + 0.17, 0.95, 1.3, -W - 0.3, -W + 0.16, "soot", n=8))
        K.boolean(tomb, K.cutter(s * W - 0.3, s * W + 0.3, 2.45, 2.85, -0.2, 0.2, "dark"))
    # THE RENDER FALLEN in patches low on the walls (the rubble under it)
    for k in range(3 if not dmg else 5):
        a = R.choice(((1, 0), (-1, 0), (0, 1)))
        x, z = (a[0] * W, R.uniform(-1.2, 1.2)) if a[0] else (R.uniform(-1.6, 1.6), W)
        K.boolean(tomb, K.breach((x, R.uniform(0.4, 1.1), z), (0.45 if a[0] else 0.5, 0.3, 0.45 if not a[0] else 0.5), seed=seed + 20 + k, mat="stoneMechta", rough=0.3))
    frame = K.box("DoorFrame", -0.82, 0.82, 0.32, 2.55, -W - 0.12, -W + 0.1, "limeWash", G, 0)
    K.boolean(frame, K.arch(-0.54, 0.54, 0.3, 1.85, -W - 0.5, -W + 0.38, "dark"))   # (a touch wider than the door's: never one face)
    K.bevel(frame, 0.05, 3, 30)
    leaf = K.box("Door", -0.49, 0.49, 0.33, 2.33, -W + 0.27, -W + 0.32, "doorGreen", G, 0)
    K.boolean(leaf, K.arch(-0.49, 0.49, 0.2, 1.85, -W + 0.1, -W + 0.5), op="INTERSECT")
    K.box("Threshold", -0.62, 0.62, 0.2, 0.35, -W - 0.45, -W + 0.3, "stoneMechta", G, 0.03)
    for s in (-1, 1):   # the windows' grilles, the niches' clay lamps
        for k in range(3): K.rod(f"Grille{s}{k}", (s * (W - 0.08), 2.45, -0.15 + k * 0.15), (s * (W - 0.08), 2.85, -0.15 + k * 0.15), 0.018, "woodDark", G, 5)
        if not ruin: lathe(K, f"Lamp{s}", [(0.0, 0.94), (0.05, 0.94), (0.08, 0.98), (0.07, 1.02), (0.04, 1.03), (0.03, 1.0), (0.0, 0.99)], (s * 1.3, -W + 0.06), "terracotta", n=14)   # (a clay oil lamp in the niche, sat in its floor)
    # the visitors' bench along the front, the right of the door
    bench = K.box("Bench", 0.95, W - 0.1, 0.25, 0.72, -W - 0.62, -W + 0.1, "limeWash", G, 0)
    K.bevel(bench, 0.08, 3, 30)
    parts = []
    if not ruin:
        # THE PARAPET round the roof (its inside cut away: the roof sits low behind it), the four corner HORNS
        par = K.box("Parapet", -W - 0.04, W + 0.04, H - 0.1, H + 0.42, -W - 0.04, W + 0.04, "limeWash", G, 0)
        K.boolean(par, K.cutter(-W + 0.32, W - 0.32, H + 0.12, H + 1.0, -W + 0.32, W - 0.32))
        K.bevel(par, 0.1, 3, 30)
        for i, (sx, sz) in enumerate(((-1, -1), (1, -1), (1, 1), (-1, 1))):
            if dmg and i == 1: continue   # (knocked off: its stump below)
            x, z = sx * (W - 0.12), sz * (W - 0.12)
            parts.append(lathe(K, f"Horn{i}", [(0.3, H + 0.3), (0.3, H + 0.62), (0.22, H + 0.7), (0.21, H + 0.92), (0.12, H + 1.05), (0.0, H + 1.32 + i * 0.01)], (x, z), "limeWash", n=4, smooth=False, rot=math.pi / 4))
        # THE DRUM (octagonal, a lip at its top) and THE DOME: turned, slightly pointed
        Rd, y0 = 1.72, H + 0.08   # (its foot 4 cm under the roof: never on it)
        parts.append(lathe(K, "Drum", [(Rd, y0), (Rd, y0 + 0.62), (Rd + 0.09, y0 + 0.68), (Rd + 0.09, y0 + 0.8), (Rd - 0.05, y0 + 0.83)], (0, 0), "limeWash", n=8, smooth=False, rot=math.pi / 8))
        Rm, yb = 1.6, y0 + 0.8
        prof = [(Rm, yb)] + [(Rm * math.cos(a) ** 1.15, yb + 1.9 * math.sin(a)) for a in (math.pi / 2 * i / 14 for i in range(1, 14))] + [(0.0, yb + 1.93)]
        dome = lathe(K, "Dome", prof, (0, 0), "limeWash", n=40)
        parts.append(dome)
        top = yb + 1.93
        if not dmg:
            K.rod("Finial", (0.0, top - 0.1, 0.0), (0.0, top + 0.95, 0.0), 0.022, "iron", G, 6)
            for k, r in enumerate((0.1, 0.08, 0.06)): lathe(K, f"Ball{k}", [(0.0, top + 0.12 + k * 0.24 - r)] + [(r * math.sin(math.pi * j / 6), top + 0.12 + k * 0.24 - r * math.cos(math.pi * j / 6)) for j in range(1, 6)] + [(0.0, top + 0.12 + k * 0.24 + r)], (0, 0), "copper", n=10)
            K.member("Crescent", (-0.09, top + 0.86, 0.0), (0.09, top + 0.86, 0.0), [(-0.012, 0.0), (0.012, 0.0), (0.012, 0.13), (-0.012, 0.13)], "copper", G)
        else:
            K.boolean(dome, K.breach((0.7, yb + 1.1, -0.9), (0.75, 0.7, 0.7), seed=seed, mat="dark"))
            K.rod("FinialBent", (0.0, top - 0.1, 0.0), (0.4, top + 0.6, -0.25), 0.022, "iron", G, 6)
            K.lump("HornFallen", (W + 0.9, 0.0, -W - 0.6), (0.3, 0.22, 0.25), "limeWash", G, seed=seed + 4, rough=0.3, sub=2)
        # offerings and votive rags by the door
        # (TURNED JARS on the ground before the footing, sunk 3 cm — cones floating 30 cm over the ground read as cheap)
        for k, (x, sc) in enumerate(((-1.95, 1.0), (-1.5, 0.82), (-1.2, 0.66))): clayJar(K, f"Offering{k}", x, -W - 0.5 - k * 0.04, sc)
        K.rod("RagCord", (-0.75, 2.5, -W - 0.16), (0.75, 2.5, -W - 0.16), 0.008, "woodDark", G, 4)
        for k in range(6):
            x, dx, dy = -0.62 + k * 0.25, R.uniform(-0.04, 0.04), R.uniform(0.18, 0.34)
            K.member(f"Rag{k}", (x, 2.5, -W - 0.17), (x + dx, 2.5 - dy, -W - 0.19), [(-0.035, 0.0), (0.035, 0.0), (0.035, 0.006), (-0.035, 0.006)], f"cloth{1 + k % 3}", G)
    # THE ENCLOSURE'S GATEWAY: two whitewashed pillars and their caps (its dry-stone wall: the piece "hawsh" — its own
    # atlas: ~1800 stones took 60 % of the koubba's, its walls and dome left blurred, 2026-10-29)
    for s in (-1, 1):
        p = K.box(f"Pillar{s}", s * 1.0 - 0.32, s * 1.0 + 0.32, -0.3, 1.45, -5.95, -5.3, "limeWash", G, 0)
        K.bevel(p, 0.08, 3, 30)
        # (a small pointed cap, the horns' shape — a round one read as a crumpled blob in the lab)
        if not ruin: lathe(K, f"Cap{s}", [(0.5, 1.38), (0.5, 1.5), (0.37, 1.57), (0.34, 1.67), (0.0, 1.93 + s * 0.01)], (s * 1.0, -5.62), "limeWash", n=4, smooth=False, rot=math.pi / 4)
    # a family grave inside the enclosure (the saint's kin): a low plastered box, its headstone
    gb = K.box("KinGrave", -4.5, -3.9, 0.0, 0.32, 0.4, 2.3, "limeWash", G, 0)
    K.bevel(gb, 0.07, 3, 30)
    K.lump("KinHead", (-4.2, -0.2, 2.42), (0.24, 0.95, 0.07), "stoneMechta", G, seed=seed + 30, rough=0.22, sub=2)
    if ruin:
        K.lump("Heap", (0.3, 0.25, 0.2), (2.2, 1.15, 2.0), "mechtaWhiteRubble", G, seed=seed + 9, rough=0.45, flatten=200)
        for k in range(5): K.lump(f"Chunk{k}", (R.uniform(-3.4, 3.4), 0.0, R.uniform(-3.6, -2.7)), (0.32, 0.2, 0.28), "limeWash", G, seed=seed + 40 + k, rough=0.35, sub=2)
    K.spots.append((4.2, 0.0, 3.6, R.uniform(0, 6.28), "Brush", 1.6))   # (a juniper grown in the enclosure's corner)

def buildHawsh(K, name, spec, state, seed):
    """THE KOUBBA'S ENCLOSURE (hawsh): a low dry-stone wall stone by stone round its irregular outline (KB_HAWSH), between
    the koubba's gateway pillars; damaged: breached on its west side; ruin: its top half fallen. Placed with the koubba."""
    stoneWallPath(K, random.Random(seed), KB_HAWSH, 0.95, 0.56, state, gap=(-5.75, 0.5, 1.1) if state != "intact" else None)

def clayJar(K, nm, x, z, sc=1.0, y0=-0.03):
    """A TURNED JAR (the offerings, a village's water): a foot, a full belly, its shoulder, a narrow neck, a rolled rim and
    its open mouth — sat on the ground (y0: 3 cm into it)."""
    prof = [(0.0, 0), (0.09, 0), (0.12, 0.03), (0.19, 0.14), (0.215, 0.25), (0.2, 0.34), (0.15, 0.42), (0.085, 0.47), (0.075, 0.52),
            (0.09, 0.55), (0.1, 0.57), (0.085, 0.585), (0.065, 0.56), (0.055, 0.5), (0.0, 0.48)]
    return lathe(K, nm, [(r * sc, y0 + y * sc) for r, y in prof], (x, z), "terracotta", n=20)

def terracotta(nb):
    """Fired clay: red-brown, paler where it dried, darker where water ran, dusty at the foot."""
    c = nb.mix(nb.noise(3.0, 5, 0.6), srgb(0x8a4a2e), srgb(0xb06a44))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(6.0, 4, 0.6, stretch=(1, 1, 0.15)), 0.55, 0.75), 0.5), c, srgb(0xc9a27e))
    return dust(nb, c, 0.3, 1.0)
def fieldRock(nb):
    """A dry-stone wall's stones: the ruined-wall photo pulled to the Aurès' warm ochre, EACH STONE its own shade (light
    to brown), lichen-grey here and there. (Not the house stone's: its darker foot — splash under 0.7 m — took the whole of
    a 1 m wall, near black in the game's shade.)"""
    c = nb.mix(0.55, nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9), srgb(0xb89a72))
    c = nb.scale(c, nb.mr(nb.island(), 0.0, 1.0, 0.8, 1.15))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.island(), 0.82, 1.0), 0.6), c, srgb(0x9a9688))
    return dust(nb, c, 0.4, 0.5)
MATDEF.update({"terracotta": (0.8, terracotta),
               # (a wall built STONE BY STONE: its bake alone — named outside the "stone" surface class, whose dry-stone photo
               # laid over 30 cm stones showed each one a scrap of the photo's dark joints: the koubba's enclosure near black)
               "fieldRock": (0.95, fieldRock)})

def wallStone(K, nm, c, size, R, yaw, mat="fieldRock"):
    """A rough field stone (fieldwall.py's: the hull of 14 points on a flattened ellipsoid, each pushed — ~24 triangles),
    its long axis turned to `yaw` (the wall's way)."""
    bm = bmesh.new(); vs = []
    tx, tz = R.uniform(-0.15, 0.15), R.uniform(-0.15, 0.15)
    ca, sa = math.cos(yaw), math.sin(yaw)
    for i in range(14):
        u = 1 - 2 * (i + 0.5) / 14; v = i * 2.399963 + R.uniform(-0.3, 0.3)
        r = math.sqrt(max(0.0, 1 - u * u)) * R.uniform(0.84, 1.0)
        px, py, pz = r * math.cos(v) * size[0], u * size[1] * R.uniform(0.88, 1.0), r * math.sin(v) * size[2]
        py += px * tx + pz * tz
        vs.append((c[0] + px * ca + pz * sa, c[1] + py, c[2] - px * sa + pz * ca))
    vs = [bm.verts.new(B(*q)) for q in vs]
    bmesh.ops.convex_hull(bm, input=vs)
    return K.obj(nm, bm, mat, "h")

def stoneWallPath(K, R, pts, h, th, state, gap=None):
    """A DRY-STONE WALL along a polyline, stone by stone (fieldwall.py's way): a rubble core, courses of rough stones on
    both faces (joints staggered, a big one now and then, thinner up — the batter), flat capstones; `gap` (x, z, r) a
    breach with its stones fallen out in front; the ruin's top half mostly gone, its stones scattered."""
    G = "h"; ruin = state == "ruin"; top = h * (0.5 if ruin else 1.0); k = 0
    for i in range(len(pts) - 1):
        (ax, az), (bx, bz) = pts[i], pts[i + 1]
        L = math.hypot(bx - ax, bz - az); dx, dz = (bx - ax) / L, (bz - az) / L; nx, nz = -dz, dx
        yaw = math.atan2(-dz, dx)
        at = lambda s, o: (ax + dx * s + nx * o, az + dz * s + nz * o)
        # the core: rubble between the faces, below the capstones (never seen through a joint)
        e = i * 0.012   # (each length's top and foot their own height: where two meet at a corner, never one face)
        K.member(f"Core{i}", (ax, 0.0, az), (bx, 0.0, bz), [(-th * 0.32, -0.5 - e), (th * 0.32, -0.5 - e), (th * 0.26, top - 0.12 - e), (-th * 0.26, top - 0.12 - e)], "rubble", G)
        y, course = -0.05, 0
        while y < top - 0.1:
            ch = R.uniform(0.17, 0.3); t = th * (1 - 0.2 * y / h)
            s = 0.02 + (0.2 if course % 2 else 0.0)
            while s < L - 0.14:   # (inside its length: never through what it ends against)
                w = min(R.uniform(0.28, 0.5) if R.random() < 0.8 else R.uniform(0.5, 0.72), L - 0.02 - s)
                cs = s + w / 2
                x, z = at(cs, 0)
                hole = gap and math.hypot(x - gap[0], z - gap[1]) < gap[2] and y > 0.05
                gone = ruin and R.random() < 0.15 + 0.5 * (y / top)
                if not hole and not gone:
                    for side in (-1, 1):
                        px, pz = at(cs + R.uniform(-0.03, 0.03), side * t * R.uniform(0.38, 0.48))
                        wallStone(K, f"W{k}{side}", (px, y + ch / 2, pz), (w * 0.6, ch * 0.66, t * 0.34), R, yaw)
                    k += 1
                s += w + R.uniform(0.0, 0.03)
            y += ch * 0.9; course += 1
        if not ruin:   # the capstones, across the top
            s = 0.0
            while s < L:
                w = R.uniform(0.3, 0.46); x, z = at(s + w / 2, 0)
                if not (gap and math.hypot(x - gap[0], z - gap[1]) < gap[2]):
                    wallStone(K, f"Cap{k}", (x, top + 0.03, z), (w / 2, R.uniform(0.06, 0.09), th * 0.42), R, yaw)
                k += 1; s += w + 0.02
    # the fallen: a heap out of the breach; a ruin's stones scattered both sides
    for i in range(10 if gap else 18 if ruin else 0):
        if gap: px, pz = gap[0] + R.uniform(-1.1, -0.3), gap[1] + R.uniform(-0.9, 0.9)
        else:
            j = R.randrange(len(pts) - 1); f = R.random(); (ax, az), (bx, bz) = pts[j], pts[j + 1]
            px, pz = ax + (bx - ax) * f + R.uniform(-0.9, 0.9), az + (bz - az) * f + R.uniform(-0.9, 0.9)
        sz = R.uniform(0.1, 0.18)
        wallStone(K, f"F{i}", (px, sz * 0.5, pz), (sz * 1.3, sz * 0.7, sz), R, R.uniform(0, 6.28))

def whiteRubble(nb):
    """The koubba's fallen walls: lime render broken over rubble stone."""
    s = nb.mix(0.5, nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.9), srgb(0xa8855c))
    return dust(nb, nb.mix(nb.mr(nb.noise(2.5, 4), 0.45, 0.6), s, srgb(0xe2dccd)), 1.6, 1.0)
MATDEF.update({"mechtaWhiteRubble": (0.95, whiteRubble)})

def graveSlab(nb):
    """The slabs of the graves: split schist and limestone from the hill, grey-ochre, each its own shade, lichen-grey
    patches, dust at the foot."""
    # (darker, more varied than the first bake — pale even slabs read as soap bars in the lab, 2026-10-29)
    c = nb.mix(0.5, nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 1.2), srgb(0x857a68))
    c = nb.scale(c, nb.mr(nb.island(), 0.0, 1.0, 0.68, 1.12))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(5.0, 4, 0.6), 0.55, 0.72), 0.7), c, srgb(0x5f5f55))   # (dark lichen)
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(9.0, 3, 0.6), 0.62, 0.74), 0.5), c, srgb(0xb8b29c))   # (pale crust)
    return dust(nb, c, 0.25, 0.8)
MATDEF.update({"graveSlab": (0.95, graveSlab)})

def buildGrave(K, name, spec, state, seed):
    """A GRAVE of the Aurès (2026-10-29, redone from references — the first, a bead ring round a pale mound, read cheap):
    laid toward Mecca, on the slope as it is (the game tilts it to the ground); its head at +Z. `grave` (spec):
      slab   a kerb of rough slabs set on edge round a bed of dark earth and small stones; an uncut upright HEADSTONE (the
             chahed), a smaller one at the foot — the commonest;
      white  a low plastered box, whitewashed and weathered (the plaster fallen in patches), a ridge along its top, a
             plastered stele with a pointed head;
      heap   an old grave: its kerb slumped low, a heap of stones over it, a short headstone half sunk.
    Every stone's foot sunk: never a gap under it on the slope."""
    R = random.Random(seed); G = "h"; kind = spec.get("grave", "slab"); stone = house.drystone.stone
    L, Wd = 1.05, 0.4   # the bed's half length and half width
    if kind == "white":
        box = K.box("Plaster", -Wd - 0.04, Wd + 0.04, -0.3, 0.3, -L, L, "limeWash", G, 0)
        K.bevel(box, 0.05, 3, 30)
        for k in range(2):   # the plaster fallen in patches (after the bevel: small cuts, no slivers)
            K.boolean(box, K.breach((R.choice((-1, 1)) * (Wd + 0.04), R.uniform(0.02, 0.16), R.uniform(-0.7, 0.4)), (0.22, 0.12, 0.25), seed=seed + k, mat="graveSlab", rough=0.3))
        ridge = K.box("Ridge", -0.15, 0.15, 0.24, 0.41, -L + 0.2, L - 0.26, "limeWash", G, 0)
        K.bevel(ridge, 0.05, 3, 30)
        K.member("Stele", (0.0, 0.0, L - 0.08), (0.0, 0.0, L + 0.06), [(-0.21, -0.3), (0.21, -0.3), (0.21, 0.62), (0.12, 0.77), (0.0, 0.84), (-0.12, 0.77), (-0.21, 0.62)], "limeWash", G, w=0.02)
        stone(K, "Foot", (0.0, 0.05, -L - 0.08), (0.14, 0.28, 0.05), R, 0.0, "graveSlab", yaw=R.uniform(-0.08, 0.08), box=0.55)
        return
    heap = kind == "heap"
    # THE KERB: slabs on edge along both sides, two across each end (a heap's slumped low)
    k = 0
    for side in (-1, 1):
        z = -L
        while z < L - 0.12:
            w = min(R.uniform(0.3, 0.5), L - z); h = R.uniform(0.15, 0.25) * (0.55 if heap else 1.0)
            stone(K, f"Kerb{k}", (side * (Wd + R.uniform(-0.02, 0.03)), h * 0.45 - 0.1, z + w / 2), (w / 2, h, 0.045), R, 0.0, "graveSlab", yaw=math.pi / 2 + R.uniform(-0.07, 0.07), box=0.6)
            k += 1; z += w + R.uniform(0.0, 0.03)
    for end in (-1, 1):
        for s in (-1, 1):
            h = R.uniform(0.14, 0.22) * (0.55 if heap else 1.0)
            stone(K, f"End{k}", (s * Wd * 0.5, h * 0.45 - 0.1, end * (L + 0.04)), (Wd * 0.5, h, 0.045), R, 0.0, "graveSlab", yaw=R.uniform(-0.07, 0.07), box=0.6)
            k += 1
    # THE BED: dark earth, small stones laid over it (a heap: piled high in the middle)
    K.lump("Bed", (0.0, -0.06, 0.0), (Wd - 0.03, 0.2 if heap else 0.1, L - 0.05), "graveEarth", G, seed=seed, rough=0.2, sub=3)
    for i in range(26 if heap else 20):
        x, z = R.uniform(-Wd + 0.1, Wd - 0.1), R.uniform(-L + 0.12, L - 0.12)
        top = (0.16 if heap else 0.05) * math.sqrt(max(0.0, 1 - (x / Wd) ** 2 - (z / L) ** 2))
        sz = R.uniform(0.06, 0.11) * (1.3 if heap else 1.0)
        wallStone(K, f"Bed{i}", (x, top - 0.02 + i * 0.002, z), (sz * 1.2, sz * 0.6, sz), R, R.uniform(0, 6.28))
    # THE HEADSTONE (the chahed): an uncut slab upright at the head, leaning a little; a smaller one at the foot
    hh = R.uniform(0.38, 0.5) * (0.6 if heap else 1.0)
    stone(K, "Head", (R.uniform(-0.04, 0.04), hh - 0.3, L + 0.13), (R.uniform(0.19, 0.25), hh + 0.3, 0.06), R, 0.0, "graveSlab", yaw=R.uniform(-0.12, 0.12), box=0.5)
    fh = hh * 0.55
    stone(K, "Foot", (R.uniform(-0.04, 0.04), fh - 0.22, -L - 0.12), (0.14, fh + 0.22, 0.05), R, 0.0, "graveSlab", yaw=R.uniform(-0.12, 0.12), box=0.5)

def buildLowWall(K, name, spec, state, seed):
    """A LOW DRY-STONE WALL, a 4 m length (the cemetery's foot, a field's edge), stone by stone (stoneWallPath — the
    first, a prism with a stone photo, read as a plank): breached when damaged, its top half fallen as a ruin."""
    stoneWallPath(K, random.Random(seed), [(-2.0, 0.0), (2.0, 0.0)], 0.78, 0.5, state, gap=(0.5, 0.0, 0.6) if state != "intact" else None)

MATDEF.update({"graveEarth": (1.0, lambda nb: dust(nb, nb.mix(nb.noise(6.0, 5), srgb(0x4a3a2b), srgb(0x5e4a37)), 0.5, 0.12))})   # (dust light: the bed is all "foot" — at 0.4 it baked pale)
TYPES["koubba"] = dict(builder=buildKoubba, atlas=2048, farRatio=0.65, islandMargin=0.004)   # (islands 8 px apart: at 1 px the dome's seams bled — dark notches)
TYPES["hawsh"] = dict(builder=buildHawsh, atlas=1024, farRatio=0.75, islandMargin=0.002, aoDist=0.2, smoothAngle=80, weighted=False)   # (stones packed: a short AO — 0.4 baked them near black; round-shaded, the sangar's — at 35° they read as crystals)
# the graves: their stones round-shaded, a short AO (packed small stones)
GRAVE = dict(builder=buildGrave, atlas=512, farRatio=0.6, states=["intact"], aoDist=0.25, smoothAngle=38, weighted=False, islandMargin=0.003)   # (split stone: crisp arrises — at 70° the slabs read as soap)
TYPES["tombe"] = dict(GRAVE, grave="slab")
TYPES["tombeb"] = dict(GRAVE, grave="white")
TYPES["tombec"] = dict(GRAVE, grave="heap")
TYPES["murette"] = dict(builder=buildLowWall, atlas=512, farRatio=0.75, aoDist=0.2, smoothAngle=80, weighted=False)

for spec in TYPES.values():
    spec.setdefault("builder", buildMechta); spec.setdefault("farRatio", 0.38)   # (0.3: the loggia house's far ruin shaded off its near — the gate)

exported = buildKit(TYPES, MATDEF, "mechta.glb", prefix="Mechta", seed0=1957, surfaces=True)
previews(TYPES, exported, prefix="Mechta", tag="mechta_", spacing=13, frame=0.8)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REFS, "mechta.blend"))
print("DONE")
