# FastContext architecture paper

This directory contains the reproducible source for the FastContext technical preprint.

## Artifacts

- `paper.md`: canonical manuscript source.
- `generate_paper.py`: ReportLab renderer and vector figure generator.
- `references.bib`: editable bibliography for future LaTeX submission.
- `figures/*.svg`: standalone vector figures generated from the renderer.
- `artifact-manifest.json`: source commits and validity boundaries.
- `../../../output/pdf/FastContext-Architecture-Paper-ZH.pdf`: final reviewed PDF.

## Build

```powershell
C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe `
  docs\papers\fastcontext\generate_paper.py
```

The renderer requires ReportLab and the Windows SimSun, SimHei, and Noto Sans SC fonts. Render the PDF with Poppler before release:

```powershell
pdftoppm -png -r 150 output\pdf\FastContext-Architecture-Paper-ZH.pdf tmp\pdfs\fastcontext-page
```

## Evidence policy

The manuscript studies TurboFlux commit `5779a946d02106836f60054ec3cd4d27647bddeb`. The benchmark table is explicitly historical: it was produced from commit `629e4c25bc646c98113cddca4c86622a286cffdc`, whose deterministic prefetch stage no longer exists. Do not use that table to claim current-version superiority.

Before journal submission, add verified author identities and affiliations, select the target journal template, rerun the current implementation across multiple public repositories and seeds, report confidence intervals, and archive the complete reproduction package.
