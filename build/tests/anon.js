// Anonymises + redacts every test file with the default profile, writes results for pydicom checks.
const DA = require('./load');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'testdata'); const out = path.join(__dirname, '..', 'testout', 'anon' + (process.env.FILL === 'white' ? '_white' : '')); fs.mkdirSync(out, { recursive: true });
global.localStorage = { getItem() { return null; }, setItem() {} };
(async () => {
  const preset = DA.engine.store.builtinPreset();
  const cfg = { rules: preset.rules, options: preset.options, pseudonym: 'ANON-TEST', presetName: preset.name };
  const ctx = { uidMap: new Map(), valueMap: new Map() };
  const box = { x: 10, y: 10, w: 50, h: 40, fill: process.env.FILL || 'black' };
  for (const f of fs.readdirSync(dir)) {
    if (f === 'DICOMDIR') continue;
    const blob = new Blob([fs.readFileSync(path.join(dir, f))]);
    const p = await DA.dicom.parse(await blob.arrayBuffer());
    const inf = DA.pixels.info(p.ds);
    let boxes = new Map();
    if (inf.hasPixels && DA.pixels.canDecode(p.ts) && inf.bitsAllocated > 1 && !(p.ts.endsWith('.4.51') && inf.bitsStored > 8)) {
      boxes.set(0, [box]);
    }
    try {
      const r = await DA.engine.processFile(blob, cfg, ctx, boxes);
      fs.writeFileSync(path.join(out, f), r.bytes);
      console.log(r.leaks.length ? 'LEAK' : 'ok  ', f.padEnd(36), 'redacted=' + r.redacted, DA.pixels.tsName(r.ts), r.leaks.map(l => l.path + ' ' + l.name + '=' + l.value).join(' | '));
    } catch (e) { console.log('FAIL', f, e.stack); }
  }
})();
