# Thunderline — reference sources (2026-10-17)

Sources behind DESIGN.md §2. UNVERIFIED = searched for and not confirmed.

## Apex Rush (the main inspiration)
- Store: https://store.steampowered.com/app/2638250/Apex_Rush/ (Thunderboom Studios, Early Access 19 Feb 2026, UE5, ~15 €)
- Reviews (JSON): https://store.steampowered.com/appreviews/2638250?json=1 · patch notes: https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=2638250
- Editor discussion: https://steamcommunity.com/app/2638250/discussions/0/797842431111365223/ · Workshop: https://steamcommunity.com/workshop/browse/?appid=2638250
- Early UE5 playtest by "Hazardous" (likely the same dev, UNVERIFIED): https://realhazardous.itch.io/
- UNVERIFIED: YouTube content (not readable), speeds, loop/wallride pieces, how medals are set.
- SCREENSHOTS (user, 2026-10-23, from a streamer's video): assets-src/refs/apex-rush/ — a wall ride rising to
  vertical with chevron panels at its entry (01, 02), a wide curved wave ramp (04), a half-pipe running into a
  red tube with white rings (05), a vertical spiral seen from inside with a yellow ring (06), a huge wall with
  orange tubes (07), an overhead chevron sign above a landing (08), crest signs with an X marker (09), a road
  with a water pool cut in it and yellow barrels (10), the START side panels with chevrons + a big air ring (11).

## Trackmania
- Block grid 32×32×8 m: https://openplanet.dev/plugin/advancedfreeblockmode · half-scale 16×4×16: https://github.com/vjeux/trackmania-tas/releases/tag/tiny-blocks-v1
- Item placement grid and rotation steps: https://doc.trackmania.com/create/nadeo-importer/08-pivots-and-placement-parameters/
- Editor modes, controls, Enter = test from the cursor, validation colours, shadow bake: https://doc.maniaplanet.com/map-editor/how-to-use-the-map-editor
- Medal formula (gold/silver/bronze = AT × 1.06/1.2/1.5, rounded up to the next second): https://github.com/ezio416/tm-default-medals (src/Main.as) · custom medals must be slower than AT: https://openplanet.dev/plugin/defaultmedals
- Hand-tuned campaign medals: https://tm.mania-exchange.com/blogs/entry/569/what-do-you-think-medal-times
- Respawn: Backspace = last checkpoint, Delete = start: https://devtrackers.gg/trackmania/p/c7a703e4-why-i-restart-from-the-checkpoint-and-not-from-the-start · speed kept, double press = standing: https://steamcommunity.com/app/2225070/discussions/0/805721428305548509/ · softlock: https://devtrackers.gg/trackmania/p/744191f7-respawn-softlock
- Linked checkpoints: https://forum.maniaplanet.com/viewtopic.php?t=46340 · missed-checkpoint plugin: https://openplanet.dev/plugin/unclaimedcheckpointindicator
- Effects list: https://openplanet.dev/plugin/currenteffects · campaign tiers: https://doc.trackmania.com/play/what-is-a-seasonal-campaign/
- Editor criticism: https://godisageek.com/reviews/trackmania-review/ · https://www.gamewatcher.com/reviews/trackmania-review/13191
- Baked track lightmaps: https://github.com/skyslide22/blendermania-addon/wiki/05.-UV-Maps
- UNVERIFIED: no air control in TM2020; typical campaign speeds; camera numbers.

## Trackmania Turbo
- Editor tiers + generator: https://en.wikipedia.org/wiki/TrackMania_Turbo_(2016_video_game) · "dumbed down": https://steamcommunity.com/app/375900/discussions/0/392184522706665183
- UNVERIFIED: a "lazy mode" that builds as you drive (not found).

## Hot Wheels
- Unleashed 2 builder, by Milestone's lead designer: https://www.gamedeveloper.com/design/a-closer-look-at-hot-wheels-unleashed-2---turbocharged-track-builder
- Criticism: https://www.thesixthaxis.com/?p=386826 · https://www.trueachievements.com/a340710/expert-builder-achievement
- Unlimited (Budge Studios): https://www.pocketgamer.com/articles/084331/ · https://www.bluestacks.com/blog/game-guides/hot-wheels-unlimited/hwu-beginners-guide-en.html

## PolyTrack
- https://kodub.itch.io/polytrack · devlogs 0.3 / 0.4 / 0.5: https://kodub.itch.io/polytrack/devlog/624385 · /773067 · /920520
- Track codes: https://itch.io/t/2912863/share-your-tracks-here · effect blocks: https://itch.io/post/9265446/view-in-topic · keys: https://poki.com/en/g/polytrack

## Others
- Planet Coaster auto-complete: https://steamcommunity.com/app/493340/discussions/0/1741100729951476260
- Excite Truck: https://en.wikipedia.org/wiki/Excite_Truck
- Distance: https://www.shacknews.com/article/76319/ · Trials Rising: https://www.nintendolife.com/eshop/trials_rising

## Piece kits (for PIECES.md)
- Trackmania surfaces and history: https://en.wikipedia.org/wiki/Trackmania_(2020_video_game) · summer 2023 blocks: https://mp1st.com/news/trackmania-update-1-11-for-july-1-races-summer-2023-campaign
- TM transitions gap / corkscrew items: https://item.mania.exchange/set/view/10409 · slope encoding: https://item.mania.exchange/set/view/10411
- TM special blocks: https://gamewave.fr/trackmania/trackmania-guide-des-blocs-interactifs/
- Hot Wheels Unleashed 1 pieces: https://www.gtplanet.net/hot-wheels-unleashed-track-builder-20210709/
- PolyTrack parts: devlogs https://kodub.itch.io/polytrack/devlog/505760/polytrack-020 · /624385 · /920520
- GTA stunt race creator: https://www.gtaboom.com/GTA_Online_Stunt_Race_Creator_Guide
- Readability: Kinetica (Christer Ericson) https://realtimecollisiondetection.net/blog/?p=10 · SuperTuxKart https://supertuxkart.net/Making_Tracks:_Gameplay_Fundamentals
- UNVERIFIED: TM2020 block list per family (wiki unreachable), Apex Rush individual piece names, Hot Wheels corkscrew.

## Speed perception and shadows
- Holm et al. 2016 (FOV, camera height, motion blur): https://doi.org/10.1007/978-3-319-55834-9_14
- Diels & Parkes (geometric FOV 1.22:1): https://pureportal.coventry.ac.uk/en/publications/geometric-field-of-view-manipulations-affect-perceived-speed-in-d/
- Peripheral vision: https://pmc.ncbi.nlm.nih.gov/articles/PMC6812648
- Techniques list: https://elliotdev.gg/adding-the-feeling-of-speed/
- Shadows: https://learn.microsoft.com/en-us/windows/win32/dxtecharts/common-techniques-to-improve-shadow-depth-maps · https://learn.microsoft.com/en-us/windows/win32/dxtecharts/cascaded-shadow-maps · https://therealmjp.github.io/posts/shadow-maps/
