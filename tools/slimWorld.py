#!/usr/bin/env python
"""
SLIM A .v3proj — drop blobs that are entirely zero.

── WHY ──────────────────────────────────────────────────────────────────────
`stunt.v3proj` is the racing game's default world, and its own comment calls
it "flat empty terrain — the world under it only has to exist and not get in
the way". MEASURED: 8.26 MB, of which the manifest carrying every actual
setting is 9.7 kB and the remaining 8.25 MB is five raw blobs that are
**entirely zero** — a 4 MB heightmap of nothing, a 2 MB splat of nothing,
and three density maps of nothing.

The reader already handles this: `blob(name)` in v3/io/projectIO.js returns
null when the manifest has no entry, and every caller treats null as "use the
default", which for a heightmap is all-zeros. So an omitted blob and a blob
full of zeros are the same file to the game — one of them just is not sent.

── SAFE BY CONSTRUCTION ─────────────────────────────────────────────────────
A blob is only dropped after every byte of it has been checked. A blob with a
single non-zero byte is kept and repacked, so this can never quietly discard
a terrain somebody sculpted. Run it on anything; it removes nothing real.

Usage:  python tools/slimWorld.py <file.v3proj> [more.v3proj ...] [--dry]
"""
import json
import os
import struct
import sys

MAGIC = b"V3PJ"
HEADER_BYTES = 12          # u32 magic · u32 version · u32 manifestByteLength


def slim(path, dry=False):
    raw = open(path, "rb").read()
    if raw[:4] != MAGIC:
        print(f"  {path}: not a V3PJ file, skipped")
        return
    version, mlen = struct.unpack("<II", raw[4:12])
    manifest = json.loads(raw[HEADER_BYTES:HEADER_BYTES + mlen].decode("utf-8"))
    start = HEADER_BYTES + mlen
    blobs = manifest.get("blobs") or {}

    keep, dropped, payload = {}, [], bytearray()
    for name, b in blobs.items():
        data = raw[start + b["offset"]: start + b["offset"] + b["length"]]
        # EVERY byte, not a sample. A sampled check would eventually throw away
        # a terrain whose only detail is somewhere the sample did not look.
        if not any(data):
            dropped.append((name, len(data)))
            continue
        keep[name] = {"offset": len(payload), "length": len(data)}
        payload += data

    if not dropped:
        print(f"  {os.path.basename(path)}: nothing to drop ({len(raw)/1048576:.2f} MB)")
        return

    manifest["blobs"] = keep
    mbytes = json.dumps(manifest).encode("utf-8")
    out = bytearray(MAGIC)
    out += struct.pack("<II", version, len(mbytes))
    out += mbytes
    out += payload

    print(f"  {os.path.basename(path)}: {len(raw)/1048576:.2f} MB -> {len(out)/1048576:.3f} MB")
    for n, ln in dropped:
        print(f"      dropped {n:16} {ln/1048576:5.2f} MB (all zero)")
    for n in keep:
        print(f"      kept    {n:16} {keep[n]['length']/1048576:5.2f} MB")
    if not dry:
        open(path, "wb").write(bytes(out))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry" in sys.argv
    if not args:
        print(__doc__)
        return
    print("slimming:")
    for a in args:
        slim(a, dry)
    if dry:
        print("(dry run — nothing written)")


if __name__ == "__main__":
    main()
