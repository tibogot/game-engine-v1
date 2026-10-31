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
from drystone import stone   # (split blocks: the mole's rock apron, its fallen coping)
from house import buildKit, previews
from bkit import B, srgb, dust, flat, paintedWood
import bkit
_join = bkit.Kit.join
def cleanJoin(self, name, objs):
    """The kit's join, every merged piece rid of its zero-area triangles (mechta.py's way: the quay cargo's left two — the
    coplanar gate)."""
    # (the world matrices refreshed first: a part placed by its location or matrix — the casks, props.place's drums — was
    # joined where it was BUILT, at the origin, every cask on top of the others: the coplanar gate, 2026-10-31)
    bpy.context.view_layer.update()
    if os.environ.get("PORT_PROBE"):
        for o in objs:
            mw = o.matrix_world
            if any(abs((mw @ v.co).x) < 0.02 and abs((mw @ v.co).z) < 0.005 and 0.05 < (mw @ v.co).y < 0.6 for v in o.data.vertices): print("PROBE", name, o.name, flush=True)
    j = _join(self, name, objs)
    bm = bmesh.new(); bm.from_mesh(j.data)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges)
    bm.to_mesh(j.data); bm.free()
    return j
bkit.Kit.join = cleanJoin

# ── Materials ────────────────────────────────────────────────────────────────
def wash(tint, foot=0x8a8070, peel=0.668):
    """A LIME WASH over rubble: the plaster photo pulled to its colour, uneven; fallen off in patches (the stone under
    it); grey rain streaks; the foot greyed by splash and salt."""
    def f(nb):
        c = nb.img("build/white_plaster_rough_01/white_plaster_rough_01_diff_1k.jpg", 0.55)
        c = nb.mix(0.6, c, srgb(tint))
        c = nb.scale(c, nb.mr(nb.noise(0.6, 4), 0.3, 0.7, 0.84, 1.04))
        stone = nb.img("build/rabdentse_ruins_wall/rabdentse_ruins_wall_diff_1k.jpg", 0.45)
        peel_ = nb.mr(nb.noise(1.7, 8, 0.66, (1, 1, 1), (1.3, 0, 4.4)), peel, peel + 0.022)
        c = nb.mix(peel_, c, stone)
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
    # (a ground-floor opening cut from 15 cm up, its STONE THRESHOLD under it to the back of the reveal: cut from the ground,
    # its floor lay at the terrain's height and z-fought it — the café, then the church; the GROUNDZ gate now)
    yc = 0.15 if y0 < 0.05 else y0
    K.boolean(wall, K.cutter(x0, x1, yc, y1, z0 - 0.5, z0 + (T + 0.3 if state == "ruin" else 0.22), "dark"))
    if y0 < 0.05: K.box(f"Threshold{nth}", x0 - 0.04, x1 + 0.04, -0.3, 0.16, z0 - 0.06, z0 + 0.24, "dressedStone", G, 0.01)
    if not joinery: return
    back = z0 + 0.2
    if kind in ("door",):
        K.box(f"Door{nth}", x0 + 0.02, x1 - 0.02, 0.17, y1 - 0.02, back - 0.06, back, spec["door"], G, 0.005)
        K.box(f"Fan{nth}", x0 + 0.05, x1 - 0.05, y1 - 0.55, y1 - 0.08, back - 0.08, back - 0.06, "glass", G, 0)
        K.box(f"Step{nth}", x0 - 0.15, x1 + 0.15, -0.3, 0.12, z0 - 0.45, z0 - 0.04, "dressedStone", G, 0.02)
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
        K.box(f"ShopSill{nth}", x0 - 0.06, x1 + 0.06, -0.3, 0.09, z0 - 0.14, z0 - 0.08, "dressedStone", G, 0.015)
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

def tileRoof(K, R, x0, x1, zE0, zE1, yE, pitch, hole=None, far=False, only=None, nm=""):
    """THE CANAL-TILE ROOF over x0..x1, its eaves at zE0 (front) and zE1 (back) at height yE, its ridge on the middle:
    a deck under it (the tiles' colour, seen between the channels), the COVER TILES in channels down each slope course by
    course (each course's foot lifted over the one below — the overlaps the eye reads), the ridge's round tiles on a
    lime bed. `hole` (x, z, r): no tiles there, the deck holed (a shell through the roof). `far`: the far level's — each
    channel one long strip, three-sided (decimated, the courses folded into each other: the coplanar gate). `only` -1 / +1:
    that slope alone, no ridge (a LEAN-TO against a higher wall — the church's aisles). `nm`: its objects' name prefix."""
    G = "h"; zR = (zE0 + zE1) / 2; rise = (zR - zE0) * math.tan(pitch); yR = yE + rise
    deck = []
    for s, zE in [(s_, z_) for s_, z_ in ((-1, zE0), (1, zE1)) if only in (None, s_)]:
        d = K.member(f"{nm}Deck{s}", (0.0, yE, zE), (0.0, yR, zR), [(x0 - 0.02, -0.06), (x1 + 0.02, -0.06), (x1 + 0.02, 0.0), (x0 - 0.02, 0.0)], "canalTile", G, up=(0, 1, 0))
        deck.append(d)
    if hole:
        for d in deck: K.boolean(d, K.breach((hole[0], yE + rise * 0.5, hole[1]), (hole[2], 1.2, hole[2]), seed=7, mat="woodDark"))
    r, pitchX, course = 0.075, 0.21, 0.42
    tiles = []   # (all of them ONE object — K.members: one each, the join cost 22 s a state)
    nx = int((x1 - x0) / pitchX)
    for s, zE in [(s_, z_) for s_, z_ in ((-1, zE0), (1, zE1)) if only in (None, s_)]:
        # (the far keeps the COURSES — strips without them changed the roof at the switch, you: "the roof lod is changing too
        # much"; its tiles three-sided instead)
        L = math.hypot(zR - zE, rise); nC = max(1, round(L / course))
        # (the far's tiles three-sided, as near's: one flat band a course, its texture projected from the near, came out
        # smeared and lighter — 2026-10-31, the warehouse; corrugated, the same)
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
                tiles.append(((x + R.uniform(-0.01, 0.01), ya, za), (x, yb, zb), [(r * math.cos(t), r * math.sin(t) * 0.8) for t in ang]))
    K.members(f"{nm}Tiles", tiles, "canalTile", G)
    if only is not None: return yR
    # the ridge: its lime bed, the round ridge tiles along it
    K.box(f"{nm}RidgeBed", x0 - 0.05, x1 + 0.05, yR - 0.04, yR + 0.05, zR - 0.14, zR + 0.14, "mortarLime", G, 0.01)
    ang = [math.pi * k / 6 for k in range(7)]
    K.member(f"{nm}Ridge", (x0 - 0.08, yR + 0.03, zR), (x1 + 0.08, yR + 0.03, zR), [(0.13 * math.cos(t), 0.11 * math.sin(t)) for t in ang], "canalTile", G, up=(0, 1, 0))
    return yR

def genoise(K, R, x0, x1, z, y, out, far=False):
    """THE GENOISE under the eaves: two rows of tile ends stepping out from the wall, bedded in lime."""
    G = "h"; ang = [math.pi * k / (2 if far else 4) for k in range(3 if far else 5)]   # (the far's tile ends three-sided)
    for row in range(2):
        yy = y - 0.17 + row * 0.12; d = 0.12 + row * 0.12
        K.box(f"GenBed{row}{out}", x0, x1, yy - 0.06, yy - 0.005, z - out * d, z + out * 0.02, "mortarLime", G, 0)
        n = int((x1 - x0) / 0.2)   # (the far keeps its tile ends: beds alone, the warehouse's far shaded off its near — the gate)
        K.members(f"Gen{row}{out}", [((x0 + (x1 - x0) * (i + 0.5) / n, yy, z + out * 0.02), (x0 + (x1 - x0) * (i + 0.5) / n, yy, z - out * d), [(0.06 * math.cos(t), 0.05 * math.sin(t)) for t in ang]) for i in range(n)], "canalTile", G)

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

# ── THE MAGASIN (2026-10-31, PORT_PLAN.md 2 — refs: Philippeville's harbour entrance, the 1887 sketch; S.alles' photographs):
# the harbour's warehouse — long and low, its gable end to the sea; rendered rubble under an ochre wash, DRESSED-STONE
# QUOINS at its corners and round its doors; four big ROUND-ARCHED DOORWAYS on the quay (its front, -Z), plank doors —
# one open on the dark inside, one ajar; small barred windows high on the back; a low canal-tile roof; a stone loading
# step along the doors. States as the houses: damaged (shell holes, the roof holed, a door torn off), ruin (the roof gone,
# the walls broken off ragged, rubble and charred trusses inside).
def quoins(K, R, x, z, sx, sz, H, nm, bev=0.012, avoid=()):
    """Dressed long-and-short blocks up a corner at (x, z), proud of both faces it turns (sx, sz: which way out)."""
    G = "h"; y, k = -0.42, 0   # (from -0.3, the first stone's top fell at the ground's height: z-fought the terrain — the GROUNDZ gate)
    while y < H - 0.25:
        h = 0.32 + R.uniform(-0.02, 0.02); L = 0.55 if k % 2 else 0.32
        for a in avoid:   # (a stone's top or foot never level with a course it meets — the string's top and a quoin's fell at one height: the gate)
            if abs(y + h - 0.012 - a) < 0.02 or abs(y + h - a) < 0.02: h += 0.045
        # (along X: L from the corner, 5 cm proud of the face at z; along Z: the short side)
        ax0, ax1 = (x - L, x + 0.04) if sx > 0 else (x - 0.04, x + L)
        K.box(f"{nm}{k}x", ax0, ax1, y, y + h - 0.012, (z - 0.05) if sz < 0 else z, z if sz < 0 else (z + 0.05), "dressedStone", G, bev)
        L2 = 0.32 if k % 2 else 0.55
        az0, az1 = (z, z + L2) if sz < 0 else (z - L2, z)
        K.box(f"{nm}{k}z", (x - 0.0) if sx > 0 else (x - 0.05), (x + 0.05) if sx > 0 else x, y + 0.006, y + h - 0.018, az0, az1, "dressedStone", G, bev)
        y += h; k += 1

def buildMagasin(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"
    dmg, ruin = state != "intact", state == "ruin"
    W, D, H, pitch = spec["W"], spec["D"], spec["H"], spec["pitch"]
    X0, X1, Z0, Z1 = -W / 2, W / 2, -D / 2, D / 2
    rise = (D / 2 + 0.4) * math.tan(pitch)
    wall = K.box("Walls", X0, X1, -0.4, H, Z0, Z1, spec["wash"], G, 0)
    K.bevel(wall, 0.04, 2, 30)
    gab = K.member("Gable", (X0, H - 0.01, 0.0), (X1, H - 0.01, 0.0), [(Z0, 0.0), (Z1, 0.0), (0.0, rise - 0.4 * math.tan(pitch) - 0.08)], spec["wash"], G, up=(0, 1, 0))
    if dmg:   # hollow once hit, as the houses
        K.boolean(wall, K.cutter(X0 + T, X1 - T, 0.02, H + 6, Z0 + T, Z1 - T, "interior"))
        K.box("Floor", X0 + T - 0.02, X1 - T + 0.02, -0.2, 0.03, Z0 + T - 0.02, Z1 - T + 0.02, "earth", G, 0)
    # THE DOORWAYS: four round arches on the quay, their dressed-stone surrounds, plank doors (one open, one ajar)
    n = spec["doors"]; xs = [X0 + W * (i + 0.5) / n for i in range(n)]; dw, ds = 2.4, 2.5
    for i, x in enumerate(xs):
        deep = i == spec["open"] and not dmg   # (the open one cut deep into the solid block: its dark inside seen — at 30 cm it showed wall)
        K.boolean(wall, K.arch(x - dw / 2, x + dw / 2, 0.12, ds, Z0 - 0.5, Z0 + (T + 0.3 if ruin else 1.8 if deep else 0.3), "dark", n=12))
        if not ruin:
            sur = K.box(f"Surround{i}", x - dw / 2 - 0.3, x + dw / 2 + 0.3, 0.1, ds + dw / 2 + 0.35, Z0 - 0.06, Z0 + 0.01, "dressedStone", G, 0)
            K.boolean(sur, K.arch(x - dw / 2 - 0.02, x + dw / 2 + 0.02, -0.5, ds, Z0 - 0.5, Z0 + 0.3, "dark", n=12))
            K.bevel(sur, 0.02, 2, 30)
        back = Z0 + 0.26
        if ruin or (dmg and i == 1): continue   # (torn off)
        if i == spec["open"]:   # open: the leaves folded back against the reveal, the dark inside
            for s in (-1, 1): K.box(f"Leaf{i}{s}", x + s * dw / 2 - (0.06 if s > 0 else 0.01), x + s * dw / 2 + (-0.01 if s > 0 else 0.06), 0.13, ds + 0.2, back - 0.02, back + 1.1, "woodDark", G, 0.005)
            if not dmg: K.box(f"Inside{i}", x - dw / 2 - 0.05, x + dw / 2 + 0.05, 0.05, ds + dw / 2 + 0.05, Z0 + 1.7, Z0 + 1.75, "dark", G, 0)
            continue
        leaf = K.box(f"Door{i}", x - dw / 2, x + dw / 2, 0.12, ds + dw / 2, back, back + 0.06, spec["door"], G, 0.005)
        K.boolean(leaf, K.arch(x - dw / 2, x + dw / 2, 0.0, ds, back - 0.2, back + 0.3), op="INTERSECT")
        for k in range(1, 6):   # the planks' joints
            K.box(f"Joint{i}{k}", x - dw / 2 + k * dw / 6 - 0.008, x - dw / 2 + k * dw / 6 + 0.008, 0.15, ds - 0.05, back - 0.006, back + 0.001, "dark", G, 0)
        for y in (0.6, 2.0): K.box(f"Strap{i}{y}", x - dw / 2 + 0.05, x + dw / 2 - 0.05, y, y + 0.07, back - 0.02, back + 0.0, "iron", G, 0)
    # the stone LOADING STEP along the doors
    K.box("Step", X0 + 0.4, X1 - 0.4, -0.3, 0.12, Z0 - 0.9, Z0 + 0.02, "dressedStone", G, 0.02)
    # small BARRED WINDOWS high on the back
    for i in range(n):
        x = X0 + W * (i + 0.5) / n
        K.boolean(wall, K.cutter(x - 0.45, x + 0.45, H - 1.5, H - 0.7, Z1 - 0.22, Z1 + 0.5, "dark"))
        if not ruin:
            for k in range(4): K.rod(f"Bar{i}{k}", (x - 0.3 + k * 0.2, H - 1.5, Z1 - 0.12), (x - 0.3 + k * 0.2, H - 0.7, Z1 - 0.12), 0.015, "iron", G, 5)
    # THE QUOINS at the four corners
    for (x, sx) in ((X0, -1), (X1, 1)):
        for (z, sz) in ((Z0, -1), (Z1, 1)):
            quoins(K, R, x, z, sx, sz, H, f"Q{'L' if sx < 0 else 'R'}{'F' if sz < 0 else 'B'}")
    # THE ROOF (none in a ruin; holed when damaged)
    if not ruin:
        genoise(K, R, X0, X1, Z0, H, 1, far); genoise(K, R, X0, X1, Z1, H, -1, far)
        tileRoof(K, R, X0 - 0.3, X1 + 0.3, Z0 - 0.4, Z1 + 0.4, H + 0.02, pitch, hole=(W * 0.2, Z0 * 0.4, 1.4) if dmg else None, far=far)
    if dmg:
        Rb = random.Random(seed + 99)
        for k in range(2 if not ruin else 1):
            px = (xs[k % n] + xs[(k + 1) % n]) / 2 if n > 1 else X0 + 1
            K.boolean(wall, K.breach((px, Rb.uniform(1.0, H - 1.0), Z0), (0.55, 0.6, 0.6), seed=seed + k, mat="stone"))
        K.lump("Fall", (xs[0] + 1.2, 0.0, Z0 - 1.2), (1.1, 0.35, 0.6), "rubble", G, seed=seed + 3)
    if ruin:
        top = K.skyline(X0 - 1, X1 + 1, Z0 - 1, Z1 + 1, H * 0.55, 1.0, seed=seed, mat="stone")
        K.boolean(wall, top); K.boolean(gab, top)
        xi0, xi1, zi0, zi1 = X0 + T, X1 - T, Z0 + T, Z1 - T
        for k in range(4):
            K.lump(f"Heap{k}", (xi0 + (k + 0.5) * (xi1 - xi0) / 4, 0.0, zi1 - 1.0 if k % 2 else zi0 + 1.0), (1.4, 0.7, 1.0), "rubble", G, seed=seed + 5 + k, rough=0.45, flatten=200)
        for k in range(4): K.rod(f"Truss{k}", (xi0 + 1 + k * (xi1 - xi0 - 2) / 3, 0.3, zi0 + 0.6), (xi0 + 1.5 + k * (xi1 - xi0 - 2) / 3, R.uniform(1.0, 2.2), zi1 - 0.4), 0.11, "fsCharred", G, 6)

TYPES["magasin"] = dict(builder=buildMagasin, W=16.0, D=8.0, H=4.6, pitch=0.3, wash="washOchre", door="doorGreen", doors=4, open=2)

# ── THE MOLE AND ITS LIGHTHOUSE (2026-10-31, PORT_PLAN.md 3 — refs: Philippeville's harbour entrance, the 1887 sketch; the
# Stora and Collo photographs). Built with autoLod from the start (Blender: the near only; tools/lod makes and proves the far).
#   mole      a 10 m length laid end to end along X: the paved deck, its walls of big dressed blocks down into the sea (a
#             dark wet band, weed at the waterline), the sea side's PARAPET with its coping stones, cast-iron bollards and
#             mooring rings on the harbour side (-Z, the camera's), the ROCK APRON of tumbled blocks against the sea side
#   phare     the mole's rounded end: the same deck and walls, the LIGHTHOUSE on its plinth — a white masonry tower, its
#             gallery and iron rail, the lantern (green: the harbour's starboard light) under a copper dome — and stone
#             steps down to the water on the harbour side
# States: damaged (the parapet breached, its blocks fallen; the lantern's glass out), ruin (the deck cratered, the parapet
# down, the lighthouse broken off at half height). Real metres; the deck at +1.7 over the sea (y 0 = the water).
def quayStone(nb):
    """The mole's dressed blocks: the sandstone blocks photo, warm, WET and dark low down, weed green at the waterline (y 0)."""
    c = nb.mix(0.35, nb.img("build/large_sandstone_blocks/large_sandstone_blocks_diff_1k.jpg", 0.33), srgb(0xb59a76))
    c = nb.scale(c, nb.mr(nb.noise(1.2, 4), 0.3, 0.7, 0.85, 1.05))
    c = nb.mix(nb.mr(nb.gy, 0.9, 0.1), c, nb.scale(c, 0.55))                                         # (wet below 0.9 m)
    c = nb.mix(nb.math("MULTIPLY", nb.mr(nb.gy, 0.25, -0.15), nb.mr(nb.noise(4.0, 4), 0.35, 0.6)), c, srgb(0x3d4a2c))   # (weed at the waterline)
    return c
def paving(nb):
    c = nb.mix(0.4, nb.img("build/seaworn_stone_tiles/seaworn_stone_tiles_diff_1k.jpg", 0.5), srgb(0xb9a688))
    return dust(nb, nb.scale(c, nb.mr(nb.noise(0.8, 3), 0.3, 0.7, 0.88, 1.05)), 0.3, 0.3)
def quayDry(nb):
    """The QUAY's wall (2026-10-31): the mole's dressed sandstone blocks, DRY — on the beach, no wet band, no weed. Not on
    the shared slots (as dressedStone is): a block's top face flattened to a line there, the UVZERO gate."""
    c = nb.mix(0.35, nb.img("build/large_sandstone_blocks/large_sandstone_blocks_diff_1k.jpg", 0.33), srgb(0xb59a76))
    return dust(nb, nb.scale(c, nb.mr(nb.noise(1.2, 4), 0.3, 0.7, 0.85, 1.05)), 0.3, 0.3)
def quayMortar(nb):   # (the mortar in the blocks' joints: the core behind them, dark and damp)
    return nb.mix(nb.mr(nb.gy, 0.9, 0.1), nb.mix(nb.noise(3.0, 4), srgb(0x6b6150), srgb(0x7d725e)), srgb(0x3b3a30))
MATDEF.update({"quayMortar": (0.95, quayMortar), "quayStone": (0.95, quayStone), "quayDry": (0.95, quayDry), "paving": (0.95, paving), "lightWhite": (0.9, wash(0xf0ece2, foot=0xb8b0a0)),
               "lantern": (0.15, flat(srgb(0x3f8a5a))), "copperGreen": (0.6, lambda nb: nb.mix(nb.noise(5.0, 4), srgb(0x4f8a74), srgb(0x6fa08c))),
               "castIron": (0.6, flat(srgb(0x23211f), 0.4))})

DECK = 1.7   # m over the sea
def lathe(K, nm, prof, c, mat, n=20):
    """A turned shape: the profile [(r, y)] spun round the vertical at c (x, z)."""
    bm = bmesh.new(); rings = []
    for r, y in prof:
        rings.append([bm.verts.new(B(c[0] + r * math.cos(2 * math.pi * i / n), y, c[1] + r * math.sin(2 * math.pi * i / n))) for i in range(n)] if r > 1e-4 else [bm.verts.new(B(c[0], y, c[1]))])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            if len(a) == 1: bm.faces.new((a[0], b[j], b[i]))
            elif len(b) == 1: bm.faces.new((a[i], a[j], b[0]))
            else: bm.faces.new((a[i], a[j], b[j], b[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, "h", smooth=True)

def blockCourses(K, R, path, nrm, y0, y1, nm, skip=None, depth=0.25, mat="quayStone"):
    """A FACE OF DRESSED BLOCKS along `path` (a polyline of (x, z), its outward normal `nrm(i)` (x, z) for each length),
    course by course from y0 to y1: each block its own length (0.8-1.5 m) and a hair proud or sunk (the wall\x27s face
    hand-laid), the courses staggered; the core behind shows as mortar in the joints. `skip(x, y, z)` True: no block there
    (a breach). The blocks stand 2-5 cm proud of the path."""
    G = "h"; y, c, k = y0, 0, 0
    while y < y1 - 0.08:
        h = min(R.uniform(0.42, 0.6), y1 - y)
        off = 0.0 if c % 2 == 0 else R.uniform(0.35, 0.6)
        for i in range(len(path) - 1):
            (ax, az), (bx, bz) = path[i], path[i + 1]
            L = math.hypot(bx - ax, bz - az); dx, dz = (bx - ax) / L, (bz - az) / L; nx, nz = nrm(i)
            s = -off if i == 0 else 0.0
            while s < L - 0.05:
                w = R.uniform(0.8, 1.5); s0, s1 = max(0.0, s), min(L, s + w)
                if s1 - s0 > 0.15:
                    mx, mz = ax + dx * (s0 + s1) / 2, az + dz * (s0 + s1) / 2
                    if not (skip and skip(mx, y + h / 2, mz)):
                        pr = R.uniform(0.02, 0.05)
                        # (the block a prism along the path; its profile across: from `depth` behind the face to `pr` proud)
                        e = 0.004 * (i % 2)   # (round a bend, neighbours' inner corners overlap: every other length 4 mm up — never one plane)
                        a = (ax + dx * (s0 + 0.012), y + 0.012 + e, az + dz * (s0 + 0.012))
                        b = (ax + dx * (s1 - 0.012), y + 0.012 + e, az + dz * (s1 - 0.012))
                        ux, uz = -dz, dx   # (up x d, in the game\x27s frame: the profile\x27s u across the face)
                        sg = 1.0 if ux * nx + uz * nz > 0 else -1.0
                        K.member(f"{nm}{k}", a, b, [(-depth * sg, 0.0), (pr * sg, 0.0), (pr * sg, h - 0.024), (-depth * sg, h - 0.024)], mat, G)
                        k += 1
                s += w
        y += h; c += 1
    return k

def moleBody(K, R, x0, x1, state, seed, head=False):
    """The deck and its walls from x0 to x1 (a head: rounded at x1), the sea side +Z: the parapet, the rock apron."""
    G = "h"; dmg, ruin = state != "intact", state == "ruin"; zH, zS = -3.0, 3.0   # the harbour face, the sea face
    body = K.box("Body", x0, x1, -3.0, DECK, zH, zS, "quayMortar", G, 0)
    if head: K.cyl("HeadRound", (x1, -3.0, 0.0), 2.98, DECK + 3.0, "quayMortar", G, 24)
    # THE DECK'S FLAGSTONES: rows of big slabs, each its own size and a hair higher or lower, over the mortar bed (one paved
    # slab read as a plain pale board in the lab)
    deck = K.box("Deck", x0 + 0.02, x1 - (0.02 if not head else 0.0), DECK - 0.05, DECK - 0.01, zH + 0.15, zS - 1.05, "quayMortar", G, 0)
    if head: K.cyl("DeckRound", (x1, DECK - 0.05, 0.0), 2.85, 0.04, "quayMortar", G, 24)
    zz, row = zH + 0.17, 0
    while zz < zS - 1.1:
        d = min(R.uniform(0.55, 0.75), zS - 1.07 - zz); xx = x0 + (0.0 if row % 2 == 0 else -R.uniform(0.2, 0.4)); k = 0
        while xx < x1 + (2.8 if head else 0.0):
            w = R.uniform(0.6, 1.0); a0, a1 = max(xx, x0 + 0.03), min(xx + w, x1 - 0.03 if not head else x1 + 2.8)
            mid = ((a0 + a1) / 2, (zz + zz + d) / 2)
            on = a1 - a0 > 0.2 and (not head or mid[0] <= x1 or math.hypot(mid[0] - x1, mid[1]) < 2.75 - max(a1 - a0, d) / 2)
            crat = ruin and math.hypot(mid[0] - ((x0 + x1) / 2), mid[1] + 0.6) < 2.1
            if on and not crat:
                K.box(f"Flag{row}_{k}", a0 + 0.012, a1 - 0.012, DECK - 0.02, DECK + 0.03 + R.uniform(-0.008, 0.012), zz + 0.012, zz + d - 0.012, "paving", G, 0)   # (unbevelled: bevelled, a mole length was 13 500 triangles)
            xx += w; k += 1
        zz += d; row += 1
    if ruin:   # the deck cratered
        cx = (x0 + x1) / 2 + R.uniform(-1, 1)
        K.boolean(body, K.breach((cx, DECK, -0.6), (1.8, 0.9, 1.6), seed=seed, mat="rubble"))
        K.boolean(deck, K.breach((cx, DECK, -0.6), (1.85, 0.9, 1.65), seed=seed + 1, mat="rubble"))
    # THE PARAPET on the sea side, its coping stones (a head: none round its end — the lighthouse stands there)
    pz0, pz1 = zS - 1.0, zS - 0.2; ph = DECK + 1.15; xe0 = x1 - (2.6 if head else 0.0)
    par = K.box("Parapet", x0, xe0, DECK, ph, pz0, pz1, "quayMortar", G, 0.02)
    bx = (x0 + xe0) / 2 - 1.0
    # THE DRESSED BLOCKS, course by course, over the mortar core (a photo on a box read as a beige box in the lab, 2026-10-31):
    # the harbour face, the sea face, round the head, the parapet's two faces — down to below the waterline
    crater = (x0 + x1) / 2
    hole = lambda x, y, z: (dmg and abs(x - bx) < 1.15 and y > DECK and z > pz0 - 0.1) or (ruin and y > DECK - 0.1 and z > pz0 - 0.1)
    xh = x1 - (0.3 if head else 0.0)
    blockCourses(K, R, [(x0, zH), (xh, zH)], lambda i: (0.0, -1.0), -0.6, DECK - 0.01, "BH", skip=lambda x, y, z: ruin and abs(x - crater) < 2.0 and y > 0.6)
    blockCourses(K, R, [(x0, zS), (xh, zS)], lambda i: (0.0, 1.0), -0.6, DECK - 0.01, "BS")
    if head:
        A = [math.radians(-84 + 168 * k / 12) for k in range(13)]
        arc = [(x1 + 3.0 * math.cos(a), 3.0 * math.sin(a)) for a in A]
        blockCourses(K, R, arc, lambda i: (math.cos((A[i] + A[i + 1]) / 2), math.sin((A[i] + A[i + 1]) / 2)), -0.6, DECK - 0.01, "BR")
    if not ruin:
        blockCourses(K, R, [(x0, pz1), (xe0, pz1)], lambda i: (0.0, 1.0), DECK + 0.01, ph - 0.01, "BPo", skip=hole, depth=0.2)
        blockCourses(K, R, [(x0, pz0), (xe0, pz0)], lambda i: (0.0, -1.0), DECK + 0.01, ph - 0.01, "BPi", skip=hole, depth=0.2)
    if dmg: K.boolean(par, K.breach((bx, ph - 0.2, (pz0 + pz1) / 2), (1.0, 0.6, 0.7), seed=seed + 2, mat="quayStone"))
    if ruin: K.boolean(par, K.skyline(x0 - 1, x1 + 1, pz0 - 1, pz1 + 1, DECK + 0.25, 0.3, seed=seed + 3, mat="quayStone"))
    if not ruin:
        x = x0; k = 0
        while x < xe0 - 0.2:
            w = R.uniform(0.9, 1.3); xe = min(x + w, xe0)
            if not (dmg and abs((x + xe) / 2 - bx) < 1.2):
                K.box(f"Coping{k}", x + 0.01, xe - 0.01, ph, ph + 0.16 + k % 2 * 0.012, pz0 - 0.06, pz1 + 0.06, "dressedStone", G, 0.02)
            x = xe; k += 1
    if dmg:   # the parapet's blocks fallen onto the deck
        for k in range(4): stone(K, f"Fallen{k}", (bx + R.uniform(-1.2, 1.2), DECK + 0.12, R.uniform(-0.2, 1.4)), (0.4, 0.18, 0.25), R, 0.0, "quayStone", box=0.7)
    # BOLLARDS and RINGS on the harbour side
    for k, x in enumerate([x0 + 2.0, x0 + 7.0] if not head else [x0 + 2.5]):
        if ruin and k == 0: continue
        lathe(K, f"Bollard{k}", [(0.0, DECK), (0.2, DECK), (0.16, DECK + 0.35), (0.22, DECK + 0.48), (0.24, DECK + 0.56), (0.0, DECK + 0.58)], (x, zH + 0.5), "castIron", n=12)
    for k, x in enumerate([x0 + 4.5, x0 + 9.0] if not head else [x0 + 5.0]):
        K.rod(f"Ring{k}a", (x - 0.15, DECK - 0.6, zH - 0.03), (x, DECK - 0.75, zH - 0.03), 0.025, "castIron", G, 5)
        K.rod(f"Ring{k}b", (x, DECK - 0.75, zH - 0.03), (x + 0.15, DECK - 0.6, zH - 0.03), 0.025, "castIron", G, 5)
    # THE ROCK APRON: tumbled blocks against the sea face, half under the water
    n = int((x1 - x0) * 1.6)
    for k in range(n):
        x = x0 + (k + R.uniform(0, 1)) * (x1 - x0) / n
        stone(K, f"Apron{k}", (x, R.uniform(-0.6, 0.3), zS + 0.6 + R.uniform(0, 1.6)), (R.uniform(0.6, 1.1), R.uniform(0.4, 0.7), R.uniform(0.5, 0.9)), R, 0.0, "quayStone", box=0.75)

def buildMole(K, name, spec, state, seed, far=False):
    moleBody(K, random.Random(seed), -5.0, 5.0, state, seed)

def buildMoleHead(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"; dmg, ruin = state != "intact", state == "ruin"
    moleBody(K, R, -5.0, 2.0, state, seed, head=True)
    # the steps down to the water on the harbour side, against the face
    for k in range(7):
        y = DECK - 0.24 * (k + 1)
        K.box(f"Step{k}", -3.4 + k * 0.32, -2.2 + k * 0.32, y - 0.5, y, -3.6, -3.02, "quayStone", G, 0.015)
    # THE LIGHTHOUSE on the head's round
    cx, cz = 2.0, 0.4
    K.box("Plinth", cx - 1.5, cx + 1.5, DECK, DECK + 1.2, cz - 1.5, cz + 1.5, "quayMortar", G, 0)
    sq = [(cx - 1.5, cz - 1.5), (cx + 1.5, cz - 1.5), (cx + 1.5, cz + 1.5), (cx - 1.5, cz + 1.5), (cx - 1.5, cz - 1.5)]
    nrm4 = [(0.0, -1.0), (1.0, 0.0), (0.0, 1.0), (-1.0, 0.0)]
    blockCourses(K, R, sq, lambda i: nrm4[i], DECK + 0.01, DECK + 1.08, "BPl", depth=0.2, mat="dressedStone")
    K.box("PlinthCap", cx - 1.58, cx + 1.58, DECK + 1.08, DECK + 1.22, cz - 1.58, cz + 1.58, "dressedStone", G, 0.02)
    top = DECK + 9.0
    tower = lathe(K, "Tower", [(0.0, DECK + 1.2), (1.05, DECK + 1.2), (0.82, top - 0.4), (0.92, top - 0.3), (0.92, top), (0.0, top)], (cx, cz), "lightWhite", n=24)
    K.boolean(tower, K.arch(cx - 0.4, cx + 0.4, DECK + 1.2, DECK + 2.9, cz - 1.4, cz - 0.6, "dark"))
    if not ruin: K.box("Door", cx - 0.38, cx + 0.38, DECK + 1.2, DECK + 3.25, cz - 0.86, cz - 0.82, "doorGreen", G, 0.005)
    for y in (DECK + 4.0, DECK + 6.4):   # small windows up the tower, facing the harbour
        K.boolean(tower, K.cutter(cx - 0.18, cx + 0.18, y, y + 0.6, cz - 1.4, cz - 0.4, "dark"))
    if ruin:
        K.boolean(tower, K.skyline(cx - 3, cx + 3, cz - 3, cz + 3, DECK + 4.5, 0.9, seed=seed + 7, mat="rubble"))
        K.lump("TowerFall", (cx + 1.2, DECK, cz + 1.8), (1.4, 0.7, 1.0), "rubble", G, seed=seed + 8)
        return
    # the CORBELS carrying the gallery: a ring of dressed stones stepping out under its slab
    for k in range(16):
        a = 2 * math.pi * (k + 0.5) / 16; ca, sa = math.cos(a), math.sin(a)
        K.member(f"Corbel{k}", (cx + 0.86 * ca, top - 0.55, cz + 0.86 * sa), (cx + 1.22 * ca, top - 0.55, cz + 1.22 * sa), [(-0.09, 0.0), (0.09, 0.0), (0.09, 0.55), (-0.09, 0.55)], "dressedStone", G)
    # the gallery: its slab, the iron rail; the lantern, its glass (out when damaged), the copper dome and its vane
    lathe(K, "Gallery", [(0.0, top), (1.3, top), (1.3, top + 0.14), (0.0, top + 0.14)], (cx, cz), "dressedStone", n=24)
    for k in range(16):
        a = 2 * math.pi * k / 16
        K.rod(f"Rail{k}", (cx + 1.22 * math.cos(a), top + 0.14, cz + 1.22 * math.sin(a)), (cx + 1.22 * math.cos(a), top + 1.05, cz + 1.22 * math.sin(a)), 0.018, "castIron", G, 4)
    lathe(K, "RailTop", [(1.18, top + 1.02), (1.26, top + 1.02), (1.26, top + 1.07), (1.18, top + 1.07)], (cx, cz), "castIron", n=24)
    lathe(K, "LanternBase", [(0.0, top + 0.14), (0.72, top + 0.14), (0.72, top + 0.55), (0.0, top + 0.55)], (cx, cz), "lightWhite", n=16)
    lathe(K, "Lantern", [(0.0, top + 0.55), (0.62, top + 0.55), (0.62, top + 1.75), (0.0, top + 1.75)], (cx, cz), "dark" if dmg else "lantern", n=8)
    for k in range(8):   # the glazing bars
        a = 2 * math.pi * (k + 0.5) / 8
        K.rod(f"Bar{k}", (cx + 0.64 * math.cos(a), top + 0.55, cz + 0.64 * math.sin(a)), (cx + 0.64 * math.cos(a), top + 1.75, cz + 0.64 * math.sin(a)), 0.03, "castIron", G, 4)
    lathe(K, "Dome", [(0.0, top + 1.75), (0.72, top + 1.75), (0.6, top + 2.0), (0.35, top + 2.25), (0.08, top + 2.4), (0.0, top + 2.45)], (cx, cz), "copperGreen", n=16)
    K.rod("Vane", (cx, top + 2.4, cz), (cx, top + 2.95, cz), 0.025, "castIron", G, 5)

TYPES["mole"] = dict(builder=buildMole, autoLod=True, atlas=2048)
TYPES["phare"] = dict(builder=buildMoleHead, autoLod=True, atlas=2048)

# ── THE LAMPARO BOAT (2026-10-31, PORT_PLAN.md 4 — the FAO's 1961 report on Algerian fishing: open, undecked LAMPARO boats
# for sardine and anchovy, fished at night under a big lamp; the Stora and Collo photographs). autoLod from the start.
#   a double-ended wooden hull, ~7.4 m, LOFTED from stations (smooth: a hull is curves, not boxes): white above, a coloured
#   SHEER BAND under the gunwale, red-brown antifouling below the waterline (y 0), a rubbing strake; the inside varnished
#   wood — floorboards, three thwarts, the stem and stern posts rising (the bow\x27s higher, curved); a short mast; the LAMP
#   on its arm over the water at the stern quarter (a white globe in a conical reflector); oars along the thwarts; the net
#   heaped amidships. Placed afloat, or beached tilted on its bilge (the game\x27s tilt).
#   damaged  a hole through the side at the waterline, the mast snapped, the lamp arm bent down
#   ruin     burnt: the hull charred and broken down to its bilge, the thwarts and posts charred, no gear
# Front -Z: the boat lies along X (its bow at +X).
def antifoul(nb): return nb.mix(nb.noise(6.0, 4), srgb(0x6e2d22), srgb(0x8a3a2a))
def hullWhite(nb):
    c = nb.mix(nb.mr(nb.noise(2.0, 4), 0.4, 0.7), srgb(0xeeeae0), srgb(0xd4cdbd))
    return nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(9.0, 3, 0.6, stretch=(1, 1, 0.1)), 0.6, 0.7), 0.5), c, srgb(0x9a958a))   # (worn streaks)
def varnish(nb):
    return nb.mix(nb.noise(12.0, 4, 0.6, stretch=(0.15, 1, 1)), srgb(0x7a5634), srgb(0x9a7046))
def netMat(nb):
    """A cotton net tanned brown: its DIAMOND MESH (6 cm) — the twine light, the gaps between dark as the shade behind a net
    (opaque: the kit's atlas has no alpha; a blotched sheet read as a camouflage tarp in the lab, 2026-10-31)."""
    f = 2 * math.pi / 0.085
    d1 = nb.math("ABSOLUTE", nb.math("SINE", nb.math("MULTIPLY", nb.math("ADD", nb.gx, nb.gy), f)))
    d2 = nb.math("ABSOLUTE", nb.math("SINE", nb.math("MULTIPLY", nb.math("SUBTRACT", nb.gx, nb.gy), f)))
    twine = nb.math("MAXIMUM", nb.mr(d1, 0.82, 0.95), nb.mr(d2, 0.82, 0.95))   # (1 on the strands)
    tw = nb.mix(nb.mr(nb.noise(3.0, 3), 0.4, 0.6), srgb(0x7a5e3c), srgb(0x94744c))
    return nb.mix(twine, srgb(0x1f1913), tw)
MATDEF.update({"antifoul": (0.8, antifoul), "hullWhite": (0.7, hullWhite), "varnish": (0.7, varnish), "net": (0.95, netMat),
               "bandBlue": (0.6, paintedWood(0x2f5d8a)), "bandGreen": (0.6, paintedWood(0x3f7a52)), "charred": (0.95, lambda nb: nb.mix(nb.noise(4.0, 5), srgb(0x161310), srgb(0x2e2620))),
               "lampGlass": (0.2, flat(srgb(0xf2efe2))), "reflector": (0.4, flat(srgb(0xa9aba8)))})

BL, BB, KEEL, SHEER = 7.4, 2.3, -0.42, 0.52   # length, beam, the keel's and the sheer's height (the waterline y 0)
def hullSection(f, t):
    """A point of the hull: f along it (-1 stern .. +1 bow), t round its section (-1 port sheer .. 0 keel .. +1 starboard
    sheer) -> (x, y, z). Double-ended: the beam falls to nothing at both ends; the sheer rises toward them (the bow more)."""
    x = f * BL / 2
    hw = (BB / 2) * (1 - abs(f) ** 2.2) ** 0.75
    sh = SHEER + 0.18 * abs(f) ** 2.5 + (0.12 * f ** 3 if f > 0 else 0.0)
    kl = KEEL + 0.12 * abs(f) ** 3
    a = abs(t) * math.pi / 2
    z = math.copysign(hw * math.sin(a) ** 0.7, t)
    y = kl + (sh - kl) * (1 - math.cos(a)) ** 0.9
    return x, y, z

def buildBarque(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"; dmg, ruin = state != "intact", state == "ruin"
    NS, NT = 28, 16   # stations along, points round a section (each side)
    def shell(nm, mat, t0, t1, inset=0.0, top=None):
        """The hull's skin between section heights t0..t1 (|t|), both sides; `inset`: the inside skin, that far in."""
        bm = bmesh.new(); grid = []
        fe = 0.9 if inset else 0.985   # (the inside skin stops short of the ends — there it folded onto itself: the coplanar gate; the posts cover them)
        for i in range(NS + 1):
            f = -fe + 2 * fe * i / NS
            row = []
            for j in range(-NT, NT + 1):
                t = j / NT
                if not (t0 <= abs(t) <= t1): row.append(None); continue
                x, y, z = hullSection(f, t)
                if inset:
                    x2, y2, z2 = hullSection(f * (1 - inset / (BL / 2)), t)
                    z = z2 * max(0.0, 1 - inset / max(0.05, abs(z2) + 1e-3)) if abs(z2) > inset else 0.0
                    y = min(max(y2 + inset, KEEL + inset), hullSection(f, 1.0)[1] - 0.03)   # (never above the outside's sheer: at the stern it stood up like a board)
                    x = x2
                if top is not None: y = min(y, top(f))
                row.append(bm.verts.new(B(x, y, z)))
            grid.append(row)
        for i in range(NS):
            for j in range(2 * NT):
                q = (grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1])
                if all(q):
                    try: bm.faces.new(q if not inset else q[::-1])
                    except ValueError: pass
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        # (split each quad on its better diagonal: on the export's fixed one a quad near the bow folded — two triangles on one
        # plane, overlapping: the coplanar gate)
        bmesh.ops.triangulate(bm, faces=bm.faces, quad_method="BEAUTY", ngon_method="BEAUTY")
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if inset: bmesh.ops.reverse_faces(bm, faces=bm.faces)
        return K.obj(nm, bm, mat, G, smooth=True)
    tw = 0.0   # where the antifouling meets the white (the waterline, as a |t| of the section) — found per section below
    if ruin:
        burnt = lambda f: SHEER * 0.25 + 0.25 * math.sin(f * 7.0 + seed)   # (burnt down to here, ragged)
        shell("HullOut", "charred", 0.0, 1.0, top=burnt)
        shell("HullIn", "charred", 0.0, 1.0, inset=0.05, top=burnt)
    else:
        # the skin in three bands by height round the section: antifouling to ~t 0.45, white, the coloured band at the top
        shell("Bottom", "antifoul", 0.0, 0.47)
        shell("Topsides", "hullWhite", 0.47, 0.8)
        shell("Band", spec["band"], 0.8, 1.0)   # (0.88: a line nobody saw in the lab)
        shell("Inside", "varnish", 0.0, 1.0, inset=0.045)
        # the GUNWALE capping the sheer and the rubbing strake below it, both ends to end
        rail = [hullSection(-0.985 + 1.97 * i / NS, 1.0) for i in range(NS + 1)]
        for s in (-1, 1):
            pts = [(x, y, z * s) for x, y, z in rail]
            for i in range(NS):
                K.member(f"Gunwale{s}_{i}", pts[i], pts[i + 1], [(-0.035, -0.03), (0.035, -0.03), (0.035, 0.035), (-0.035, 0.035)], "varnish", G)
            low = [hullSection(-0.97 + 1.94 * i / NS, 0.8) for i in range(NS + 1)]
            pts2 = [(x, y, z * s * 1.02) for x, y, z in low]
            for i in range(NS):
                K.member(f"Strake{s}_{i}", pts2[i], pts2[i + 1], [(-0.02, -0.025), (0.02, -0.025), (0.02, 0.025), (-0.02, 0.025)], spec["band"], G)
    if dmg:   # a hole through the side at the waterline (the hull\x27s skins cut together)
        for o in list(K.groups[G]):
            if o.name.startswith(("Bottom", "Topsides", "Inside", "HullOut", "HullIn")):
                K.boolean(o, K.breach((-0.8, 0.05, 0.95), (0.55, 0.32, 0.4), seed=seed, mat="charred" if ruin else "varnish"))
    # THE POSTS: the stem at the bow rising and curving forward, the sternpost
    mat = "charred" if ruin else "varnish"
    bx, by, _ = hullSection(0.985, 0.0); sx, sy, _ = hullSection(-0.985, 0.0)
    stem = [(bx - 0.1, KEEL + 0.2, 0.0), (bx + 0.05, 0.3, 0.0), (bx + 0.12, 0.85, 0.0), (bx + 0.1, 1.25 if not ruin else 0.6, 0.0)]
    for i in range(len(stem) - 1): K.member(f"Stem{i}", stem[i], stem[i + 1], [(-0.05, -0.06), (0.05, -0.06), (0.05, 0.06), (-0.05, 0.06)], mat, G, up=(0, 0, 1))
    post = [(sx + 0.1, KEEL + 0.2, 0.0), (sx - 0.04, 0.4, 0.0), (sx - 0.08, 0.95 if not ruin else 0.4, 0.0)]
    for i in range(len(post) - 1): K.member(f"Post{i}", post[i], post[i + 1], [(-0.05, -0.06), (0.05, -0.06), (0.05, 0.06), (-0.05, 0.06)], mat, G, up=(0, 0, 1))
    # FLOORBOARDS and THWARTS
    K.box("Floor", -2.2, 2.2, KEEL + 0.12, KEEL + 0.16, -0.42, 0.42, mat, G, 0)
    for k, x in enumerate((-1.6, 0.1, 1.7)):
        _, sy2, sz = hullSection(x / (BL / 2), 0.9)
        K.box(f"Thwart{k}", x - 0.15, x + 0.15, sy2 - 0.2, sy2 - 0.15, -abs(sz) + 0.06, abs(sz) - 0.06, mat, G, 0)
    if ruin: return
    # the MAST (snapped when damaged), the LAMP on its arm over the stern quarter, the OARS, the NET
    K.rod("Mast", (0.1, KEEL + 0.16, 0.0), (0.1, 2.4 if not dmg else 1.2, 0.0), 0.05, "varnish", G, 8)
    ax, ay, az = -2.6, SHEER + 0.05, 0.75
    K.rod("LampPost", (ax, KEEL + 0.2, az - 0.3), (ax, 1.6, az - 0.3), 0.035, "castIron", G, 6)
    tip = (ax - 0.25, 1.15 if dmg else 1.55, az + 0.75)
    K.rod("LampArm", (ax, 1.55, az - 0.3), tip, 0.03, "castIron", G, 6)
    lathe(K, "Reflector", [(0.06, tip[1] - 0.05), (0.32, tip[1] - 0.3), (0.34, tip[1] - 0.32), (0.08, tip[1] - 0.02)], (tip[0], tip[2]), "reflector", n=14)   # (galvanised: black, it read as a hole)
    lathe(K, "Globe", [(0.0, tip[1] - 0.48), (0.12, tip[1] - 0.42), (0.15, tip[1] - 0.32), (0.1, tip[1] - 0.2), (0.0, tip[1] - 0.18)], (tip[0], tip[2]), "lampGlass", n=12)
    for s in (-1, 1): K.rod(f"Oar{s}", (-2.0, SHEER - 0.05, s * 0.55), (2.3, SHEER - 0.02, s * 0.5), 0.028, "varnish", G, 6)
    K.lump("Net", (-0.8, KEEL + 0.19, 0.0), (0.85, 0.32, 0.55), "net", G, seed=seed + 4, rough=0.35, sub=3)
    for k in range(5):   # the net\x27s cork floats along its edge
        K.lump(f"Cork{k}", (-1.4 + k * 0.3, KEEL + 0.38 + R.uniform(-0.03, 0.04), 0.5 - k * 0.05), (0.06, 0.04, 0.06), "woodDark", G, seed=seed + 10 + k, rough=0.1, sub=1)

TYPES["barque"] = dict(builder=buildBarque, band="bandBlue", autoLod=True, atlas=1024, smoothAngle=50)
TYPES["barque2"] = dict(builder=buildBarque, band="bandGreen", autoLod=True, atlas=1024, smoothAngle=50)

# ── THE QUAY'S LIFE (2026-10-31, PORT_PLAN.md 5): the props of a working fishing quay, built from the same shared props as every
# kit (props.py: the crates and drums) plus the harbour's own. One state each (props); autoLod.
#   etal      the FISH STALL: a dressed-stone counter, its striped awning on four poles, slatted fish boxes of silver sardines
#             on it, the hanging balance scale, a basket, a cask
#   caisses   CARGO on the quay: crates stacked, wooden casks in their iron hoops, oil drums, a coil of mooring rope
#   filets    NETS DRYING: two posts and a line, the brown net draped over it sagging, its cork floats along the edge, a
#             bench with a net heaped on it for mending
import props
def fishSilver(nb):   # (sardines: silver flanks, a blue-dark back)
    return nb.mix(nb.mr(nb.noise(30.0, 3), 0.4, 0.6), srgb(0x9ea7ad), srgb(0x3c4c5c))
MATDEF.update({"fishSilver": (0.35, fishSilver), "basketWeave": (0.9, lambda nb: nb.mix(nb.noise(40.0, 3, 0.7), srgb(0x8a6a40), srgb(0xb08a55))),
               "rope": (0.95, lambda nb: nb.mix(nb.noise(30.0, 3, 0.6), srgb(0x8f7b55), srgb(0xb59e72))),
               "drumBlue": (0.6, props.drum_paint(0x2c4a66, 0.5)), "drumOlive": (0.6, props.drum_paint(0x4d5536, 0.4)), "drumSteel": (0.5, props.steel_paint(0x6a6a66, 0.3))})

def make(K):
    return lambda n, bm, m: K.obj(n, bm, m, "h", smooth=True)

def cask(K, nm, x, z, y0=0.0, h=0.82, lying=False, yaw=0.0):
    """A wooden cask: staves bulging, four iron hoops. Lying: on its side along `yaw`."""
    prof = [(0.0, 0.0), (0.27, 0.0), (0.31, h * 0.2), (0.335, h * 0.5), (0.31, h * 0.8), (0.27, h), (0.0, h)]
    parts = [lathe(K, f"{nm}Body", prof, (0.0, 0.0), "woodDark", n=16)]
    for k, f in enumerate((0.08, 0.3, 0.7, 0.92)):
        r = 0.27 + 0.065 * math.sin(math.pi * f) + 0.012
        parts.append(lathe(K, f"{nm}Hoop{k}", [(r - 0.012, h * f - 0.025), (r, h * f - 0.025), (r, h * f + 0.025), (r - 0.012, h * f + 0.025)], (0.0, 0.0), "castIron", n=16))
    for o in parts:
        if lying:
            o.rotation_euler = (0.0, math.pi / 2, yaw)   # (Blender: about its Y — the game\x27s across; then turned)
            o.location = B(x, y0 + 0.335, z)
        else:
            o.location = B(x, y0, z)
    return parts

def fishBox(K, R, nm, x, y, z, yaw=0.0, full=True):
    """A slatted fish box (60 x 40 x 15 cm), sardines laid in it."""
    G = "h"; L, W, H = 0.6, 0.4, 0.15; c, s = math.cos(yaw), math.sin(yaw)
    at = lambda lx, lz: (x + lx * c + lz * s, z - lx * s + lz * c)
    K.member(f"{nm}Floor", (*at(-L / 2, 0)[:1], y, at(-L / 2, 0)[1]), (*at(L / 2, 0)[:1], y, at(L / 2, 0)[1]), [(-W / 2, 0.0), (W / 2, 0.0), (W / 2, 0.02), (-W / 2, 0.02)], "wood", G)
    for side in (-1, 1):
        a, b = at(-L / 2, side * W / 2), at(L / 2, side * W / 2)
        K.member(f"{nm}Side{side}", (a[0], y, a[1]), (b[0], y, b[1]), [(-0.012, 0.0), (0.012, 0.0), (0.012, H), (-0.012, H)], "wood", G)
        a, b = at(side * L / 2, -W / 2), at(side * L / 2, W / 2)
        K.member(f"{nm}End{side}", (a[0], y, a[1]), (b[0], y, b[1]), [(-0.018, 0.0), (0.018, 0.0), (0.018, H + 0.03), (-0.018, H + 0.03)], "woodDark", G)
    if full:
        for k in range(9):   # the sardines, laid head to tail
            fx, fz = R.uniform(-0.22, 0.22), R.uniform(-0.14, 0.14); p = at(fx, fz); ya = yaw + R.uniform(-0.4, 0.4)
            K.member(f"{nm}Fish{k}", (p[0] - 0.09 * math.cos(ya), y + 0.05 + k * 0.004, p[1] + 0.09 * math.sin(ya)), (p[0] + 0.09 * math.cos(ya), y + 0.05 + k * 0.004, p[1] - 0.09 * math.sin(ya)),
                     [(-0.022, 0.0), (0.0, -0.012), (0.022, 0.0), (0.0, 0.016)], "fishSilver", G)

def buildEtal(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"
    K.box("Counter", -1.6, 1.6, 0.0, 0.82, -0.45, 0.45, "dressedStone", G, 0.03)
    K.box("CounterTop", -1.7, 1.7, 0.82, 0.9, -0.55, 0.52, "sill", G, 0.015)
    for k, x in enumerate((-1.0, 0.0, 1.0)): fishBox(K, R, f"Box{k}", x, 0.9, -0.05 + R.uniform(-0.05, 0.05), R.uniform(-0.1, 0.1))
    fishBox(K, R, "BoxStack", 1.3, 0.0, -1.05, 0.3, full=False); fishBox(K, R, "BoxStack2", 1.32, 0.17, -1.02, 0.25)
    # THE AWNING on four poles, sloping to the front, striped
    for x in (-1.9, 1.9):
        for z, h in ((-1.2, 2.25), (0.9, 2.7)): K.rod(f"Pole{x}{z}", (x, 0.0, z), (x, h, z), 0.035, "woodDark", G, 6)
    K.member("Awning", (0.0, 2.7, 0.95), (0.0, 2.22, -1.3), [(-2.05, -0.008), (2.05, -0.008), (2.05, 0.008), (-2.05, 0.008)], "awningRed", G)
    K.member("Valance", (0.0, 2.24, -1.3), (0.0, 1.98, -1.33), [(-2.05, -0.008), (2.05, -0.008), (2.05, 0.008), (-2.05, 0.008)], "awningRed", G, up=(0, 0, -1))
    # the balance scale hanging from the awning\x27s front, its pans
    K.rod("ScaleChain", (0.55, 2.3, -1.15), (0.55, 1.55, -1.15), 0.008, "castIron", G, 4)
    K.rod("ScaleBeam", (0.3, 1.55, -1.15), (0.8, 1.55, -1.15), 0.012, "castIron", G, 4)
    for x in (0.3, 0.8): lathe(K, f"Pan{x}", [(0.0, 1.27), (0.1, 1.27), (0.12, 1.31), (0.0, 1.3)], (x, -1.15), "castIron", n=12)
    lathe(K, "Basket", [(0.0, 0.0), (0.2, 0.0), (0.26, 0.32), (0.27, 0.34), (0.0, 0.33)], (-1.3, -1.0), "basketWeave", n=14)
    cask(K, "Cask", -2.2, 0.4)

def buildCaisses(K, name, spec, state, seed, far=False):
    R = random.Random(seed); mk = make(K)
    # crates stacked two high, a third leaning on the stack (props.crate: its top at H + CRATE_TOP — stacked 3 mm over it)
    top = 0.42 + getattr(props, "CRATE_TOP", 0.02) + 0.003
    for k, (x, z, y, yaw) in enumerate(((-1.2, -0.3, 0.0, 0.05), (-0.42, -0.32, 0.0, -0.04), (-0.8, -0.3, top, 0.12), (-1.0, 0.45, 0.0, 1.5))):
        props.place(props.crate(mk, f"Crate{k}", "wood", "rope"), (x, y, z), yaw)
    for k, (x, z) in enumerate(((0.55, -0.4), (1.2, -0.25), (0.85, 0.35))): cask(K, f"Cask{k}", x, z)
    cask(K, "CaskLying", 0.2, 0.9, lying=True, yaw=0.3)
    for k, (x, z, p) in enumerate(((1.9, 0.45, "drumBlue"), (2.25, -0.1, "drumOlive"))):
        props.place(props.drum(mk, f"Drum{k}", p, "drumSteel", seed=seed + k), (x, 0.0, z), R.uniform(0, 6))
    # a coil of mooring rope: a flat spiral, three turns
    pts = [(-0.3 + (0.16 + 0.05 * (a / (2 * math.pi))) * math.cos(a), 0.035 + 0.04 * (a // (2 * math.pi)), 1.0 + (0.16 + 0.05 * (a / (2 * math.pi))) * math.sin(a)) for a in [k * 0.4 for k in range(48)]]
    for k in range(len(pts) - 1): K.rod(f"Rope{k}", pts[k], pts[k + 1], 0.03, "rope", "h", 6)

def buildFilets(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"
    for x in (-2.0, 2.0): K.rod(f"Post{x}", (x, -0.1, 0.0), (x + R.uniform(-0.03, 0.03), 1.85, 0.0), 0.05, "woodDark", G, 7)
    K.rod("Line", (-2.0, 1.78, 0.0), (2.0, 1.76, 0.0), 0.012, "rope", G, 4)
    # THE NET draped over the line, sagging between the posts and hanging both sides in folds — one surface, its edge
    # lifted where it lies on the ground
    bm = bmesh.new(); NX, NZ = 64, 14; grid = []   # (64 along: the pleats need the vertices)
    for i in range(NX + 1):
        x = -1.9 + 3.8 * i / NX; sag = 0.18 * (1 - (x / 2.0) ** 2)
        row = []
        for j in range(NZ + 1):
            v = -1 + 2 * j / NZ   # -1 front .. +1 back, 0 over the line
            hang = abs(v) * 1.45
            y = max(0.04, 1.76 - sag - hang * (0.95 + 0.06 * math.sin(x * 5.0 + j)))
            # (GATHERED: vertical pleats where it hangs — spread flat it read as a tarp)
            z = math.copysign(0.05 + 0.32 * abs(v) ** 1.5, v) + (0.06 * math.sin(x * 4.0 + v * 3.0) + 0.07 * math.sin(x * 11.0 + 1.3 * math.sin(x * 2.0))) * min(1.0, abs(v) * 2.5)
            row.append(bm.verts.new(B(x, y, z)))
        grid.append(row)
    for i in range(NX):
        for j in range(NZ): bm.faces.new((grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    net = K.obj("Net", bm, "net", G, smooth=True)
    sol = net.modifiers.new("T", "SOLIDIFY"); sol.thickness = 0.015   # (both faces seen: a sheet, not a card)
    for k in range(10):   # the cork floats along its lower edges
        x = -1.7 + k * 0.38
        for side in (-1, 1): K.lump(f"Cork{k}{side}", (x, 0.08, side * 0.42), (0.06, 0.04, 0.06), "woodDark", G, seed=seed + k, rough=0.1, sub=1)
    # the mending bench, a heap of net on it
    K.box("Bench", -1.0, 0.6, 0.38, 0.45, -1.45, -1.1, "woodDark", G, 0.01)
    for x in (-0.85, 0.45): K.box(f"BenchLeg{x}", x - 0.04, x + 0.04, 0.0, 0.38, -1.4, -1.15, "woodDark", G, 0.005)
    K.lump("NetHeap", (-0.2, 0.46, -1.27), (0.55, 0.16, 0.2), "net", G, seed=seed + 30, rough=0.3, sub=3, flatten=200)   # (round, sunk into the bench: its flattened foot folded — the gate)

TYPES["etal"] = dict(builder=buildEtal, states=["intact"], autoLod=True, atlas=1024, smoothAngle=50)
TYPES["caisses"] = dict(builder=buildCaisses, states=["intact"], autoLod=True, atlas=1024, smoothAngle=50)
TYPES["filets"] = dict(builder=buildFilets, states=["intact"], autoLod=True, atlas=1024, smoothAngle=50)

# ── THE QUAY (2026-10-31, PORT_PLAN.md 8 — you: "yes commit and go ahead", after the port stood on the bare sand): the paved
# quay under the front row, laid end to end along X; the deck at y 0 (the row's ground), its SEA EDGE at -Z (the camera's).
#   pave        a 10 m length, 8 m deep: big worn flagstones in courses, a dressed-stone COPING along the sea edge, the quay
#               WALL of dressed blocks under it down into the sand (the beach falls away: 0.5-1 m of it shows), two
#               cast-iron bollards and a mooring ring on the wall
#   lampadaire  the quay's cast-iron lamp: a fluted post on its plinth, the crook, the lantern
# One state each (dry stone: no wet band, no weed — those are the mole's, in the sea).
def buildPave(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"; X0, X1, ZS, ZL = -5.0, 5.0, -4.0, 4.0; FOOT_Y = -1.6
    K.box("Core", X0, X1, FOOT_Y, -0.02, ZS + 0.15, ZL, "quayMortar", G, 0)
    # the flagstones, course by course across the deck (as the mole's: each its own size and a hair high or low)
    zz, row = ZS + 0.5, 0
    while zz < ZL - 0.05:
        d = min(R.uniform(0.55, 0.8), ZL - zz); xx = X0 - (0.0 if row % 2 == 0 else R.uniform(0.2, 0.4)); k = 0
        while xx < X1 - 0.05:
            w = R.uniform(0.7, 1.1); a0, a1 = max(xx, X0), min(xx + w, X1)
            if a1 - a0 > 0.2:
                K.box(f"Flag{row}_{k}", a0 + 0.012, a1 - 0.012, -0.05, 0.03 + R.uniform(-0.008, 0.012), zz + 0.012, zz + d - 0.012, "paving", G, 0)
            xx += w; k += 1
        zz += d; row += 1
    # the COPING along the sea edge: long dressed kerb stones, rounded, a little over the wall's face
    x, k = X0, 0
    while x < X1 - 0.1:
        w = R.uniform(1.0, 1.5); xe = min(x + w, X1)
        K.box(f"Coping{k}", x + 0.01, xe - 0.01, -0.12, 0.09 + (k % 2) * 0.012, ZS - 0.06, ZS + 0.48, "dressedStone", G, 0.025)
        x = xe; k += 1
    # the WALL: dressed blocks from the coping down into the sand
    blockCourses(K, R, [(X0, ZS), (X1, ZS)], lambda i: (0.0, -1.0), FOOT_Y, -0.14, "BW", mat="quayDry")
    # the BOLLARDS behind the coping, a RING on the wall
    for k, bx in enumerate((-2.6, 2.4)):
        lathe(K, f"Bollard{k}", [(0.0, 0.0), (0.2, 0.0), (0.16, 0.35), (0.22, 0.48), (0.24, 0.56), (0.0, 0.58)], (bx, ZS + 0.85), "castIron", n=12)
    K.rod("Ringa", (-0.15, -0.35, ZS - 0.06), (0.0, -0.5, ZS - 0.06), 0.025, "castIron", G, 5)
    K.rod("Ringb", (0.0, -0.5, ZS - 0.06), (0.15, -0.35, ZS - 0.06), 0.025, "castIron", G, 5)

def buildLampadaire(K, name, spec, state, seed, far=False):
    G = "h"
    lathe(K, "Plinth", [(0.0, -0.1), (0.24, -0.1), (0.24, 0.12), (0.2, 0.18), (0.16, 0.5), (0.11, 0.62), (0.0, 0.62)], (0.0, 0.0), "castIron", n=12)
    lathe(K, "Post", [(0.0, 0.6), (0.075, 0.6), (0.06, 2.9), (0.08, 3.0), (0.0, 3.02)], (0.0, 0.0), "castIron", n=10)
    # the crook: out to the lantern, a scroll under it
    K.rod("Arm", (0.0, 2.95, 0.0), (0.0, 3.25, -0.55), 0.03, "castIron", G, 6)
    K.rod("Scroll", (0.0, 2.6, 0.0), (0.0, 3.0, -0.45), 0.018, "castIron", G, 5)
    lathe(K, "LampCap", [(0.0, 3.1), (0.04, 3.1), (0.2, 2.98), (0.22, 2.94), (0.0, 2.95)], (0.0, -0.62), "castIron", n=8)
    lathe(K, "LampGlass", [(0.0, 2.62), (0.09, 2.62), (0.16, 2.92), (0.0, 2.92)], (0.0, -0.62), "glass", n=8)
    K.rod("LampHang", (0.0, 3.25, -0.55), (0.0, 3.08, -0.62), 0.02, "castIron", G, 5)

def buildPlace(K, name, spec, state, seed, far=False):
    """THE SQUARE's paving (the church's, 2026-10-31): a 7.5 m square of the quay's flagstones on a thin bed, a dressed
    kerb round its four sides (two side by side: a band of kerb down the middle — the square's pattern)."""
    R = random.Random(seed); G = "h"; H = 3.75
    K.box("Bed", -H, H, -0.45, -0.02, -H, H, "quayMortar", G, 0)
    zz, row = -H + 0.32, 0
    while zz < H - 0.34:
        d = min(R.uniform(0.55, 0.8), H - 0.32 - zz); xx = -H + 0.32 - (0.0 if row % 2 == 0 else R.uniform(0.2, 0.4)); k = 0
        while xx < H - 0.34:
            w = R.uniform(0.7, 1.1); a0, a1 = max(xx, -H + 0.32), min(xx + w, H - 0.32)
            if a1 - a0 > 0.2 and d > 0.2:
                K.box(f"Flag{row}_{k}", a0 + 0.012, a1 - 0.012, -0.05, 0.03 + R.uniform(-0.008, 0.012), zz + 0.012, zz + d - 0.012, "paving", G, 0)
            xx += w; k += 1
        zz += d; row += 1
    # the KERB: long dressed stones round the edge (the corners' stones over the sides' ends: never one plane)
    k = 0
    for side in (-1, 1):
        x = -H
        while x < H - 0.1:
            w = R.uniform(1.0, 1.4); xe = min(x + w, H)
            K.box(f"KerbX{k}", x + 0.01, xe - 0.01, -0.2, 0.07 + (k % 2) * 0.01, side * H - (0.3 if side > 0 else 0.0), side * H + (0.0 if side > 0 else 0.3), "dressedStone", G, 0.02)
            x = xe; k += 1
        z = -H + 0.31
        while z < H - 0.41:
            w = R.uniform(1.0, 1.4); ze = min(z + w, H - 0.31)
            K.box(f"KerbZ{k}", side * H - (0.3 if side > 0 else 0.0), side * H + (0.0 if side > 0 else 0.3), -0.2, 0.065 + (k % 2) * 0.01, z + 0.01, ze - 0.01, "dressedStone", G, 0.02)
            z = ze; k += 1

TYPES["pave"] = dict(builder=buildPave, states=["intact"], autoLod=True, atlas=2048)
TYPES["place"] = dict(builder=buildPlace, states=["intact"], autoLod=True, atlas=2048)
TYPES["lampadaire"] = dict(builder=buildLampadaire, states=["intact"], autoLod=True, atlas=512, smoothAngle=50)

# ── THE CHURCH (2026-10-31, PORT_PLAN.md 6 — assets-src/refs/coast/Algerie.Jemmapes.Eglise.jpg, the 1930s postcard): the
# colonial village church of the Constantinois. autoLod from the start.
#   the TOWER before the nave: rendered rubble, dressed-stone QUOINS and string courses; the round-arched DOOR at its foot,
#   a tall round-arched WINDOW over it, the CLOCK, the BELFRY with its twin louvred lancets on every face, a cornice, the
#   steep octagonal SLATE SPIRE flaring at its eaves, its iron cross
#   the NAVE behind it, higher, its gable to the front; two lower AISLES either side under canal-tile LEAN-TOS, round-
#   arched windows down their sides and on their fronts
#   damaged  shell holes in the tower and an aisle, the spire's tip shot away, a hole in the nave's roof
#   ruin     the roofs gone, the walls broken off ragged, the tower broken at its belfry, rubble and charred trusses inside
# Built along X (its front at -X), then turned so its front faces -Z, the camera's (every kit's way).
def slate(nb):
    c = nb.mix(nb.noise(6.0, 4), srgb(0x3b4046), srgb(0x535a60))
    return nb.mix(nb.math("MULTIPLY", nb.mr(nb.noise(18.0, 3, 0.6, stretch=(1, 1, 0.2)), 0.6, 0.7), 0.5), c, srgb(0x6b6f6a))
# (churchWash: the render fallen in big patches, the rubble stone shows — a flat wash read cheap)
MATDEF.update({"churchWash": (0.95, wash(0xc4b69c, foot=0x7c705e, peel=0.61)), "slate": (0.6, slate), "clockFace": (0.6, flat(srgb(0xe8e2d2))),
               "louvre": (0.8, paintedWood(0x4a3a2a))})


# ── THE CHURCH'S DRESSING (2026-10-31, you: "church could be way better … looks too cheap"): what makes the postcard's church a
# church — the dressed STONE round every arch (voussoirs, a keystone, the jambs long-and-short, a sill), BUTTRESSES between
# the aisles' windows, a PLINTH course round its foot, CORNICES under the eaves, the door\x27s stepped ARCHIVOLT and its steps.
def hullPrism(K, nm, pts, mat):
    """A convex solid through the given game points (bmesh convex hull)."""
    bm = bmesh.new(); vs = [bm.verts.new(B(*p)) for p in pts]
    bmesh.ops.convex_hull(bm, input=vs)
    for v in [v for v in bm.verts if not v.link_faces]: bm.verts.remove(v)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return K.obj(nm, bm, mat, "h")

def onFace(face, u, y, d):
    """A face's local point -> game point. face ("x", X, out) the plane x = X, its outside toward x * out, u along z;
    ("z", Z, out) the plane z = Z, u along x. d: out from the face."""
    ax, P, out = face
    return (P + out * d, y, u) if ax == "x" else (u, y, P + out * d)

def archSurround(K, R, face, u, y0, ys, w, nm, depth=0.09, ring=0.26, sill=True, mat="dressedStone"):
    """The dressed stone round a round-headed opening (its sides from y0 to the springing ys, w wide, its centre u): nine
    VOUSSOIRS on the arch, the KEYSTONE proud and taller, the JAMBS long-and-short, a SILL (windows). Each piece 1.2 cm out from
    the opening\x27s edge (never in the plane of the cut reveal), into the wall 2 cm, `depth` proud of it."""
    r = w / 2 + 0.012; n = 9
    for k in range(n):
        a0, a1 = math.pi * k / n + 0.006, math.pi * (k + 1) / n - 0.006
        ro = r + ring + (0.08 if k == n // 2 else 0.0); dp = depth + (0.03 if k == n // 2 else 0.0)
        pts = []
        for a in (a0, a1):
            for rr in (r, ro):
                for d in (-0.02, dp): pts.append(onFace(face, u + rr * math.cos(a), ys + rr * math.sin(a), d))
        hullPrism(K, f"{nm}V{k}", pts, mat)
    for side in (-1, 1):
        y, k = y0 + (0.02 if sill else 0.0), 0
        while y < ys - 0.08:
            h = min(0.36 + R.uniform(-0.03, 0.03), ys - y); wd = 0.36 if k % 2 == 0 else 0.22
            a, b = u + side * r, u + side * (r + wd)
            pts = [onFace(face, uu, yy, d) for uu in (a, b) for yy in (y + 0.006, y + h - 0.006) for d in (-0.02, depth)]
            hullPrism(K, f"{nm}J{side}{k}", pts, mat)
            y += h; k += 1
    if sill:
        pts = [onFace(face, uu, yy, d) for uu in (u - r - 0.16, u + r + 0.16) for yy in (y0 - 0.15, y0 + 0.012) for d in (-0.02, depth + 0.07)]
        hullPrism(K, f"{nm}Sill", pts, mat)

def leaded(K, face, u, y0, ys, w, nm, back):
    """A church window\x27s iron tracery: a mullion, two transoms, the arch\x27s ring — on the glass, `back` in from the face."""
    G = "h"; r = w / 2
    K.rod(f"{nm}Mul", onFace(face, u, y0, -back + 0.015), onFace(face, u, ys + r * 0.95, -back + 0.015), 0.018, "castIron", G, 4)
    for f in (0.35, 0.7): K.rod(f"{nm}Tr{f}", onFace(face, u - r, y0 + (ys - y0) * f, -back + 0.015), onFace(face, u + r, y0 + (ys - y0) * f, -back + 0.015), 0.014, "castIron", G, 4)
    pts = [onFace(face, u + r * 0.98 * math.cos(math.pi * k / 8), ys + r * 0.98 * math.sin(math.pi * k / 8), -back + 0.015) for k in range(9)]
    for k in range(8): K.rod(f"{nm}Ar{k}", pts[k], pts[k + 1], 0.016, "castIron", G, 4)

def buttress(K, x, Z, s, h, nm, mat="churchWash"):
    """A stepped BUTTRESS against the wall z = Z (its outside toward z * s): 0.7 wide, 0.7 deep at its foot, its top sloping
    back into the wall; its stone weathering cap."""
    pts = [(x + dx, y, Z + s * dz) for dx in (-0.35, 0.35) for (y, dz) in ((-0.4, -0.05), (-0.4, 0.72), (h - 1.2, 0.72), (h, -0.05))]
    hullPrism(K, nm, pts, mat)
    cap = [(x + dx, y, Z + s * dz) for dx in (-0.39, 0.39) for (y, dz) in ((h - 1.24, 0.78), (h - 1.14, 0.78), (h + 0.04, -0.04), (h - 0.08, -0.04))]
    hullPrism(K, nm + "Cap", cap, "dressedStone")

def buildEglise(K, name, spec, state, seed, far=False):
    R = random.Random(seed); G = "h"; dmg, ruin = state != "intact", state == "ruin"
    before = set(bpy.data.objects)
    NX0, NX1, NW, NH = -8.0, 9.0, 3.6, 9.0          # the nave: its x, half width, wall height
    AW, AH = 3.4, 5.6                                # the aisles: their width, wall height
    TX0, TX1, TW, TH = -12.2, -7.4, 2.4, 17.0        # the tower: its x, half width, height to its cornice
    ZO = NW + AW                                     # the aisles' outer walls
    wall = lambda nm, x0, x1, y1, z0, z1: K.box(nm, x0, x1, -0.4, y1, z0, z1, "churchWash", G, 0)
    nave = wall("Nave", NX0, NX1, NH, -NW, NW); K.bevel(nave, 0.04, 2, 30)
    aisles = [wall(f"Aisle{s}", NX0 - 0.6, NX1 - 0.3, AH, *( (NW - 0.02, ZO) if s > 0 else (-ZO, -NW + 0.02) )) for s in (-1, 1)]
    for a in aisles: K.bevel(a, 0.04, 2, 30)
    tower = wall("Tower", TX0, TX1, TH, -TW, TW); K.bevel(tower, 0.04, 2, 30)
    # HOLLOW once hit, as the houses (solid, a ruin's broken aisles read as slabs of rubble — you on the houses: "not showing
    # the inside"): the nave and aisles emptied to 0.5 m walls, an earth floor
    if dmg:
        K.boolean(nave, K.cutter(NX0 + 0.5, NX1 - 0.5, 0.02, NH + 3, -NW + 0.5, NW - 0.5, "interior"))
        for s, a in zip((-1, 1), aisles):
            z0, z1 = (NW - 0.6, ZO - 0.5) if s > 0 else (-ZO + 0.5, -NW + 0.6)
            K.boolean(a, K.cutter(NX0 - 0.1, NX1 - 0.8, 0.02, AH + 3, z0, z1, "interior"))
        K.box("Floor", NX0 - 0.1, NX1 - 0.5, -0.2, 0.03, -ZO + 0.48, ZO - 0.48, "earth", G, 0)
        K.boolean(tower, K.cutter(TX0 + 0.6, TX1 - 0.6, 0.02, TH - 0.6, -TW + 0.6, TW - 0.6, "interior"))   # (the tower too: its belfry's floor left)
    # the nave's front gable over the aisles' roofs (behind the tower), the back gable
    for x, nm in ((NX0, "GableF"), (NX1, "GableB")):
        K.member(nm, (x - 0.25, NH - 0.01, 0.0), (x + 0.25, NH - 0.01, 0.0), [(-NW, 0.0), (NW, 0.0), (0.0, NW * math.tan(0.5) - 0.05)], "churchWash", G, up=(0, 1, 0))
    # THE OPENINGS — the door, the window over it, the clock\'s round, the belfry's twin lancets on each face; the aisles'
    # windows down their sides and on their fronts
    K.boolean(tower, K.arch(-0.95, 0.95, 0.2, 2.9, TX0 - 0.5, TX0 + 0.45, "dark", across="x"))   # (from 20 cm: from the ground, its floor z-fought the terrain — the GROUNDZ gate)
    K.boolean(tower, K.arch(-0.6, 0.6, 5.2, 7.3, TX0 - 0.5, TX0 + 0.3, "dark", across="x"))
    for (fx, across, d0, d1) in ((None, "x", TX0 - 0.5, TX0 + 0.35), (None, "x", TX1 - 0.35, TX1 + 0.5)):
        for u in (-0.55, 0.55): K.boolean(tower, K.arch(u - 0.32, u + 0.32, 13.0, 15.3, d0, d1, "dark", across="x"))
    for zs in (-1, 1):
        zf = zs * TW
        for u in (-0.55, 0.55): K.boolean(tower, K.arch((TX0 + TX1) / 2 + u - 0.32, (TX0 + TX1) / 2 + u + 0.32, 13.0, 15.3, min(zf - zs * 0.5, zf + zs * 0.35), max(zf - zs * 0.5, zf + zs * 0.35), "dark"))
    for s, a in zip((-1, 1), aisles):
        zf = s * ZO
        for k in range(4):
            x = NX0 + 2.6 + k * 3.6
            dw = AW + 0.4 if ruin else 0.5   # (a ruin's right through: its recess's back met the broken top in a sliver — the gate)
            K.boolean(a, K.arch(x - 0.55, x + 0.55, 1.6, 3.9, min(zf - s * dw, zf + s * 0.3), max(zf - s * dw, zf + s * 0.3), "dark"))
        K.boolean(a, K.arch(s * (NW + AW / 2) - 0.6, s * (NW + AW / 2) + 0.6, 1.6, 3.9, NX0 - 1.1, NX0 - 0.3, "dark", across="x"))
        # THE BACK too (you: "at its back the texture looks cheap" — blank walls): the aisles' back windows
        K.boolean(a, K.arch(s * (NW + AW / 2) - 0.55, s * (NW + AW / 2) + 0.55, 1.6, 3.9, NX1 - 0.6 if not ruin else NX1 - AW, NX1 + 0.3, "dark", across="x"))
    # the nave's tall back window
    K.boolean(nave, K.arch(-0.65, 0.65, 4.4, 6.9, NX1 - (0.3 if not ruin else 1.0), NX1 + 0.5, "dark", across="x"))
    k_of = lambda wx: round((wx - NX0 - 2.6) / 3.6)
    # THE DRESSING (the plinth, the arches' stone, the leading, the buttresses, the cornices, the door's steps)
    for s in (-1, 1):
        K.box(f"PlinthS{s}", NX0 - 0.6, NX1 - 0.3, -0.4, 0.55, *sorted((s * (ZO - 0.02), s * (ZO + 0.08))), "dressedStone", G, 0.01)
        K.box(f"PlinthF{s}", NX0 - 0.68, NX0 - 0.58, -0.4, 0.61, *sorted((s * NW, s * (ZO + 0.08))), "dressedStone", G, 0.01)
        K.box(f"PlinthT{s}", TX0, TX1 + 0.05, -0.4, 0.55, *sorted((s * (TW - 0.02), s * (TW + 0.08))), "dressedStone", G, 0.01)
    # (plinths meeting: their tops 5 cm apart — 1 cm apart, autoLod's 1.5 cm budget merged them into one plane, the gate)
    pt = K.box("PlinthTF", TX0 - 0.08, TX0 + 0.02, -0.4, 0.61, -TW - 0.08, TW + 0.08, "dressedStone", G, 0.01)
    K.boolean(pt, K.arch(-0.95, 0.95, 0.2, 2.9, TX0 - 0.5, TX0 + 0.45, "dark", across="x"))
    for k in range(3):   # the door's steps, the top one its threshold into the doorway
        K.box(f"DoorStep{k}", TX0 - 0.95 + k * 0.32, TX0 + (0.3 if k == 2 else -0.0), -0.4, 0.07 + k * 0.065, -1.35 + k * 0.1, 1.35 - k * 0.1, "dressedStone", G, 0.015)
    archSurround(K, R, ("x", TX0, -1), 0.0, 0.2, 2.9, 1.9, "SrDoor", depth=0.12, ring=0.34, sill=False)
    archSurround(K, R, ("x", TX0, -1), 0.0, 5.2, 7.3, 1.2, "SrWinT")
    if not ruin:
        for s in (-1, 1):
            for k in range(4):
                wx = NX0 + 2.6 + k * 3.6
                if not (dmg and s > 0 and k == 1): archSurround(K, R, ("z", s * ZO, s), wx, 1.6, 3.9, 1.1, f"SrW{s}{k}")
            archSurround(K, R, ("x", NX0 - 0.6, -1), s * (NW + AW / 2), 1.6, 3.9, 1.2, f"SrWF{s}")
            for k in range(1, 4): buttress(K, NX0 + 0.8 + k * 3.6, s * ZO, s, AH - 0.6, f"Butt{s}{k}")
            K.box(f"CorniceA{s}", NX0 - 0.62, NX1 - 0.28, AH - 0.22, AH - 0.02, *sorted((s * (ZO - 0.03), s * (ZO + 0.15))), "dressedStone", G, 0.015)
            K.box(f"CorniceN{s}", NX0 + 0.02, NX1 - 0.02, NH - 0.2, NH - 0.02, *sorted((s * (NW - 0.03), s * (NW + 0.13))), "dressedStone", G, 0.015)
            # the back: the aisles' windows dressed, their plinth, the nave's corners quoined over the aisles' roofs
            archSurround(K, R, ("x", NX1 - 0.3, 1), s * (NW + AW / 2), 1.6, 3.9, 1.1, f"SrWB{s}")
            K.box(f"PlinthB{s}", NX1 - 0.32, NX1 - 0.22, -0.4, 0.61, *sorted((s * NW, s * (ZO + 0.08))), "dressedStone", G, 0.01)
            quoins(K, R, NX1, s * NW, 1, s, NH, f"QN{s}", bev=0)
        archSurround(K, R, ("x", NX1, 1), 0.0, 4.4, 6.9, 1.3, "SrWN")
        K.box("PlinthBN", NX1 - 0.02, NX1 + 0.08, -0.4, 0.67, -NW + 0.01, NW - 0.01, "dressedStone", G, 0.01)
        # the OCULUS in the back gable: a dark round in its ring of voussoirs
        oc = (0.0, NH + 0.75); gx = NX1 + 0.25
        lathe(K, "OculusGlass", [(0.0, -0.01), (0.42, -0.01), (0.42, 0.01), (0.0, 0.01)], (0.0, 0.0), "glass", n=20)
        K.groups[G][-1].rotation_euler = (0.0, math.pi / 2, 0.0); K.groups[G][-1].location = B(gx + 0.005, oc[1], oc[0])
        for k in range(14):
            a0, a1 = 2 * math.pi * k / 14 + 0.01, 2 * math.pi * (k + 1) / 14 - 0.01
            pts = [onFace(("x", gx, 1), oc[0] + rr * math.cos(a), oc[1] + rr * math.sin(a), d) for a in (a0, a1) for rr in (0.43, 0.68) for d in (-0.02, 0.08)]
            hullPrism(K, f"OcV{k}", pts, "dressedStone")
    # the glazing: leaded panes behind iron bars, set in the reveals (not in a ruin)
    if not ruin:
        K.box("DoorLeaf", TX0 + 0.3, TX0 + 0.36, 0.21, 3.85, -0.94, 0.94, "woodDark", G, 0.005)
        K.box("DoorSplit", TX0 + 0.28, TX0 + 0.3, 0.21, 3.4, -0.02, 0.02, "dark", G, 0)
        K.box("WinT", TX0 + 0.26, TX0 + 0.28, 5.2, 7.85, -0.6, 0.6, "glass", G, 0)
        leaded(K, ("x", TX0, -1), 0.0, 5.2, 7.3, 1.2, "LdT", 0.26)
        K.box("WinN", NX1 - 0.28, NX1 - 0.26, 4.4, 7.55, -0.65, 0.65, "glass", G, 0)
        leaded(K, ("x", NX1, 1), 0.0, 4.4, 6.9, 1.3, "LdN", 0.26)
        for s in (-1, 1):
            leaded(K, ("x", NX0 - 0.6, -1), s * (NW + AW / 2), 1.6, 3.9, 1.2, f"LdF{s}", 0.26)
            for k in range(4):
                if not (dmg and s > 0 and k == 1): leaded(K, ("z", s * ZO, s), NX0 + 2.6 + k * 3.6, 1.6, 3.9, 1.1, f"Ld{s}{k}", 0.26)
        for (wx, wz, nx_, s_) in [(NX0 + 2.6 + k * 3.6, s * ZO, 0, s) for s in (-1, 1) for k in range(4)]:
            if dmg and s_ > 0 and k_of(wx) == 1: continue   # (the shell hole there)
            zz = wz - s_ * 0.26
            K.box(f"Win{wx:.1f}{s_}", wx - 0.55, wx + 0.55, 1.6, 4.45, min(zz, zz + s_ * 0.02), max(zz, zz + s_ * 0.02), "glass", G, 0)
        for s in (-1, 1):
            K.box(f"WinBack{s}", NX1 - 0.57, NX1 - 0.55, 1.6, 4.45, s * (NW + AW / 2) - 0.55, s * (NW + AW / 2) + 0.55, "glass", G, 0)
            leaded(K, ("x", NX1 - 0.3, 1), s * (NW + AW / 2), 1.6, 3.9, 1.1, f"LdB{s}", 0.26)
            K.box(f"WinFront{s}", NX0 - 0.35, NX0 - 0.33, 1.6, 4.5, s * (NW + AW / 2) - 0.6, s * (NW + AW / 2) + 0.6, "glass", G, 0)
        # the belfry's LOUVRES: slats slanted down and out in each lancet
        for face in range(4):
            for u in (-0.55, 0.55):
                for k in range(6):
                    y = 13.15 + k * 0.33
                    if face < 2:
                        x = TX0 + 0.12 if face == 0 else TX1 - 0.12
                        K.member(f"Lv{face}{u}{k}", (x, y + 0.12, u - 0.3), (x, y + 0.12, u + 0.3), [(-0.12, -0.02), (0.12, -0.14), (0.12, -0.11), (-0.12, 0.01)], "louvre", G)
                    else:
                        zz = TW - 0.12 if face == 2 else -TW + 0.12; xm = (TX0 + TX1) / 2 + u
                        K.member(f"Lv{face}{u}{k}", (xm - 0.3, y + 0.12, zz), (xm + 0.3, y + 0.12, zz), [(-0.12, -0.02), (0.12, -0.14), (0.12, -0.11), (-0.12, 0.01)], "louvre", G)
        # THE CLOCK on the front, under the belfry
        lathe(K, "ClockRim", [(0.0, -0.06), (0.62, -0.06), (0.62, 0.05), (0.0, 0.05)], (0.0, 0.0), "dressedStone", n=24)
        K.groups[G][-1].rotation_euler = (0.0, math.pi / 2, 0.0); K.groups[G][-1].location = B(TX0 - 0.02, 10.8, 0.0)
        lathe(K, "ClockFace", [(0.0, -0.08), (0.5, -0.08), (0.5, 0.075), (0.0, 0.075)], (0.0, 0.0), "clockFace", n=24)
        K.groups[G][-1].rotation_euler = (0.0, math.pi / 2, 0.0); K.groups[G][-1].location = B(TX0 - 0.03, 10.8, 0.0)
        K.rod("HandH", (TX0 - 0.12, 10.8, 0.0), (TX0 - 0.12, 11.08, 0.12), 0.025, "castIron", G, 4)
        K.rod("HandM", (TX0 - 0.13, 10.8, 0.0), (TX0 - 0.13, 11.22, -0.08), 0.018, "castIron", G, 4)
    # STRING COURSES and the CORNICE (dressed stone, proud), the QUOINS up the tower's and the building's corners
    for y in ((4.4, 9.4, 12.6) if not ruin else (4.4, 9.4)):   # (a ruin's tower broken at ~10.5: the higher one floated)
        st = K.box(f"String{y}", TX0 - 0.08, TX1 + 0.08, y, y + 0.18, -TW - 0.08, TW + 0.08, "dressedStone", G, 0.015)
        if dmg: K.boolean(st, K.cutter(TX0 + 0.6, TX1 - 0.6, y - 1, y + 1, -TW + 0.6, TW - 0.6, "interior"))   # (hollow with the tower: solid, it lay across its inside)
    if not ruin: K.box("Cornice", TX0 - 0.22, TX1 + 0.22, TH - 0.02, TH + 0.3, -TW - 0.22, TW + 0.22, "dressedStone", G, 0.02)
    for (x, sx) in ((TX0, -1), (TX1, 1)):
        for (z, sz) in ((-TW, -1), (TW, 1)): quoins(K, R, x, z, sx, sz, TH if not ruin else 8.0, f"QT{sx}{sz}", bev=0, avoid=[v for y in (4.4, 9.4, 12.6) for v in (y, y + 0.18)])
    for (x, sx) in ((NX0 - 0.6, -1), (NX1 - 0.3, 1)):
        for (z, sz) in ((-ZO, -1), (ZO, 1)): quoins(K, R, x, z, sx, sz, AH if not ruin else 3.0, f"QA{sx}{sz}", bev=0)
    # THE ROOFS: the nave's gable (along X), the aisles' lean-tos against it
    if not ruin:
        hole = (2.0, -1.4, 1.3) if dmg else None
        # (its tiles three-sided — far=True: 3 500 six-sided tiles made the church 136 000 triangles; seen from the RTS camera
        # a canal tile's roundness is under a pixel)
        tileRoof(K, R, NX0 - 0.2, NX1 + 0.3, -NW - 0.35, NW + 0.35, NH + 0.02, 0.5, hole=hole, far=far, nm="Nv")
        for s in (-1, 1):
            zE = s * (ZO + 0.35); zW = s * (NW - 0.02)
            tileRoof(K, R, NX0 - 0.6, NX1 - 0.1, zE if s < 0 else 2 * zW - zE, 2 * zW - zE if s < 0 else zE, AH + 0.02, math.atan2((NH - 1.6) - AH, abs(zE - zW)), far=far, only=-1 if s < 0 else 1, nm=f"Ai{s}")
        # THE SPIRE: octagonal, flaring at its eaves, its tip shot away when damaged; the iron cross
        top = TH + 0.3; tip = top + (8.6 if not dmg else 5.4)
        lathe(K, "Spire", [(0.0, top), (2.35, top), (2.2, top + 0.45), (1.9, top + 0.75), (0.08 if not dmg else 0.7, tip), (0.0, tip + 0.02)], ((TX0 + TX1) / 2, 0.0), "slate", n=8)
        if not dmg:
            K.rod("Cross", ((TX0 + TX1) / 2, tip, 0.0), ((TX0 + TX1) / 2, tip + 1.3, 0.0), 0.045, "castIron", G, 5)
            K.rod("CrossBar", ((TX0 + TX1) / 2, tip + 0.9, -0.38), ((TX0 + TX1) / 2, tip + 0.9, 0.38), 0.04, "castIron", G, 5)
    if dmg:
        K.boolean(tower, K.breach((TX0, 9.4 if not ruin else 6.0, 1.1), (0.7, 0.8, 0.7), seed=seed + 1, mat="rubble"))
        K.boolean(aisles[1], K.breach((NX0 + 6.2, 2.6, ZO), (0.9, 1.0, 0.8), seed=seed + 2, mat="rubble"))
        K.lump("Fall", (NX0 + 6.2, 0.0, ZO + 1.4), (1.4, 0.4, 0.8), "rubble", G, seed=seed + 3)
    if ruin:
        for o, h in [(nave, 5.5), (aisles[0], 3.4), (aisles[1], 3.0), (tower, 10.5)]:
            K.boolean(o, K.skyline(TX0 - 3, NX1 + 3, -ZO - 3, ZO + 3, h, 1.4, seed=seed + int(h * 10), mat="rubble"))
        for nm in ("GableF", "GableB"):
            for o in K.groups[G]:
                if o.name == nm: K.boolean(o, K.skyline(TX0 - 3, NX1 + 3, -ZO - 3, ZO + 3, 5.0, 1.0, seed=seed + 9, mat="rubble"))
        for k in range(4): K.lump(f"Heap{k}", (NX0 + 2 + k * 4.0, 0.0, R.uniform(-2, 2)), (1.8, 0.9, 1.4), "rubble", G, seed=seed + 20 + k, rough=0.45, flatten=200)
        for k in range(5): K.rod(f"Truss{k}", (NX0 + 1.5 + k * 3.2, 0.4, -NW + 0.7), (NX0 + 2.0 + k * 3.2, R.uniform(1.5, 3.5), NW - 0.7), 0.13, "fsCharred", G, 6)
    # turned so the front faces -Z: every object made here (and its cutters) about the origin
    import mathutils
    M = mathutils.Matrix.Rotation(-math.pi / 2, 4, "Z")
    bpy.context.view_layer.update()   # (the clock's parts placed by location: stale, the turn sent them to the origin)
    for o in set(bpy.data.objects) - before: o.matrix_world = M @ o.matrix_world

TYPES["eglise"] = dict(builder=buildEglise, autoLod=True, atlas=4096)   # (the town's one landmark, 30 m: at 2048 its walls had ~25 texels a metre — blurred blotches on its back, you)

for spec in TYPES.values():
    # (its far level its own build — the tiles as long strips, the genoise's beds alone — baked on the same atlas)
    b = spec.get("builder", buildHouse)
    # (autoLod: Blender builds the NEAR only; tools/lod/autoLod.mjs makes the far from it — 2026-10-31. The far builders and
    # their far=True branches stay for a kit that wants its own)
    spec.update(builder=b, autoLod=True, atlas=spec.get("atlas", 2048),
                # (wider gaps between the islands — 0.004, 0.006 — baked the atlas BLACK, silently: the far level's bars are widened instead)
                islandMargin=0.003,
                # (its thin coloured parts kept wide enough in the atlas to hold their colour at the mips — bkit.bake `thin`)
                thin=("frameWhite", "sill", "iron", "mortarLime", "glass"), thinPx=20,
                # (the roof's and the genoise's thousand tiles on 8 shared islands — bkit.bake `shared`: room for wide gaps)
                # (the small dressed stones, louvres and iron too — thousands of specks each its own island took ~90 % of the church's atlas, its walls a blurred corner: 2026-10-31)
                shared=("canalTile", "dressedStone", "louvre", "castIron", "iron"),
                boost={"awningRed": 2.0, "awningBlue": 2.0})   # (the café's stripes: 8 texels each smeared — the mip check, 90 %)

# (surfaces: the game tiles a full-resolution photo over each face's class — the washes the rough plaster, the stone the dry
# stone — a baked atlas alone, over a 30 m church, was a blurred mosaic close up: you, "at its back the texture looks cheap")
exported = buildKit(TYPES, MATDEF, "port.glb", prefix="Port", seed0=1955, surfaces=True)
previews(TYPES, exported, prefix="Port", tag="port_", spacing=14, frame=0.8)
print("DONE")
