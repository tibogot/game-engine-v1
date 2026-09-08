# City hero adverts

Drop images in here and the city's billboards pick them up on the next load.
Nothing else to wire — no manifest, no code change.

    public/city-ads/ad-01.webp
    public/city-ads/ad-02.webp
    ...
    public/city-ads/ad-16.webp

## The rules, and the reasons

**Sixteen images, not one per board.** The city places ~145 hero boards but they
share a 4x4 atlas, so there are 16 distinct adverts and each shows up roughly
nine times around the map. `HERO_COLS` / `HERO_ROWS` in
`games/modular-road-v3/modularRoadCitySigns.js` if you ever want more.

**Numbered by the label on the board.** An unfilled board paints itself `AD 07`;
that is `ad-07.webp`. (Internally it is slot 6 — the loader does the -1 so you
do not have to.)

**Aspect ~1.46:1. Author at 1024x700.** The printed panel inside a board's frame
is 1.461:1, and the atlas tile it samples is square, so the tile is stretched
1.46x horizontally on the wall. `setImage` fills the tile rather than cropping
to it, which means a 1.46:1 source is squashed on the way in and stretched back
out on the way to the wall, arriving exactly as you drew it. A SQUARE image will
therefore look wide — that is not a bug, it is the honest consequence of the
board's shape.

**512x512 is the real resolution.** Each atlas tile is 2048/4 = 512 px, so
anything larger is downscaled at load. 1024x700 is a good source size: enough to
resample cleanly, not enough to waste bandwidth. If the boards look soft up
close, raise `HERO_PX` to 4096 (1024 per tile, 4x the texture memory).

**WebP, at about q80.** The image is decoded into the atlas canvas either way,
so the source format has NO effect on GPU cost or memory — only on download size
and decode time. WebP is typically a third of the PNG for photographic art. Use
PNG only for flat colour and hard-edged text where you want it lossless.
`.png` and `.jpg` are tried too, so either still works.

**No alpha.** The boards are opaque quads on purpose: three r184 blends only the
`output` MRT attachment, so a transparent sign would wipe the emissive buffer
behind it and kill the bloom of every lit window it covers.

**Missing files are fine.** Any slot without an image keeps its `AD nn`
placeholder, so you can add three adverts today and the rest later.
