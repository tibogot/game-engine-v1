# attic — investigations that have already served their purpose

These are the one-off instruments: `*Repro`, `*Probe`, `*Sweep`, `*Hunt`, `*Scan`,
`*Trace`, `*Diag`, and friends. They were written to answer ONE question — why
does the car pop off that lip, where does the rail let the car through, what does
the landing actually do — and they answered it. The answer then went into a fix,
a comment, or a `*Test.mjs` that guards it.

They are kept because re-deriving a measurement rig is expensive and the rig is
often the hard part. They are moved out of `tools/` because they are not tests
and never were:

* **`runAll.mjs` never ran them.** It matches `*Test.mjs` / `*Test.run.mjs` only,
  so nothing here was ever part of the suite. Moving them changed no result.
* **They print tables, not pass/fail.** Most exit 0 whatever they measure, so
  "it still runs" tells you nothing about whether the game is correct.
* **They were the bulk of the search noise.** Grepping `landing` in `tools/` used
  to return 44 hits against 18 in the actual game source. Most of the excess was
  in here.

## Running one

They still work — nothing about them changed but their directory. Paths inside
them are resolved from the file's own location (`dirname(fileURLToPath(...))`
then `..`), so a file that has moved one level deeper needs its `ROOT` checked
before it will find the game source. Fix the `..` to `../..` if it complains,
and note that in the file when you do.

## Before adding to this folder

If the thing you wrote asserts something and you would be upset to see it break,
it is a test — leave it in `tools/` and name it `*Test.mjs` so the runner picks it
up. This folder is for the ones where the *finding* mattered and the code was
just how you got there.
