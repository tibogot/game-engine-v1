"""THE PORT IN BLENDER (2026-10-30, games/alg-rts/PORT_PLAN.md — you: "make the port assets for the other map; as always
think AAA Company of Heroes assets, not cheap assets, of course as optimized as possible"). The coast map's fishing port,
late 1950s Constantinois (Stora, Collo, Philippeville — assets-src/refs/coast/), NEW pieces (not algPort.js re-dressed):

  ROW HOUSES   French colonial, two or three storeys, LIME-WASHED (white, cream, ochre, pale blue — worn grey at the foot,
               streaked under the sills, the rubble showing where the render fell), real wall thickness: every opening
               a deep reveal; tall windows with glazing bars, stone sills, louvred SHUTTERS (some open flat on the wall,
               some closed); a dressed-stone PLINTH, a stone band between the storeys; under the eaves the GENOISE (rows
               of tile ends, the Mediterranean's eaves); a low gable roof of CANAL TILES, modelled — channels of round
               cover tiles, course by course, their round ends at the eaves; the ridge of tiles on its lime mortar; a
               chimney. A balcony on iron brackets over the door; a café's canvas awning.
                 quai     two storeys, three bays, the balcony
                 cafe     the café below (a glazed shopfront either side of the door, the awning), two storeys
                 etroite  narrow, three storeys, two bays
  STATES       damaged: shell holes through the front, shutters torn off, a hole in the roof (its tiles gone round it);
               ruin: the upper floor gone (the walls broken off ragged), no roof, its rubble and charred beams inside

Real metres (the game x1.3); x along the front, y up, the FRONT (the street, the sea) at -Z.

  node tools/blenderKit.mjs port [--only quai] [--quick]

Writes public/models/alg/port.glb (Port<Type>_<State> + _Far).
"""
import sys, os, math, random
sys.path.insert(0, os.path.dirname(__file__))
import bpy, bmesh
import house
from house import buildKit, previews
from bkit import B, srgb, dust, flat, paintedWood

# ── Materials ────────────────────────────────────────────────────────────────
def wash(tint, foot=0x8a8070):
    """A LIME WASH over rubble: the plaster photo pulled to its colour, uneven; fallen off in patches (the stone under
    it); grey rain streaks; the foot greyed by splash and salt."""
    def f(nb):
        c = nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.55)
        c = nb.mix(0.6, c, srgb(tint))
        c = nb.scale(c, nb.mr(nb.noise(0.6, 4), 0.3, 0.7, 0.84, 1.04))
        stone = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
        peel = nb.mr(nb.noise(1.7, 8, 0.66, (1, 1, 1), (1.3, 0, 4.4)), 0.668, 0.69)
        c = nb.mix(peel, c, stone)
        streak = nb.math("MULTIPLY", nb.mr(nb.noise(3.2, 5, 0.6, (9, 9, 0.45)), 0.5, 0.7), 0.45)
        c = nb.mix(streak, c, srgb(0x9a9286))
        c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.gy, 1.2, 0.1), 0.55), c, srgb(foot))
        return dust(nb, c, 1.2, 0.8)
    return f
def canalTile(nb):
    """Fired clay canal tiles: orange-red, each tile its own shade, lichen-grey and sooty in patches, paler where the sun
    bleached them."""
    c = nb.mix(nb.noise(2.0, 4), srgb(0x9c4a2c), srgb(0xb8653a))
    c = nb.scale(c, nb.mr(nb.island(), 0.0, 1.0, 0.78, 1.12))
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(4.0, 5, 0.6), 0.58, 0.72), 0.6), c, srgb(0x6d6a5c))   # (lichen)
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(1.2, 3), 0.6, 0.75), 0.4), c, srgb(0xd09a70))         # (bleached)
    return c
def dressedStone(nb):
    """The plinths and bands: dressed sandstone, warm, weathered."""
    c = nb.mix(0.5, nb.img("build/large_sandstone_blocks/large_sandstone_blocks_diff_1k.jpg", 0.9), srgb(0xc2a77e))
    c = nb.scale(c, nb.mr(nb.noise(1.5, 4), 0.3, 0.7, 0.85, 1.05))
    return dust(nb, c, 0.8, 0.6)
def glass(nb):   # (dark panes, a dull sky reflection in some)
    return nb.mix(nb.mr(nb.noise(1.0, 2), 0.5, 0.7), srgb(0x1c2024), srgb(0x56636b))
def stripes(a, b, freq=2.0):
    """A café's awning canvas: broad stripes along its fall (50 cm — 31 cm, noised, baked blurred and mottled in the
    lab), crisp, a little faded."""
    def f(nb):
        s = nb.mr(nb.math("SINE", nb.math("MULTIPLY", nb.gx, freq * 6.283)), -0.02, 0.02)
        c = nb.mix(s, srgb(a), srgb(b))
        # (faded broadly, not in specks: the fine noise read blotchy in the lab and the first mip smoothed it away — the mip check)
        return nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(0.25, 2), 0.4, 0.7), 0.25), c, srgb(0xd8d0bc))
    return f
MATDEF = dict(house.MATDEF)
MATDEF.update({
    "interior": (0.95, wash(0xd7cbb2, foot=0x6e6658)), "earth": (1.0, flat(srgb(0x5d4c3b))),
    "fsCharred": (0.95, lambda nb: nb.mix(nb.noise(3.0, 5), srgb(0x1c1814), srgb(0x3a2a1e))),
    "washWhite": (0.95, wash(0xece6d8)), "washCream": (0.95, wash(0xe8d6b0)), "washOchre": (0.95, wash(0xd8a86a)),
    "washBlue": (0.95, wash(0xb9cdd8)),
    "canalTile": (0.85, canalTile), "mortarLime": (0.95, flat(srgb(0xd8d2c4))), "dressedStone": (0.95, dressedStone),
    "glass": (0.2, glass), "frameWhite": (0.8, flat(srgb(0xd9d4c7))),
    "shutterBrown": (0.8, paintedWood(0x6b4a33)),
    "awningRed": (0.9, stripes(0xa8402e, 0xe0d6bf)), "awningBlue": (0.9, stripes(0x2f5d8a, 0xe0d6bf)),
})

# ── THE HOUSE ────────────────────────────────────────────────────────────────
TYPES = {
    "quai": dict(W=8.4, D=7.0, storeys=[3.4, 3.2], wash="washCream", shutter="shutterGreen", door="doorGreen",
                    ground=["win", "door", "win"], upper=[["win", "balc", "win"]], chimney=2.0, pitch=0.42, open=[0, 2, 5]),
    "cafe": dict(W=9.6, D=7.5, storeys=[3.6, 3.2], wash="washWhite", shutter="shutterBlue", door="doorBlue",
                    ground=["shop", "door", "shop"], upper=[["win", "win", "win"]], chimney=-2.6, pitch=0.4, awning="awningBlue", open=[1, 4]),
    "etroite": dict(W=5.6, D=7.0, storeys=[3.3, 3.1, 3.0], wash="washOchre", shutter="shutterBrown", door="doorRed",
                    ground=["door", "win"], upper=[["win", "balc"], ["win", "win"]], chimney=1.2, pitch=0.44, open=[0, 3]),
}
T = 0.5   # the walls' thickness (the reveals' depth: 0.22)

def bays(spec):
    n = len(spec["ground"]); W = spec["W"]
    return [-W / 2 + W * (i + 0.5) / n for i in range(n)]

def opening(K, R, spec, wall, kind, x, y0, state, nth, z0, joinery=True, far=False):
    """One opening in the front at x, from y0: its reveal cut in `wall`, its joinery, sill, shutters (`joinery` False:
    the reveal only — a ruin's upper floor, broken off below them: they hung in the air)."""
    G = "h"; dmg = state != "intact"
    if kind == "door":
        w, h = 1.2, 2.7
    elif kind == "shop":
        w, h = 2.3, 2.8
    elif kind == "balc":
        w, h = 1.15, 2.6
    else:
        w, h = 1.0, 1.95
        y0 += 0.85 if y0 < 1 else 0.55
    x0, x1, y1 = x - w / 2, x + w / 2, y0 + h
    # (a ruin's openings right through its hollow walls: the room seen through them)
    K.boolean(wall, K.cutter(x0, x1, y0, y1, z0 - 0.5, z0 + (T + 0.3 if state == "ruin" else 0.22), "dark"))
    if not joinery: return
    back = z0 + 0.2
    if kind in ("door",):
        K.box(f"Door{nth}", x0 + 0.02, x1 - 0.02, y0, y1 - 0.02, back - 0.06, back, spec["door"], G, 0.005)
        K.box(f"Fan{nth}", x0 + 0.05, x1 - 0.05, y1 - 0.55, y1 - 0.08, back - 0.08, back - 0.06, "glass", G, 0)
        K.box(f"Step{nth}", x0 - 0.15, x1 + 0.15, -0.3, 0.12, z0 - 0.45, z0 + 0.05, "dressedStone", G, 0.02)
        K.box(f"Surround{nth}", x0 - 0.18, x1 + 0.18, y1 - 0.02, y1 + 0.22, z0 - 0.04, z0 + 0.04, "dressedStone", G, 0.01)   # (the lintel stone)
        return
    # the glazing: dark panes behind a white frame and glazing bars
    K.box(f"Pane{nth}", x0, x1, y0, y1, back - 0.01, back + 0.01, "glass", G, 0)
    # (the far level's bars twice as wide: at 4 cm, a texel or two, the mips there blended them with the tiles beside them
    # — orange crosses, you, 2026-10-30)
    fb = 2.0 if far else 1.0
    K.box(f"FrameT{nth}", x0, x1, y1 - 0.07 * fb, y1, back - 0.05, back - 0.01, "frameWhite", G, 0)
    K.box(f"FrameM{nth}", x - 0.03 * fb, x + 0.03 * fb, y0, y1 - 0.07 * fb, back - 0.05, back - 0.01, "frameWhite", G, 0)
    for k in range(1 if kind == "win" else 2):
        yb = y0 + (y1 - y0) * (k + 1) / (3 if kind != "win" else 2)
        K.box(f"Bar{nth}{k}", x0, x1, yb - 0.02 * fb, yb + 0.02 * fb, back - 0.04, back - 0.02, "frameWhite", G, 0)
    if kind == "shop":   # a shopfront: its stall riser, no shutters
        K.box(f"Riser{nth}", x0, x1, 0.0, 0.6, back - 0.08, back - 0.02, spec["door"], G, 0.005)
        # its stone THRESHOLD: the opening's floor was the ground's height — the two flickered (you, 2026-10-30, the café)
        K.box(f"ShopSill{nth}", x0 - 0.06, x1 + 0.06, -0.3, 0.09, z0 - 0.14, back - 0.1, "dressedStone", G, 0.015)
        return
    if kind != "balc":   # the stone sill, proud
        K.box(f"Sill{nth}", x0 - 0.08, x1 + 0.08, y0 - 0.1, y0 - 0.02, z0 - 0.09, z0 + 0.05, "sill", G, 0.01)
    # THE SHUTTERS: open flat against the wall either side, or closed in the reveal; torn off when damaged
    if dmg and R.random() < 0.6: return
    if nth in spec.get("open", []):
        for s, (a, b) in enumerate(((x0 - w / 2 - 0.02, x0 - 0.02), (x1 + 0.02, x1 + w / 2 + 0.02))):
            if dmg and s == 1: continue
            K.box(f"Sh{nth}{s}", a, b, y0, y1, z0 - 0.06, z0 - 0.02, spec["shutter"], G, 0.005)
    else:
        K.box(f"Sh{nth}", x0 + 0.01, x1 - 0.01, y0 + 0.01, y1 - 0.01, z0 + 0.06, z0 + 0.1, spec["shutter"], G, 0.005)
        K.box(f"ShGap{nth}", x - 0.008, x + 0.008, y0 + 0.02, y1 - 0.02, z0 + 0.055, z0 + 0.065, "dark", G, 0)

def tileRoof(K, R, x0, x1, zE0, zE1, yE, pitch, hole=None, far=False):
    """THE CANAL-TILE ROOF over x0..x1, its eaves at zE0 (front) and zE1 (back) at height yE, its ridge on the middle:
    a deck under it (the tiles' colour, seen between the channels), the COVER TILES in channels down each slope course by
    course (each course's foot lifted over the one below — the overlaps the eye reads), the ridge's round tiles on a
    lime bed. `hole` (x, z, r): no tiles there, the deck holed (a shell through the roof). `far`: the far level's — each
    channel one long strip, three-sided (decimated, the courses folded into each other: the coplanar gate)."""
    G = "h"; zR = (zE0 + zE1) / 2; rise = (zR - zE0) * math.tan(pitch); yR = yE + rise
    deck = []
    for s, zE in ((-1, zE0), (1, zE1)):
        d = K.member(f"Deck{s}", (0.0, yE, zE), (0.0, yR, zR), [(x0 - 0.02, -0.06), (x1 + 0.02, -0.06), (x1 + 0.02, 0.0), (x0 - 0.02, 0.0)], "canalTile", G, up=(0, 1, 0))
        deck.append(d)
    if hole:
        for d in deck: K.boolean(d, K.breach((hole[0], yE + rise * 0.5, hole[1]), (hole[2], 1.2, hole[2]), seed=7, mat="woodDark"))
    r, pitchX, course = 0.075, 0.21, 0.42
    nx = int((x1 - x0) / pitchX)
    for s, zE in ((-1, zE0), (1, zE1)):
        # (the far keeps the COURSES — strips without them changed the roof at the switch, you: "the roof lod is changing too
        # much"; its tiles three-sided instead)
        L = math.hypot(zR - zE, rise); nC = max(1, round(L / course))
        for i in range(nx):
            x = x0 + pitchX * (i + 0.5)
            for c in range(nC):
                # (each course stops 8 mm short of the next, its foot lifted over it: overlapped, their faces were one — the gate,
                # 29 pairs, then 92 with the courses sized up)
                f0, f1 = c / nC, (c + 1) / nC - 0.008 / L
                za, zb = zE + (zR - zE) * f0, zE + (zR - zE) * min(1.0, f1)
                ya, yb = yE + rise * f0 + 0.04, yE + rise * min(1.0, f1) + 0.012   # (the far the same steps as the near: at 1.5 cm its courses did not read)
                if hole and math.hypot(x - hole[0], (za + zb) / 2 - hole[1]) < hole[2] + 0.3: continue
                ang = [math.pi * k / (3 if far else 5) for k in range(4 if far else 6)]
                K.member(f"Tile{s}_{i}_{c}", (x + R.uniform(-0.01, 0.01), ya, za), (x, yb, zb), [(r * math.cos(t), r * math.sin(t) * 0.8) for t in ang], "canalTile", G, up=(0, 1, 0))
    # the ridge: its lime bed, the round ridge tiles along it
    K.box("RidgeBed", x0 - 0.05, x1 + 0.05, yR - 0.04, yR + 0.05, zR - 0.14, zR + 0.14, "mortarLime", G, 0.01)
    ang = [math.pi * k / 6 for k in range(7)]
    K.member("Ridge", (x0 - 0.08, yR + 0.03, zR), (x1 + 0.08, yR + 0.03, zR), [(0.13 * math.cos(t), 0.11 * math.sin(t)) for t in ang], "canalTile", G, up=(0, 1, 0))
    return yR

def genoise(K, R, x0, x1, z, y, out, far=False):
    """THE GENOISE under the eaves: two rows of tile ends stepping out from the wall, bedded in lime."""
    G = "h"; ang = [math.pi * k / 4 for k in range(5)]
    for row in range(2):
        yy = y - 0.17 + row * 0.12; d = 0.12 + row * 0.12
        K.box(f"GenBed{row}{out}", x0, x1, yy - 0.06, yy - 0.005, z - out * d, z + out * 0.02, "mortarLime", G, 0)
        n = 0 if far else int((x1 - x0) / 0.2)   # (the far level: the beds alone)
        for i in range(n):
            x = x0 + (x1 - x0) * (i + 0.5) / n
            K.member(f"Gen{row}{out}_{i}", (x, yy, z + out * 0.02), (x, yy, z - out * d), [(0.06 * math.cos(t), 0.05 * math.sin(t)) for t in ang], "canalTile", G, up=(0, 1, 0))

def buildHouse(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    W, D = spec["W"], spec["D"]; X0, X1, Z0, Z1 = -W / 2, W / 2, -D / 2, D / 2
    heights = spec["storeys"]; floors = [sum(heights[:i]) for i in range(len(heights))]; HE = sum(heights)
    pitch = spec["pitch"]; rise = (D / 2 + 0.45) * math.tan(pitch)
    # THE WALLS: one block to the eaves, the gables' triangles on it
    wall = K.box("Walls", X0, X1, -0.4, HE, Z0, Z1, spec["wash"], G, 0)
    K.bevel(wall, 0.04, 2, 30)
    # HOLLOW once hit (the inside in its own plaster): solid, a ruin's broken top was a flat cap — "the roof full, not
    # showing the inside of the house" (you, 2026-10-30); a shell hole looked into stone. Intact: solid (never seen inside).
    if dmg:
        K.boolean(wall, K.cutter(X0 + T, X1 - T, 0.02, HE + 6, Z0 + T, Z1 - T, "interior"))
        K.box("GroundFloor", X0 + T - 0.02, X1 - T + 0.02, -0.2, 0.03, Z0 + T - 0.02, Z1 - T + 0.02, "earth", G, 0)
        if not ruin:   # its floors, seen through a shell hole
            for fy in floors[1:]: K.box(f"Floor{fy}", X0 + T - 0.02, X1 - T + 0.02, fy - 0.25, fy, Z0 + T - 0.02, Z1 - T + 0.02, "woodDark", G, 0)
    gab = K.member("Gable", (X0, HE - 0.01, 0.0), (X1, HE - 0.01, 0.0), [(Z0, 0.0), (Z1, 0.0), (0.0, rise - 0.5 * math.tan(pitch) - 0.08)], spec["wash"], G, up=(0, 1, 0))
    # the openings: the front's bays storey by storey; the back's two small windows a storey
    xs = bays(spec); nth = 0
    for k, x in enumerate(xs):
        opening(K, R, spec, wall, spec["ground"][k], x, 0.0, state, nth, Z0, far=far); nth += 1
    for fl, row in enumerate(spec["upper"]):
        for k, x in enumerate(xs):
            opening(K, R, spec, wall, row[k], x, floors[fl + 1], state, nth, Z0, joinery=not ruin, far=far); nth += 1
    for fy in floors:
        for x in (X0 + W * 0.3, X1 - W * 0.3):
            yb = fy + (1.0 if fy == 0 else 0.7)
            K.boolean(wall, K.cutter(x - 0.4, x + 0.4, yb, yb + 1.3, Z1 - 0.22, Z1 + 0.5, "dark"))
            if not (ruin and fy > 0): K.box(f"BackSh{fy}{x}", x - 0.38, x + 0.38, yb + 0.02, yb + 1.28, Z1 - 0.1, Z1 - 0.06, spec["shutter"], G, 0.005)
    # THE PLINTH and the band between the storeys: proud skins of dressed stone (their door cut a touch wider than the wall's)
    plinths = [K.box("PlinthF", X0 - 0.06, X1 + 0.06, -0.4, 0.62, Z0 - 0.06, Z0 + 0.01, "dressedStone", G, 0.01),
               K.box("PlinthB", X0 - 0.06, X1 + 0.06, -0.4, 0.6, Z1 - 0.01, Z1 + 0.06, "dressedStone", G, 0.01),
               K.box("PlinthL", X0 - 0.06, X0 + 0.01, -0.4, 0.61, Z0 - 0.03, Z1 + 0.03, "dressedStone", G, 0.01),
               K.box("PlinthR", X1 - 0.01, X1 + 0.06, -0.4, 0.59, Z0 - 0.03, Z1 + 0.03, "dressedStone", G, 0.01)]
    for k, x in enumerate(xs):
        if spec["ground"][k] in ("door", "shop"):
            w = 1.2 if spec["ground"][k] == "door" else 2.3
            if not ruin: K.boolean(plinths[0], K.cutter(x - w / 2 - 0.03, x + w / 2 + 0.03, -1, 3, Z0 - 0.5, Z0 + 0.3, "dark"))   # (not in a ruin: there it left a sliver with the deeper cut — the gate, the café)
    for fy in floors[1:]:
        K.box(f"Band{fy}", X0 - 0.04, X1 + 0.04, fy - 0.2, fy - 0.04, Z0 - 0.05, Z0 + 0.01, "dressedStone", G, 0.01)
    # A BALCONY on iron brackets before each "balc": its slab, its rail
    for fl, row in enumerate(spec["upper"]):
        for k, x in enumerate(xs):
            if row[k] != "balc" or ruin: continue
            y = floors[fl + 1]
            K.box(f"Balc{fl}{k}", x - 0.95, x + 0.95, y - 0.12, y + 0.02, Z0 - 0.75, Z0 + 0.02, "dressedStone", G, 0.015)
            for s in (-1, 1):   # stone corbels under it (thin iron struts read as cables in the lab)
                for j, (d, h) in enumerate(((0.62, 0.16), (0.42, 0.3), (0.22, 0.42))):
                    K.box(f"Corbel{fl}{k}{s}{j}", x + s * 0.7 - 0.07, x + s * 0.7 + 0.07, y - 0.12 - h, y - 0.12 - (0.0 if j == 0 else 0.002 * j), Z0 - d, Z0 + 0.01, "dressedStone", G, 0.01)
            for px in [x - 0.9 + 0.12 * i for i in range(16)]:
                K.rod(f"Bal{fl}{k}{px:.2f}", (px, y + 0.02, Z0 - 0.7), (px, y + 0.95, Z0 - 0.7), 0.012, "iron", G, 4)
            K.rod(f"Rail{fl}{k}", (x - 0.93, y + 0.97, Z0 - 0.71), (x + 0.93, y + 0.97, Z0 - 0.71), 0.025, "iron", G, 6)
            for s in (-1, 1): K.rod(f"RailS{fl}{k}{s}", (x + s * 0.93, y + 0.97, Z0 - 0.71), (x + s * 0.93, y + 0.97, Z0 - 0.02), 0.025, "iron", G, 6)
    # THE CAFE'S AWNING over the ground floor, on its iron arms
    if spec.get("awning") and not ruin:
        a = K.member("Awning", (0.0, 3.05, Z0 - 0.02), (0.0, 2.55, Z0 - 1.6), [(X0 + 0.3, -0.01), (X1 - 0.3, -0.01), (X1 - 0.3, 0.01), (X0 + 0.3, 0.01)], spec["awning"], G, up=(0, 1, 0))
        if dmg: K.boolean(a, K.breach((1.5, 2.8, Z0 - 0.9), (1.0, 0.6, 0.6), seed=seed, mat=spec["awning"]))
        K.member("Valance", (0.0, 2.57, Z0 - 1.6), (0.0, 2.35, Z0 - 1.62), [(X0 + 0.3, -0.01), (X1 - 0.3, -0.01), (X1 - 0.3, 0.01), (X0 + 0.3, 0.01)], spec["awning"], G, up=(0, 0, -1))
        for x in (X0 + 0.5, X1 - 0.5): K.rod(f"AwArm{x}", (x, 2.3, Z0 - 0.01), (x, 2.56, Z0 - 1.58), 0.018, "iron", G, 5)
    # THE ROOF, the genoise, the chimney (none in a ruin; holed when damaged)
    if not ruin:
        genoise(K, R, X0, X1, Z0, HE, 1, far); genoise(K, R, X0, X1, Z1, HE, -1, far)
        yR = tileRoof(K, R, X0 - 0.3, X1 + 0.3, Z0 - 0.45, Z1 + 0.45, HE + 0.02, pitch, hole=(W * 0.18, Z0 * 0.45, 1.1) if dmg else None, far=far)
        cx = spec["chimney"]
        ch = K.box("Chimney", cx - 0.35, cx + 0.35, HE, yR + 0.9, 0.35, 1.0, spec["wash"], G, 0)
        K.bevel(ch, 0.03, 2, 30)
        K.box("ChimCap", cx - 0.45, cx + 0.45, yR + 0.9, yR + 0.98, 0.25, 1.1, "dressedStone", G, 0.01)
    # DAMAGE: shell holes through the front; RUIN: the walls broken off ragged, rubble and charred beams inside
    if dmg:
        # (on the wall BETWEEN the openings, their own draws: one through a reveal's side left a sliver — the gate, etroite)
        Rb = random.Random(seed + 99)
        piers = [(xs[k] + xs[k + 1]) / 2 for k in range(len(xs) - 1)] + [X0 + 0.55, X1 - 0.55]
        for k in range(2 if not ruin else 1):
            K.boolean(wall, K.breach((piers[(k + seed) % len(piers)], Rb.uniform(1.6, HE - 1.2), Z0), (0.5, 0.65, 0.6), seed=seed + k, mat="stone"))
        K.lump("Fall", (R.uniform(X0 + 1, X1 - 1), 0.0, Z0 - 1.0), (1.1, 0.35, 0.6), "rubble", G, seed=seed + 3)
    if ruin:
        top = K.skyline(X0 - 1, X1 + 1, Z0 - 1, Z1 + 1, floors[1] + 0.6, 1.1, seed=seed, mat="stone")
        for o in [wall, gab] + plinths: K.boolean(o, top)
        # THE INSIDE: rubble heaped LOW against the walls and in a corner (one heap to the brim read as a roof of dirt), the
        # upper floor's broken ledge along the back wall, joists down from it, a partition's stub, charred beams
        xi0, xi1, zi0, zi1 = X0 + T, X1 - T, Z0 + T, Z1 - T
        for k, (cx, cz, sx, sy, sz) in enumerate(((xi0 + 0.9, zi1 - 0.9, 1.3, 0.95, 1.0), (xi1 - 0.8, zi0 + 0.7, 1.0, 0.6, 0.8),
                                                  ((xi0 + xi1) / 2, zi1 - 0.6, W * 0.22, 0.55, 0.6), (xi1 - 0.7, zi1 - 0.8, 0.8, 0.7, 0.8))):
            K.lump(f"Heap{k}", (cx, 0.0, cz), (sx, sy, sz), "rubble", G, seed=seed + 5 + k, rough=0.45, flatten=200)
        y1 = floors[1]
        ledge = K.box("Ledge", xi0 - 0.03, xi1 + 0.03, y1 - 0.28, y1, zi1 - 1.5, zi1 + 0.04, "woodDark", G, 0)
        K.boolean(ledge, K.breach(((xi0 + xi1) / 2 + 0.6, y1 - 0.1, zi1 - 1.5), (W * 0.28, 0.6, 0.9), seed=seed + 11, mat="woodDark"))
        for k in range(6):   # the joists: some still in the back wall, some fallen to the floor, one end on the rubble
            x = xi0 + 0.4 + k * (xi1 - xi0 - 0.8) / 5
            if k % 2: K.rod(f"Joist{k}", (x, y1 - 0.14, zi1 + 0.1), (x + R.uniform(-0.2, 0.2), y1 - 0.14, zi1 - R.uniform(1.6, 2.4)), 0.08, "woodDark", G, 6)
            else: K.rod(f"Joist{k}", (x, y1 - 0.2, zi1 - 0.3), (x + R.uniform(-0.6, 0.6), 0.15, zi0 + R.uniform(0.6, 1.8)), 0.08, "fsCharred" if k == 2 else "woodDark", G, 6)
        part = K.box("Partition", -0.12 + W * 0.08, 0.12 + W * 0.08, 0.0, y1 * 0.8, zi0 - 0.02, (zi0 + zi1) / 2, "interior", G, 0)
        K.boolean(part, K.skyline(X0, X1, Z0, Z1, 1.1, 0.6, seed=seed + 13, mat="stone"))
        for k in range(3): K.rod(f"Beam{k}", (R.uniform(xi0 + 0.4, xi1 - 0.4), 0.2, zi0 + 0.5), (R.uniform(xi0 + 0.4, xi1 - 0.4), R.uniform(0.6, 1.2), zi1 - 0.8), 0.09, "fsCharred", G, 6)

for spec in TYPES.values():
    # (its far level its own build — the tiles as long strips, the genoise's beds alone — baked on the same atlas)
    spec.update(builder=buildHouse, farBuilder=lambda K, n, sp, st, sd: buildHouse(K, n, sp, st, sd, far=True), atlas=2048,
                # (wider gaps between the islands — 0.004, 0.006 — baked the atlas BLACK, silently: the far level's bars are widened instead)
                islandMargin=0.003,
                # (its thin coloured parts kept wide enough in the atlas to hold their colour at the mips — bkit.bake `thin`)
                thin=("frameWhite", "sill", "iron", "mortarLime", "glass"), thinPx=20,
                # (the roof's and the genoise's thousand tiles on 8 shared islands — bkit.bake `shared`: room for wide gaps)
                shared=("canalTile",),
                boost={"awningRed": 2.0, "awningBlue": 2.0})   # (the café's stripes: 8 texels each smeared — the mip check, 90 %)

exported = buildKit(TYPES, MATDEF, "port.glb", prefix="Port", seed0=1955)
previews(TYPES, exported, prefix="Port", tag="port_", spacing=14, frame=0.8)
print("DONE")
