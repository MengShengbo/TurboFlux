# Kernel benchmark entrypoints

Run from the Desktop workspace root. These commands keep their work and logs in a new output directory; they do not modify the installed Desktop application or daily conversation storage.

## Measured-usage replay

```sh
npm run bench:kernel -- --mode replay --output /tmp/turboflux-ledger-check
```

This replays the sanitized usage facts from the completed 23-request engineering task through the current normalizer, event log and V2 repository. Each envelope is submitted twice, and each request receives repeated cumulative reports. A new Node process reloads the journal and must recover exactly 856,333 input, 784,256 cached and 40,750 output tokens. It makes **zero model calls**; its 91.58% is historical fixture data, not a fresh cache-performance result.

Use a fresh output directory on each run. The generated report is written to `report.json`. Temporary conversation storage is removed after verification.

## Live engineering regression

```sh
npm run bench:kernel:live -- --task invoice-fix --output /tmp/turboflux-invoice-candidate
```

This uses the configured model through native Electron credential protection. It sends real requests and consumes provider tokens. Model and reasoning settings are preserved. The seeded ESM project has precision and invoice-calculation bugs. TurboFlux must repair it, write tests and documentation, and run its tests. An independent verifier outside the project checks large exact amounts, malformed inputs, discount limits and tax rounding.

Results include the actual attempt records, tool results, source fingerprints, verification output, end-to-end duration and token totals. The latest record for each physical attempt is counted once. Unknown or interrupted consumption remains explicit. The runtime totals must exactly match a newly constructed repository's loaded totals.

The runner has a 15-minute safety timeout. It does not add warm-up requests or suppress failures to improve a ratio. The first runner startup failure in the implementation evidence happened before a provider call and is retained separately.

## Current coverage

- P0 minimal replay and a B2-style live engineering runner: implemented.
- B1 workspace-guard prompt: stored under `tasks/`; its full independent verifier remains in the prior engineering artifact and has not yet been generalized here.
- Repeated A/B runs, B3/B4/B5/B6 scenario drivers and multi-size resource baselines: not yet complete.
- Request accounting covers the main model and non-streamed context compaction, including compatibility and transport retries. Existing subagent progress statistics are still separate; per-attempt subagent coverage remains an outstanding P1 item.

Do not compare different task sizes or claim a replay as a live optimization gain. See `docs/plans/kernel-optimization.md` for the full acceptance plan.
