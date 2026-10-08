#!/usr/bin/env node
// verify-dois.js — resolve every DOI in a BibTeX file against Crossref / DataCite.
//
// Node is used deliberately: its fs and JSON defaults to UTF-8, which sidesteps the
// PowerShell 5.1 ANSI corruption that mangles author names and titles.
//
// Usage:
//   node verify-dois.js <input.bib> [--out <dir>] [--json <file>]
//
// Exits 0 when every DOI resolved, 1 otherwise, so it can gate a pipeline.

const fs = require('fs');
const path = require('path');
const https = require('https');

const args = process.argv.slice(2);
const bibPath = args[0];
if (!bibPath) {
  console.error('usage: node verify-dois.js <input.bib> [--out <dir>] [--json <file>]');
  process.exit(2);
}
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const outDir = flag('--out', path.join(path.dirname(bibPath), 'registry-cache'));
const jsonOut = flag('--json', path.join(path.dirname(bibPath), 'doi-verify.json'));

// ---- minimal BibTeX entry scan (only what is needed: cite key + DOI) ----
function parseBibTeX(text) {
  const entries = [];
  const re = /^@(\w+)\s*\{\s*([^,]+),/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const key = m[2].trim();
    // entry body runs to the first line that is exactly "}"
    const end = text.indexOf('\n}', start);
    const body = text.slice(start, end > -1 ? end : text.length);
    const doi = /\bdoi\s*=\s*\{([^}]+)\}/i.exec(body);
    const title = /\btitle\s*=\s*\{(.+?)\}\s*,?\s*$/im.exec(body);
    entries.push({
      key,
      type: m[1].toLowerCase(),
      doi: doi ? doi[1].trim() : '',
      title: title ? title[1].trim() : '',
    });
  }
  return entries;
}

function get(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'zotero-citation-skill/1.0 (mailto:verify@example.org)',
          Accept: 'application/json',
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
          res.resume();
          return resolve(get(res.headers.location, redirects + 1));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const first = (v) => (Array.isArray(v) ? v[0] : v);
const issuedYear = (m) => {
  const pp = m['published-print'] && m['published-print']['date-parts'];
  if (pp && pp[0] && pp[0][0]) return pp[0][0];
  const iss = m.issued && m.issued['date-parts'];
  return iss && iss[0] && iss[0][0] ? iss[0][0] : '';
};

// Nobiliary particles: never treat the token before one of these as a given name.
const PARTICLES = new Set([
  'van', 'von', 'de', 'der', 'den', 'ter', 'ten', 'da', 'di', 'del',
  'la', 'le', 'du', 'dos', 'das', 'bin', 'al', 'ibn', 'st',
]);

function normFamily(family, given) {
  let fam = family || '';
  let g = given || '';
  // DataCite sometimes packs the whole personal name into `family`
  if (fam.includes(',') && !g) {
    const parts = fam.split(',');
    fam = parts[0].trim();
    g = parts.slice(1).join(',').trim();
  }
  // Crossref sometimes prefixes the surname with a middle initial:
  // family="F. Dormann", given="Carsten"  ->  Dormann / Carsten F.
  let m = fam.match(/^([A-Z]\.)\s+(.+)$/);
  if (m) {
    if (g && !g.includes(m[1])) g = `${g} ${m[1]}`;
    fam = m[2];
  } else if (
    // ...or the inverse: given holds only an initial, family holds a full given name
    /^[A-Z]\.$/.test(g) &&
    (m = fam.match(/^(.+?)\s+(.+)$/)) &&
    !PARTICLES.has(m[1].toLowerCase())
  ) {
    g = `${g} ${m[1]}`;
    fam = m[2];
  }
  if (fam === fam.toUpperCase() && fam.length > 2) fam = fam[0] + fam.slice(1).toLowerCase();
  return { lastName: fam, firstName: g };
}

// Flag creator records that would render wrongly in APA. Worth running over the whole
// list before import — these are silent and cheap to miss.
function creatorDefects(authors) {
  const bad = [];
  for (const a of authors || []) {
    if (!a.lastName) continue;
    if (/^[A-Z]\.\s+\S/.test(a.lastName)) bad.push(`initial-in-surname: ${a.lastName} ${a.firstName}`);
    else if (/^[A-Z]\.$/.test(a.firstName || '') && a.lastName.split(/\s+/).length >= 2) {
      bad.push(`bare-initial-given: ${a.lastName} ${a.firstName}`);
    }
  }
  return bad;
}

async function resolveOne(entry) {
  if (!entry.doi) return { ...entry, status: 'NO_DOI' };
  const url = 'https://api.crossref.org/works/' + encodeURIComponent(entry.doi);
  const cache = path.join(outDir, entry.key + '.crossref.json');
  try {
    if (fs.existsSync(cache)) {
      const m = JSON.parse(fs.readFileSync(cache, 'utf8')).message;
      return shape(entry, m, 'Crossref');
    }
  } catch (_) {
    /* fall through to network */
  }
  let res;
  try {
    res = await get(url);
  } catch (e) {
    res = { status: 0, body: '' };
  }
  if (res.status === 200) {
    try {
      const payload = JSON.parse(res.body);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(cache, res.body, 'utf8');
      return shape(entry, payload.message, 'Crossref');
    } catch (_) {
      return { ...entry, status: 'PARSE_ERROR', source: 'Crossref' };
    }
  }
  // DataCite fallback (arXiv 10.48550, Zenodo 10.5281, ...)
  try {
    const d = await get('https://api.datacite.org/dois/' + encodeURIComponent(entry.doi));
    if (d.status === 200) {
      const a = JSON.parse(d.body).data.attributes;
      const creators = (a.creators || []).map((c) =>
        c.name ? { ...normFamily(c.name, ''), name: c.name } : normFamily(c.familyName, c.givenName)
      );
      return {
        ...entry,
        status: 'OK',
        source: 'DataCite',
        year: a.publicationYear || '',
        title: (a.titles && a.titles[0] && a.titles[0].title) || '',
        container: (a.container && a.container.title) || '',
        authors: creators,
        doi: a.doi,
      };
    }
  } catch (_) {
    /* fall through */
  }
  return { ...entry, status: 'NOT_FOUND' };
}

function shape(entry, m, source) {
  const authors = (m.author || []).map((a) =>
    a.name ? { ...normFamily('', ''), name: a.name } : normFamily(a.family, a.given)
  );
  return {
    ...entry,
    status: 'OK',
    source,
    year: issuedYear(m),
    title: first(m.title) || '',
    container: first(m['container-title']) || '',
    volume: m.volume || '',
    issue: m.issue || '',
    page: m.page || '',
    type: m.type || '',
    authors,
    doi: m.DOI || entry.doi,
  };
}

(async () => {
  if (!fs.existsSync(bibPath)) {
    console.error('not found: ' + bibPath);
    process.exit(2);
  }
  const entries = parseBibTeX(fs.readFileSync(bibPath, 'utf8'));
  console.log(`entries: ${entries.length}  with DOI: ${entries.filter((e) => e.doi).length}`);

  const results = [];
  const defects = [];
  for (const e of entries) {
    const r = await resolveOne(e);
    results.push(r);
    for (const d of creatorDefects(r.authors)) defects.push(`${e.key}: ${d}`);
    const flag = r.status === 'OK' ? 'OK  ' : r.status === 'NO_DOI' ? 'nodoi' : 'MISS';
    const first = r.authors && r.authors[0];
    const who = first ? first.name || `${first.lastName}, ${first.firstName}` : '';
    console.log(
      `${flag} ${e.key.padEnd(22)} ${String(r.year || '').padEnd(6)} ${who.padEnd(30)} ${
        (r.title || '').slice(0, 58)
      }`
    );
    if (e.doi) await new Promise((res) => setTimeout(res, 200)); // be polite to the registry
  }

  fs.writeFileSync(jsonOut, JSON.stringify(results, null, 2), 'utf8');

  const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  console.log('\n--- summary ---');
  for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v}`);
  console.log(`report: ${jsonOut}`);
  const failed = results.filter((r) => r.status === 'NOT_FOUND' || r.status === 'PARSE_ERROR');
  if (failed.length) {
    console.log('\nunresolved:');
    failed.forEach((f) => console.log(`  ${f.key}  ${f.doi}`));
  }
  if (defects.length) {
    console.log('\ncreator defects (would render wrongly in APA) - fix before import:');
    defects.forEach((d) => console.log(`  ${d}`));
  } else {
    console.log('\ncreator defects: none');
  }
  process.exit(failed.length ? 1 : 0);
})();