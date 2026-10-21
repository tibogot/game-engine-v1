"""Homography from the gauge close-up (cluster.png) to the front photo (front.png), SIFT + RANSAC, restricted to
the panel; then warp the close-up into the panel canvas (front px 205..845 x 232..625, x2)."""
import cv2, numpy as np, json
import os, tempfile
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
R = ROOT + "/assets-src/refs/turnin-turbo/"
S = os.path.join(tempfile.gettempdir(), "turnin-turbo-panel") + "/"; os.makedirs(S, exist_ok=True)   # intermediates
close = cv2.imread(R + "cluster.png"); front = cv2.imread(R + "front.png")
g1, g2 = cv2.cvtColor(close, cv2.COLOR_BGR2GRAY), cv2.cvtColor(front, cv2.COLOR_BGR2GRAY)
m1 = np.zeros_like(g1); m1[250:1000, 330:1420] = 255            # the panel in the close-up
m2 = np.zeros_like(g2); m2[232:625, 205:845] = 255              # the panel in the front photo
sift = cv2.SIFT_create(8000)
k1, d1 = sift.detectAndCompute(g1, m1); k2, d2 = sift.detectAndCompute(g2, m2)
matches = cv2.BFMatcher().knnMatch(d1, d2, k=2)
good = [m for m, n in matches if m.distance < 0.75 * n.distance]
p1 = np.float32([k1[m.queryIdx].pt for m in good]); p2 = np.float32([k2[m.trainIdx].pt for m in good])
H, inl = cv2.findHomography(p1, p2, cv2.RANSAC, 2.5)
print("matches", len(good), "inliers", int(inl.sum()))
err = np.linalg.norm(cv2.perspectiveTransform(p1[inl.ravel() == 1][None], H)[0] - p2[inl.ravel() == 1], axis=1)
print("reproj px: mean %.2f max %.2f" % (err.mean(), err.max()))
# panel canvas: front px (205..845, 232..625) scaled x2 -> 1280 x 786
K = 2; X0, Y0, X1, Y1 = 205, 232, 845, 625
T = np.array([[K, 0, -X0 * K], [0, K, -Y0 * K], [0, 0, 1]], float)
W, Hh = (X1 - X0) * K, (Y1 - Y0) * K
warp = cv2.warpPerspective(close, T @ H, (W, Hh), flags=cv2.INTER_LANCZOS4, borderValue=(0, 0, 0))
valid = cv2.warpPerspective(np.full(close.shape[:2], 255, np.uint8), T @ H, (W, Hh))
cv2.imwrite(S + "panel_warp.png", warp); cv2.imwrite(S + "panel_valid.png", valid)
json.dump({"H": H.tolist()}, open(S + "panel_H.json", "w"))
# check: blend with the front photo's own panel
fr = cv2.resize(front[Y0:Y1, X0:X1], (W, Hh), interpolation=cv2.INTER_CUBIC)
cv2.imwrite(S + "panel_check.png", np.hstack([fr, warp, cv2.addWeighted(fr, 0.5, warp, 0.5, 0)]))
