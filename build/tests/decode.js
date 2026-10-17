// Decodes frame 0 (and last frame) of each test file and dumps raw samples for comparison with pydicom.
const DA = require('./load');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'testdata'); const out = path.join(__dirname, '..', 'testout', 'dec'); fs.mkdirSync(out, { recursive: true });
(async () => {
  const meta = {};
  for (const f of fs.readdirSync(dir)) {
    try {
      const p = await DA.dicom.parse(fs.readFileSync(path.join(dir, f)));
      const inf = DA.pixels.info(p.ds);
      if (!inf.hasPixels) continue;
      const fr = await DA.pixels.decodeFrame(p, 0);
      // apply stored-bits masking like pydicom does
      const d = Float64Array.from(fr.data);
      fs.writeFileSync(path.join(out, f + '.bin'), Buffer.from(d.buffer));
      meta[f] = { rows: fr.rows, cols: fr.cols, spp: fr.spp, photometric: fr.photometric, frames: inf.frames, ts: DA.pixels.tsName(p.ts) };
      // also exercise rendering
      DA.pixels.render(fr, inf, DA.pixels.defaultWindow(fr, inf), p.ds);
      if (inf.frames > 1) await DA.pixels.decodeFrame(p, inf.frames - 1);
      console.log('ok  ', f.padEnd(36), meta[f].ts, fr.photometric, fr.data.constructor.name, inf.frames + 'f');
    } catch (e) { console.log('FAIL', f, e.message); }
  }
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta));
})();
