// Minimal DICOM Part 10 reader/writer.
// Reads implicit/explicit little endian, explicit big endian, deflated and all
// encapsulated (compressed) transfer syntaxes. Writes explicit VR little endian
// (keeping encapsulated pixel data untouched when it was not redacted).
(function () {
  'use strict';
  const DA = (window.DA = window.DA || {});

  const TS = {
    IMPLICIT: '1.2.840.10008.1.2',
    EXPLICIT: '1.2.840.10008.1.2.1',
    DEFLATE: '1.2.840.10008.1.2.1.99',
    BIG: '1.2.840.10008.1.2.2',
  };
  const TAG = {
    PixelData: 0x7fe00010,
    Item: 0xfffee000,
    ItemDelim: 0xfffee00d,
    SeqDelim: 0xfffee0dd,
  };
  const LONG_VR = new Set(['OB', 'OD', 'OF', 'OL', 'OV', 'OW', 'SQ', 'UC', 'UN', 'UR', 'UT', 'SV', 'UV']);
  const STRING_VR = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
  const VALID_VR = new Set([...LONG_VR, ...STRING_VR, 'AT', 'FD', 'FL', 'SL', 'SS', 'UL', 'US']);
  // Byte size of one value for VRs that need swapping when reading big endian.
  const SWAP_SIZE = { US: 2, SS: 2, OW: 2, AT: 2, UL: 4, SL: 4, FL: 4, OF: 4, OL: 4, FD: 8, OD: 8, SV: 8, UV: 8, OV: 8 };

  function hex(tag) {
    return (tag >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
  function fmtTag(tag) {
    const h = hex(tag);
    return '(' + h.slice(0, 4) + ',' + h.slice(4) + ')';
  }

  // Dictionary lookup -> {vr, name}. Handles repeating groups, group lengths and private tags.
  function lookup(tag) {
    const g = tag >>> 16;
    const e = tag & 0xffff;
    let entry = window.DA_DICT[hex(tag)];
    if (!entry && (g & 0xff00) === 0x5000 && !(g & 1)) entry = window.DA_DICT[hex(0x50000000 + e)];
    if (!entry && (g & 0xff00) === 0x6000 && !(g & 1)) entry = window.DA_DICT[hex(0x60000000 + e)];
    if (entry) {
      const i = entry.indexOf('|');
      return { vr: entry.slice(0, i), name: entry.slice(i + 1) };
    }
    if (e === 0) return { vr: 'UL', name: 'GroupLength' };
    if (g & 1) {
      if (e >= 0x10 && e <= 0xff) return { vr: 'LO', name: 'PrivateCreator' };
      return { vr: 'UN', name: 'Private tag' };
    }
    return { vr: 'UN', name: 'Unknown' };
  }

  // ---- character sets ----
  const CHARSETS = {
    '': 'windows-1252', 'ISO_IR 6': 'windows-1252', 'ISO_IR 100': 'windows-1252', 'ISO_IR 192': 'utf-8',
    'ISO_IR 101': 'iso-8859-2', 'ISO_IR 109': 'iso-8859-3', 'ISO_IR 110': 'iso-8859-4', 'ISO_IR 144': 'iso-8859-5',
    'ISO_IR 127': 'iso-8859-6', 'ISO_IR 126': 'iso-8859-7', 'ISO_IR 138': 'iso-8859-8', 'ISO_IR 148': 'windows-1254',
    'ISO_IR 166': 'windows-874', 'ISO_IR 13': 'shift_jis', 'GB18030': 'gb18030', 'GBK': 'gbk',
  };
  const decoders = {};
  function textDecoder(charset) {
    const first = (charset || '').split('\\').filter(Boolean).pop() || '';
    const label = CHARSETS[first.replace('ISO 2022 IR', 'ISO_IR').trim()] || 'windows-1252';
    if (!decoders[label]) {
      try { decoders[label] = new TextDecoder(label); } catch (e) { decoders[label] = new TextDecoder('windows-1252'); }
    }
    return decoders[label];
  }
  function decodeText(bytes, charset, vr) {
    if (!bytes || !bytes.length) return '';
    const dec = vr === 'UI' || vr === 'DA' || vr === 'TM' || vr === 'CS' || vr === 'DS' || vr === 'IS' || vr === 'AS'
      ? textDecoder('') : textDecoder(charset);
    return dec.decode(bytes).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  }
  function encodeText(str, charset, vr) {
    let bytes;
    if (/ISO_IR 192/.test(charset || '') && vr !== 'UI') {
      bytes = new TextEncoder().encode(str);
    } else {
      bytes = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        bytes[i] = c < 256 ? c : 63; // '?'
      }
    }
    if (bytes.length & 1) {
      const p = new Uint8Array(bytes.length + 1);
      p.set(bytes);
      p[bytes.length] = vr === 'UI' ? 0 : 32;
      bytes = p;
    }
    return bytes;
  }

  // ---- reading ----
  class Reader {
    constructor(bytes, little) {
      this.b = bytes;
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.le = little;
      this.pos = 0;
    }
    u16() { const v = this.dv.getUint16(this.pos, this.le); this.pos += 2; return v; }
    u32() { const v = this.dv.getUint32(this.pos, this.le); this.pos += 4; return v; }
    tag() { const g = this.u16(); const e = this.u16(); return g * 65536 + e; }
    str(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.pos + i]); this.pos += n; return s; }
  }

  function swapCopy(bytes, size) {
    const out = new Uint8Array(bytes.length);
    for (let i = 0; i + size <= bytes.length; i += size) {
      for (let k = 0; k < size; k++) out[i + k] = bytes[i + size - 1 - k];
    }
    return out;
  }

  function readElementHeader(r, explicit) {
    const tag = r.tag();
    if (tag >>> 16 === 0xfffe) return { tag, vr: null, len: r.u32() };
    let vr;
    let len;
    if (explicit) {
      vr = r.str(2);
      if (VALID_VR.has(vr)) {
        if (LONG_VR.has(vr)) { r.pos += 2; len = r.u32(); } else len = r.u16();
      } else {
        // Not a valid VR: some writers switch to implicit for single elements.
        r.pos -= 2;
        vr = lookup(tag).vr;
        len = r.u32();
      }
    } else {
      vr = lookup(tag).vr;
      len = r.u32();
    }
    return { tag, vr, len };
  }

  // Parses elements until `end` (or an item delimiter). Returns the dataset Map.
  function parseDataset(r, end, explicit, opts) {
    const ds = new Map();
    while (r.pos + 8 <= end) {
      const start = r.pos;
      const h = readElementHeader(r, explicit);
      if (h.tag === TAG.ItemDelim) break;
      if (h.tag === TAG.SeqDelim || h.tag === TAG.Item) { r.pos = start; break; }
      const undef = h.len === 0xffffffff;
      const el = { tag: h.tag, vr: h.vr };
      if (h.tag === TAG.PixelData && opts.skipPixelData) {
        // Header-only read: record pixel data and stop (nothing relevant follows it).
        el.value = null;
        el.encapsulated = undef;
        el.length = undef ? 0 : h.len;
        ds.set(h.tag, el);
        r.pos = r.b.length;
        break;
      }
      if (h.tag === TAG.PixelData && undef) {
        el.vr = 'OB';
        el.frags = parseFragments(r);
        el.pixelOffset = start;
      } else if (h.vr === 'SQ' || (undef && h.vr === 'UN')) {
        // Undefined-length UN is an implicit-VR little-endian sequence (PS3.5 6.2.2).
        const seqExplicit = h.vr === 'UN' ? false : explicit;
        if (h.vr === 'UN') el.vr = 'SQ';
        el.items = parseItems(r, undef ? Infinity : r.pos + h.len, seqExplicit, opts);
      } else {
        if (undef) throw new Error('Undefined length for ' + fmtTag(h.tag) + ' ' + h.vr);
        if (r.pos + h.len > r.b.length) throw new Error('Element ' + fmtTag(h.tag) + ' runs past end of file');
        let v = r.b.subarray(r.pos, r.pos + h.len);
        if (!r.le && SWAP_SIZE[h.vr]) {
          let size = SWAP_SIZE[h.vr];
          if (h.tag === TAG.PixelData && opts.bitsAllocated === 8) size = 1;
          if (size > 1) v = swapCopy(v, size);
        }
        if (h.tag === TAG.PixelData) {
          el.pixelOffset = start;
          if (opts.skipPixelData) { el.value = null; el.length = h.len; } else el.value = v;
        } else {
          el.value = opts.copyValues && v.buffer === r.b.buffer ? v.slice() : v;
        }
        if (h.tag === 0x00280100 && el.value && el.value.length >= 2) {
          opts.bitsAllocated = el.value[0] | (el.value[1] << 8); // already little endian
        }
        r.pos += h.len;
      }
      ds.set(h.tag, el);
    }
    return ds;
  }

  function parseItems(r, end, explicit, opts) {
    const items = [];
    while (r.pos < end && r.pos + 8 <= r.b.length) {
      const tag = r.tag();
      const len = r.u32();
      if (tag === TAG.SeqDelim) break;
      if (tag !== TAG.Item) throw new Error('Expected sequence item, found ' + fmtTag(tag));
      if (len === 0xffffffff) {
        items.push(parseDataset(r, r.b.length, explicit, opts));
      } else {
        const itemEnd = r.pos + len;
        items.push(parseDataset(r, itemEnd, explicit, opts));
        r.pos = itemEnd;
      }
    }
    return items;
  }

  function parseFragments(r) {
    const frags = [];
    while (r.pos + 8 <= r.b.length) {
      const tag = r.tag();
      const len = r.u32();
      if (tag === TAG.SeqDelim) break;
      if (tag !== TAG.Item) throw new Error('Bad pixel data fragment');
      frags.push(r.b.subarray(r.pos, r.pos + len));
      r.pos += len;
    }
    return frags;
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Quick check whether a buffer looks like a DICOM file.
  function sniff(bytes) {
    if (bytes.length >= 132 && bytes[128] === 68 && bytes[129] === 73 && bytes[130] === 67 && bytes[131] === 77) return 'part10';
    if (bytes.length >= 8) {
      const g = bytes[0] | (bytes[1] << 8);
      if (g === 0x0002 || g === 0x0008) return 'raw';
    }
    return null;
  }

  // Parses a whole file. Returns {meta, ds, ts, charset}.
  async function parse(buffer, opts) {
    opts = Object.assign({ skipPixelData: false, copyValues: false }, opts || {});
    let bytes = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : new Uint8Array(buffer);
    const kind = sniff(bytes);
    if (!kind) throw new Error('Not a DICOM file');
    let r = new Reader(bytes, true);
    r.pos = kind === 'part10' ? 132 : 0;
    // File meta information (always explicit little endian)
    const meta = new Map();
    while (r.pos + 6 <= bytes.length && r.dv.getUint16(r.pos, true) === 0x0002) {
      const h = readElementHeader(r, true);
      meta.set(h.tag, { tag: h.tag, vr: h.vr, value: bytes.slice(r.pos, r.pos + h.len) });
      r.pos += h.len;
    }
    let ts = meta.has(0x00020010) ? decodeText(meta.get(0x00020010).value, '', 'UI') : '';
    if (!ts) {
      // No meta header: guess explicit vs implicit from the bytes after the first tag.
      const vr = String.fromCharCode(bytes[r.pos + 4] || 0, bytes[r.pos + 5] || 0);
      ts = VALID_VR.has(vr) ? TS.EXPLICIT : TS.IMPLICIT;
    }
    if (ts === TS.DEFLATE) {
      bytes = await inflateRaw(bytes.subarray(r.pos));
      r = new Reader(bytes, true);
    }
    if (ts === TS.BIG) {
      const rest = bytes.subarray(r.pos);
      r = new Reader(rest, false);
    }
    const explicit = ts !== TS.IMPLICIT;
    const ds = parseDataset(r, r.b.length, explicit, opts);
    const csEl = ds.get(0x00080005);
    const charset = csEl ? decodeText(csEl.value, '', 'CS') : '';
    return { meta, ds, ts, charset };
  }

  // ---- writing ----
  class Writer {
    constructor() { this.chunks = []; this.size = 0; }
    push(u8) { this.chunks.push(u8); this.size += u8.length; }
    header(tag, vr, len) {
      const long = !vr || LONG_VR.has(vr);
      const b = new Uint8Array(vr ? (long ? 12 : 8) : 8);
      const dv = new DataView(b.buffer);
      dv.setUint16(0, tag >>> 16, true);
      dv.setUint16(2, tag & 0xffff, true);
      if (!vr) { dv.setUint32(4, len, true); }
      else if (long) { b[4] = vr.charCodeAt(0); b[5] = vr.charCodeAt(1); dv.setUint32(8, len, true); }
      else { b[4] = vr.charCodeAt(0); b[5] = vr.charCodeAt(1); dv.setUint16(6, len, true); }
      this.push(b);
    }
    concat() {
      const out = new Uint8Array(this.size);
      let p = 0;
      for (const c of this.chunks) { out.set(c, p); p += c.length; }
      return out;
    }
  }

  function padValue(el) {
    let v = el.value || new Uint8Array(0);
    if (v.length & 1) {
      const p = new Uint8Array(v.length + 1);
      p.set(v);
      p[v.length] = STRING_VR.has(el.vr) && el.vr !== 'UI' ? 32 : 0;
      v = p;
    }
    return v;
  }

  function writeDataset(w, ds) {
    const tags = [...ds.keys()].sort((a, b) => a - b);
    for (const tag of tags) {
      const el = ds.get(tag);
      if ((tag & 0xffff) === 0) continue; // group lengths are optional; drop them
      if (el.items) {
        w.header(tag, 'SQ', 0xffffffff);
        for (const item of el.items) {
          w.header(TAG.Item, null, 0xffffffff);
          writeDataset(w, item);
          w.header(TAG.ItemDelim, null, 0);
        }
        w.header(TAG.SeqDelim, null, 0);
      } else if (el.frags) {
        w.header(tag, 'OB', 0xffffffff);
        for (const f of el.frags) {
          let frag = f;
          if (frag.length & 1) { frag = new Uint8Array(f.length + 1); frag.set(f); }
          w.header(TAG.Item, null, frag.length);
          w.push(frag);
        }
        w.header(TAG.SeqDelim, null, 0);
      } else {
        const v = padValue(el);
        let vr = el.vr;
        if (!LONG_VR.has(vr) && v.length > 0xfffe) vr = 'UN';
        w.header(tag, vr, v.length);
        w.push(v);
      }
    }
  }

  const IMPLEMENTATION_UID = '2.25.191474018625836520916264151375129476211';
  const IMPLEMENTATION_NAME = 'DICOMANON_1';

  // Builds a complete Part 10 file. Meta header is rebuilt from scratch.
  function write(ds, ts, sopClassUID, sopInstanceUID) {
    const meta = new Map();
    const add = (tag, vr, v) => meta.set(tag, { tag, vr, value: typeof v === 'string' ? encodeText(v, '', vr) : v });
    add(0x00020001, 'OB', new Uint8Array([0, 1]));
    add(0x00020002, 'UI', sopClassUID);
    add(0x00020003, 'UI', sopInstanceUID);
    add(0x00020010, 'UI', ts);
    add(0x00020012, 'UI', IMPLEMENTATION_UID);
    add(0x00020013, 'SH', IMPLEMENTATION_NAME);
    const mw = new Writer();
    writeDataset(mw, meta);
    const metaBytes = mw.concat();

    const w = new Writer();
    const pre = new Uint8Array(132);
    pre.set([68, 73, 67, 77], 128);
    w.push(pre);
    w.header(0x00020000, 'UL', 4);
    const gl = new Uint8Array(4);
    new DataView(gl.buffer).setUint32(0, metaBytes.length, true);
    w.push(gl);
    w.push(metaBytes);
    writeDataset(w, ds);
    return w.concat();
  }

  // ---- value helpers ----
  function getString(ds, tag, charset) {
    const el = ds.get(tag);
    if (!el || !el.value) return '';
    return decodeText(el.value, charset, el.vr);
  }
  function getNumber(ds, tag, def) {
    const el = ds.get(tag);
    if (!el || !el.value || !el.value.length) return def;
    const v = el.value;
    const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
    switch (el.vr) {
      case 'US': return dv.getUint16(0, true);
      case 'SS': return dv.getInt16(0, true);
      case 'UL': return dv.getUint32(0, true);
      case 'SL': return dv.getInt32(0, true);
      case 'FL': return dv.getFloat32(0, true);
      case 'FD': return dv.getFloat64(0, true);
      default: {
        const n = parseFloat(decodeText(v, '', 'DS').split('\\')[0]);
        return isNaN(n) ? def : n;
      }
    }
  }
  function getNumbers(ds, tag) {
    const s = getString(ds, tag, '');
    return s ? s.split('\\').map(Number).filter((n) => !isNaN(n)) : [];
  }
  function setString(ds, tag, vr, str, charset) {
    ds.set(tag, { tag, vr, value: encodeText(str, charset, vr) });
  }
  function setUint16(ds, tag, n) {
    const v = new Uint8Array(2);
    new DataView(v.buffer).setUint16(0, n, true);
    ds.set(tag, { tag, vr: 'US', value: v });
  }

  // Human-readable value for display (truncated for binary / long values).
  function displayValue(el, charset) {
    if (el.items) return el.items.length + ' item(s)';
    if (el.frags) return 'Compressed pixel data, ' + (el.frags.length - 1) + ' fragment(s)';
    if (!el.value) return el.length ? '<' + el.length + ' bytes>' : '';
    const v = el.value;
    if (STRING_VR.has(el.vr)) {
      const s = decodeText(v, charset, el.vr);
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    }
    const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
    const nums = [];
    const step = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, AT: 4 }[el.vr];
    if (step && v.length <= 64) {
      for (let i = 0; i + step <= v.length; i += step) {
        if (el.vr === 'US') nums.push(dv.getUint16(i, true));
        else if (el.vr === 'SS') nums.push(dv.getInt16(i, true));
        else if (el.vr === 'UL') nums.push(dv.getUint32(i, true));
        else if (el.vr === 'SL') nums.push(dv.getInt32(i, true));
        else if (el.vr === 'FL') nums.push(+dv.getFloat32(i, true).toPrecision(6));
        else if (el.vr === 'FD') nums.push(+dv.getFloat64(i, true).toPrecision(8));
        else if (el.vr === 'AT') nums.push(fmtTag(dv.getUint16(i, true) * 65536 + dv.getUint16(i + 2, true)));
      }
      return nums.join('\\');
    }
    if (el.vr === 'UN' && v.length <= 128) {
      // Try showing printable text for unknown / private elements.
      const s = textDecoder('').decode(v).replace(/[\0 ]+$/, '');
      if (/^[\x20-\x7e\xa0-\xff\\]*$/.test(s)) return s;
    }
    return '<' + v.length + ' bytes>';
  }

  DA.dicom = {
    TS, TAG, LONG_VR, STRING_VR, hex, fmtTag, lookup, parse, write, sniff,
    getString, getNumber, getNumbers, setString, setUint16, decodeText, encodeText, displayValue,
  };
})();
