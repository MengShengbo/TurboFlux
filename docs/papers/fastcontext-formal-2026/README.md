# FastContext formal paper

This directory contains independent Chinese and English manuscripts for the frozen 2026 formal retrieval experiment.

## Build paper data

```powershell
npm run paper:fastcontext:data
```

The command is safe to run while the benchmark is active. Partial outputs are marked `INCOMPLETE` and may only be used to validate schemas and figures.

## Render draft PDFs

```powershell
C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe `
  docs\papers\fastcontext-formal-2026\render_papers.py
```

Draft PDFs are written to `output/pdf/`. Before release, render every page through Poppler and inspect the resulting PNG files.

After both matrices complete:

```powershell
npm run paper:fastcontext:data
npm run paper:fastcontext:finalize
C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe `
  docs\papers\fastcontext-formal-2026\render_papers.py --final
```

## Release rule

Do not replace the results placeholders, remove incomplete labels, or rename PDFs from `Draft` until both the 200-task main matrix and the 100-task three-repeat matrix are complete.
