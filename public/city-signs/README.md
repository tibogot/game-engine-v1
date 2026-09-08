# City road signs

Drop a PNG here to replace a drawn sign.

Every sign in the city is **drawn in code at boot** with Canvas2D, so this
folder can stay empty forever and the signage is still correct. That is not a
placeholder: a road sign is flat vector art made of circles, triangles and one
piece of text, which is exactly what a 2D canvas is good at. It means the city
ships with real signage and zero asset files — nothing to author, nothing to
load, nothing to 404.

A file here **replaces one tile in place**: no new draw call, no new texture,
no shader rebuild. Same mechanism the hero adverts use.

| file | sign | file | sign |
|---|---|---|---|
| `sign-01` | 30 limit | `sign-06` | stop |
| `sign-02` | 50 limit | `sign-07` | pedestrian crossing |
| `sign-03` | no entry | `sign-08` | one way |
| `sign-04` | no parking | `sign-09` | roadworks ahead |
| `sign-05` | give way | `sign-10`…`sign-16` | unused — draw an "NN" placeholder |

**Author at 256×256 with transparency.** The sign's shape comes from the alpha
— the plate is cut to it with an `alphaTest` discard, never a blend, because
r184 blends only the `output` MRT attachment and a transparent surface would
erase the emissive buffer behind it.

`.png`, `.webp` or `.jpg`; the first one found wins, in that order. A missing
file is not an error — the drawn sign simply stays.

Placement rules live in `modularRoadCityFurniture.js`: mid-block signs never
roll STOP or GIVE WAY (those mean a junction, and this city signals its
junctions), and the roadworks warning is placed by the clutter module a few
metres before each lane closure, facing the traffic that is about to meet it.
