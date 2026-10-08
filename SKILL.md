---
name: zotero-citation
description: |
  Drive Zotero programmatically from the shell: verify reference metadata against
  Crossref/DataCite, import verified items into a Zotero collection, and convert a
  Word manuscript's plain-text citations into genuine Zotero field codes
  (ADDIN ZOTERO_ITEM CSL_CITATION / ADDIN ZOTERO_BIBL) under a chosen CSL style.
  Load this skill whenever the user mentions Zotero, 文献引用 / 参考文献 / 引用格式 /
  DOI 核验 / 假引用 / fake citation, "把引用变成 Zotero 域", or asks to audit or repair
  a reference list in a .docx. Do NOT use for merely reading a .docx or PDF, for
  plain-text bibliography formatting with no Zotero involved, or for Word field codes
  unrelated to Zotero citations.
---

# Zotero Citation

## Zotero API ground truth (verified against Zotero 9.0.6)

Getting these wrong costs several wasted turns. Read before planning.

| Fact | Consequence |
|---|---|
| The **local API is read-only**. `POST /api/users/0/collections` → `400 Endpoint does not support method`. | Ticking "允许其他计算机上的应用程序与 Zotero 通信" enables GET **only**. You cannot create collections or items through it. Stop promising the user you can. |
| The only working **write path** is `POST /connector/import` (body = raw file bytes, e.g. `.bib`). | Zotero auto-detects the translator and creates items. Returns `201` with the created items **including their `key`s**. |
| `POST /connector/saveItems` returned **500** in this setup, even with a valid minimal payload. | Don't build the plan on it. If you need item-level control, use `/connector/import` with a hand-built `.bib`. |
| `/connector/import` saves into the collection **currently selected in the Zotero window**. | Collection creation is a **user UI action**. You cannot create it. |
| `POST /connector/getSelectedCollection` → `{libraryID, id, name, targets[]}`. **Needs both** `-H "Content-Type: application/json"` **and** `-d '{}'`. | Without a body you get `400 Content-length not provided`; without the header, `400 Endpoint does not support content-type`. `libraryID` (usually `1`) is what citation URIs need. Poll `targets[]` length to detect a collection the user just created. |
| The **Zotero Word plugin is separate**. The files under `<install>\integration\word-for-windows\` (including `Zotero.dotm`) ship with Zotero but are **not** proof it is installed. | Check `<profile>/extensions.json` — `{"addons":[]}` means not installed. Fields render as plain text and will **never refresh** until the user installs it (Zotero → 工具 → Word 处理器插件). Always tell them. |

Citation URIs are `http://zotero.org/users/local/<libraryID>/items/<itemKey>`.

## Inputs to collect

- Manuscript `.docx` path, and whether to overwrite or write a new file (default to a new file; the user usually wants to diff).
- Target CSL style. Match the manuscript's existing style unless told otherwise — APA 7 for author-date social-science drafts, Nature for numbered geo/physics journals.
- The reference corpus: `.bib`, PDFs, a manuscript reference list, or a mix.

## Procedure

1. **Probe before promising.** Confirm Zotero is running, read `libraryID`, and check whether the Zotero Word plugin exists under `<profile>/extensions` or `extensions.json`. Telling the user "done, it refreshes in Word" before checking the plugin is the single most common way this task is reported falsely.

2. **Verify every reference against a registry before importing anything.** Unverified citations are exactly the failure mode this task exists to remove, so verify first rather than trusting a bundled `.bib`. Use `scripts/verify-dois.js` (Node, UTF-8 safe — see pitfall below). For each entry with a DOI: query `https://api.crossref.org/works/<doi>`, fall back to `https://api.datacite.org/dois/<doi>` for `10.48550` (arXiv) and `10.5281` (Zenodo). Report which resolved and which did not. Entries with no DOI need manual confirmation against a local source file.

3. **Build the item list from registry data, not from the supplied `.bib`.** Registry-authoritative title/authors/container beats a hand-maintained bib that may have drifted. See `references/metadata-verification.md` for the quirks that matter (published-print vs online-first year, uppercased surnames, truncated given names, series packed into `container-title`).

4. **Get the collection created and selected.** Before asking, check whether the target collection already exists and is already populated — a prior run of this same workflow is common, and re-importing silently duplicates every reference. If it exists, surface the reuse-vs-duplicate choice to the user instead of creating a second copy. To create a new one, the user must act in the UI: 右键「我的文库」→ 新建分类 → 命名 → 点一下选中它. Then poll:

   ```powershell
   curl.exe -s -H "Content-Type: application/json" -d '{}' `
     http://127.0.0.1:23119/connector/getSelectedCollection
   ```

   Re-run this immediately before any write and abort if the selection changed — you would otherwise pollute the user's real library.

5. **Emit a `.bib` from the verified item list and POST it** to `/connector/import`. This runs Zotero's own BibTeX translator, so the items are genuine Zotero objects. Content-Type `text/plain; charset=utf-8`, body = the file. Expect `201`; the response array carries each item's `key`.

6. **Map your cite keys → Zotero keys** by DOI first, then exact normalized title, then first-word prefix. Write the map to a JSON file — the docx step consumes it. Log every unmatched entry rather than guessing.

7. **Rewrite the manuscript** per `references/field-formats.md`: replace each in-text citation string with a 5-run field (`begin` / `instrText` / `separate` / display text / `end`), wrap the reference paragraphs in one `ZOTERO_BIBL` field, and write `ZOTERO_PREF` into `word/settings.xml`. Put real URIs in every `citationItems[]` entry — with embedded `itemData` alone the fields render but never link back to the library.

8. **Verify with Word, not just XML.** XML well-formedness does not prove the file opens. Drive `Word.Application` via COM, open the output, and assert: no repair prompt, expected field count, and the rendered `Field.Result.Text` of a few citations. This is the only check that catches package-level damage. Schema details in `references/field-formats.md`.

9. **Report honestly.** State what was verified, what could not be fixed, and what the user must do. Then send the user the follow-up actions — see Output contract.

## Output contract

Deliver:
- the rewritten manuscript as a **new** file (original untouched), plus the verified `.bib`;
- the list of resolved / unresolved DOIs;
- item-type mismatches introduced by the BibTeX translator;
- an explicit list of **user actions still required**: create-and-select the collection (if not done), install the Zotero Word plugin, click 刷新, and any manual metadata fixes.

Never report the task as finished while the Word plugin is missing — the citations will not refresh.

## Failure handling

- **`/connector/import` returns 400** → Zotero found no translator for the payload. Confirm the body is raw BibTeX text, not JSON.
- **`getSaveTarget` picks the wrong collection** → the user changed selection mid-run. Re-check immediately before writing and abort rather than writing into the wrong collection.
- **A citation string is not found in the paragraph** → it is split across `w:t` nodes. Most manuscript runs keep a citation inside one node; confirm with a DOM walk and handle node splitting rather than silently skipping.
- **Non-ASCII characters corrupt** (`≠`, `Bıçakçı`, `Kühn`) → this is a PowerShell encoding bug, not bad source data. Read `references/powershell-traps.md` before writing more script.
- **Some items import as `document` instead of `preprint`/`webpage`** → expected. Zotero's BibTeX translator maps `@misc` → `document` always and has **no** path to `preprint` at all; only `@online`/`@electronic` reach `webpage`. Do not re-import hoping for a different result — tell the user to change the type manually and give them the item keys.
- **`word_validate.ps1` hangs** → a Word dialog is blocking. Run the COM check in the background with `DisplayAlerts = 0` and a timeout.

## Examples

**Input**: "1008 里有新稿子和原文，把这些文献扔给 Zotero 识别正确的引用，覆盖掉稿件里原来的引用字符。"

**Output**: verified 32/32 DOIs resolved; new Zotero collection created and 38 items imported with keys mapped; manuscript rewritten with 28 citation fields + 1 bibliography field + `ZOTERO_PREF` pinning APA 7; Word COM validation passed with no repair prompt. Reported back: plugin not installed → install it, then 刷新; 4 items landed as `document` because the BibTeX translator has no `preprint` mapping; one title needs a manual character fix.

**Input**: "核验一下这个 .bib 里有没有假引用。"

**Output**: registry lookup only — no Zotero import needed. Report resolved vs unresolved DOIs and metadata drift between the `.bib` and the registry.

## Windows (win32) platform notes

Run everything through `curl.exe` rather than `Invoke-RestMethod` for registry calls — `Invoke-RestMethod` to Crossref fails TLS/proxy handshakes on this machine while `curl.exe` returns `200`.

Two encoding traps caused real corruption in a prior run of this workflow and are the most likely source of weird characters in author names or titles. Read `references/powershell-traps.md` before writing any PowerShell that touches non-ASCII content.

Avoid `Remove-Item` in generated scripts; the permission gate blocks it. Use `ZipFile.Open($path,'Update')` + `SetLength(0)` on the existing entry to rewrite a `.docx` part without deleting entries (delete+recreate appends them at the end of the zip).