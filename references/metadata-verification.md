# Reference metadata verification

Goal: prove every reference is real and settle every field the manuscript's own
bibliography may have gotten wrong, **before** anything is imported.

## Lookup order

1. **Crossref** — `https://api.crossref.org/works/<url-encoded-doi>`
   Covers journal articles, books, book chapters, proceedings.
2. **DataCite** — `https://api.datacite.org/dois/<url-encoded-doi>`
   Required for `10.48550/...` (arXiv) and `10.5281/zenodo...`. Crossref returns 404 for
   these, which looks identical to "fake reference" — it is not.
3. **No DOI** — confirm against a local source file. Books (ISBN), reports, web posts
   and preprints often legitimately have no DOI; record why rather than skipping.

Always report the resolved / unresolved split to the user. "32/32 resolved" is a claim
they can act on; a silent import is not.

## Year: use `published-print`, not `issued`

Crossref `issued` is frequently the **online-first** year, which can be a year earlier
than the version of record. In one manuscript 3 of 32 entries differed:

| Entry | issued | published-print | manuscript cited |
|---|---|---|---|
| Arthur 2025 | 2024 | 2025 | 2025 |
| Lou 2026 | 2025 | 2026 | 2026 |
| Lu 2026 | 2025 | 2026 | 2026 |

The manuscript was right in all three. Prefer `published-print`, else `issued`. This
matters beyond cosmetics: APA author-date disambiguation keys off the year, so an
off-by-one year silently changes `Sun et al., 2026a` into a different letter or
collapses two distinct works into one label.

For arXiv records there is no print date — the registry year is the posting year. If the
manuscript cites the *venue* (ICLR/NeurIPS/ICML), use the venue year and set the item
type accordingly.

## Registry quirks that must be normalised

Observed directly in Crossref/DataCite payloads:

- **Middle initial glued onto the surname** — the most damaging one, because it silently
  corrupts both the in-text label and the bibliography entry. Crossref returned
  `family: "F. Dormann", given: "Carsten"` for Carsten F. Dormann. 7 of 17 authors in one
  paper were affected, and APA then rendered `(F. Dormann et al., 2007)`. Detect with
  `family -match '^[A-Z]\.\s+\S'` and move that initial to the end of `given`.
- **The inverse case** — `family: "Daniel Kissling", given: "W."`. Fix only when the
  first token of `family` is not a nobiliary particle (`van`, `de`, `der`, `von`, `ten`,
  `di`, `da`, `la`, `le`, `du`, `del`, …), otherwise you corrupt names like *van der Berg*.
- **Uppercased surnames** — `MORAN` for `Moran`. Title-case single-letter-uppercase
  family names before saving.
- **Truncated given names** — Crossref stored `Stef` where the real name is `Stefano`.
  Cross-check against the source PDF or the journal record; do not propagate the
  truncation into the library.
- **DataCite packs the whole personal name into `family`** — `"family": "De Sabbata,
  Stef"` with `given: ""`. Split on the first comma.
- **Series packed into `container-title`** — IOS Press book chapters returned
  `"Frontiers in Artificial Intelligence and Applications Geography According to
  Foundation Models"`. Split into `bookTitle` + `seriesTitle`.
- **Title case mangling** — Crossref returned Moran's title in all caps
  (`NOTES ON CONTINUOUS STOCHASTIC PHENOMENA`). Use the journal's own casing.
- **HTML markup inside titles** — `<i>via</i>` survived from the publisher feed and lands
  in Zotero as a literal tag. Strip tags before importing.
- **LaTeX left in titles** — `"Causality $\neq$ Decodability"`. Convert to the real
  character and verify the code point survived (§4 of `powershell-traps.md`).

Always **scan every item after building the list** for these two predicates before
importing — they are cheap to check and expensive to discover downstream:

```
lastName matches '^[A-Z]\.\s+\S'                       # initial glued to surname
givenName matches '^[A-Z]\.$' AND lastName has 2+ words # inverse case
```

Crossref author lists are complete and authoritative — a 70-author EULUC-China paper
came through with all 70. Prefer them over truncated bib author lists.

## BibTeX translator limits (plan around these before importing)

From `<dataDir>/translators/BibTeX.js`:

| Input | Zotero itemType |
|---|---|
| `@article` | journalArticle |
| `@book` | book |
| `@incollection` | bookSection |
| `@inproceedings` | conferencePaper |
| `@techreport` | report |
| `@misc` | **document, always** |
| `@online`, `@electronic` | webpage |
| (preprint) | **no mapping exists** |

So arXiv preprints and web pages arrive as `document` no matter how they are written.
Do not re-import hoping for a better result — surface the affected item keys and let the
user change the type, and say plainly that it does not affect author-date citation
correctness.

## What a real audit should report

- N of M DOIs resolved, with the registry used for each.
- Field-level drift between the supplied `.bib` and the registry (year, title case,
  container).
- Items with no DOI and how they were confirmed.
- Item types the translator will get wrong.

The headline finding is often that the references were real all along and only the
in-text markers were fake — say that explicitly, because it changes what the user
believes they need to fix.