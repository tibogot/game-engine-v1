# Recorded car sounds (sound lab)

These are free CC0 recordings: no credit is needed and commercial use is allowed. They were cut by the
scratch script `sfxCut.py`: it takes the steadiest stretch of each recording, makes it a seamless loop with
an equal-power crossfade of its tail onto its head, and sets every loop to the same loudness (RMS 0.12).
All files are 16-bit WAV, 48 kHz, mono. You audition them in `proto/sound-lab.html`.

The user's picks, 2026-10-20:
- **Drift squeal: B, the long screech.** Used in the game: `sfxSamples.js` plays it, and the synthesised
  squeal in `sfx.js` is switched off.
- **Wind:** kept, not used yet.
- **Tyres rolling:** "not sure", kept, not used yet. The synthesised roll stays.
- **Rail scrape and landing:** rejected. The recordings didn't sound right, and the landings sounded "like
  Mario Bros". Deleted; the synthesised landing stays.

| file | source |
|---|---|
| squeal_b | BigSoundBank #2371 "Screeching Tires #4" (Joseph Sardin), 2.05 s in, 1.5 s loop |
| roll_a | BigSoundBank #1286 "Car on a Road", 43.15 s in, 4 s loop |
| roll_b | BigSoundBank #0505 "Car Interior, 80km/h", 51.7 s in, 4 s loop |
| wind_a | BigSoundBank #0152 "Strong wind #2", 6 s loop |
| wind_b | BigSoundBank #0147 "Whistling of the Wind #1", 6 s loop |
| wind_c | BigSoundBank #0146 "Strong Wind #1", 6 s loop |

Source: https://bigsoundbank.com (every sound there is CC0)
