// Per-layer tint and UV rotation (AUDIT 5): the TextureLibrary side — setters,
// the cos/sin the shader reads, and the project save/load round trip. The
// shader half (rotated taps, turned normals, untinted height blend) is checked
// in the editor.
import { TextureLibrary, NUM_LAYERS } from "../v3/terrain/textureLibrary.js";

let fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) fail++;
};
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const lib = new TextureLibrary();
lib._defaultsPromise = Promise.resolve();

// ── Defaults: a layer renders exactly as before ──
{
  const ok = lib.slotUniforms.every((u, i) =>
    lib.getTintHex(i) === "#ffffff" && lib.slots[i].uvRotation === 0 &&
    u.uUVRot.value.x === 1 && u.uUVRot.value.y === 0);
  check("every layer starts white and unturned", ok);
}

// ── Rotation: degrees on the slot, cos/sin in the uniform, wrapped ──
{
  lib.setUVRotation(2, 90);
  const v = lib.slotUniforms[2].uUVRot.value;
  check("90 deg gives (cos, sin) = (0, 1)", near(v.x, 0) && near(v.y, 1), `${v.x}, ${v.y}`);
  lib.setUVRotation(2, -30);
  check("-30 deg is stored as 330", lib.slots[2].uvRotation === 330);
  check("and its cos/sin match -30", near(lib.slotUniforms[2].uUVRot.value.y, -0.5));
  lib.setUVRotation(2, 725);
  check("725 deg wraps to 5", near(lib.slots[2].uvRotation, 5));
}

// ── Tint: a hex in, the same hex out (colour management round trip) ──
{
  for (const hex of ["#e0a060", "#123456", "#80c0ff", "#000000"]) {
    lib.setTint(1, hex);
    check(`tint ${hex} reads back unchanged`, lib.getTintHex(1) === hex, lib.getTintHex(1));
  }
}

// ── Save / load ──
{
  lib.setTint(4, "#e0a060"); lib.setUVRotation(4, 45);
  const saved = JSON.parse(JSON.stringify(lib.exportData()));
  check("export carries tint and rotation", saved[4].tint === "#e0a060" && saved[4].uvRotation === 45);

  const other = new TextureLibrary();
  other._defaultsPromise = Promise.resolve();
  // Strip the maps so the load does not try to fetch anything.
  const data = saved.map((d) => ({ ...d, albedo: null, normal: null, rough: null, ao: null }));
  await other.importData(data);
  check("load restores the tint", other.getTintHex(4) === "#e0a060", other.getTintHex(4));
  check("load restores the rotation and its cos/sin",
    other.slots[4].uvRotation === 45 && near(other.slotUniforms[4].uUVRot.value.x, Math.SQRT1_2));

  // A file written before these existed: white and unturned, whatever was set.
  other.setTint(3, "#123456"); other.setUVRotation(3, 99);
  const old = data.map((d) => { const c = { ...d }; delete c.tint; delete c.uvRotation; return c; });
  await other.importData(old);
  check("an older file loads white", other.getTintHex(3) === "#ffffff");
  check("an older file loads unturned", other.slots[3].uvRotation === 0 && other.slotUniforms[3].uUVRot.value.x === 1);

  const bad = data.map((d) => ({ ...d, tint: "orange", uvRotation: "x" }));
  await other.importData(bad);
  check("a malformed tint or rotation falls back to the default",
    other.getTintHex(0) === "#ffffff" && other.slots[0].uvRotation === 0);
  check("seven layers round-trip", other.exportData().length === NUM_LAYERS);
}

console.log(fail === 0 ? "\nall passed" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
