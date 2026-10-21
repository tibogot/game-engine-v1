# Run first: python games/turnin-turbo/tools/panel_match.py, then panel_flaps.py (needs opencv-python-headless).
"""From the warped close-up (panel_warp.png, 1280 x 786 = front px 205..845 x 232..625, x2): find every flap window,
make the panel with all flaps OFF (base) and an atlas of each flap ON (patches), for instruments.js.
Writes public/textures/turnin-turbo/cluster_base.png, cluster_lit.png, cluster_flaps.json + a debug overlay."""
import cv2, numpy as np, json, os
import os, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
S = os.path.join(tempfile.gettempdir(), "turnin-turbo-panel") + "/"; os.makedirs(S, exist_ok=True)   # intermediates
OUT = ROOT + "/public/textures/turnin-turbo/"
os.makedirs(OUT, exist_ok=True)
img = cv2.imread(S + "panel_warp.png").astype(np.float32)
H, W = img.shape[:2]
b, g, r = img[..., 0], img[..., 1], img[..., 2]
hsv = cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
hue, sat, val = hsv[..., 0], hsv[..., 1], hsv[..., 2]

PANEL_BLACK = np.median(img[600:615, 300:560].reshape(-1, 3), axis=0)
print("panel black", PANEL_BLACK)

def comps(mask, min_area=40):
    n, lab, st, cen = cv2.connectedComponentsWithStats(mask.astype(np.uint8), 8)
    out = [(lab == i, st[i], cen[i]) for i in range(1, n) if st[i][4] >= min_area]
    return out

def region(x0, y0, x1, y1):
    m = np.zeros((H, W), bool); m[y0:y1, x0:x1] = True; return m

# --- 1. clean the close-up's wheel rim (bottom left) ----------------------------------------------------------------
rim = np.zeros((H, W), np.uint8)
cv2.fillPoly(rim, [np.int32([(0, 652), (240, 650), (262, 621), (700, 618), (770, 690), (860, 786), (0, 786)])], 1)
base = img.copy()
# fill: per column, the panel colour just above the patch (smoothed along x), with the panel's own fine grain
pp = img[520:615, 280:700].reshape(-1, 3); PANEL_DARK = np.median(pp[pp.mean(axis=1) < 40], axis=0)
col = np.broadcast_to(PANEL_DARK, (W, 3))
rng = np.random.default_rng(7)
fill = np.broadcast_to(col[None], (H, W, 3)) + cv2.GaussianBlur(rng.normal(0, 3.0, (H, W)).astype(np.float32), (0, 0), 0.8)[..., None]
a_rim = cv2.GaussianBlur(rim.astype(np.float32), (0, 0), 3)[..., None]
a_rim = np.maximum(a_rim, rim[..., None].astype(np.float32))
base = base * (1 - a_rim) + fill * a_rim
# the warning box's bottom edge and right side, redrawn as the printed lines are (white, ~7 px)
bx = img[560:660, 100:280].reshape(-1, 3); LINE = np.median(bx[bx.mean(axis=1) > 150], axis=0)
ln = np.zeros((H, W), np.uint8)
cv2.line(ln, (104, 641), (271, 641), 1, 7, cv2.LINE_AA)
cv2.line(ln, (271, 600), (271, 644), 1, 7, cv2.LINE_AA)
la = cv2.GaussianBlur(ln.astype(np.float32), (0, 0), 0.7)[..., None]
base = base * (1 - la) + LINE * la
# --- 2. masks -------------------------------------------------------------------------------------------------------
yellow = (hue > 12) & (hue < 35) & (sat > 110) & (val > 110)
pink = ((hue > 160) | (hue < 6)) & (sat > 90) & (val > 90)
green = (hue > 35) & (hue < 85) & (sat > 70) & (val > 60)
dil = lambda m, k=3: cv2.dilate(m.astype(np.uint8), np.ones((k, k), np.uint8)) > 0

flaps = {}
tacho = [c for c in comps(dil(yellow & region(0, 0, 760, 320)), 150)]
tacho.sort(key=lambda c: c[2][0])
print("tacho blocks", len(tacho))
for i, (m, st, cen) in enumerate(tacho): flaps[f"tacho{i}"] = m

fuel_lit = comps(dil(pink & region(1000, 0, 1280, 300)), 100)
turbo_lit = comps(dil(pink & region(500, 300, 700, 600)), 100)
print("fuel lit", [c[1].tolist() for c in fuel_lit], "turbo lit", [c[1].tolist() for c in turbo_lit])

# the unlit bars / cells: slightly lighter than the panel, in their columns
def dark_cells(x0, y0, x1, y1, min_area):
    sub = img[y0:y1, x0:x1].mean(axis=2)
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = (sub > PANEL_BLACK.mean() + 9) & (sub < 90)
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)) > 0
    return [c for c in comps(m, min_area)]
def bbox(m):
    ys, xs = np.nonzero(m); return xs.min(), ys.min(), xs.max(), ys.max()
def shifted(m, dx, dy):
    M = np.float32([[1, 0, dx], [0, 1, dy]])
    return cv2.warpAffine(m.astype(np.uint8), M, (W, H), flags=cv2.INTER_NEAREST) > 0

# fuel: the lit bar sits in the bottom box; the four boxes above (centres measured) get the same bar
fm = max(fuel_lit, key=lambda c: c[1][4])[0]
fx0, fy0, fx1, fy1 = bbox(fm)
FUEL_C = [249, 200, 161, 121, 81]                    # box centres, bottom (E) to top (F)
for i in range(5): flaps[f"fuel{i}"] = shifted(fm, 0, FUEL_C[i] - (fy0 + fy1) / 2)
pitch_f = None
# turbo: ONE flap sliding up its slot (lit = the pink bar, 372..458 here): five slices, lit from the bottom
tm = max(turbo_lit, key=lambda c: c[1][4])[0]
tx0, ty0, tx1, ty1 = bbox(tm)
for i in range(5):
    sl = np.zeros((H, W), bool); y1s = ty1 + 1 - (ty1 + 1 - ty0) * i / 5; y0s = ty1 + 1 - (ty1 + 1 - ty0) * (i + 1) / 5
    sl[int(round(y0s)):int(round(y1s)), :] = True
    flaps[f"turbo{i}"] = tm & sl
# speed: the middle digit is an 8 (all seven segments lit); the left is 1 (b c), the right 0 (a b c d e f)
gr = comps(dil(green & region(560, 300, 1120, 470), 3), 80)
mid = [c for c in gr if 790 < c[2][0] < 950]
print("speed: green comps", len(gr), "in middle digit", len(mid))
cx = np.mean([c[2][0] for c in mid]); cy = np.mean([c[2][1] for c in mid])
def seg_name(c):
    x, y = c[2][0] - cx, c[2][1] - cy
    if abs(x) < 18: return "a" if y < -25 else ("d" if y > 25 else "g")
    if y < 0: return "f" if x < 0 else "b"
    return "e" if x < 0 else "c"
segs = {seg_name(c): c[0] for c in mid}
if "g" not in segs:
    gm = np.zeros((H, W), np.uint8)
    cv2.fillPoly(gm, [np.int32([(823, 375), (832, 366), (858, 366), (867, 375), (858, 384), (832, 384)])], 1)
    segs["g"] = gm > 0
print("segments", sorted(segs))
right = [c for c in gr if c[2][0] >= 950]
pitch_d = np.mean([c[2][0] for c in right]) - cx
print("digit pitch", pitch_d)
for d, dx in enumerate((-pitch_d, 0, pitch_d)):
    if d == 0:   # the hundreds digit is only ever a 1 (the toy tops out at 180): its own two segments, lit in the photo
        left = sorted([c for c in gr if c[2][0] < 760], key=lambda c: c[2][1])
        flaps["spd0b"], flaps["spd0c"] = left[0][0], left[1][0]
        continue
    if d == 2:   # the units digit: its own segments (a 0 in the photo, a-f lit; slightly bigger than the middle's)
        rc = [c for c in gr if c[2][0] >= 950]
        cx2 = np.mean([c[2][0] for c in rc]); cy2 = np.mean([c[2][1] for c in rc])
        def nm2(c):
            x, y = c[2][0] - cx2, c[2][1] - cy2
            if abs(x) < 18: return "a" if y < 0 else "d"
            return ("f" if x < 0 else "b") if y < 0 else ("e" if x < 0 else "c")
        for c in rc: flaps[f"spd2{nm2(c)}"] = c[0]
        flaps["spd2g"] = shifted(segs["g"], cx2 - cx, cy2 - cy)
        continue
    for k, m in segs.items(): flaps[f"spd{d}{k}"] = shifted(m, dx, 0)

# trip: the two green digits on their flap wheels — cleared from the base, drawn as text by the page
trip_g = comps(dil(green & region(1050, 520, 1280, 650), 3), 30)
trip_boxes = []
for m, st, cen in sorted(trip_g, key=lambda c: c[2][0]):
    x0, y0, x1, y1 = bbox(m); trip_boxes.append([int(x0), int(y0), int(x1 - x0 + 1), int(y1 - y0 + 1)])
print("trip digits", trip_boxes)

# --- 3. base (all OFF) and lit ----------------------------------------------------------------------------------------
OFF = {"tacho": np.array([30, 30, 32.0]), "fuel": np.array([34, 31, 33.0]), "turbo": np.array([34, 31, 33.0]),
       "spd": np.array([28, 36, 28.0])}       # BGR
lit = base.copy()
ON = {"fuel": np.array([120, 40, 225.0]), "turbo": np.array([120, 40, 225.0])}  # BGR pink for the copied bars
grain = (img.mean(axis=2) - cv2.GaussianBlur(img.mean(axis=2), (0, 0), 3))[..., None]
for name, m in flaps.items():
    kind = "".join(ch for ch in name if not ch.isdigit())[:5].rstrip("abcdefg") if not name.startswith("spd") else "spd"
    kind = "tacho" if name.startswith("tacho") else "fuel" if name.startswith("fuel") else "turbo" if name.startswith("turbo") else "spd"
    mm = dil(m, 7)                     # wide enough to swallow the lit colour's fringe
    base[mm] = OFF[kind] + grain[mm] * 0.4
GREEN_ON = np.median(img[segs["a"]].reshape(-1, 3), axis=0)
for name, m in flaps.items():
    mm = dil(m, 3)
    if name.startswith(("tacho", "turbo", "spd0")) or name == "fuel0" or (name[:4] in ("spd1", "spd2") and name[-1] != "g"):
        lit[mm] = img[mm]                         # lit in the photo itself
    elif name.endswith("g") and name.startswith("spd"):
        lit[mm] = GREEN_ON + grain[mm] * 0.6
    elif name.startswith("spd"):
        dx = (int(name[3]) - 1) * pitch_d
        moved = cv2.warpAffine(img, np.float32([[1, 0, dx], [0, 1, 0]]), (W, H))
        lit[mm] = moved[mm]
    else:   # fuel 1..4: the bottom bar's pixels moved up
        dy = FUEL_C[int(name[4])] - (fy0 + fy1) / 2
        moved = cv2.warpAffine(img, np.float32([[1, 0, 0], [0, 1, dy]]), (W, H))
        lit[mm] = moved[mm]
# the 4th fuel box shows a flap caught half-way (a thin pink line): off
stray = pink & region(1000, 205, 1280, 222)
base[dil(stray, 5)] = OFF["fuel"]
for x, y, w, h in trip_boxes:
    base[y - 3:y + h + 3, x - 3:x + w + 3] = np.median(img[y - 8:y - 4, x:x + w].reshape(-1, 3), axis=0)
    lit[y - 3:y + h + 3, x - 3:x + w + 3] = base[y - 3:y + h + 3, x - 3:x + w + 3]

# --- 4. atlas: each flap's ON patch with alpha ------------------------------------------------------------------------
pad = 3
items, atlas_rows, x_cur, y_cur, row_h, AW = {}, [], 0, 0, 0, 1024
patches = []
for name, m in flaps.items():
    mm = dil(m, 3)
    x0, y0, x1, y1 = bbox(mm); x0 -= pad; y0 -= pad; x1 += pad; y1 += pad
    w, h = x1 - x0 + 1, y1 - y0 + 1
    if x_cur + w > AW: x_cur = 0; y_cur += row_h + 2; row_h = 0
    alpha = cv2.GaussianBlur(mm.astype(np.float32), (0, 0), 0.8)[y0:y1 + 1, x0:x1 + 1]
    rgba = np.dstack([lit[y0:y1 + 1, x0:x1 + 1], alpha * 255])
    patches.append((x_cur, y_cur, rgba))
    items[name] = [int(x0), int(y0), int(w), int(h), int(x_cur), int(y_cur)]
    x_cur += w + 2; row_h = max(row_h, h)
AH = y_cur + row_h + 2
atlas = np.zeros((AH, AW, 4), np.float32)
for x, y, p in patches: atlas[y:y + p.shape[0], x:x + p.shape[1]] = p
cv2.imwrite(OUT + "cluster_base.png", np.clip(base, 0, 255).astype(np.uint8))
cv2.imwrite(OUT + "cluster_flaps.png", np.clip(atlas, 0, 255).astype(np.uint8))
json.dump({"size": [W, H], "flaps": items, "trip": trip_boxes}, open(OUT + "cluster_flaps.json", "w"))
# debug: everything ON
dbg = base.copy()
for name, (x0, y0, w, h, ax, ay) in items.items():
    p = atlas[ay:ay + h, ax:ax + w]; a = p[..., 3:] / 255
    dbg[y0:y0 + h, x0:x0 + w] = dbg[y0:y0 + h, x0:x0 + w] * (1 - a) + p[..., :3] * a
cv2.imwrite(S + "cluster_dbg.png", np.hstack([base, dbg]).astype(np.uint8))
print("flaps", len(items), "atlas", AW, AH)
