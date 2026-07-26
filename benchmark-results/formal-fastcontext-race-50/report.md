# FastContext Race 50-Case Report

## Executive Summary

FastContext Race localizes implementation files at a similar level to the two comparison agents in this consolidated 50-case matrix while keeping substantially lower tail latency than OpenCode Explore. Claude Code has the highest success rate in this slice; OpenCode has the highest descriptive Recall@10 but also the largest latency tail. Race is therefore retained as TurboFlux's single production retrieval path because it provides the intended speed-quality balance.

## Results

| System | N | Success rate | Recall@10 | MRR | MAP | nDCG@10 | Full coverage@10 | p50 | p95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| FastContext Race | 50 | 0.9800 | 0.7726 | 0.8317 | 0.7280 | 0.7733 | 0.6800 | 46.3s | 98.2s |
| Claude Code read-only | 50 | 1.0000 | 0.7783 | 0.8350 | 0.7483 | 0.7858 | 0.7000 | 54.6s | 117.2s |
| OpenCode Explore | 50 | 0.8400 | 0.7816 | 0.7915 | 0.7145 | 0.7626 | 0.7000 | 231.0s | 444.7s |

## Measurement Contract

The task is issue-to-edit-file localization at a pre-fix repository snapshot. Each system receives the issue description and read-only repository access, then returns at most ten ranked implementation paths. Gold paths come from the human patch metadata in the selected benchmark manifests. Recall@10 is the fraction of gold implementation paths present in the first ten predictions. MRR, MAP, nDCG@10, and full-file coverage are reported for the same records.

Failed or invalid runs contribute zero to retrieval quality. Latency is reported separately over successful runs so availability and responsiveness are not conflated. The raw JSONL retains protocol, model, API request, retry, tool-call, token, and error fields for audit.

## Provenance

The 50 cases are the union of three non-overlapping slices: 30 cases from the Race comparison run, 10 cases from the four-system run, and 10 cases from the older Race/Claude/OpenCode comparison. The 30-case and four-system slices use `e56d054`; the older 10-case slice uses `82576eb`. The `manifest.json` file records this split, while every record in `runs.jsonl` records its source slice.

## Interpretation

The data supports an engineering trade-off statement: Race is materially faster than OpenCode Explore and close to Claude Code on this matrix, but it does not establish that Race universally exceeds either comparator. Larger repeated experiments on a locked, unseen test split are required for a publication-grade superiority claim.
