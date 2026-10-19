# The shared sound system — plan

User, 2026-10-19: build the SHARED sound system now, Thunderline its first user. Start from
games/shared-rts/rtsAudio.js; a game-neutral mixer in the engine with a pluggable LISTENER; what a
racer needs on top; game sounds stay in each game (its own manifest); replace Thunderline's
proto/kit/engineSound.js + sfx.js; volumes (master, music, effects) in Thunderline's settings.
**DON'T touch games/shared-rts/rtsAudio.js or alg-rts** (it is about to ship). After it ships,
rtsAudio becomes a thin layer over this core. One step at a time; ask before committing.

## What exists

- **rtsAudio.js (436 lines)**, used by alg-rts (algSounds, algGame) and nam-rts (namAudio): one
  context; buses sfx / ambience / ui → master → compressor; slots with candidate files (per-file
  `gain`, `start`/`end` trims, picks saved), one-shots with per-slot and global voice caps (steal the
  quietest), anti-phasing (min gap, no same file twice, pitch apart); loops asked from PROVIDERS each
  frame, kept by key, crossfaded at the seam; the RTS listener (camera focus + height: gain, low-pass
  by distance, pan from the screen); opt-in valley echo / delay / ducking (alg); mute = suspended
  context; unlock on first input; hidden tab = suspended; a meter.
- **Thunderline**: engineSound.js (its OWN AudioContext, an AudioWorklet engine synth fed by
  engineModel.js) and sfx.js (rides on that context: tyres, squeal, wind, boost whine as noise
  voices; landings, boost, race beeps as synth one-shots). No files at all. No music.

## The design

```
v3/audio/
  mixer.js       the core: context, buses (music, sfx, ambience, ui) → master → compressor,
                 settings (saved per game), unlock on first input, pause/resume (+ hidden tab),
                 meter; slots + manifest (rtsAudio's machinery, ported, not moved); one-shots
                 with caps / stealing / anti-phasing; providers' loops with seam crossfade
  voices.js      CONTINUOUS voices: a handle with smooth gain / rate / filter / pan
                 (setTargetAtTime, a time constant per call) over a buffer loop, a stack of
                 layered loops (RPM layers: crossfaded by a parameter), or a game's own node
                 (a worklet, a noise synth); SYNTH one-shots a game registers (a function that
                 builds its nodes into the voice's chain), so synths get buses, caps and the mix
  music.js       the music bus: play(track, {fade}) crossfades the old track out, the new in;
                 stop(fade); duck(amount) for menus / the finish screen
  listeners.js   the LISTENER interface: update() → { position, right, forward, velocity? };
                 spatial(pos, ref) → { gain, cutoff, pan, dist } from it.
                 rtsListener(focus, height, camera)  — rtsAudio's rule, unchanged
                 chaseListener(camera, car)          — Thunderline: the camera's ear, the car's speed
  doppler        OPTIONAL, measured first: rate × (c / (c − v_radial)) for a source passing the
                 listener (the ghost car, a later traffic / city mode). Only if a measured case
                 shows it matters.
```

**Thunderline, on top** (games/thunderline/audio/): `thunderAudio.js` — its manifest (synth slots
now; files when a recorded engine pack is chosen), the chase listener, and its sounds:
- the ENGINE: a continuous voice; today the worklet synth (engineWorklet.js + engineModel.js stay),
  later layered RPM loops (on/off-load per ~500 RPM) — only the voice's source changes
- tyres (roll, squeal), wind, boost whine: continuous voices with smooth gain / filter / rate
- landings (thump by impact, the PERFECT chime), boost, race beeps, UI clicks: synth one-shots
- the bus layout: engine / tyres / wind / one-shots → sfx; beeps / clicks → ui; music → music

**Settings** (Thunderline menu): Sound on/off (stays OFF by default), Master, Music, Effects.

## Steps (one at a time; the user hears each; ask before every commit)

1. **The core**: v3/audio/mixer.js + listeners.js — context, buses, compressor, settings, unlock,
   pause/resume, meter; slots, one-shots, loops (ported from rtsAudio, which stays as it is).
   A small audio lab page that plays test slots and prints the meter (nobody can listen for me).
2. **Continuous + synth voices, the music bus** (voices.js, music.js), measured in the lab
   (smooth ramps: no zipper noise; crossfade: no gap, no bump — meter traces).
3. **Thunderline's layer** (thunderAudio.js): the engine, tyres, wind, whine, landings, boost,
   beeps, UI clicks on the core; the chase listener; driveSession and engine-lab use it;
   engineSound.js + sfx.js deleted. The user listens: same sounds as today, one mix.
4. **Settings**: Master / Music / Effects sliders in Thunderline's menu, live in the game.
5. **Music**: the bus is ready; tracks need a source (the user chooses: CC0 packs, a composer).
6. **Doppler**: measure the ghost car passing first; add only if it matters.

Later (after alg-rts ships): rtsAudio.js → a thin layer over mixer.js (the RTS listener, the
valley echo / ducking as an RTS add-on), alg-rts and nam-rts unchanged in behaviour.
