# Contributing to SIM CONSOLE

Thanks for wanting to help build the bench. Students and first-time contributors are
very welcome — if something here is unclear, open an issue and ask.

## Getting set up

```bash
git clone https://github.com/Zero-State-Logic/Sim-Console
cd Sim-Console
npm install
npm run dev
```

Open http://localhost:5173 in Chrome or Edge.

## Before you open a pull request

```bash
npm run check
```

This runs the TypeScript check, every test and the production build. A pull request
should keep all three green.

## Good first contributions

- **A new gait** for the walker — gaits live in `src/robots/walker/gaits.ts` and are
  tested in `gaits.test.ts`.
- **A firmware template** for another board or servo driver — see `src/codegen/`.
- **Example programs** for the code sandbox — `src/sandbox/examples/`.
- **Testing on your own hardware** and reporting what the Virtual Device gets wrong.

## Adding a robot

Every robot is one folder under `src/robots/` that exports an `entry` from its
`index.ts` and implements the `RobotModule` contract in `src/core/types.ts`. The
registry discovers it automatically, and the shell, instruments, hardware link and
code sandbox all work with it without changes.

## Style

- TypeScript strict, two-space indent, single quotes, no semicolons.
- Keep the maths pure (no three.js, no DOM) so it can be unit-tested, and test it.
- No per-frame allocations in simulation loops.
- The colour tokens in `src/theme.css` (`:root`) are part of the design — please don't
  change them in a feature PR.

## Reporting bugs

Open an issue with the robot, the drive source (SIM / HARDWARE / CODE), your browser
or OS, and what you expected to happen. A recording exported from the timeline
(`.json`) makes motion bugs much easier to reproduce.
