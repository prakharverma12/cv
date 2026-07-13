# ATS / résumé scorer

Scores `../index.html` two ways:

1. **Parse fidelity** — extracts the résumé's text layer (what an ATS actually reads).
2. **Per-role JD match** — scores that text against each job description in `roles/`
   using Claude with a structured rubric (skills, seniority, quantified impact,
   keyword coverage) plus present/missing keywords and honest suggestions.

There is no universal "ATS score" — the meaningful number is match-vs-a-specific-JD.
Replace the sample JDs in `roles/` with **real postings** you're targeting for
accurate results.

## Setup

```bash
cd ats
npm install
export ANTHROPIC_API_KEY=sk-ant-...   # or run `ant auth login`
```

## Use

```bash
npm run score                       # all roles
node score.mjs backend-engineer     # one role
node score.mjs --pdf ../resume.pdf  # score a real exported PDF (needs pdftotext)
node score.mjs --print-resume       # dump the extracted text, no API call
```

## Add / change roles

Drop a `roles/<name>.md` file containing a job description. Paste the real posting —
the closer to the actual JD, the more accurate the keyword-coverage and gap analysis.

## Notes

- Model: `claude-opus-4-8`. Each role = one API call (small; a few cents total).
- `--print-resume` runs fully offline (no key needed) — use it to sanity-check extraction.
- Suggestions are constrained to skills you plausibly already have; the tool will not
  recommend fabricating experience or keyword-stuffing.
