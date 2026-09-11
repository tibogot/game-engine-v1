# City citylight posters

Portrait posters for the pavement cabinets — the slim ad totems that stand at
eye level beside the kerb, the ones you actually drive past rather than look up
at.

    public/city-totems/totem-01.webp
    public/city-totems/totem-02.webp
    ...
    public/city-totems/totem-08.webp

Drop them in and the city picks them up on the next load. No manifest, no code
change.

## The rules, and the reasons

**Eight images, not one per cabinet.** The city stands ~640 citylights and they
share a 4x2 atlas, so there are eight distinct posters. `BANNER_COLS` /
`BANNER_ROWS` in `games/modular-road-v3/modularRoadCitySigns.js` if you ever
want more.

**PORTRAIT. Author at 512x1024 — the panel is 1.28 x 2.22 m, about 0.58:1.**
Each atlas tile is 256 x 512 (a 1024 page split 4 x 2), so 512x1024 is a clean
2x source. Anything larger is downscaled at load.

**Until you author them, the big boards stand in.** Any slot without a file
borrows `/city-ads/ad-NN` instead. A hero advert is LANDSCAPE (1.46:1), so it
arrives **centre-cropped, not squashed** — `setImage` cover-fits. That is a
deliberate stopgap: an empty cabinet looks worse than a cropped one. Drop a
portrait file in and it takes over that slot, on its own, with no code change.

The console says which is which on load:

    [CitySigns] 8 citylight posters loaded (8 borrowed from /city-ads/)

**WebP at about q80.** The image is decoded into the atlas canvas either way, so
the source format has no effect on GPU cost or memory — only on download size.
`.png` and `.jpg` are tried too, in that order after webp.

**No alpha.** Same rule as the hero boards: three r184 blends only the `output`
MRT attachment, so a transparent poster would wipe the emissive buffer behind it
and kill the bloom of everything it covers. The cabinet already provides the
frame and the dark backing, so the poster is a full-bleed rectangle.

**Missing files are fine.** Eight, three or none — anything unfilled falls back
to a hero advert, and failing that keeps its procedural placeholder.
