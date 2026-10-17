// User interface and workflow: load folder -> pick study -> tags -> images -> review & save.
(function () {
  'use strict';
  const DA = window.DA;
  const D = DA.dicom;
  const P = DA.pixels;
  const E = DA.engine;
  const store = E.store;

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const pad = (n, w) => String(n).padStart(w, '0');
  const main = $('#main');
  const FS_OK = typeof window.showDirectoryPicker === 'function';

  function fmtDate(da) {
    return /^\d{8}$/.test(da) ? da.slice(0, 4) + '-' + da.slice(4, 6) + '-' + da.slice(6) : da || '';
  }
  function fmtName(pn) {
    return (pn || '').split('=')[0].replace(/\^+/g, ', ').replace(/, $/, '');
  }
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, bad ? 7000 : 3500);
  }
  function modal(title, bodyHtml, buttons) {
    return new Promise((resolve) => {
      const m = $('#modal');
      const box = $('#modalBox');
      box.innerHTML = '<h2>' + esc(title) + '</h2><div class="mbody">' + bodyHtml + '</div><div class="actions"></div>';
      const actions = $('.actions', box);
      for (const b of buttons) {
        const el = document.createElement('button');
        el.textContent = b.label;
        if (b.cls) el.className = b.cls;
        el.onclick = () => {
          const input = $('input', box);
          m.hidden = true;
          resolve(b.value === '__input__' ? (input ? input.value : '') : b.value);
        };
        actions.appendChild(el);
      }
      m.hidden = false;
      const input = $('input', box);
      if (input) { input.focus(); input.select(); input.onkeydown = (e) => { if (e.key === 'Enter') actions.lastChild.click(); }; }
    });
  }
  const confirmBox = (title, body, ok, danger) =>
    modal(title, body, [{ label: 'Cancel', value: false }, { label: ok || 'OK', value: true, cls: danger ? 'danger' : 'primary' }]);
  const promptBox = (title, label, def) =>
    modal(title, '<p>' + esc(label) + '</p><input type="text" style="width:100%" value="' + esc(def || '') + '">',
      [{ label: 'Cancel', value: null }, { label: 'OK', value: '__input__', cls: 'primary' }]);

  function setSteps(active) {
    const names = ['Load', 'Studies', '1 · Tags', '2 · Images', '3 · Review & save'];
    $('#steps').innerHTML = names.map((n, i) =>
      '<span class="' + (i === active ? 'active' : i < active ? 'done' : '') + '">' + n + '</span>').join('');
  }
  function updateKeyStatus() {
    const k = $('#keyStatus');
    if (S.key) { k.className = 'pill ok'; k.textContent = 'Key file: ' + S.key.handle.name + ' (' + S.key.rows.length + ' entries)'; }
    else { k.className = 'pill warn'; k.textContent = 'No key file'; }
  }
  async function pool(items, n, fn) {
    let i = 0;
    const workers = Array.from({ length: n }, async () => {
      while (i < items.length) { const k = i++; await fn(items[k], k); }
    });
    await Promise.all(workers);
  }
  function downloadText(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: type || 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function pickFileText(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = accept;
      inp.onchange = async () => resolve(inp.files[0] ? await inp.files[0].text() : null);
      inp.click();
    });
  }

  // ---------------------------------------------------------------- state
  const S = {
    root: null,
    files: [],
    dicomdirs: [],
    skipped: [],
    studies: [],
    key: null,
    outDir: null,
    session: { uidMap: new Map(), valueMaps: new Map(), patientPseudo: new Map() },
    cur: null,
  };
  window.DA.state = S; // for debugging / testing

  // ---------------------------------------------------------------- start screen
  function renderStart() {
    setSteps(0);
    main.className = '';
    const st = store.load();
    const names = store.presetNames();
    const modMap = st.modalityPreset;
    main.innerHTML = `
      <div style="max-width:1100px;margin:0 auto">
      ${FS_OK ? '' : '<div class="note bad"><b>This browser cannot read and write folders.</b> Please open this app in Microsoft Edge or Google Chrome.</div>'}
      <div class="dropzone card" id="drop">
        <div class="big">Open a DICOM folder</div>
        <p class="muted">For example a Philips PACS export or a patient CD (the folder that contains the DICOMDIR).<br>
        All subfolders are read. Files without extension are fine. Nothing leaves this computer.</p>
        <button class="primary" id="openBtn" ${FS_OK ? '' : 'disabled'}>Choose folder…</button>
        <p class="small muted" style="margin-top:10px">…or drag a folder onto this box.</p>
        ${S.studies.length ? '<p><button id="backList">Back to the ' + S.studies.length + ' loaded studies</button></p>' : ''}
      </div>
      <div class="grid2" style="margin-top:16px">
        <div class="card">
          <h2>Key file (re-identification list)</h2>
          <p class="small muted">A CSV file (semicolon-separated, opens in Excel) that links each pseudonym to the original
          patient ID. Keep it in a secure place, <b>separate from the anonymised data</b>. It is also used to continue the
          numbering and to reuse the same pseudonym for a patient seen before.</p>
          <p>${S.key ? '<span class="badge ok">In use</span> <b>' + esc(S.key.handle.name) + '</b> · ' + S.key.rows.length + ' entries'
            : '<span class="badge warn">None selected</span> Pseudonyms will not be traceable.'}</p>
          <div class="row">
            <button id="keyNew" ${FS_OK ? '' : 'disabled'}>Create new key file…</button>
            <button id="keyOpen" ${FS_OK ? '' : 'disabled'}>Open existing key file…</button>
            ${S.key ? '<button id="keyClose" class="ghost">Stop using</button>' : ''}
          </div>
        </div>
        <div class="card">
          <h2>Pseudonyms</h2>
          <div class="row" style="margin-bottom:8px">
            <label>Prefix <input type="text" id="pfx" value="${esc(st.prefix)}" style="width:110px"></label>
            <label>Digits <input type="number" id="digits" min="1" max="10" value="${st.digits}" style="width:60px"></label>
            <label>Next number <input type="number" id="nextNo" min="1" value="${nextNumber()}"></label>
          </div>
          <p class="small muted">Next new patient: <b id="nextPs">${esc(E.formatPseudonym(nextNumber()))}</b>.
          The counter is stored in this browser and in exported settings; the app also continues after the highest number in the key file.</p>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="row"><h2 style="margin:0">Presets</h2><span class="spacer"></span>
          <button id="exportBtn">Export settings…</button><button id="importBtn">Import settings…</button></div>
        <p class="small muted" style="margin-top:8px">Presets store your tag choices. The last preset used for a modality is pre-selected
        for the next study of that modality. Export them to a file to move them to another computer.</p>
        <table><thead><tr><th>Preset</th><th>Default for</th><th>Saved</th><th></th></tr></thead><tbody>
        ${names.map((n) => {
          const p = n === DA.profile.NAME ? null : st.presets[n];
          const mods = Object.keys(modMap).filter((m) => modMap[m] === n);
          return '<tr><td>' + esc(n) + (p ? '' : ' <span class="badge">built-in</span>') + '</td><td>' +
            mods.map((m) => '<span class="badge blue">' + esc(m) + '</span>').join('') + '</td><td class="small muted">' +
            (p && p.saved ? esc(p.saved.slice(0, 16).replace('T', ' ')) : '') + '</td><td>' +
            (p ? '<button class="small" data-del="' + esc(n) + '">Delete</button>' : '') + '</td></tr>';
        }).join('')}
        </tbody></table>
      </div>
      <p class="small muted" style="margin-top:16px">DICOM Anonymiser runs entirely in this browser. Default tag rules follow the
      DICOM PS3.15 Basic Application Level Confidentiality Profile. Always check the result before sharing data.</p>
      </div>`;

    $('#openBtn').onclick = async () => {
      try { await openFolder(await window.showDirectoryPicker({ id: 'dicomIn', mode: 'read' })); }
      catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    };
    if ($('#backList')) $('#backList').onclick = renderStudies;
    const drop = $('#drop');
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = async (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const item = [...e.dataTransfer.items].find((i) => i.kind === 'file');
      if (!item || !item.getAsFileSystemHandle) return toast('Please use the "Choose folder" button.', true);
      const h = await item.getAsFileSystemHandle();
      if (h.kind !== 'directory') return toast('Please drop a folder, not a single file.', true);
      openFolder(h);
    };
    $('#keyNew').onclick = async () => {
      try {
        const h = await window.showSaveFilePicker({ id: 'dicomKey', suggestedName: 'anonymisation_key.csv',
          types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] });
        await useKey(h);
      } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    };
    $('#keyOpen').onclick = async () => {
      try {
        const [h] = await window.showOpenFilePicker({ id: 'dicomKey', types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] });
        if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return toast('Write permission is needed to add entries to the key file.', true);
        await useKey(h);
      } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    };
    if ($('#keyClose')) $('#keyClose').onclick = () => { S.key = null; updateKeyStatus(); renderStart(); };
    const saveNum = () => {
      const s = store.load();
      s.prefix = $('#pfx').value || 'ANON-';
      s.digits = Math.max(1, Math.min(10, parseInt($('#digits').value, 10) || 4));
      const n = parseInt($('#nextNo').value, 10);
      if (n >= 1) s.counter = n - 1;
      store.save();
      $('#nextPs').textContent = E.formatPseudonym(nextNumber());
    };
    $('#pfx').onchange = saveNum;
    $('#digits').onchange = saveNum;
    $('#nextNo').onchange = saveNum;
    $('#exportBtn').onclick = () => downloadText('dicom-anonymiser-settings.json', store.exportSettings());
    $('#importBtn').onclick = async () => {
      const text = await pickFileText('.json,application/json');
      if (!text) return;
      try {
        const decisions = {};
        const data = JSON.parse(text);
        for (const n of Object.keys(data.presets || {})) {
          if (store.load().presets[n]) {
            decisions[n] = await modal('Preset "' + n + '" already exists', '<p>What should happen with the imported preset?</p>',
              [{ label: 'Skip', value: 'skip' }, { label: 'Keep both', value: 'keep' }, { label: 'Replace', value: 'replace', cls: 'primary' }]);
          }
        }
        const r = store.importSettings(text, (n) => decisions[n] || 'keep');
        toast('Imported ' + r.added + ' preset(s).');
        renderStart();
      } catch (e) { toast('Import failed: ' + e.message, true); }
    };
    $$('[data-del]').forEach((b) => {
      b.onclick = async () => {
        if (await confirmBox('Delete preset', '<p>Delete preset <b>' + esc(b.dataset.del) + '</b>?</p>', 'Delete', true)) {
          store.deletePreset(b.dataset.del);
          renderStart();
        }
      };
    });
  }

  async function useKey(handle) {
    S.key = await new E.KeyFile(handle).open();
    updateKeyStatus();
    toast('Key file ready: ' + S.key.rows.length + ' existing entries.');
    if (S.cur && S.cur.screen === 'review') renderReview(); else renderStart();
  }

  function nextNumber() {
    let n = store.load().counter || 0;
    if (S.key) n = Math.max(n, S.key.maxNumber());
    for (const p of S.session.patientPseudo.values()) n = Math.max(n, E.pseudonymNumber(p));
    return n + 1;
  }

  // ---------------------------------------------------------------- scanning
  async function walk(dir, path, out) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') await walk(h, path + name + '/', out);
      else out.push({ handle: h, parent: dir, name, path: path + name });
    }
  }

  async function openFolder(handle) {
    S.root = handle;
    S.files = []; S.dicomdirs = []; S.skipped = []; S.studies = [];
    setSteps(0);
    main.className = '';
    main.innerHTML = `<div class="card" style="max-width:700px;margin:40px auto">
      <h2>Reading “${esc(handle.name)}”…</h2><div class="progress"><div id="bar"></div></div>
      <p class="muted" id="scanMsg">Listing files…</p></div>`;
    const entries = [];
    try { await walk(handle, '', entries); } catch (e) { toast('Could not read folder: ' + e.message, true); return renderStart(); }
    let done = 0;
    let id = 0;
    await pool(entries, 6, async (en) => {
      try {
        if (/^dicomdir$/i.test(en.name)) { S.dicomdirs.push(en); return; }
        const file = await en.handle.getFile();
        if (file.size < 16) { S.skipped.push(en.path); return; }
        const head = await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer();
        if (!D.sniff(new Uint8Array(head))) { S.skipped.push(en.path); return; }
        let parsed;
        const opts = { skipPixelData: true, copyValues: true };
        try { parsed = await D.parse(head, opts); } catch (e) { parsed = null; }
        if ((!parsed || !parsed.ds.has(D.TAG.PixelData)) && file.size > head.byteLength) {
          parsed = await D.parse(await file.arrayBuffer(), opts);
        }
        if (!parsed) throw new Error('unreadable');
        const ds = parsed.ds;
        const cls = D.getString(parsed.meta, 0x00020002, '') || D.getString(ds, 0x00080016, '');
        if (cls === '1.2.840.10008.1.3.10') { S.dicomdirs.push(en); return; }
        const inf = P.info(ds);
        S.files.push({
          id: ++id, handle: en.handle, parent: en.parent, name: en.name, path: en.path, size: file.size,
          ds, charset: parsed.charset, ts: parsed.ts,
          studyUID: D.getString(ds, 0x0020000d, '') || 'unknown-study',
          seriesUID: D.getString(ds, 0x0020000e, '') || 'unknown-series',
          inst: D.getNumber(ds, 0x00200013, 0),
          modality: D.getString(ds, 0x00080060, '') || '?',
          rows: inf.rows, cols: inf.cols, frames: inf.hasPixels ? inf.frames : 0, hasPixels: inf.hasPixels,
        });
      } catch (e) {
        S.skipped.push(en.path);
      } finally {
        done++;
        if (done % 10 === 0 || done === entries.length) {
          $('#bar').style.width = (100 * done / entries.length) + '%';
          $('#scanMsg').textContent = done + ' of ' + entries.length + ' files read, ' + S.files.length + ' DICOM images found';
        }
      }
    });
    groupStudies();
    if (!S.studies.length) {
      toast('No DICOM files found in this folder.', true);
      return renderStart();
    }
    renderStudies();
  }

  function groupStudies() {
    const map = new Map();
    for (const f of S.files) {
      let st = map.get(f.studyUID);
      if (!st) {
        const g = (t) => D.getString(f.ds, t, f.charset);
        st = {
          uid: f.studyUID, files: [], series: new Map(), status: 'pending',
          patientName: g(0x00100010), patientId: g(0x00100020), birth: g(0x00100030), date: g(0x00080020),
          desc: g(0x00081030), accession: g(0x00080050),
        };
        map.set(f.studyUID, st);
      }
      st.files.push(f);
      let se = st.series.get(f.seriesUID);
      if (!se) {
        se = {
          uid: f.seriesUID, files: [], number: D.getNumber(f.ds, 0x00200011, 0), modality: f.modality,
          desc: D.getString(f.ds, 0x0008103e, f.charset), risk: P.riskReasons(f.ds), ts: f.ts,
        };
        st.series.set(f.seriesUID, se);
      }
      se.files.push(f);
      for (const r of P.riskReasons(f.ds)) if (!se.risk.includes(r)) se.risk.push(r);
    }
    for (const st of map.values()) {
      for (const se of st.series.values()) {
        se.files.sort((a, b) => a.inst - b.inst || a.path.localeCompare(b.path));
        se.images = [];
        for (const f of se.files) for (let k = 0; k < f.frames; k++) se.images.push({ file: f, frame: k });
      }
      st.seriesList = [...st.series.values()].sort((a, b) => a.number - b.number);
      st.modalities = [...new Set(st.files.map((f) => f.modality))];
    }
    S.studies = [...map.values()].sort((a, b) => (a.patientName + a.date).localeCompare(b.patientName + b.date));
  }

  // ---------------------------------------------------------------- study list
  function renderStudies() {
    setSteps(1);
    S.cur = null;
    main.className = '';
    const pending = S.studies.filter((s) => s.status === 'pending').length;
    main.innerHTML = `<div style="max-width:1300px;margin:0 auto">
      <div class="row" style="margin-bottom:12px"><h1 style="margin:0">Studies in “${esc(S.root ? S.root.name : '')}”</h1>
        <span class="spacer"></span><button id="otherFolder">Open another folder…</button>
        <button class="primary" id="nextPending" ${pending ? '' : 'disabled'}>Start next pending study</button></div>
      <div class="card" style="padding:0">
      <table><thead><tr><th>Patient</th><th>Patient ID</th><th>Born</th><th>Study date</th><th>Description</th>
        <th>Modality</th><th>Series</th><th>Files</th><th>Status</th><th></th></tr></thead><tbody>
      ${S.studies.map((st, i) => `<tr>
        <td>${esc(fmtName(st.patientName))}</td><td class="mono">${esc(st.patientId)}</td><td>${esc(fmtDate(st.birth))}</td>
        <td>${esc(fmtDate(st.date))}</td><td>${esc(st.desc)}</td>
        <td>${st.modalities.map((m) => '<span class="badge blue">' + esc(m) + '</span>').join('')}</td>
        <td>${st.series.size}</td><td>${st.files.length}</td>
        <td>${st.status === 'done' ? '<span class="badge ok">Done → ' + esc(st.pseudonym) + '</span>'
          : st.status === 'skipped' ? '<span class="badge">Skipped</span>' : '<span class="badge warn">Pending</span>'}</td>
        <td class="row"><button class="small primary" data-open="${i}">${st.status === 'done' ? 'Again' : 'Anonymise'}</button>
          ${st.status === 'pending' ? '<button class="small" data-skip="' + i + '">Skip</button>' : ''}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="small muted" style="margin-top:10px">${S.files.length} DICOM files in ${S.studies.length} studies.
      ${S.dicomdirs.length ? S.dicomdirs.length + ' DICOMDIR file(s) found (never copied, because they contain patient names). ' : ''}
      ${S.skipped.length ? S.skipped.length + ' other file(s) ignored (not DICOM).' : ''}</p></div>`;
    $('#otherFolder').onclick = renderStart;
    $('#nextPending').onclick = () => openStudy(S.studies.find((s) => s.status === 'pending'));
    $$('[data-open]').forEach((b) => { b.onclick = () => openStudy(S.studies[+b.dataset.open]); });
    $$('[data-skip]').forEach((b) => { b.onclick = () => { S.studies[+b.dataset.skip].status = 'skipped'; renderStudies(); }; });
  }

  // ---------------------------------------------------------------- open study
  function patientKey(st) {
    return st.patientId || (st.patientName + '|' + st.birth);
  }
  function primaryModality(st) {
    const counts = {};
    for (const f of st.files) if (f.hasPixels) counts[f.modality] = (counts[f.modality] || 0) + 1;
    const list = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return list.length ? list[0][0] : st.modalities[0];
  }

  function openStudy(st) {
    if (!st) return;
    const mod = primaryModality(st);
    const presetName = store.presetForModality(mod);
    const preset = store.getPreset(presetName);
    const pk = patientKey(st);
    let pseudonym = S.session.patientPseudo.get(pk) || (S.key && S.key.pseudonymFor(st.patientId));
    const reused = !!pseudonym;
    if (!pseudonym) pseudonym = E.formatPseudonym(nextNumber());
    S.cur = {
      study: st, mod, presetName, rules: preset.rules, options: preset.options, dirty: false, pseudonym, reused,
      boxes: [], reviewed: new Set(), win: new Map(), active: null, index: 0, scope: 'image', fill: store.load().boxFill || 'black',
      filter: 'all', search: '', showPrivate: false, outMode: 'copy', verify: null, screen: 'tags',
    };
    // Position of each image in the study (series order, then instance order): used by "counter" and merging.
    S.cur.order = new Map();
    for (const se of st.seriesList) for (const f of se.files) S.cur.order.set(f.id, S.cur.order.size + 1);
    S.cur.stackUID = DA.anon.newUID();
    S.cur.summary = summarise(st);
    renderTags();
  }

  // Union of all tags in a study, with example values.
  function summarise(st) {
    const rows = new Map();
    const needles = new Set();
    const firstPerSeries = st.seriesList.map((se) => se.files[0]);
    for (const f of firstPerSeries) for (const n of DA.anon.identifiers(f.ds, f.charset)) needles.add(n);
    const visit = (ds, f, seq) => {
      for (const [tag, el] of ds) {
        if ((tag & 0xffff) === 0 || tag === D.TAG.PixelData) continue;
        const h = D.hex(tag);
        let r = rows.get(h);
        if (!r) {
          const info = D.lookup(tag);
          const g = tag >>> 16;
          let name = info.name;
          if (g & 1 && (tag & 0xffff) >= 0x1000) {
            const creator = D.getString(ds, g * 65536 + ((tag & 0xffff) >> 8), f.charset);
            name = 'Private' + (creator ? ' (' + creator + ')' : '');
          }
          r = { hex: h, tag, name, vr: el.vr, count: 0, values: new Map(), seqs: new Set(), priv: !!(g & 1),
            overlay: (g & 0xff00) === 0x6000, curve: (g & 0xff00) === 0x5000, leak: false };
          rows.set(h, r);
        }
        r.count++;
        if (seq) r.seqs.add(seq);
        if (!el.items) {
          const v = D.displayValue(el, f.charset);
          if (r.values.size < 50 || r.values.has(v)) r.values.set(v, (r.values.get(v) || 0) + 1);
        }
        if (el.items) for (const item of el.items) visit(item, f, D.lookup(tag).name);
      }
    };
    for (const f of st.files) visit(f.ds, f, '');
    const needleList = [...needles];
    for (const r of rows.values()) {
      if (r.vr === 'UI') continue;
      for (const v of r.values.keys()) {
        const up = v.toUpperCase();
        const tokens = new Set(up.split(/[^0-9A-ZÀ-ɏ]+/));
        if (needleList.some((n) => tokens.has(n) || (n.length >= 6 && up.includes(n)))) { r.leak = true; break; }
      }
    }
    return { rows: [...rows.values()].sort((a, b) => a.tag - b.tag), needles: needleList };
  }

  function studyBanner() {
    const c = S.cur;
    const st = c.study;
    return `<div class="banner">
      <div><span class="from">${esc(fmtName(st.patientName)) || '(no name)'} · ID ${esc(st.patientId) || '–'} ·
        ${esc(fmtDate(st.date))} · ${st.modalities.map(esc).join('/')} · ${st.files.length} files</span></div>
      <div class="arrow">→</div>
      <div class="to">${esc(c.pseudonym)}</div>
      ${c.reused ? '<span class="badge blue">Known patient: same pseudonym as before</span>' : ''}
      <span class="spacer"></span>
      <button class="small" id="toList">Back to study list</button></div>`;
  }
  function bindBanner() {
    $('#toList').onclick = async () => {
      if (await confirmBox('Leave this study?', '<p>Your box drawings and unsaved tag changes for this study will be lost.</p>', 'Leave')) renderStudies();
    };
  }

  // ---------------------------------------------------------------- step 1: tags
  const ACTIONS = { keep: 'Keep', empty: 'Empty', remove: 'Remove', random: 'Random', fixed: 'Fixed value', pseudo: 'Pseudonym', counter: 'Counter (1, 2, 3…)' };
  function actionsFor(vr) {
    if (vr === 'SQ') return ['keep', 'empty', 'remove'];
    if (D.STRING_VR.has(vr) || vr === 'UN') return ['keep', 'empty', 'remove', 'random', 'fixed', 'pseudo', 'counter'];
    if (['US', 'UL', 'SS', 'SL'].includes(vr)) return ['keep', 'empty', 'remove', 'counter'];
    return ['keep', 'empty', 'remove'];
  }
  function ruleOf(r) {
    const c = S.cur;
    if (r.priv && c.options.removePrivate) return { a: 'remove', implied: 'all private tags are removed' };
    if (r.overlay && c.options.removeOverlays) return { a: 'remove', implied: 'overlays (60xx) are removed' };
    if (r.curve && c.options.removeCurves) return { a: 'remove', implied: 'curves (50xx) are removed' };
    if (c.options.mergeStack && r.hex === '0020000E') return { a: 'random', implied: 'one shared UID: merged into one stack' };
    if (c.options.mergeStack && r.hex === '00200011') return { a: 'fixed', implied: 'set to 1: merged into one stack' };
    if (c.options.mergeStack && r.hex === '00200013') return { a: 'counter', implied: 'numbered 1…N: merged into one stack' };
    let rule = c.rules[r.hex];
    if (!rule && (r.overlay || r.curve)) rule = c.rules[r.hex.slice(0, 2) + '00' + r.hex.slice(4)];
    if (rule) return rule;
    if (r.vr === 'UI' && c.options.remapOtherUIDs && !DA.profile.isClassUIDTag(r.tag)) return { a: 'random', implied: 'all other UIDs are replaced' };
    return { a: 'keep' };
  }

  function renderTags() {
    const c = S.cur;
    c.screen = 'tags';
    setSteps(2);
    main.className = 'full';
    const names = store.presetNames();
    const sum = c.summary;
    const nPriv = sum.rows.filter((r) => r.priv).length;
    const nOv = sum.rows.filter((r) => r.overlay).length;
    const nCurve = sum.rows.filter((r) => r.curve).length;
    main.innerHTML = studyBanner() + `
      <div class="toolbar">
        <label>Preset <select id="preset">${names.map((n) => '<option' + (n === c.presetName ? ' selected' : '') + '>' + esc(n) + '</option>').join('')}</select></label>
        <span class="badge ${c.dirty ? 'warn' : ''}" id="dirty">${c.dirty ? 'modified' : 'auto-selected for ' + esc(c.mod)}</span>
        <button id="savePreset" ${c.presetName === DA.profile.NAME ? 'disabled title="The built-in preset cannot be changed"' : ''}>Save preset</button>
        <button id="saveAs">Save as new preset…</button>
        <button id="resetPreset" class="ghost">Reset</button>
        <span class="spacer"></span>
        <label>Pseudonym (Patient Name &amp; ID) <input type="text" id="pseudo" value="${esc(c.pseudonym)}" style="width:150px"></label>
      </div>
      <div class="toolbar">
        <label><input type="checkbox" data-opt="removePrivate" ${c.options.removePrivate ? 'checked' : ''}> Remove all private tags (${nPriv})</label>
        <label><input type="checkbox" data-opt="removeOverlays" ${c.options.removeOverlays ? 'checked' : ''}> Remove overlays 60xx (${nOv})</label>
        <label><input type="checkbox" data-opt="removeCurves" ${c.options.removeCurves ? 'checked' : ''}> Remove curves 50xx (${nCurve})</label>
        <label><input type="checkbox" data-opt="remapOtherUIDs" ${c.options.remapOtherUIDs ? 'checked' : ''}> Replace all other UIDs</label>
        <label title="All images of the study get the same new Series Instance UID and Series Number 1, and are numbered 1…N, so viewers show one stack."><input type="checkbox" data-opt="mergeStack" ${c.options.mergeStack ? 'checked' : ''}> Merge all images into one stack (${c.study.files.length} images)</label>
        <span class="spacer"></span>
        <label><select id="filter">
          <option value="all">All tags</option><option value="change">Only tags that change</option><option value="keep">Only kept tags</option>
          <option value="leak">Only tags with patient data</option></select></label>
        <label><input type="checkbox" id="showPriv" ${c.showPrivate ? 'checked' : ''}> Show private tags</label>
        <input type="search" id="search" placeholder="Search name, tag or value" value="${esc(c.search)}" style="width:220px">
      </div>
      <div class="tagwrap"><table class="tagtable"><thead><tr><th style="width:30px" title="Anonymise this tag"></th>
        <th style="width:110px">Tag</th><th>Name</th><th style="width:40px">VR</th><th>Value(s) in this study</th>
        <th style="width:290px">Action</th></tr></thead><tbody id="tagBody"></tbody></table></div>
      <div class="footer"><span class="muted small" id="tagStats"></span><span class="spacer"></span>
        <button class="primary" id="toImages">Next: check images →</button></div>`;
    bindBanner();
    $('#filter').value = c.filter;
    fillTagBody();

    $('#preset').onchange = async (e) => {
      if (c.dirty && !(await confirmBox('Discard changes?', '<p>Your changes to the current preset will be lost.</p>', 'Discard'))) {
        e.target.value = c.presetName;
        return;
      }
      const p = store.getPreset(e.target.value);
      Object.assign(c, { presetName: p.name, rules: p.rules, options: p.options, dirty: false });
      renderTags();
    };
    $('#savePreset').onclick = () => {
      store.putPreset({ name: c.presetName, rules: c.rules, options: c.options });
      c.dirty = false;
      toast('Preset "' + c.presetName + '" saved.');
      renderTags();
    };
    $('#saveAs').onclick = async () => {
      const name = ((await promptBox('Save as new preset', 'Name for the preset, for example "Teaching US":', c.presetName === DA.profile.NAME ? '' : c.presetName)) || '').trim();
      if (!name) return;
      if (name === DA.profile.NAME) return toast('Please choose a different name.', true);
      if (store.load().presets[name] && !(await confirmBox('Overwrite preset?', '<p>A preset called <b>' + esc(name) + '</b> exists. Replace it?</p>', 'Replace'))) return;
      store.putPreset({ name, rules: c.rules, options: c.options });
      Object.assign(c, { presetName: name, dirty: false });
      toast('Preset "' + name + '" saved.');
      renderTags();
    };
    $('#resetPreset').onclick = () => {
      const p = store.getPreset(c.presetName);
      Object.assign(c, { rules: p.rules, options: p.options, dirty: false });
      renderTags();
    };
    $('#pseudo').onchange = (e) => {
      const v = e.target.value.trim().slice(0, 64);
      if (!v) { e.target.value = c.pseudonym; return toast('The pseudonym cannot be empty.', true); }
      c.pseudonym = v;
      c.reused = false;
    };
    $$('[data-opt]').forEach((cb) => {
      cb.onchange = () => { c.options = Object.assign({}, c.options, { [cb.dataset.opt]: cb.checked }); markDirty(); fillTagBody(); };
    });
    $('#filter').onchange = (e) => { c.filter = e.target.value; fillTagBody(); };
    $('#showPriv').onchange = (e) => { c.showPrivate = e.target.checked; fillTagBody(); };
    $('#search').oninput = (e) => { c.search = e.target.value; fillTagBody(); };

    const body = $('#tagBody');
    body.onchange = (e) => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      const hex = tr.dataset.hex;
      const row = sum.rows.find((r) => r.hex === hex);
      const t = e.target;
      if (t.dataset.act === 'toggle') {
        setRule(row, t.checked ? defaultChangeFor(row) : 'keep');
      } else if (t.dataset.act === 'action') {
        setRule(row, t.value);
      } else if (t.dataset.act === 'fixed') {
        c.rules[hex] = { a: 'fixed', v: t.value };
        markDirty();
        return;
      }
      fillTagBody();
    };
    $('#toImages').onclick = () => {
      const leaks = sum.rows.filter((r) => r.leak && ruleOf(r).a === 'keep');
      const go = () => renderImages();
      if (leaks.length) {
        confirmBox('Patient data would be kept', '<p>These tags contain the patient name or ID but are set to <b>Keep</b>:</p><ul>' +
          leaks.slice(0, 12).map((r) => '<li>' + esc(r.name) + ' ' + esc(D.fmtTag(r.tag)) + '</li>').join('') + '</ul><p>Continue anyway?</p>',
        'Continue').then((ok) => ok && go());
      } else go();
    };
  }

  function defaultChangeFor(row) {
    if (row.vr === 'UI') return 'random';
    if (row.vr === 'SQ') return 'remove';
    return 'empty';
  }
  function setRule(row, a) {
    const c = S.cur;
    const prev = c.rules[row.hex];
    c.rules[row.hex] = a === 'fixed' ? { a, v: (prev && prev.v) || '' } : { a };
    markDirty();
  }
  function markDirty() {
    S.cur.dirty = true;
    const d = $('#dirty');
    if (d) { d.textContent = 'modified'; d.className = 'badge warn'; }
  }

  function fillTagBody() {
    const c = S.cur;
    const q = c.search.trim().toLowerCase();
    let shown = 0;
    let changed = 0;
    const html = [];
    for (const r of c.summary.rows) {
      const rule = ruleOf(r);
      const change = rule.a !== 'keep';
      if (change) changed++;
      if (r.priv && !c.showPrivate && c.filter !== 'leak') continue;
      if (c.filter === 'change' && !change) continue;
      if (c.filter === 'keep' && change) continue;
      if (c.filter === 'leak' && !r.leak) continue;
      const vals = [...r.values.keys()];
      if (q && !(r.name.toLowerCase().includes(q) || r.hex.toLowerCase().includes(q.replace(/[(),\s]/g, '')) ||
        vals.some((v) => v.toLowerCase().includes(q)))) continue;
      shown++;
      if (shown > 1500) continue;
      const leak = r.leak && !change;
      const opts = actionsFor(r.vr);
      const valHtml = vals.length
        ? vals.slice(0, 3).map((v) => esc(v) || '<span class="muted">(empty)</span>').join('<br>') + (vals.length > 3 ? '<br><span class="muted small">+' + (vals.length - 3) + ' more values</span>' : '')
        : (r.vr === 'SQ' ? '<span class="muted">sequence</span>' : '');
      html.push(`<tr data-hex="${r.hex}" class="${leak ? 'leak' : change ? 'change' : ''}${r.priv ? ' private' : ''}">
        <td><input type="checkbox" data-act="toggle" ${change ? 'checked' : ''} ${rule.implied ? 'disabled' : ''}></td>
        <td class="mono">${D.fmtTag(r.tag)}</td>
        <td>${esc(r.name)}${r.seqs.size ? '<span class="seqname">in ' + esc([...r.seqs].slice(0, 2).join(', ')) + '</span>' : ''}
          ${leak ? '<br><span class="badge bad">contains patient name/ID</span>' : ''}</td>
        <td class="mono">${esc(r.vr)}</td>
        <td class="val">${valHtml}</td>
        <td>${rule.implied
          ? '<span class="muted small">' + esc(ACTIONS[rule.a]) + ' (' + esc(rule.implied) + ')</span>'
          : '<select data-act="action">' + opts.map((a) => '<option value="' + a + '"' + (a === rule.a ? ' selected' : '') + '>' + ACTIONS[a] + '</option>').join('') + '</select>' +
            (rule.a === 'fixed' ? ' <input type="text" data-act="fixed" placeholder="value, {PSEUDONYM} allowed" value="' + esc(rule.v || '') + '">' : '') +
            (rule.a === 'random' && r.vr === 'UI' ? ' <span class="muted small">new UID</span>' : '')}</td></tr>`);
    }
    $('#tagBody').innerHTML = html.join('') || '<tr><td colspan="6" class="muted">No tags match.</td></tr>';
    $('#tagStats').textContent = c.summary.rows.length + ' different tags in this study · ' + changed + ' will be changed or removed · ' + shown + ' shown';
  }

  // ---------------------------------------------------------------- frame cache
  const parsedCache = new Map();
  const frameCache = new Map();
  async function getParsed(file) {
    if (parsedCache.has(file.id)) return parsedCache.get(file.id);
    const p = D.parse(await (await file.handle.getFile()).arrayBuffer());
    parsedCache.set(file.id, p);
    if (parsedCache.size > 4) parsedCache.delete(parsedCache.keys().next().value);
    try { return await p; } catch (e) { parsedCache.delete(file.id); throw e; }
  }
  async function getFrame(file, k) {
    const key = file.id + ':' + k;
    if (frameCache.has(key)) return frameCache.get(key);
    const parsed = await getParsed(file);
    const frame = await P.decodeFrame(parsed, k);
    const v = { frame, inf: P.info(parsed.ds), ds: parsed.ds };
    frameCache.set(key, v);
    if (frameCache.size > 40) frameCache.delete(frameCache.keys().next().value);
    return v;
  }
  function boxesFor(file, frame) {
    return S.cur.boxes.filter((b) =>
      (b.scope === 'image' && b.fileId === file.id && b.frame === frame) ||
      (b.scope === 'series' && b.seriesUID === file.seriesUID) ||
      (b.scope === 'size' && b.rows === file.rows && b.cols === file.cols));
  }
  function boxesByFrame(file) {
    const m = new Map();
    for (let k = 0; k < file.frames; k++) {
      const b = boxesFor(file, k);
      if (b.length) m.set(k, b);
    }
    return m;
  }

  // ---------------------------------------------------------------- step 2: images
  let viewer = null;
  let showToken = 0;
  let thumbToken = 0;

  function renderImages() {
    const c = S.cur;
    c.screen = 'images';
    setSteps(3);
    main.className = 'full';
    const st = c.study;
    const withPix = st.seriesList.filter((se) => se.images.length);
    const noPix = st.seriesList.filter((se) => !se.images.length);
    if (!c.active || !withPix.includes(c.active)) { c.active = withPix[0] || null; c.index = 0; }
    main.innerHTML = studyBanner() + `
      <div class="imgwrap">
        <div class="serieslist" id="seriesList">
          ${withPix.map((se) => `<div class="series" data-se="${esc(se.uid)}">
            <canvas width="64" height="64" data-thumb="${esc(se.uid)}"></canvas>
            <div class="meta"><b>S${se.number} · ${esc(se.modality)}</b> <span class="muted">${se.images.length} img</span><br>
              <span class="muted">${esc(se.desc)}</span><br>
              ${se.risk.length ? '<span class="badge bad" title="' + esc(se.risk.join('\n')) + '">⚠ check for burned-in text</span>' : ''}
              ${P.canDecode(se.ts) ? '' : '<span class="badge warn">cannot display</span>'}
              <span data-status="${esc(se.uid)}"></span></div></div>`).join('')}
          ${noPix.length ? '<div class="small muted" style="padding:10px">' + noPix.length + ' series without images (reports, structured data): tags only.</div>' : ''}
        </div>
        <div class="viewerpane">
          <div class="viewerbar">
            <span id="imgLabel"></span>
            <input type="range" id="slider" min="0" value="0">
            <button class="small" id="resetWL" title="Reset window/level">Reset W/L</button>
            <span id="wlLabel"></span>
          </div>
          <div class="canvasbox"><canvas id="view"></canvas><div class="overlaymsg" id="viewMsg"></div></div>
          <div class="viewerbar"><span>Left-drag: draw a redaction box · Right-drag (or Shift+drag): window/level · Mouse wheel / ← →: next image · Ctrl+Z: undo box</span></div>
        </div>
        <div class="sidepanel" id="side"></div>
      </div>
      <div class="footer"><button id="backTags">← Tags</button><span class="muted small" id="reviewStat"></span>
        <span class="spacer"></span><button class="primary" id="toReview">Next: review &amp; save →</button></div>`;
    bindBanner();
    if (viewer) viewer.destroy();
    viewer = new DA.Viewer($('#view'), {
      draw: true,
      onBox: addBox,
      onWheel: (d) => go(c.index + d),
      onWindow: (dx, dy) => {
        const w = c.win.get(c.active.uid);
        if (!w) return;
        const k = Math.max(w.w, 1) / 300;
        w.w = Math.max(1, w.w + dx * k * 2);
        w.c += dy * k * 2;
        showImage();
      },
    });
    $$('#seriesList .series').forEach((el) => {
      el.onclick = () => { c.active = st.series.get(el.dataset.se); c.index = 0; selectSeries(); };
    });
    $('#slider').oninput = (e) => go(+e.target.value);
    $('#resetWL').onclick = () => { if (c.active) { c.win.delete(c.active.uid); showImage(); } };
    $('#backTags').onclick = renderTags;
    $('#toReview').onclick = async () => {
      const unchecked = withPix.filter((se) => se.risk.length && !c.reviewed.has(se.uid));
      if (unchecked.length && !(await confirmBox('Some series were not viewed',
        '<p>' + unchecked.length + ' series that may contain burned-in text were not opened:</p><ul>' +
        unchecked.map((se) => '<li>S' + se.number + ' ' + esc(se.modality) + ' ' + esc(se.desc) + '</li>').join('') + '</ul><p>Continue anyway?</p>', 'Continue'))) return;
      renderReview();
    };
    document.onkeydown = (e) => {
      if (S.cur !== c || c.screen !== 'images' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { go(c.index + 1); e.preventDefault(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { go(c.index - 1); e.preventDefault(); }
      if (e.key === 'z' && (e.ctrlKey || e.metaKey) && c.boxes.length) { c.boxes.pop(); refreshBoxes(); }
    };
    selectSeries();
    loadThumbs(withPix);
  }

  async function loadThumbs(list) {
    const token = ++thumbToken;
    for (const se of list) {
      if (token !== thumbToken) return;
      const cv = $('canvas[data-thumb="' + CSS.escape(se.uid) + '"]');
      if (!cv) continue;
      try {
        const it = se.images[Math.floor(se.images.length / 2)];
        const { frame, inf, ds } = await getFrame(it.file, it.frame);
        const rgba = P.render(frame, inf, P.defaultWindow(frame, inf), ds);
        const tmp = document.createElement('canvas');
        tmp.width = frame.cols; tmp.height = frame.rows;
        tmp.getContext('2d').putImageData(new ImageData(rgba, frame.cols, frame.rows), 0, 0);
        const g = cv.getContext('2d');
        const s = Math.min(64 / frame.cols, 64 / frame.rows);
        g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
        g.drawImage(tmp, (64 - frame.cols * s) / 2, (64 - frame.rows * s) / 2, frame.cols * s, frame.rows * s);
      } catch (e) {
        const g = cv.getContext('2d');
        g.fillStyle = '#334'; g.fillRect(0, 0, 64, 64);
      }
    }
  }

  function selectSeries() {
    const c = S.cur;
    $$('#seriesList .series').forEach((el) => el.classList.toggle('active', c.active && el.dataset.se === c.active.uid));
    if (!c.active) {
      $('#viewMsg').textContent = 'This study has no images. Continue to the review.';
      renderSide();
      return;
    }
    const sl = $('#slider');
    sl.max = Math.max(0, c.active.images.length - 1);
    sl.disabled = c.active.images.length < 2;
    showImage();
  }
  function go(i) {
    const c = S.cur;
    if (!c.active) return;
    c.index = Math.max(0, Math.min(c.active.images.length - 1, i));
    $('#slider').value = c.index;
    showImage();
  }

  async function showImage() {
    const c = S.cur;
    const se = c.active;
    const it = se.images[c.index];
    const token = ++showToken;
    $('#imgLabel').textContent = 'Image ' + (c.index + 1) + ' / ' + se.images.length +
      (it.file.frames > 1 ? ' (frame ' + (it.frame + 1) + ' of file ' + it.file.name + ')' : ' · ' + it.file.name) + ' · ' + it.file.cols + '×' + it.file.rows;
    try {
      const { frame, inf, ds } = await getFrame(it.file, it.frame);
      if (token !== showToken) return;
      let win = c.win.get(se.uid);
      if (!win) { win = P.defaultWindow(frame, inf); c.win.set(se.uid, win); }
      viewer.setImage(P.render(frame, inf, win, ds), frame.cols, frame.rows);
      $('#viewMsg').textContent = '';
      $('#wlLabel').textContent = frame.spp === 1 && frame.photometric !== 'PALETTE COLOR' ? 'W ' + Math.round(win.w) + ' / L ' + Math.round(win.c) : '';
      c.reviewed.add(se.uid);
    } catch (e) {
      if (token !== showToken) return;
      viewer.clear();
      $('#viewMsg').innerHTML = '<div>This image cannot be displayed:<br><b>' + esc(e.message) + '</b><br><br>' +
        'Its pixels will be copied unchanged (tags are still anonymised). Check it with another viewer if it may contain patient data.</div>';
      c.reviewed.add(se.uid);
    }
    refreshBoxes();
  }

  function addBox(b) {
    const c = S.cur;
    const it = c.active.images[c.index];
    c.boxes.push(Object.assign(b, {
      id: Date.now() + Math.random(), scope: c.scope, fill: c.fill, seriesUID: it.file.seriesUID, fileId: it.file.id, frame: it.frame,
      rows: it.file.rows, cols: it.file.cols, seriesNo: c.active.number,
    }));
    refreshBoxes();
  }

  function refreshBoxes() {
    const c = S.cur;
    if (c.active && viewer) {
      const it = c.active.images[c.index];
      viewer.boxes = boxesFor(it.file, it.frame).map((b) => Object.assign({}, b, { label: scopeLabel(b.scope) }));
      viewer.draw();
    }
    // series status badges
    for (const se of c.study.seriesList) {
      const el = $('[data-status="' + CSS.escape(se.uid) + '"]');
      if (!el) continue;
      const n = se.files.reduce((a, f) => a + boxesByFrame(f).size, 0);
      el.innerHTML = (c.reviewed.has(se.uid) ? '<span class="badge ok">viewed</span>' : '') + (n ? '<span class="badge">' + n + ' img redacted</span>' : '');
    }
    const withPix = c.study.seriesList.filter((se) => se.images.length);
    const rs = $('#reviewStat');
    if (rs) rs.textContent = c.reviewed.size + ' of ' + withPix.length + ' series viewed · ' + c.boxes.length + ' box(es)';
    renderSide();
  }
  function scopeLabel(s) {
    return s === 'image' ? 'this image' : s === 'series' ? 'whole series' : 'all same-size';
  }

  function renderSide() {
    const c = S.cur;
    const side = $('#side');
    if (!side) return;
    const it = c.active && c.active.images[c.index];
    const sizeCount = it ? c.study.files.filter((f) => f.rows === it.file.rows && f.cols === it.file.cols).reduce((a, f) => a + f.frames, 0) : 0;
    const risk = c.active && c.active.risk.length
      ? '<div class="note warn small"><b>Check this series carefully:</b><br>' + c.active.risk.map(esc).join('<br>') + '</div>' : '';
    side.innerHTML = `${risk}
      <h3>New boxes apply to</h3>
      <label class="opt"><input type="radio" name="scope" value="image" ${c.scope === 'image' ? 'checked' : ''}> This image only</label>
      <label class="opt"><input type="radio" name="scope" value="series" ${c.scope === 'series' ? 'checked' : ''}> Whole series / stack
        <span class="muted small">(${c.active ? c.active.images.length : 0} images)</span></label>
      <label class="opt"><input type="radio" name="scope" value="size" ${c.scope === 'size' ? 'checked' : ''}> All ${it ? it.file.cols + '×' + it.file.rows : ''} images in this study
        <span class="muted small">(${sizeCount} images)</span></label>
      <h3 style="margin-top:14px">New boxes are filled with</h3>
      <div class="row"><label class="opt"><input type="radio" name="fill" value="black" ${c.fill !== 'white' ? 'checked' : ''}> Black</label>
        <label class="opt"><input type="radio" name="fill" value="white" ${c.fill === 'white' ? 'checked' : ''}> White</label></div>
      <p class="small muted">The box area is replaced with this colour in the saved files. Draw boxes generously around text.</p>
      <h3 style="margin-top:14px">Boxes (${c.boxes.length})</h3>
      ${c.boxes.length ? '' : '<p class="small muted">No boxes yet. If an image shows a name, date of birth, ID or other identifying text, drag a box over it.</p>'}
      ${c.boxes.map((b, i) => {
        const cur = it && boxesFor(it.file, it.frame).includes(b);
        return `<div class="boxitem ${cur ? 'cur' : ''}"><div class="row"><b>Box ${i + 1}</b><span class="muted">S${b.seriesNo} · ${b.w}×${b.h} at ${b.x},${b.y}</span></div>
          <div class="row" style="margin-top:4px"><select data-bscope="${i}">
            <option value="image" ${b.scope === 'image' ? 'selected' : ''}>this image only</option>
            <option value="series" ${b.scope === 'series' ? 'selected' : ''}>whole series</option>
            <option value="size" ${b.scope === 'size' ? 'selected' : ''}>all ${b.cols}×${b.rows} images</option></select>
            <select data-bfill="${i}"><option value="black" ${b.fill !== 'white' ? 'selected' : ''}>black</option>
              <option value="white" ${b.fill === 'white' ? 'selected' : ''}>white</option></select>
            <button class="small" data-bgo="${i}">Show</button><button class="small" data-bdel="${i}">Delete</button></div></div>`;
      }).join('')}
      ${c.boxes.length ? '<button class="small" id="clearBoxes">Delete all boxes</button>' : ''}`;
    $$('input[name=scope]', side).forEach((r) => { r.onchange = () => { c.scope = r.value; }; });
    $$('input[name=fill]', side).forEach((r) => {
      r.onchange = () => { c.fill = r.value; store.load().boxFill = r.value; store.save(); };
    });
    $$('[data-bfill]', side).forEach((s) => { s.onchange = () => { c.boxes[+s.dataset.bfill].fill = s.value; refreshBoxes(); }; });
    $$('[data-bscope]', side).forEach((s) => { s.onchange = () => { c.boxes[+s.dataset.bscope].scope = s.value; refreshBoxes(); }; });
    $$('[data-bdel]', side).forEach((b) => { b.onclick = () => { c.boxes.splice(+b.dataset.bdel, 1); refreshBoxes(); }; });
    $$('[data-bgo]', side).forEach((b) => {
      b.onclick = () => {
        const box = c.boxes[+b.dataset.bgo];
        const se = c.study.series.get(box.seriesUID);
        c.active = se;
        const idx = se.images.findIndex((x) => x.file.id === box.fileId && x.frame === box.frame);
        c.index = Math.max(0, idx);
        selectSeries();
        $('#slider').value = c.index;
      };
    });
    if ($('#clearBoxes')) {
      $('#clearBoxes').onclick = async () => {
        if (await confirmBox('Delete all boxes?', '<p>All ' + c.boxes.length + ' boxes in this study will be removed.</p>', 'Delete all', true)) { c.boxes = []; refreshBoxes(); }
      };
    }
  }

  // ---------------------------------------------------------------- step 3: review & save
  // file: the image being processed (gives the "counter" value = its position in the study)
  function cfg(file) {
    const c = S.cur;
    return { rules: c.rules, options: c.options, pseudonym: c.pseudonym, presetName: c.presetName + (c.dirty ? ' (modified)' : ''),
      counter: (file && c.order.get(file.id)) || 1 };
  }
  function ctx() {
    const pk = patientKey(S.cur.study);
    if (!S.session.valueMaps.has(pk)) S.session.valueMaps.set(pk, new Map());
    return { uidMap: S.session.uidMap, valueMap: S.session.valueMaps.get(pk), stackUID: S.cur.stackUID };
  }

  let beforeV = null;
  let afterV = null;
  let verifyToken = 0;

  function renderReview() {
    const c = S.cur;
    c.screen = 'review';
    setSteps(4);
    main.className = 'full';
    document.onkeydown = null;
    const st = c.study;
    const all = st.seriesList;
    if (!c.cmpSeries || !all.includes(c.cmpSeries)) c.cmpSeries = (c.active && all.includes(c.active)) ? c.active : all[0];
    c.cmpIndex = c.cmpIndex || 0;
    main.innerHTML = studyBanner() + `
      <div style="flex:1;overflow:auto;padding:16px 20px">
      <div class="grid2" style="grid-template-columns: 3fr 2fr">
        <div class="card">
          <div class="row" style="margin-bottom:8px"><h2 style="margin:0">Before / after</h2><span class="spacer"></span>
            <select id="cmpSeries">${all.map((se) => '<option value="' + esc(se.uid) + '"' + (se === c.cmpSeries ? ' selected' : '') + '>S' + se.number + ' · ' + esc(se.modality) + ' · ' + esc(se.desc || '') + ' (' + se.files.length + ' files)</option>').join('')}</select>
            <input type="range" id="cmpSlider" min="0" style="width:160px"><span class="small muted" id="cmpLabel"></span></div>
          <div class="compare">
            <div class="pane"><div class="cap">Original</div><canvas id="cvBefore"></canvas></div>
            <div class="pane"><div class="cap">Anonymised (read back from the generated file)</div><canvas id="cvAfter"></canvas></div>
          </div>
          <div class="row" style="margin:12px 0 6px"><h3 style="margin:0">Tags of this file</h3><span class="spacer"></span>
            <label class="small"><input type="checkbox" id="onlyChanged" checked> only changed</label></div>
          <div style="max-height:380px;overflow:auto"><table class="difftable"><thead><tr><th>Tag</th><th>Name</th><th>Original</th><th>Anonymised</th></tr></thead>
            <tbody id="diffBody"><tr><td colspan="4" class="muted">Preparing…</td></tr></tbody></table></div>
        </div>
        <div>
          <div class="card">
            <h2>Check all files</h2>
            <div class="progress"><div id="vBar"></div></div>
            <div id="vResult" class="small muted">Starting…</div>
          </div>
          <div class="card">
            <h2>Where to save</h2>
            <label class="opt" style="display:flex;gap:6px;margin:6px 0"><input type="radio" name="mode" value="copy" ${c.outMode === 'copy' ? 'checked' : ''}>
              <span><b>Save a copy to an output folder</b> (originals stay untouched)<br>
              <span class="small muted">Creates <span class="mono">${esc(c.pseudonym)}/S&lt;series&gt;_&lt;modality&gt;/IM00001.dcm</span>…</span></span></label>
            <div class="row" style="margin:4px 0 10px 26px"><button id="pickOut" class="small">Choose output folder…</button>
              <span class="small" id="outName">${S.outDir ? '📁 ' + esc(S.outDir.name) : '<span class="muted">none selected</span>'}</span></div>
            <label class="opt" style="display:flex;gap:6px;margin:6px 0"><input type="radio" name="mode" value="overwrite" ${c.outMode === 'overwrite' ? 'checked' : ''}>
              <span><b>Overwrite the original files</b><br><span class="small muted">The original files in “${esc(S.root.name)}” are replaced. DICOMDIR files are deleted because they contain patient names.</span></span></label>
            <div id="owBox" class="note bad small" ${c.outMode === 'overwrite' ? '' : 'hidden'}>
              <label><input type="checkbox" id="owOk"> I understand that the original files will be permanently replaced and cannot be recovered.</label></div>
            <div style="margin-top:10px">${S.key
              ? '<span class="badge ok">Key file</span> A line for <b>' + esc(c.pseudonym) + '</b> will be added to <b>' + esc(S.key.handle.name) + '</b>.'
              : '<div class="note warn small">No key file selected: this pseudonym cannot be traced back to the patient later. <button class="small" id="pickKey">Choose key file…</button></div>'}</div>
          </div>
          <div class="card">
            <div class="row"><button id="backImages">← Images</button><span class="spacer"></span>
              <button class="primary" id="saveBtn" disabled>Confirm &amp; save</button></div>
            <p class="small muted" id="saveHint" style="margin-top:8px">Waiting for the check of all files…</p>
          </div>
        </div>
      </div></div>`;
    bindBanner();
    beforeV = new DA.Viewer($('#cvBefore'), {});
    afterV = new DA.Viewer($('#cvAfter'), {});
    $('#cmpSeries').onchange = (e) => { c.cmpSeries = st.series.get(e.target.value); c.cmpIndex = 0; showCompare(); };
    $('#cmpSlider').oninput = (e) => { c.cmpIndex = +e.target.value; showCompare(); };
    $('#onlyChanged').onchange = showCompare;
    $('#backImages').onclick = () => { verifyToken++; renderImages(); };
    $$('input[name=mode]').forEach((r) => {
      r.onchange = () => { c.outMode = r.value; $('#owBox').hidden = r.value !== 'overwrite'; updateSave(); };
    });
    $('#owOk').onchange = updateSave;
    $('#pickOut').onclick = async () => {
      try {
        const d = await window.showDirectoryPicker({ id: 'dicomOut', mode: 'readwrite' });
        if (await S.root.isSameEntry(d)) return toast('Please choose a different folder than the input folder.', true);
        if (await S.root.resolve(d)) {
          if (!(await confirmBox('Output inside input folder', '<p>The output folder is inside the folder with the original data. Anonymised and original files would be mixed. Use it anyway?</p>', 'Use anyway'))) return;
        }
        S.outDir = d;
        $('#outName').innerHTML = '📁 ' + esc(d.name);
        if (c.outMode !== 'copy') { c.outMode = 'copy'; $$('input[name=mode]')[0].checked = true; $('#owBox').hidden = true; }
        updateSave();
      } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    };
    if ($('#pickKey')) {
      $('#pickKey').onclick = async () => {
        try {
          const h = await window.showSaveFilePicker({ id: 'dicomKey', suggestedName: 'anonymisation_key.csv', types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] });
          await useKey(h);
        } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
      };
    }
    $('#saveBtn').onclick = saveStudy;
    showCompare();
    runVerify();
  }

  function updateSave() {
    const c = S.cur;
    const btn = $('#saveBtn');
    const hint = $('#saveHint');
    if (!btn) return;
    let msg = '';
    if (!c.verify || !c.verify.finished) msg = 'Waiting for the check of all files…';
    else if (c.verify.errors.length && c.outMode === 'overwrite') msg = 'Some files could not be processed. Overwriting is blocked; save a copy instead.';
    else if (c.outMode === 'copy' && !S.outDir) msg = 'Choose an output folder.';
    else if (c.outMode === 'overwrite' && !$('#owOk').checked) msg = 'Confirm that the originals may be replaced.';
    btn.disabled = !!msg;
    btn.className = c.outMode === 'overwrite' ? 'danger' : 'primary';
    btn.textContent = c.outMode === 'overwrite' ? 'Confirm & overwrite originals' : 'Confirm & save copy';
    hint.textContent = msg || (c.verify.leaks.length ? 'Warning: possible patient data was found (see above).' : 'Ready.');
  }

  async function showCompare() {
    const c = S.cur;
    const se = c.cmpSeries;
    const list = se.images.length ? se.images : se.files.map((f) => ({ file: f, frame: 0 }));
    c.cmpIndex = Math.min(c.cmpIndex, list.length - 1);
    const it = list[c.cmpIndex];
    const sl = $('#cmpSlider');
    sl.max = list.length - 1;
    sl.value = c.cmpIndex;
    sl.disabled = list.length < 2;
    $('#cmpLabel').textContent = (c.cmpIndex + 1) + ' / ' + list.length;
    const token = ++showToken;
    try {
      const blob = await it.file.handle.getFile();
      const r = await E.processFile(blob, cfg(it.file), ctx(), boxesByFrame(it.file));
      if (token !== showToken) return;
      const orig = await getParsed(it.file);
      // Images
      if (it.file.hasPixels) {
        try {
          const b = await getFrame(it.file, it.frame);
          const win = c.win.get(se.uid) || P.defaultWindow(b.frame, b.inf);
          beforeV.setImage(P.render(b.frame, b.inf, win, b.ds), b.frame.cols, b.frame.rows);
          const af = await P.decodeFrame(r.output, it.frame);
          const ainf = P.info(r.output.ds);
          afterV.setImage(P.render(af, ainf, win, r.output.ds), af.cols, af.rows);
        } catch (e) { beforeV.clear(); afterV.clear(); }
      } else { beforeV.clear(); afterV.clear(); }
      // Tags
      const before = DA.anon.flatten(orig.ds, orig.charset);
      const after = DA.anon.flatten(r.output.ds, r.output.charset);
      const only = $('#onlyChanged').checked;
      const rows = [];
      const paths = new Set([...before.keys(), ...after.keys()]);
      for (const p of [...paths].sort()) {
        const a = before.get(p);
        const b = after.get(p);
        const changed = !a || !b || a.value !== b.value;
        if (only && !changed) continue;
        const row = a || b;
        if (rows.length > 600) break;
        rows.push(`<tr class="${!b ? 'removed' : ''}"><td class="mono">${esc(p)}</td><td>${esc(row.name)}</td>
          <td class="val ${changed ? 'before' : ''}">${a ? esc(a.value) : '<span class="muted">–</span>'}</td>
          <td class="val ${changed ? 'after' : ''}">${b ? esc(b.value) || '<span class="muted">(empty)</span>' : 'removed'}</td></tr>`);
      }
      $('#diffBody').innerHTML = rows.join('') || '<tr><td colspan="4" class="muted">No differences.</td></tr>';
    } catch (e) {
      $('#diffBody').innerHTML = '<tr><td colspan="4" class="note bad">Could not process this file: ' + esc(e.message) + '</td></tr>';
    }
  }

  async function runVerify() {
    const c = S.cur;
    const token = ++verifyToken;
    const files = c.study.files;
    const v = { finished: false, done: 0, leaks: [], errors: [], redacted: 0 };
    c.verify = v;
    const cx = ctx();
    for (const f of files) {
      if (token !== verifyToken || S.cur !== c) return;
      try {
        const r = await E.processFile(await f.handle.getFile(), cfg(f), cx, boxesByFrame(f));
        if (r.redacted) v.redacted++;
        for (const l of r.leaks) v.leaks.push({ file: f, leak: l });
      } catch (e) {
        v.errors.push({ file: f, msg: e.message });
      }
      v.done++;
      if (v.done % 5 === 0 || v.done === files.length) {
        const bar = $('#vBar');
        if (!bar) return;
        bar.style.width = (100 * v.done / files.length) + '%';
        $('#vResult').textContent = 'Processed ' + v.done + ' of ' + files.length + ' files…';
      }
    }
    v.finished = true;
    const boxesUsed = c.boxes.length;
    let html = '';
    html += v.errors.length ? '' : '<div class="note ok">✓ All ' + files.length + ' files were anonymised in memory and read back successfully.</div>';
    html += '<ul class="small" style="margin:6px 0 0 18px;padding:0">' +
      '<li>Patient Name and ID become <b>' + esc(c.pseudonym) + '</b></li>' +
      '<li>' + c.summary.rows.filter((r) => ruleOf(r).a !== 'keep').length + ' tag types changed or removed</li>' +
      '<li>' + v.redacted + ' file(s) with redacted pixels (' + boxesUsed + ' box(es))</li></ul>';
    if (v.leaks.length) {
      const uniq = new Map();
      for (const l of v.leaks) uniq.set(l.leak.path + l.leak.match, l);
      html += '<div class="note bad"><b>Possible patient data still present</b> in ' + v.leaks.length + ' place(s):<ul style="margin:4px 0 0 18px;padding:0">' +
        [...uniq.values()].slice(0, 10).map((l) => '<li>' + esc(l.leak.name) + ' <span class="mono">' + esc(l.leak.path) + '</span>: “' + esc(l.leak.value) + '”</li>').join('') +
        '</ul>Go back to <b>Tags</b> and change these, or save anyway if they are false alarms.</div>';
    }
    if (v.errors.length) {
      html += '<div class="note bad"><b>' + v.errors.length + ' file(s) could not be processed</b> and will not be saved:<ul style="margin:4px 0 0 18px;padding:0">' +
        v.errors.slice(0, 8).map((e) => '<li>' + esc(e.file.path) + ': ' + esc(e.msg) + '</li>').join('') + '</ul></div>';
    }
    const undecodable = c.study.seriesList.filter((se) => se.images.length && !P.canDecode(se.ts));
    if (undecodable.length) html += '<div class="note warn">' + undecodable.length + ' series could not be displayed; their pixels were not checked.</div>';
    $('#vResult').innerHTML = html;
    $('#vResult').className = '';
    updateSave();
  }

  async function uniqueDir(parent, name) {
    let n = name;
    for (let i = 2; ; i++) {
      try { await parent.getDirectoryHandle(n); n = name + '_' + i; } catch (e) { return parent.getDirectoryHandle(n, { create: true }); }
    }
  }

  async function saveStudy() {
    const c = S.cur;
    const st = c.study;
    if (c.verify.leaks.length && !(await confirmBox('Save with warnings?', '<p>The check found possible patient data in ' + c.verify.leaks.length + ' place(s). Save anyway?</p>', 'Save anyway', true))) return;
    const overwrite = c.outMode === 'overwrite';
    try {
      if (overwrite) {
        if ((await S.root.requestPermission({ mode: 'readwrite' })) !== 'granted') return toast('Write permission for the original folder was not granted.', true);
      } else if ((await S.outDir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        return toast('Write permission for the output folder was not granted.', true);
      }
    } catch (e) { return toast(e.message, true); }
    verifyToken++;
    main.className = '';
    main.innerHTML = `<div class="card" style="max-width:700px;margin:40px auto"><h2>Saving ${esc(c.pseudonym)}…</h2>
      <div class="progress"><div id="sBar"></div></div><p class="muted" id="sMsg"></p>
      <p class="small muted">Please keep this window open.</p></div>`;
    const cx = ctx();
    const errors = [];
    const leaks = [];
    let written = 0;
    let studyDir = null;
    const seriesDirs = new Map();
    try {
      if (!overwrite) studyDir = await uniqueDir(S.outDir, c.pseudonym.replace(/[\\/:*?"<>|]/g, '_'));
      let done = 0;
      for (const se of st.seriesList) {
        let i = 0;
        for (const f of se.files) {
          i++;
          try {
            const r = await E.processFile(await f.handle.getFile(), cfg(f), cx, boxesByFrame(f));
            leaks.push(...r.leaks);
            let target;
            if (overwrite) target = f.handle;
            else {
              // Merged stack: one series folder, files numbered in study order.
              const merged = c.options.mergeStack;
              const dirKey = merged ? 'stack' : se.uid;
              let sd = seriesDirs.get(dirKey);
              if (!sd) {
                const dirName = merged ? 'S001_' + st.seriesList[0].modality : 'S' + pad(se.number, 3) + '_' + se.modality;
                sd = await studyDir.getDirectoryHandle(dirName.replace(/[^A-Za-z0-9_-]/g, '_'), { create: true });
                seriesDirs.set(dirKey, sd);
              }
              target = await sd.getFileHandle('IM' + pad(merged ? c.order.get(f.id) : i, 5) + '.dcm', { create: true });
            }
            const w = await target.createWritable();
            await w.write(r.bytes);
            await w.close();
            written++;
          } catch (e) {
            errors.push({ file: f, msg: e.message });
          }
          done++;
          $('#sBar').style.width = (100 * done / st.files.length) + '%';
          $('#sMsg').textContent = done + ' of ' + st.files.length + ' files';
        }
      }
      const removedDirs = [];
      if (overwrite) {
        for (const d of S.dicomdirs) {
          try { await d.parent.removeEntry(d.name); removedDirs.push(d.path); } catch (e) { errors.push({ file: d, msg: 'DICOMDIR could not be deleted: ' + e.message }); }
        }
        S.dicomdirs = S.dicomdirs.filter((d) => !removedDirs.includes(d.path));
      }
      // Key file and counter
      let keyMsg = 'No key file in use.';
      if (S.key) {
        try {
          await S.key.append({
            anonymised_at: new Date().toISOString().slice(0, 19).replace('T', ' '), pseudonym: c.pseudonym,
            original_patient_id: st.patientId, original_patient_name: st.patientName, original_birth_date: st.birth,
            original_study_date: st.date, original_accession_number: st.accession, original_study_uid: st.uid,
            new_study_uid: S.session.uidMap.get(st.uid) || '', modalities: st.modalities.join('/'), files: written,
            output_mode: overwrite ? 'overwrite' : 'copy to ' + S.outDir.name,
          });
          keyMsg = 'Key file entry added to ' + S.key.handle.name + '.';
        } catch (e) { keyMsg = 'Could not write the key file: ' + e.message; errors.push({ file: { path: S.key.handle.name }, msg: keyMsg }); }
      }
      const s = store.load();
      s.counter = Math.max(s.counter || 0, E.pseudonymNumber(c.pseudonym));
      store.save();
      store.rememberModality([c.mod], c.presetName);
      S.session.patientPseudo.set(patientKey(st), c.pseudonym);
      st.status = 'done';
      st.pseudonym = c.pseudonym;
      for (const f of st.files) { parsedCache.delete(f.id); }
      frameCache.clear();
      renderDone({ written, errors, leaks, overwrite, removedDirs, keyMsg, folder: overwrite ? S.root.name : S.outDir.name + '/' + studyDir.name });
    } catch (e) {
      toast('Saving failed: ' + e.message, true);
      renderDone({ written, errors: errors.concat([{ file: { path: '' }, msg: e.message }]), leaks, overwrite, removedDirs: [], keyMsg: '', folder: '' });
    }
  }

  function renderDone(r) {
    const c = S.cur;
    updateKeyStatus();
    const next = S.studies.find((s) => s.status === 'pending');
    main.className = '';
    main.innerHTML = `<div class="card" style="max-width:760px;margin:40px auto">
      <h1>${r.errors.length ? 'Saved with problems' : '✓ Study anonymised'}</h1>
      <p><b>${r.written}</b> of ${c.study.files.length} files written as <b>${esc(c.pseudonym)}</b>
        ${r.overwrite ? '(originals overwritten in “' + esc(r.folder) + '”)' : 'to <span class="mono">' + esc(r.folder) + '</span>'}.</p>
      ${r.removedDirs.length ? '<p>Deleted DICOMDIR: ' + r.removedDirs.map(esc).join(', ') + '</p>' : ''}
      <p>${esc(r.keyMsg)}</p>
      ${r.leaks.length ? '<div class="note warn">' + r.leaks.length + ' possible patient data warning(s) remained in the saved files.</div>' : ''}
      ${r.errors.length ? '<div class="note bad"><b>Problems:</b><ul>' + r.errors.slice(0, 20).map((e) => '<li>' + esc(e.file.path) + ': ' + esc(e.msg) + '</li>').join('') + '</ul>' +
        (r.overwrite ? '<b>Files listed here were NOT overwritten and still contain original data.</b>' : '') + '</div>' : ''}
      <div class="row" style="margin-top:16px"><button id="toList2">Back to study list</button><span class="spacer"></span>
        ${next ? '<button class="primary" id="nextStudy">Next study →</button>' : ''}</div></div>`;
    $('#toList2').onclick = renderStudies;
    if (next) $('#nextStudy').onclick = () => openStudy(next);
    S.cur = null;
  }

  // ---------------------------------------------------------------- boot
  $('#homeBtn').onclick = async () => {
    if (S.cur && !(await confirmBox('Leave this study?', '<p>Unsaved work on the current study will be lost.</p>', 'Leave'))) return;
    S.cur = null;
    renderStart();
  };
  window.addEventListener('beforeunload', (e) => { if (S.cur) { e.preventDefault(); e.returnValue = ''; } });
  // Test hook: open a directory handle programmatically (used by automated tests).
  DA.openFolder = openFolder;
  updateKeyStatus();
  renderStart();
})();
