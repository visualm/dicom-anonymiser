// Per-file processing pipeline, settings/preset storage and the CSV key file.
(function () {
  'use strict';
  const DA = (window.DA = window.DA || {});
  const D = () => DA.dicom;

  // ---------- processing ----------
  // Produces the anonymised bytes for one file and verifies them by re-reading.
  // cfg: {rules, options, pseudonym, presetName}; ctx: {uidMap, valueMap}; boxesByFrame: Map
  async function processFile(blob, cfg, ctx, boxesByFrame) {
    const buf = await blob.arrayBuffer();
    const parsed = await D().parse(buf);
    const charset = parsed.charset;
    const needles = DA.anon.identifiers(parsed.ds, charset);
    let ts = parsed.ds.get(D().TAG.PixelData) && parsed.ds.get(D().TAG.PixelData).frags ? parsed.ts : D().TS.EXPLICIT;
    const redacted = boxesByFrame && boxesByFrame.size > 0;
    if (redacted) {
      ts = await DA.pixels.redact(parsed, boxesByFrame);
      D().setString(parsed.ds, 0x00280301, 'CS', 'NO', ''); // Burned In Annotation
    }
    DA.anon.anonymise(parsed.ds, cfg, { uidMap: ctx.uidMap, valueMap: ctx.valueMap, stackUID: ctx.stackUID, charset });
    const sopClass = D().getString(parsed.ds, 0x00080016, '') || D().getString(parsed.meta, 0x00020002, '');
    let sopInst = D().getString(parsed.ds, 0x00080018, '');
    if (!sopInst) sopInst = DA.anon.newUID();
    const bytes = D().write(parsed.ds, ts, sopClass, sopInst);

    // Verify: the output must parse, and must not contain the original identifiers.
    const check = await D().parse(bytes);
    const leaks = DA.anon.findLeaks(check.ds, check.charset, needles);
    if (!cfg.options.removePrivate) {
      for (let i = leaks.length - 1; i >= 0; i--) if (leaks[i].match === 'private tag present') leaks.splice(i, 1);
    }
    return { bytes, leaks, ts, redacted, output: check };
  }

  // ---------- settings & presets (browser storage) ----------
  const KEY = 'dicomAnonymiser.v1';
  let mem = null;
  function defaults() {
    return { presets: {}, modalityPreset: {}, counter: 0, prefix: 'ANON-', digits: 4 };
  }
  function load() {
    if (mem) return mem;
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
    mem = Object.assign(defaults(), s || {});
    return mem;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(mem)); return true; } catch (e) { return false; }
  }
  function builtinPreset() {
    return { name: DA.profile.NAME, builtin: true, rules: JSON.parse(JSON.stringify(DA.profile.defaults)), options: Object.assign({}, DA.profile.options) };
  }
  function presetNames() {
    return [DA.profile.NAME, ...Object.keys(load().presets).sort()];
  }
  function getPreset(name) {
    if (!name || name === DA.profile.NAME) return builtinPreset();
    const p = load().presets[name];
    return p ? JSON.parse(JSON.stringify(p)) : builtinPreset();
  }
  function putPreset(p) {
    if (p.name === DA.profile.NAME) throw new Error('The built-in preset cannot be overwritten. Use "Save as new".');
    load().presets[p.name] = { name: p.name, rules: p.rules, options: p.options, saved: new Date().toISOString() };
    save();
  }
  function deletePreset(name) {
    const s = load();
    delete s.presets[name];
    for (const m of Object.keys(s.modalityPreset)) if (s.modalityPreset[m] === name) delete s.modalityPreset[m];
    save();
  }
  function presetForModality(mod) {
    const n = load().modalityPreset[mod];
    return n && (n === DA.profile.NAME || load().presets[n]) ? n : DA.profile.NAME;
  }
  function rememberModality(mods, name) {
    const s = load();
    for (const m of mods) s.modalityPreset[m] = name;
    save();
  }
  function exportSettings() {
    const s = load();
    return JSON.stringify({ app: 'DICOM Anonymiser', version: 1, exported: new Date().toISOString(),
      presets: s.presets, modalityPreset: s.modalityPreset, counter: s.counter, prefix: s.prefix, digits: s.digits }, null, 2);
  }
  // conflict(name) -> 'replace' | 'keep' (keep both, renamed) | 'skip'
  function importSettings(json, conflict) {
    const data = JSON.parse(json);
    if (!data || data.app !== 'DICOM Anonymiser' || typeof data.presets !== 'object') throw new Error('Not a DICOM Anonymiser settings file');
    const s = load();
    let added = 0;
    for (const [name, p] of Object.entries(data.presets)) {
      let target = name;
      if (s.presets[name]) {
        const c = conflict(name);
        if (c === 'skip') continue;
        if (c === 'keep') { let i = 2; while (s.presets[name + ' (' + i + ')']) i++; target = name + ' (' + i + ')'; }
      }
      s.presets[target] = Object.assign({}, p, { name: target });
      added++;
    }
    for (const [m, n] of Object.entries(data.modalityPreset || {})) if (!s.modalityPreset[m]) s.modalityPreset[m] = n;
    s.counter = Math.max(s.counter || 0, data.counter || 0);
    if (data.prefix && !Object.keys(s.presets).length) s.prefix = data.prefix;
    save();
    return { added, counter: s.counter };
  }

  // ---------- pseudonyms ----------
  function formatPseudonym(n) {
    const s = load();
    return s.prefix + String(n).padStart(s.digits, '0');
  }
  function pseudonymNumber(p) {
    const s = load();
    const esc = s.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp('^' + esc + '(\\d+)$').exec(p || '');
    return m ? parseInt(m[1], 10) : 0;
  }

  // ---------- CSV key file ----------
  const KEY_COLUMNS = ['anonymised_at', 'pseudonym', 'original_patient_id', 'original_patient_name', 'original_birth_date',
    'original_study_date', 'original_accession_number', 'original_study_uid', 'new_study_uid', 'modalities', 'files', 'output_mode'];

  function csvParse(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/)[0] || '';
    const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
      } else if (c === '"') q = true;
      else if (c === sep) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some((x) => x !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((x) => x !== '')) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim());
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
  }
  function csvLine(values) {
    return values.map((v) => {
      v = String(v == null ? '' : v);
      return /[;",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(';') + '\r\n';
  }

  class KeyFile {
    constructor(handle) { this.handle = handle; this.rows = []; }
    async open() {
      const f = await this.handle.getFile();
      this.rows = f.size ? csvParse(await f.text()) : [];
      return this;
    }
    maxNumber() {
      return this.rows.reduce((m, r) => Math.max(m, pseudonymNumber(r.pseudonym)), 0);
    }
    pseudonymFor(patientKey) {
      const r = this.rows.find((x) => x.original_patient_id && x.original_patient_id === patientKey);
      return r ? r.pseudonym : null;
    }
    async append(record) {
      const f = await this.handle.getFile();
      const w = await this.handle.createWritable({ keepExistingData: true });
      try {
        let text = '';
        if (!f.size) text += '﻿' + csvLine(KEY_COLUMNS);
        text += csvLine(KEY_COLUMNS.map((c) => record[c]));
        await w.seek(f.size);
        await w.write(text);
      } finally {
        await w.close();
      }
      this.rows.push(record);
    }
  }

  DA.engine = {
    processFile,
    store: { load, save, getPreset, putPreset, deletePreset, presetNames, presetForModality, rememberModality,
      exportSettings, importSettings, builtinPreset },
    formatPseudonym, pseudonymNumber, KeyFile, csvParse,
  };
})();
