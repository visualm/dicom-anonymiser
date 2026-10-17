// Applies tag rules to a parsed dataset, plus leak checks used to verify the result.
(function () {
  'use strict';
  const DA = (window.DA = window.DA || {});
  const D = () => DA.dicom;

  const STANDARD_UID_ROOT = '1.2.840.10008.';

  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }
  function randInt(min, max) {
    const v = new Uint32Array(1);
    crypto.getRandomValues(v);
    return min + (v[0] % (max - min + 1));
  }
  function randomAlnum(n, alphabet) {
    alphabet = alphabet || 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (const b of randomBytes(n)) s += alphabet[b % alphabet.length];
    return s;
  }
  // UUID-derived UID (PS3.5 B.2): 2.25.<128-bit integer>
  function newUID() {
    let n = 0n;
    for (const b of randomBytes(16)) n = (n << 8n) | BigInt(b);
    return '2.25.' + n.toString();
  }
  const pad = (n, w) => String(n).padStart(w, '0');

  function randomValue(vr, orig) {
    const len = Math.max(4, Math.min(orig.length || 8, 16));
    switch (vr) {
      case 'PN': return 'ANON^' + randomAlnum(6, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      case 'DA': return pad(randInt(1950, 2020), 4) + pad(randInt(1, 12), 2) + pad(randInt(1, 28), 2);
      case 'TM': return pad(randInt(0, 23), 2) + pad(randInt(0, 59), 2) + pad(randInt(0, 59), 2);
      case 'DT': return randomValue('DA') + randomValue('TM');
      case 'AS': return pad(randInt(18, 90), 3) + 'Y';
      case 'DS': case 'IS': return String(randInt(1, 100));
      case 'AE': return 'AE' + randomAlnum(6);
      case 'UR': return 'urn:anon:' + randomAlnum(8).toLowerCase();
      case 'CS': return randomAlnum(Math.min(len, 16));
      case 'SH': return randomAlnum(Math.min(len, 16));
      case 'LO': case 'LT': case 'ST': case 'UT': case 'UC': return randomAlnum(Math.max(len, 8));
      default: return null; // binary VRs: emptied instead
    }
  }

  function ruleFor(rules, tag) {
    const h = D().hex(tag);
    if (rules[h]) return rules[h];
    const g = tag >>> 16;
    if ((g & 0xff00) === 0x5000 || (g & 0xff00) === 0x6000) {
      return rules[D().hex(((g & 0xff00) * 65536) + (tag & 0xffff))];
    }
    return null;
  }

  function mapUID(ctx, uid) {
    if (!uid || uid.startsWith(STANDARD_UID_ROOT)) return uid;
    let n = ctx.uidMap.get(uid);
    if (!n) { n = newUID(); ctx.uidMap.set(uid, n); }
    return n;
  }

  // Mutates `ds` in place. cfg: {rules, options, pseudonym, presetName, counter}. ctx: {uidMap, valueMap, charset, stackUID}
  // cfg.counter is this image's 1-based position in the study (used by the "counter" action and mergeStack).
  function anonymise(ds, cfg, ctx) {
    const opt = cfg.options;
    const cs = ctx.charset;
    const dicom = D();

    function setStr(target, el, str) {
      el.value = dicom.encodeText(str, cs, el.vr);
      delete el.items;
      target.set(el.tag, el);
    }

    function walk(target) {
      for (const [tag, el] of [...target]) {
        const g = tag >>> 16;
        if (tag === dicom.TAG.PixelData) continue;
        if ((tag & 0xffff) === 0) { target.delete(tag); continue; }
        if (opt.removePrivate && (g & 1)) { target.delete(tag); continue; }
        if (opt.removeOverlays && (g & 0xff00) === 0x6000) { target.delete(tag); continue; }
        if (opt.removeCurves && (g & 0xff00) === 0x5000) { target.delete(tag); continue; }

        let rule = ruleFor(cfg.rules, tag);
        if (!rule && el.vr === 'UI' && opt.remapOtherUIDs && !DA.profile.isClassUIDTag(tag)) rule = { a: 'random' };
        const action = rule ? rule.a : 'keep';

        if (action === 'remove') { target.delete(tag); continue; }
        if (action === 'empty') {
          if (el.items) el.items = [];
          else el.value = new Uint8Array(0);
          continue;
        }
        if (action === 'pseudo' || action === 'fixed') {
          if (!dicom.STRING_VR.has(el.vr) && el.vr !== 'UN') { el.value = new Uint8Array(0); delete el.items; continue; }
          const str = action === 'pseudo' ? cfg.pseudonym : String(rule.v || '').replace(/\{PSEUDONYM\}/g, cfg.pseudonym);
          if (el.vr === 'UN') el.vr = 'LO';
          setStr(target, el, str);
          continue;
        }
        if (action === 'counter') {
          const n = cfg.counter || 1;
          if (el.items) { el.items = []; continue; }
          if (el.vr === 'US' || el.vr === 'UL' || el.vr === 'SS' || el.vr === 'SL') {
            const size = el.vr === 'US' || el.vr === 'SS' ? 2 : 4;
            const v = new Uint8Array(size);
            const dv = new DataView(v.buffer);
            if (size === 2) dv.setUint16(0, n & 0xffff, true); else dv.setUint32(0, n >>> 0, true);
            el.value = v;
          } else if (dicom.STRING_VR.has(el.vr) || el.vr === 'UN') {
            if (el.vr === 'UN') el.vr = 'IS';
            setStr(target, el, String(n));
          } else el.value = new Uint8Array(0);
          continue;
        }
        if (action === 'random') {
          if (el.items) { el.items = []; continue; }
          const orig = el.value ? dicom.decodeText(el.value, cs, el.vr) : '';
          if (el.vr === 'UI') {
            setStr(target, el, orig.split('\\').map((u) => mapUID(ctx, u.trim())).join('\\'));
            continue;
          }
          if (!orig) continue; // nothing to replace
          const key = el.vr + '|' + orig;
          let v = ctx.valueMap.get(key);
          if (v === undefined) { v = randomValue(el.vr, orig); ctx.valueMap.set(key, v); }
          if (v === null) el.value = new Uint8Array(0);
          else setStr(target, el, v);
          continue;
        }
        // keep: still descend into sequences so nested identifiers are handled
        if (el.items) for (const item of el.items) walk(item);
      }
    }
    walk(ds);

    if (opt.mergeStack && ctx.stackUID) {
      // One series for the whole study: shared Series UID and number, images numbered 1..N.
      dicom.setString(ds, 0x0020000e, 'UI', ctx.stackUID, cs);
      dicom.setString(ds, 0x00200011, 'IS', '1', cs);
      dicom.setString(ds, 0x00200013, 'IS', String(cfg.counter || 1), cs);
    }

    dicom.setString(ds, 0x00120062, 'CS', 'YES', cs); // PatientIdentityRemoved
    dicom.setString(ds, 0x00120063, 'LO', ('DICOM Anonymiser: ' + (cfg.presetName || 'custom')).slice(0, 64), cs);
    return ds;
  }

  // Flattens a dataset into rows for display / comparison: path -> {tag, name, vr, value}
  function flatten(ds, charset, prefix, out, seqName) {
    out = out || new Map();
    for (const [tag, el] of ds) {
      if (tag === D().TAG.PixelData) continue;
      const path = (prefix ? prefix + ' › ' : '') + D().fmtTag(tag);
      const info = D().lookup(tag);
      out.set(path, { tag, path, name: info.name, vr: el.vr, value: D().displayValue(el, charset), seq: seqName || '' });
      if (el.items) {
        el.items.forEach((item, i) => flatten(item, charset, path + '[' + (i + 1) + ']', out, info.name));
      }
    }
    return out;
  }

  // Values from the original file that must not appear anywhere in the output.
  function identifiers(ds, charset) {
    const get = (t) => D().getString(ds, t, charset);
    const needles = new Set();
    const name = get(0x00100010);
    for (const part of name.split(/[\^=\s,]+/)) if (part.length >= 3) needles.add(part.toUpperCase());
    for (const t of [0x00100020, 0x00080050, 0x00101000, 0x00101001, 0x00100030, 0x00101040, 0x00102154]) {
      const v = get(t);
      if (v && v.length >= 3) for (const p of v.split('\\')) if (p.trim().length >= 3) needles.add(p.trim().toUpperCase());
    }
    return [...needles];
  }

  // Searches every text element of the anonymised dataset for original identifiers.
  function findLeaks(ds, charset, needles) {
    const leaks = [];
    if (!needles.length) return leaks;
    const rows = flatten(ds, charset);
    for (const row of rows.values()) {
      if (!D().STRING_VR.has(row.vr) && row.vr !== 'UN') continue;
      if (row.vr === 'UI') continue;
      const v = String(row.value).toUpperCase();
      const tokens = new Set(v.split(/[^0-9A-ZÀ-ɏ]+/));
      for (const n of needles) {
        // Whole-word match for short values, substring match for long ones (e.g. IDs embedded in text).
        if (tokens.has(n) || (n.length >= 6 && v.includes(n))) {
          leaks.push({ path: row.path, name: row.name, value: row.value, match: n });
          break;
        }
      }
    }
    for (const tag of ds.keys()) {
      if ((tag >>> 16) & 1) { leaks.push({ path: D().fmtTag(tag), name: 'Private tag', value: '', match: 'private tag present' }); break; }
    }
    return leaks;
  }

  DA.anon = { anonymise, flatten, identifiers, findLeaks, newUID, randomValue };
})();
