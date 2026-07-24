# FastContext 10-Case Historical Comparison

## Scope

This run reuses ten exact cases from the first 27 completed tasks of the earlier three-system experiment. All systems used `gpt-5.5` with native reasoning disabled and the same retrieval scorer. The current FastContext run uses commit `25f3a86`, one repeat, four-case concurrency, and a 300-second per-case timeout.

`TURBOFLUX_DISABLE_CODEGRAPH=1` was set for the current run to enforce the cold-workspace path. This is equivalent to the fixed runtime behavior when no CodeGraph index already exists: `trace_symbol` uses ripgrep without starting an index. Historical Claude Code and OpenCode values are reused from the earlier experiment rather than rerun concurrently, so latency comparisons remain directional and stochastic quality variance is not confidence-bounded.

## Aggregate Results

Historical failures and timeouts are scored as zero for R@10 and MRR. Latency percentiles include successful runs only.

| System | Success | R@10 | MRR | p50 |
|---|---:|---:|---:|---:|
| FastContext, current | 100% | 0.900 | 0.783 | 77.3s |
| FastContext, previous | 70% | 0.500 | 0.500 | 76.4s |
| Claude Code readonly, previous | 80% | 0.800 | 0.800 | 66.7s |
| OpenCode Explore, previous | 80% | 0.800 | 0.733 | 170.1s |

Against the previous FastContext controller, success improves by 30 percentage points and R@10 by 0.400 while p50 stays effectively flat. Against the historical Claude Code runs, current FastContext gains 20 percentage points in success and 0.100 R@10, with 0.017 lower MRR and 10.6 seconds higher p50. Against historical OpenCode, it gains 20 percentage points in success, 0.100 R@10, and 0.050 MRR while reducing p50 by 92.8 seconds.

## Per-Case Results

| Case | Previous FastContext R@10 | Current R@10 | Current MRR | Current latency | Requests |
|---|---:|---:|---:|---:|---:|
| `pydata__xarray-6461` | 1.00 | 1.00 | 1.00 | 58.9s | 4 |
| `django__django-12193` | 0.00 | 1.00 | 0.33 | 99.0s | 4 |
| `matplotlib__matplotlib-24970` | 1.00 | 1.00 | 1.00 | 77.3s | 4 |
| `pylint-dev__pylint-7080` | 0.00 | 1.00 | 0.50 | 61.9s | 4 |
| `astropy__astropy-7671` | 1.00 | 1.00 | 1.00 | 113.2s | 4 |
| `pytest-dev__pytest-10051` | 1.00 | 1.00 | 1.00 | 117.6s | 4 |
| `pylint-dev__pylint-6903` | 0.00 | 1.00 | 1.00 | 87.7s | 4 |
| `astropy__astropy-14365` | 1.00 | 1.00 | 1.00 | 50.3s | 4 |
| `sphinx-doc__sphinx-9658` | 0.00 | 1.00 | 1.00 | 81.5s | 6 |
| `psf__requests-6028` | 0.00 | 0.00 | 0.00 | 42.9s | 4 |

Nine cases achieve full file recall. Eight finish in four provider requests; `sphinx-doc__sphinx-9658` uses the bounded rescue wave and finishes in six.

## Remaining Miss

For `psf__requests-6028`, FastContext reads and ranks `requests/adapters.py`, `requests/sessions.py`, and `tests/test_requests.py`. That is a coherent proxy-authentication hypothesis, but the human patch changes `requests/utils.py`, which never enters the read set. The failure is candidate-generation recall rather than evidence validation or ranking rejection: once the model commits to `HTTPAdapter.proxy_headers`, the bounded frontier check does not test the Python 3.8.12 URL-parsing compatibility path in `get_auth_from_url`.

The next quality improvement should therefore target counter-hypothesis generation for environment- or runtime-version-specific regressions, not add more unconditional search turns. A low-cost rule at the semantic planning level is to reserve one alternative hypothesis when the issue explicitly attributes behavior to a language/runtime version change.

## Interpretation

This ten-case overlap is strong regression evidence for the adaptive controller and the removal of mandatory relationship validation. It is not sufficient evidence for a general claim of comprehensive superiority: the sample is Python-only, public, previously observed, single-repeat, and the comparator runs are historical. A blinded, multi-language holdout with fresh concurrent comparator runs remains necessary for that claim.
