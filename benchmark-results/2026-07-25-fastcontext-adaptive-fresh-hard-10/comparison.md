# FastContext Adaptive Retrieval Comparison

This comparison reuses the same ten issue-localization cases, repository commits, `gpt-5.5` model, disabled native reasoning, API profile, and 600-second per-run timeout. Each system was run once. Failures and timeouts score zero.

## Aggregate Results

| System | Success | R@10 | MRR | Full@10 | p50 / p95 | Tools | Input tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| FastContext before adaptive loop | 90% | 0.435 | 0.725 | 10% | 46.2s / 114.6s | 9.7 | 18,440 |
| FastContext adaptive loop | 100% | 0.647 | 0.900 | 30% | 125.8s / 183.4s | 22.3 | 57,313 |
| OpenCode Explore | 80% | 0.538 | 0.750 | 10% | 223.8s / 468.1s | 13.8 | 82,761 |

The adaptive loop raises FastContext R@10 by 0.212 absolute, a 48.7% relative improvement, and triples full-file coverage. The cost is a 2.7x p50 latency increase, 2.3x as many tool calls, and 3.1x as many input tokens compared with the fixed controller.

Against OpenCode with timeout failures included, adaptive FastContext is 43.8% faster at p50 and 60.8% faster at p95, while scoring higher on R@10, MRR, reliability, and full coverage. On only the eight cases OpenCode completed successfully, FastContext scores R@10 0.683 versus 0.673 and MRR 1.000 versus 0.938.

## Per-Case Recall@10

| Case | Previous FastContext | Adaptive FastContext | OpenCode |
|---|---:|---:|---:|
| `sphinx-doc__sphinx-10673` | 0.667 | 1.000 | 0.667 |
| `tailwindlabs__tailwindcss-853` | 1.000 | 1.000 | 1.000 |
| `prettier__prettier-8777` | 0.250 | 0.500 | 0.750 |
| `pylint-dev__pylint-4604` | 0.500 | 0.500 | 0.500 |
| `django__django-14011` | 0.000 | 0.500 | 0.500 |
| `mui__material-ui-34138` | 0.000 | 1.000 | 0.000 timeout |
| `huggingface__transformers-27717` | 0.667 | 0.667 | 0.667 |
| `google__gson-1904` | 0.600 | 0.800 | 0.800 |
| `mui__material-ui-23701` | 0.500 | 0.500 | 0.500 |
| `trinodb__trino-2768` | 0.167 | 0.000 | 0.000 timeout |

## Interpretation

The architecture change fixes the dominant premature-closure failure: Django rises from zero to partial coverage, Sphinx reaches full coverage, and the four-file MUI task reaches full coverage instead of failing. The remaining weakness is not first-owner ranking; nine of ten tasks still have MRR 1.0. It is selective multi-owner closure, especially long Java execution chains such as Trino and distributed formatting pipelines such as Prettier.

The next optimization target should be tail cost rather than another broad quality expansion. Seven tasks used the full eight-request allowance. Planner state reuse, compact evidence deltas, and an explicit marginal-information stop decision are now the highest-value improvements.

These are single-run public-benchmark results and are not sufficient for a statistical superiority claim.
