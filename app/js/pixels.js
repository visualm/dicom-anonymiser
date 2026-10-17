// Pixel data: frame extraction, decoding (native, RLE, JPEG, JPEG lossless,
// JPEG-LS, JPEG 2000), rendering for display, and burning in redaction boxes.
(function () {
  'use strict';
  const DA = (window.DA = window.DA || {});
  const D = () => DA.dicom;

  const TSX = {
    RLE: '1.2.840.10008.1.2.5',
    JPEG_BASELINE: '1.2.840.10008.1.2.4.50',
    JPEG_EXTENDED: '1.2.840.10008.1.2.4.51',
    JPEG_PROGRESSIVE: '1.2.840.10008.1.2.4.55',
    JPEG_LOSSLESS: '1.2.840.10008.1.2.4.57',
    JPEG_LOSSLESS_SV1: '1.2.840.10008.1.2.4.70',
    JPEGLS: '1.2.840.10008.1.2.4.80',
    JPEGLS_NEAR: '1.2.840.10008.1.2.4.81',
    J2K_LOSSLESS: '1.2.840.10008.1.2.4.90',
    J2K: '1.2.840.10008.1.2.4.91',
  };
  const LOSSY_TS = new Set([TSX.JPEG_BASELINE, TSX.JPEG_EXTENDED, TSX.JPEG_PROGRESSIVE, TSX.JPEGLS_NEAR, TSX.J2K]);
  const NATIVE_TS = new Set([D().TS.IMPLICIT, D().TS.EXPLICIT, D().TS.BIG, D().TS.DEFLATE]);

  function tsName(ts) {
    const names = {
      '1.2.840.10008.1.2': 'Implicit VR Little Endian', '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
      '1.2.840.10008.1.2.2': 'Explicit VR Big Endian', '1.2.840.10008.1.2.1.99': 'Deflated', [TSX.RLE]: 'RLE Lossless',
      [TSX.JPEG_BASELINE]: 'JPEG Baseline', [TSX.JPEG_EXTENDED]: 'JPEG Extended', [TSX.JPEG_PROGRESSIVE]: 'JPEG Progressive',
      [TSX.JPEG_LOSSLESS]: 'JPEG Lossless', [TSX.JPEG_LOSSLESS_SV1]: 'JPEG Lossless SV1', [TSX.JPEGLS]: 'JPEG-LS Lossless',
      [TSX.JPEGLS_NEAR]: 'JPEG-LS Near-lossless', [TSX.J2K_LOSSLESS]: 'JPEG 2000 Lossless', [TSX.J2K]: 'JPEG 2000',
    };
    return names[ts] || (ts.startsWith('1.2.840.10008.1.2.4.10') ? 'Video (MPEG/HEVC)' : ts);
  }
  function canDecode(ts) {
    return NATIVE_TS.has(ts) || Object.values(TSX).includes(ts);
  }

  function info(ds) {
    const n = (t, d) => D().getNumber(ds, t, d);
    const photometric = D().getString(ds, 0x00280004, '') || 'MONOCHROME2';
    const ww = D().getNumbers(ds, 0x00281051);
    const wc = D().getNumbers(ds, 0x00281050);
    return {
      rows: n(0x00280010, 0),
      cols: n(0x00280011, 0),
      spp: n(0x00280002, 1),
      bitsAllocated: n(0x00280100, 16),
      bitsStored: n(0x00280101, n(0x00280100, 16)),
      signed: n(0x00280103, 0) === 1,
      planar: n(0x00280006, 0),
      photometric,
      frames: Math.max(1, n(0x00280008, 1) | 0),
      slope: n(0x00281053, 1) || 1,
      intercept: n(0x00281052, 0),
      wc: wc.length ? wc[0] : null,
      ww: ww.length ? ww[0] : null,
      hasPixels: ds.has(D().TAG.PixelData),
    };
  }

  // Reasons why a series is likely to contain burned-in identifying text.
  function riskReasons(ds) {
    const reasons = [];
    const s = (t) => D().getString(ds, t, '').toUpperCase();
    if (s(0x00280301) === 'YES') reasons.push('Burned In Annotation = YES');
    const mod = s(0x00080060);
    if (mod === 'US') reasons.push('Ultrasound (usually has text overlays)');
    if (['SC', 'OT', 'DOC', 'XC', 'ES', 'GM'].includes(mod)) reasons.push('Modality ' + mod + ' (captured image or document)');
    const cls = s(0x00080016);
    if (cls.startsWith('1.2.840.10008.5.1.4.1.1.7') || cls === '1.2.840.10008.5.1.4.1.1.104.1') reasons.push('Secondary capture or encapsulated document');
    const type = s(0x00080008);
    if (/SCREEN SAVE|SECONDARY/.test(type)) reasons.push('Image Type ' + type.replace(/\\/g, '/'));
    return [...new Set(reasons)];
  }

  // ---- encapsulated fragments -> frames ----
  function concat(arrs) {
    if (arrs.length === 1) return arrs[0];
    const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
    let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  }
  function encodedFrames(el, nFrames) {
    const bot = el.frags[0];
    const frags = el.frags.slice(1);
    if (nFrames <= 1) return [concat(frags)];
    if (frags.length === nFrames) return frags;
    if (bot && bot.length >= 4 * nFrames) {
      const dv = new DataView(bot.buffer, bot.byteOffset, bot.byteLength);
      const offsets = [];
      for (let i = 0; i < nFrames; i++) offsets.push(dv.getUint32(i * 4, true));
      const frames = offsets.map(() => []);
      let pos = 0;
      for (const f of frags) {
        let idx = 0;
        while (idx + 1 < nFrames && offsets[idx + 1] <= pos) idx++;
        frames[idx].push(f);
        pos += 8 + f.length;
      }
      return frames.map(concat);
    }
    // No offset table: start a new frame at each JPEG SOI / J2K SOC marker.
    const frames = [];
    for (const f of frags) {
      const start = f[0] === 0xff && (f[1] === 0xd8 || f[1] === 0x4f);
      if (start || !frames.length) frames.push([f]);
      else frames[frames.length - 1].push(f);
    }
    return frames.map(concat);
  }

  // ---- codecs ----
  const codecPromises = {};
  function codec(key) {
    if (!codecPromises[key]) {
      const c = window.DA_CODECS[key];
      const bin = Uint8Array.from(atob(c.wasm), (ch) => ch.charCodeAt(0));
      codecPromises[key] = c.factory({ wasmBinary: bin, print() {}, printErr() {} });
    }
    return codecPromises[key];
  }
  async function wasmDecode(key, cls, bytes) {
    const m = await codec(key);
    const dec = new m[cls]();
    try {
      dec.getEncodedBuffer(bytes.length).set(bytes);
      dec.decode();
      const fi = dec.getFrameInfo();
      const out = dec.getDecodedBuffer().slice();
      const interleave = typeof dec.getInterleaveMode === 'function' ? dec.getInterleaveMode() : 1;
      return { fi, bytes: out, interleave };
    } finally {
      dec.delete();
    }
  }

  // Mirrors libjpeg's colour space guess for 3-component images.
  function jpegAssumesYCbCr(b) {
    let i = 2;
    let ids = null;
    while (i + 4 < b.length && b[i] === 0xff) {
      const m = b[i + 1];
      const len = (b[i + 2] << 8) | b[i + 3];
      if (m === 0xe0 && b[i + 4] === 0x4a) return true; // JFIF
      if (m === 0xee && b[i + 4] === 0x41) return b[i + 15] !== 0; // Adobe transform flag
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) ids = [b[i + 10], b[i + 13], b[i + 16]];
      if (m === 0xda) break;
      i += 2 + len;
    }
    return !(ids && ids[0] === 82 && ids[1] === 71 && ids[2] === 66);
  }
  // Marks a JPEG stream as untransformed RGB: hides any JFIF marker and adds an Adobe APP14 (transform 0).
  function markAsRGB(b) {
    const out = new Uint8Array(b.length + 16);
    out.set([0xff, 0xd8, 0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00]);
    out.set(b.subarray(2), 18);
    let i = 18;
    while (i + 4 < out.length && out[i] === 0xff) {
      const m = out[i + 1];
      if (m === 0xe0 && out[i + 4] === 0x4a) out[i + 1] = 0xef;
      if (m === 0xda) break;
      i += 2 + ((out[i + 2] << 8) | out[i + 3]);
    }
    return out.subarray(0, b.length + 16);
  }

  function decodeRLE(bytes, inf) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const nSeg = dv.getUint32(0, true);
    const px = inf.rows * inf.cols;
    const bps = inf.bitsAllocated / 8;
    const out = new Uint8Array(px * inf.spp * bps);
    for (let s = 0; s < nSeg; s++) {
      const start = dv.getUint32(4 + s * 4, true);
      const end = s + 1 < nSeg ? dv.getUint32(8 + s * 4, true) : bytes.length;
      const sample = Math.floor(s / bps);
      const byteInSample = bps - 1 - (s % bps); // segments are MSB first
      let o = 0;
      let i = start;
      const stride = inf.spp * bps;
      const base = sample * bps + byteInSample;
      while (i < end && o < px) {
        const n = (bytes[i] << 24) >> 24;
        i++;
        if (n >= 0) {
          for (let k = 0; k <= n && o < px; k++) out[base + (o++) * stride] = bytes[i++];
        } else if (n > -128) {
          const v = bytes[i++];
          for (let k = 0; k < 1 - n && o < px; k++) out[base + (o++) * stride] = v;
        }
      }
    }
    return out; // interleaved, little endian
  }

  function typed(bytes, bitsAllocated, signed) {
    const buf = bytes.byteOffset % 4 === 0 && bytes.byteLength % 4 === 0 ? bytes : bytes.slice();
    if (bitsAllocated <= 8) return signed ? new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;
    if (bitsAllocated === 16) {
      const b = buf.byteOffset % 2 ? buf.slice() : buf;
      return signed ? new Int16Array(b.buffer, b.byteOffset, b.byteLength >> 1) : new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
    }
    const b = buf.byteOffset % 4 ? buf.slice() : buf;
    return signed ? new Int32Array(b.buffer, b.byteOffset, b.byteLength >> 2) : new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
  }

  function planarToInterleaved(arr, px, spp) {
    const out = new arr.constructor(arr.length);
    for (let s = 0; s < spp; s++) for (let i = 0; i < px; i++) out[i * spp + s] = arr[s * px + i];
    return out;
  }

  function nativeFrameBytes(inf) {
    if (inf.photometric === 'YBR_FULL_422') return inf.rows * inf.cols * 2;
    return Math.ceil((inf.rows * inf.cols * inf.spp * inf.bitsAllocated) / 8);
  }

  // Expands uncompressed YBR_FULL_422 (Y0 Y1 Cb Cr) to interleaved YBR_FULL.
  function expand422(bytes, inf) {
    const out = new Uint8Array(inf.rows * inf.cols * 3);
    for (let i = 0, o = 0; i + 3 < bytes.length; i += 4, o += 6) {
      out[o] = bytes[i]; out[o + 1] = bytes[i + 2]; out[o + 2] = bytes[i + 3];
      out[o + 3] = bytes[i + 1]; out[o + 4] = bytes[i + 2]; out[o + 5] = bytes[i + 3];
    }
    return out;
  }

  // Decodes one frame into {data (interleaved typed array), photometric, bitsAllocated, signed, spp}
  async function decodeFrame(parsed, index) {
    const ds = parsed.ds;
    const inf = info(ds);
    const el = ds.get(D().TAG.PixelData);
    if (!el) throw new Error('No pixel data');
    const ts = parsed.ts;
    const px = inf.rows * inf.cols;
    let photometric = inf.photometric;
    let data;
    let bits = inf.bitsAllocated;
    let signed = inf.signed;

    if (!el.frags) {
      if (bits === 1) throw new Error('1-bit images are not supported');
      const fb = nativeFrameBytes(inf);
      const bytes = el.value.subarray(index * fb, (index + 1) * fb);
      if (bytes.length < fb) throw new Error('Pixel data shorter than expected');
      if (photometric === 'YBR_FULL_422') { data = expand422(bytes, inf); photometric = 'YBR_FULL'; }
      else {
        data = typed(bytes, bits, signed);
        if (inf.spp > 1 && inf.planar === 1) data = planarToInterleaved(data, px, inf.spp);
      }
    } else {
      const frame = encodedFrames(el, inf.frames)[index];
      if (!frame) throw new Error('Frame ' + (index + 1) + ' not found');
      if (ts === TSX.RLE) {
        data = typed(decodeRLE(frame, inf), bits, signed);
      } else if (ts === TSX.JPEG_LOSSLESS || ts === TSX.JPEG_LOSSLESS_SV1) {
        const dec = new window.DA_CODECS.lossless.Decoder();
        const nb = bits > 8 ? 2 : 1;
        const copy = frame.slice();
        const out = dec.decode(copy.buffer, 0, copy.length, nb);
        data = out.subarray(0, px * inf.spp);
        if (signed) data = nb === 2 ? new Int16Array(data.buffer, data.byteOffset, data.length) : new Int8Array(data.buffer, data.byteOffset, data.length);
      } else if (ts === TSX.JPEG_BASELINE || ts === TSX.JPEG_EXTENDED || ts === TSX.JPEG_PROGRESSIVE) {
        if (inf.bitsStored > 8) throw new Error('12-bit JPEG Extended is not supported');
        // libjpeg assumes YCbCr unless markers say otherwise; DICOM "RGB" means no transform was applied.
        const src = inf.spp === 3 && inf.photometric === 'RGB' && jpegAssumesYCbCr(frame) ? markAsRGB(frame) : frame;
        const r = await wasmDecode('jpeg', 'JPEGDecoder', src);
        data = r.bytes; bits = 8; signed = false;
        if (inf.spp === 3) photometric = 'RGB';
      } else if (ts === TSX.JPEGLS || ts === TSX.JPEGLS_NEAR) {
        const r = await wasmDecode('jpegls', 'JpegLSDecoder', frame);
        bits = r.fi.bitsPerSample > 8 ? 16 : 8;
        data = typed(r.bytes, bits, signed);
        if (inf.spp > 1 && r.interleave === 0) data = planarToInterleaved(data, px, inf.spp);
      } else if (ts === TSX.J2K || ts === TSX.J2K_LOSSLESS) {
        const r = await wasmDecode('j2k', 'J2KDecoder', frame);
        bits = r.fi.bitsPerSample > 8 ? 16 : 8;
        signed = !!r.fi.isSigned;
        data = typed(r.bytes, bits, signed);
        if (/YBR_(ICT|RCT)/.test(photometric) || (inf.spp === 3 && photometric === 'YBR_FULL_422')) photometric = 'RGB';
      } else {
        throw new Error('Cannot decode ' + tsName(ts));
      }
      if (photometric === 'YBR_FULL_422') photometric = 'YBR_FULL';
    }
    return { data, rows: inf.rows, cols: inf.cols, spp: inf.spp, photometric, bitsAllocated: bits, bitsStored: Math.min(inf.bitsStored, bits), signed };
  }

  // ---- rendering ----
  function storedValue(frame, v) {
    // Mask unused high bits / sign-extend stored bits.
    const bs = frame.bitsStored;
    if (bs >= frame.bitsAllocated || bs >= 32) return v;
    if (frame.signed) { const sh = 32 - bs; return (v << sh) >> sh; }
    return v & ((1 << bs) - 1);
  }

  function minMax(frame, inf) {
    const d = frame.data;
    let lo = Infinity;
    let hi = -Infinity;
    const step = d.length > 4e6 ? 4 : 1;
    for (let i = 0; i < d.length; i += step) {
      const v = storedValue(frame, d[i]);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return { lo: lo * inf.slope + inf.intercept, hi: hi * inf.slope + inf.intercept, rawLo: lo, rawHi: hi };
  }

  function defaultWindow(frame, inf) {
    if (inf.wc !== null && inf.ww !== null && inf.ww > 1) return { c: inf.wc, w: inf.ww };
    const mm = minMax(frame, inf);
    return { c: (mm.lo + mm.hi) / 2, w: Math.max(1, mm.hi - mm.lo) };
  }

  function paletteLUT(ds) {
    const luts = [];
    for (const [desc, data] of [[0x00281101, 0x00281201], [0x00281102, 0x00281202], [0x00281103, 0x00281203]]) {
      const de = ds.get(desc);
      const da = ds.get(data);
      if (!de || !da || !da.value) return null;
      const dv = new DataView(de.value.buffer, de.value.byteOffset, de.value.byteLength);
      const n = dv.getUint16(0, true) || 65536;
      const first = de.vr === 'SS' ? dv.getInt16(2, true) : dv.getUint16(2, true);
      const bits = dv.getUint16(4, true);
      const vals = new Uint8Array(n);
      const ddv = new DataView(da.value.buffer, da.value.byteOffset, da.value.byteLength);
      for (let i = 0; i < n; i++) {
        if (da.value.length >= n * 2) {
          const w = ddv.getUint16(i * 2, true);
          vals[i] = bits === 16 ? w >> 8 : (w > 255 ? w >> 8 : w);
        } else vals[i] = da.value[i] || 0;
      }
      luts.push({ first, vals });
    }
    return luts;
  }

  // Renders a decoded frame into an ImageData-like RGBA buffer.
  function render(frame, inf, win, ds, rgba) {
    const px = frame.rows * frame.cols;
    const out = rgba || new Uint8ClampedArray(px * 4);
    const d = frame.data;
    if (frame.spp === 1 && frame.photometric === 'PALETTE COLOR' && ds) {
      const lut = paletteLUT(ds);
      if (lut) {
        for (let i = 0; i < px; i++) {
          for (let c = 0; c < 3; c++) {
            const L = lut[c];
            const idx = Math.min(L.vals.length - 1, Math.max(0, storedValue(frame, d[i]) - L.first));
            out[i * 4 + c] = L.vals[idx];
          }
          out[i * 4 + 3] = 255;
        }
        return out;
      }
    }
    if (frame.spp === 1) {
      const invert = frame.photometric === 'MONOCHROME1';
      const lo = win.c - win.w / 2;
      const scale = 255 / win.w;
      const s = inf.slope;
      const b = inf.intercept;
      for (let i = 0; i < px; i++) {
        let g = ((storedValue(frame, d[i]) * s + b) - lo) * scale;
        g = g < 0 ? 0 : g > 255 ? 255 : g;
        if (invert) g = 255 - g;
        const o = i * 4;
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = 255;
      }
      return out;
    }
    const shift = frame.bitsAllocated > 8 ? frame.bitsStored - 8 : 0;
    const ybr = frame.photometric.startsWith('YBR_FULL');
    for (let i = 0; i < px; i++) {
      let r = d[i * 3] >> shift;
      let g = d[i * 3 + 1] >> shift;
      let bl = d[i * 3 + 2] >> shift;
      if (ybr) {
        const y = r; const cb = g - 128; const cr = bl - 128;
        r = y + 1.402 * cr; g = y - 0.344136 * cb - 0.714136 * cr; bl = y + 1.772 * cb;
      }
      const o = i * 4;
      out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = 255;
    }
    return out;
  }

  // ---- redaction ----
  function clipBox(b, rows, cols) {
    const x0 = Math.max(0, Math.floor(Math.min(b.x, b.x + b.w)));
    const y0 = Math.max(0, Math.floor(Math.min(b.y, b.y + b.h)));
    const x1 = Math.min(cols, Math.ceil(Math.max(b.x, b.x + b.w)));
    const y1 = Math.min(rows, Math.ceil(Math.max(b.y, b.y + b.h)));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  }

  // Fill value per sample that displays as black (or white) for this frame.
  function fillValues(frame, ds, white) {
    const p = frame.photometric;
    if (frame.spp === 3) {
      const shift = frame.bitsStored > 8 ? frame.bitsStored - 8 : 0;
      const max = (1 << Math.min(frame.bitsStored, 16)) - 1;
      const mid = 128 << shift;
      if (p.startsWith('YBR')) return [white ? max : 0, mid, mid];
      return white ? [max, max, max] : [0, 0, 0];
    }
    if (p === 'PALETTE COLOR' && ds) {
      const lut = paletteLUT(ds);
      if (lut) {
        let best = 0; let bestSum = white ? -Infinity : Infinity;
        for (let i = 0; i < lut[0].vals.length; i++) {
          const sum = lut[0].vals[i] + (lut[1].vals[i] || 0) + (lut[2].vals[i] || 0);
          if (white ? sum > bestSum : sum < bestSum) { bestSum = sum; best = i; }
        }
        return [best + lut[0].first];
      }
      return [white ? 255 : 0];
    }
    // Greyscale: use the darkest / brightest value present in this frame.
    const mm = minMax(Object.assign({}, frame), { slope: 1, intercept: 0 });
    const inverted = p === 'MONOCHROME1';
    return [white !== inverted ? mm.rawHi : mm.rawLo];
  }

  // box.fill: 'black' (default) or 'white'
  function fillTyped(frame, boxes, ds) {
    const fills = {};
    const { rows, cols, spp, data } = frame;
    for (const b of boxes) {
      const c = clipBox(b, rows, cols);
      if (!c) continue;
      const white = b.fill === 'white';
      const key = white ? 'w' : 'b';
      if (!fills[key]) fills[key] = fillValues(frame, ds, white);
      const fill = fills[key];
      for (let y = c.y0; y < c.y1; y++) {
        for (let x = c.x0; x < c.x1; x++) {
          const i = (y * cols + x) * spp;
          for (let s = 0; s < spp; s++) data[i + s] = fill[s];
        }
      }
    }
  }

  // Burns boxes into the parsed file. boxesByFrame: Map<frameIndex, box[]>.
  // Modifies parsed.ds and returns the transfer syntax to write with.
  async function redact(parsed, boxesByFrame) {
    const ds = parsed.ds;
    const inf = info(ds);
    const el = ds.get(D().TAG.PixelData);
    if (!el || !boxesByFrame.size) return parsed.ts;
    if (!canDecode(parsed.ts)) throw new Error('Cannot redact ' + tsName(parsed.ts) + ' images');

    if (!el.frags) {
      // Uncompressed: edit the stored pixel bytes in place.
      if (inf.bitsAllocated === 1) throw new Error('1-bit images cannot be redacted');
      const fb = nativeFrameBytes(inf);
      const value = el.value.slice();
      for (const [fi, boxes] of boxesByFrame) {
        const bytes = value.subarray(fi * fb, (fi + 1) * fb);
        if (inf.photometric === 'YBR_FULL_422') {
          for (const b of boxes) {
            const c = clipBox(b, inf.rows, inf.cols);
            if (!c) continue;
            const y422 = b.fill === 'white' ? 255 : 0;
            const x0 = c.x0 & ~1;
            const x1 = Math.min(inf.cols, (c.x1 + 1) & ~1);
            for (let y = c.y0; y < c.y1; y++) {
              for (let x = x0; x < x1; x += 2) {
                const i = (y * inf.cols + x) * 2;
                bytes[i] = y422; bytes[i + 1] = y422; bytes[i + 2] = 128; bytes[i + 3] = 128;
              }
            }
          }
          continue;
        }
        let arr = typed(bytes, inf.bitsAllocated, inf.signed);
        const copied = arr.buffer !== value.buffer;
        const planar = inf.spp > 1 && inf.planar === 1;
        if (planar) arr = planarToInterleaved(arr, inf.rows * inf.cols, inf.spp);
        const frame = { data: arr, rows: inf.rows, cols: inf.cols, spp: inf.spp, photometric: inf.photometric, bitsAllocated: inf.bitsAllocated, bitsStored: inf.bitsStored, signed: inf.signed };
        fillTyped(frame, boxes, ds);
        if (planar) {
          const px = inf.rows * inf.cols;
          const back = new arr.constructor(arr.length);
          for (let s = 0; s < inf.spp; s++) for (let i = 0; i < px; i++) back[s * px + i] = arr[i * inf.spp + s];
          arr = back;
        }
        if (copied || planar) bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
      }
      el.value = value;
      return D().TS.EXPLICIT; // native data is always written as explicit VR little endian
    }

    // Compressed: decode every frame, burn boxes, store uncompressed.
    const frames = [];
    let first;
    for (let i = 0; i < inf.frames; i++) {
      const f = await decodeFrame(parsed, i);
      if (!first) first = f;
      const boxes = boxesByFrame.get(i);
      if (boxes) fillTyped(f, boxes, ds);
      frames.push(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength));
    }
    let pixel = concat(frames);
    if (pixel === frames[0]) pixel = pixel.slice();
    ds.set(D().TAG.PixelData, { tag: D().TAG.PixelData, vr: first.bitsAllocated > 8 ? 'OW' : 'OB', value: pixel });
    ds.delete(0x7fe00001); // Extended Offset Table
    ds.delete(0x7fe00002);
    D().setUint16(ds, 0x00280100, first.bitsAllocated);
    D().setUint16(ds, 0x00280101, first.bitsStored);
    D().setUint16(ds, 0x00280102, first.bitsStored - 1);
    D().setString(ds, 0x00280004, 'CS', first.photometric, '');
    if (inf.spp > 1) D().setUint16(ds, 0x00280006, 0);
    if (LOSSY_TS.has(parsed.ts)) {
      D().setString(ds, 0x00282110, 'CS', '01', '');
    }
    return D().TS.EXPLICIT;
  }

  DA.pixels = { TSX, info, riskReasons, decodeFrame, render, defaultWindow, redact, canDecode, tsName, encodedFrames };
})();
