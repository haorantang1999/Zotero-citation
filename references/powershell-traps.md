# PowerShell 5.1 traps that corrupted Zotero reference data

Every item here caused a real defect during a Zotero import run. On Chinese Windows the
system ANSI code page is GBK, and PowerShell 5.1 silently mis-decodes UTF-8 — producing
plausible-looking but wrong author names and titles that only surface on inspection.

**Node.js is the reliable escape hatch.** It defaults to UTF-8 for `fs` and `JSON.parse`,
so for anything non-ASCII prefer a `.js` script (`scripts/verify-dois.js`) over `.ps1`.

## 1. BOM-less `.ps1` files are read as ANSI

A `.ps1` written without a UTF-8 BOM is decoded with the ANSI code page. A literal
`≠` in the source became `鈮?`, and `Bıçakçı` became `B谋莽ak莽谋` — then those broken
strings were written back into the `.bib` and imported into Zotero.

Fix: never put non-ASCII in a `.ps1` literal. Build from code points:

```powershell
$neqChar = [char]0x2260              # ≠
$bicakci = 'B' + [char]0x0131 + [char]0x00E7 + 'ak' + [char]0x00E7 + [char]0x0131
$outName = $base + '_Zotero' + [char]0x5F15 + [char]0x7528 + [char]0x7248   # 引用版
```

This also applies to **paths** — a Chinese filename literal in a script will not
resolve. Resolve the path from disk instead:

```powershell
$srcDocx = (Get-ChildItem $dir -Filter '*.docx' |
            Where-Object { $_.Name -notlike '*_Zotero*' } | Select-Object -First 1).FullName
```

## 2. `Get-Content` without `-Encoding UTF8` mangles UTF-8 JSON

Reading Crossref/DataCite responses this way corrupted author names *before* they ever
reached the item builder, so re-running the pipeline reproduced the damage.

Fix — explicit .NET read:

```powershell
$m = ([System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json).message
```

Conversely, `Out-File -Encoding UTF8` and `Set-Content -Encoding UTF8` write a **BOM**.
Use `(New-Object System.Text.UTF8Encoding($false))` when producing files that get
re-parsed by other tools:

```powershell
[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
```

`curl.exe -o file` writes raw bytes and sidesteps the whole problem for JSON payloads.

## 3. `Invoke-RestMethod` fails where `curl.exe` succeeds

`Invoke-RestMethod https://api.crossref.org/works/...` failed on every DOI, which
looked exactly like "these references are fake". `curl.exe` returned `200` for the same
URLs. A false "all references are fabricated" conclusion is the worst outcome this trap
can produce — always confirm with a second client before reporting DOIs as missing.

```powershell
curl.exe -s -w "`nHTTP:%{http_code}`n" --max-time 25 -A "tool/1.0 (mailto:x@y.z)" `
  "https://api.crossref.org/works/<escaped-doi>" -o $tmp
```

## 4. Diagnosing "character is wrong" by reading it back

Console output of a non-ASCII string looked corrupted (`鈮?`) even when the in-memory
value was fine — and later looked fine when the stored value was genuinely wrong. Print
code points instead of the rendered string:

```powershell
($title.ToCharArray() | Select-Object -First 16 | ForEach-Object { "{0}:{1}" -f $_, [int]$_ }) -join '  '
```

`[int]` of each char is the ground truth; console glyphs are not.

## 5. `Remove-Item` is blocked by the permission gate

Scripts that clean up temp files fail with "can irreversibly destroy files". Write temp
files into the working directory and leave them, or use the recoverable trash flow.

## 6. Regex over XML merges adjacent fields

Validating `ADDIN ZOTERO_ITEM CSL_CITATION (\{.*\})` with a greedy quantifier swallowed
all 28 fields into one match and reported "1 field, JSON parse failure". Parse
`//w:instrText` through an XML DOM and filter with `-match`, not `-like 'ADDIN …*'` —
`instrText` has a **leading space**, so `-like 'ADDIN*'` silently matches nothing and
looks like "0 fields found" rather than an error.