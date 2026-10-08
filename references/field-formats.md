# Zotero Word field-code formats

Verified against Zotero 9.0.6 by reading its own `integration.js`
(`<install>/app/omni.ja` → `chrome/content/zotero/xpcom/integration.js`).

## The three field codes

Zotero builds each field code from `Zotero.Integration.Field.setCode()`:

```
citation       →  ADDIN ZOTERO_ITEM CSL_CITATION {json}
bibliography   →  ADDIN ZOTERO_BIBL {json} CSL_BIBLIOGRAPHY
```

Note the asymmetry: the citation form has **no** trailing token, the bibliography
form ends with ` CSL_BIBLIOGRAPHY`. Parsing only ever slices from the first `{` to the
last `}`, so a trailing token is tolerated — but match Zotero exactly.

## Citation field JSON (CSL-CITATION)

```json
{
  "citationID": "mrg1",
  "properties": {
    "formattedCitation": "(Biljecki & Ito, 2021; Fotheringham et al., 2002)",
    "plainCitation": "(Biljecki & Ito, 2021; Fotheringham et al., 2002)",
    "noteIndex": 0
  },
  "citationItems": [
    {
      "id": 1,
      "uris": ["http://zotero.org/users/local/1/items/UEJZJPKH"],
      "itemData": { "type": "article-journal", "title": "...", "author": [ ... ], "issued": {"date-parts":[[2021]]} }
    }
  ],
  "schema": "https://github.com/citation-style-language/schema/raw/master/csl-citation.json"
}
```

- `citationID` must be unique per citation.
- `itemData` is **CSL JSON**, not Zotero item JSON. Omitting `uris` is legal —
  Zotero falls back to `itemData` — but the field then never links to the library.
- `properties.formattedCitation` is the text Word shows until the first refresh, so
  set it to the manuscript's existing string to keep the document stable on open.
- Optional per-item keys Zotero understands: `prefix`, `suffix`, `locator`,
  `label`, `suppress-author`.

`prefix` is the clean way to absorb prose that sits inside the parentheses. For
`(EULUC-China; Gong et al., 2020)` put `"prefix": "EULUC-China; "` on the single
citation item instead of nesting a second pair of parens.

## Bibliography field JSON

```json
{"uncited": [], "omitted": [], "custom": []}
```

The CSL style is **not** stored here — it lives in the document preferences below.

## Document preferences (`ZOTERO_PREF`)

Stored as a Word document variable, i.e. in `word/settings.xml`:

```xml
<w:docVars>
  <w:docVar w:name="ZOTERO_PREF"
            w:val="{&quot;style&quot;:{...},&quot;prefs&quot;:{...},&quot;sessionID&quot;:null,&quot;zoteroVersion&quot;:&quot;9.0.6&quot;,&quot;dataVersion&quot;:4}"/>
</w:docVars>
```

```json
{
  "style": { "styleID": "ba829554", "locale": "en-US",
             "hasBibliography": true, "bibliographyStyleHasBeenSet": true },
  "prefs": { "fieldType": "Field", "noteType": 0, "automaticJournalAbbreviations": false },
  "sessionID": null, "zoteroVersion": "9.0.6", "dataVersion": 4
}
```

- `fieldType` is `Field` for Word (`ReferenceMark` only for legacy converted docs).
- **`styleID` is the first 8 hex chars of the SHA-256 of the installed `.csl` file
  bytes**, e.g. `<dataDir>/styles/apa.csl` → `ba829554`. Verify it per machine; a
  wrong value degrades to Zotero prompting for a style rather than erroring.
- Placement in `word/settings.xml` is schema-ordered: insert **between `<w:compat>`
  and `<w:rsids>`**. Elsewhere Word may report the file as corrupt.

## Run sequence for one citation

Replace the citation text inside its parent run with five runs, preserving the
original run's `<w:rPr>` on each so formatting survives:

```xml
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> ADDIN ZOTERO_ITEM CSL_CITATION {…} </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t xml:space="preserve">(Author, 2020)</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
```

Text before and after the match inside the same `<w:t>` become separate runs either
side of the field.

For the bibliography: prepend `begin` / `instrText` / `separate` to the **first**
reference paragraph and append `end` to the **last** — one field spanning all of them.

## Finding the citation text

Walk the paragraph's `w:t` nodes building a concatenated string plus per-node
`(start, end)` offsets, then `IndexOf` the exact citation string. If one node fully
contains the match, the surgery above applies directly. If the match spans nodes you
must split the boundary nodes first — do not silently skip.

When matching text containing diacritics, build the search string from code points
rather than embedding it as a source literal (see `powershell-traps.md`).

## Zotero itemType → CSL type

| Zotero | CSL |
|---|---|
| journalArticle | article-journal |
| conferencePaper | paper-conference |
| book | book |
| bookSection | chapter |
| preprint | article |
| webpage | webpage |
| report | report |

## Validation via Word COM

```powershell
$word = New-Object -ComObject Word.Application
$word.Visible = $false; $word.DisplayAlerts = 0
$doc = $word.Documents.Open($path, $false, $true, $false)
$doc.Fields.Count                       # expect 1 + citation count
$doc.Fields.Item($i).Code.Text          # match 'ZOTERO' to count Zotero fields
$doc.Fields.Item($i).Result.Text        # rendered display text
$doc.Close($false); $word.Quit()
```

Run it in the background with a timeout — a modal Word dialog will otherwise hang the
shell. Opening successfully with the expected field count is the real proof the
package is intact; XML well-formedness alone does not prove it.

## Repackaging a .docx

```powershell
$zip = [System.IO.Compression.ZipFile]::Open($out, 'Update')
$e = $zip.GetEntry('word/document.xml'); $st = $e.Open(); $st.SetLength(0)
$w = New-Object System.IO.StreamWriter($st, (New-Object System.Text.UTF8Encoding($false)))
$w.Write($xml); $w.Flush(); $w.Dispose(); $st.Dispose(); $zip.Dispose()
```

Overwrite in place to preserve zip entry order. `Copy-Item` the original first so the
build stays idempotent, and when globbing the source `.docx` exclude any previous
output (`-notlike '*_Zotero*'`) or you will read your own output as the source.