# Engine loops — how they were made

The drive page's engine (proto/kit/engineLoops.js) plays loops from `public/sounds/thunderline/engines/<engine>/`.
They are rendered offline by **enginesound** (MIT, github.com/DasEtwas/enginesound, the 1.5.0 CLI).

- `gen6.esc` is the tool's own `example6.esc`, a four-cylinder. These are the throttle loops, `rpm_<rpm>.wav`.
- `gen6_off.esc` is the same engine coasting with no fuel, for the loops in `off/rpm_<rpm>.wav`. It changes three values:
  - `ignition_factor` goes from 5 to 1.2 on every cylinder (weak combustion),
  - `intake_volume` goes from 0.55 to 0.22 (the throttle is shut),
  - `engine_vibrations_volume` goes from 0.085 to 0.17 (the mechanical noise comes forward).

Each loop is 1.0 s long, at 1000, 1750, 2500, 3250, 4000, 5000, 6000, 7000 and 8200 RPM:

    cf  = 120 / rpm * 2 * 8          # the crossfade: 8 engine cycles
    len = 1.0 + cf / 2
    enginesound-cli -h -c gen6.esc -r <rpm> -l <len> -f <cf> -w 1.5 -v 0.25 -o rpm_<rpm>.wav

The CLI writes 32-bit float WAV. The files are converted to 16-bit PCM, about 96 KB a loop.

User's choice, 2026-10-20: gen6 out of the six example engines. The other five were not kept.
