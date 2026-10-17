// Merges patient A of the fake export (4 series) into one stack; checks counter on binary VRs too.
const DA = require('./load');
const fs = require('fs'), path = require('path');
global.localStorage = { getItem() { return null; }, setItem() {} };
const src = path.join(__dirname, '..', 'testexport', 'DICOM');
const out = path.join(__dirname, '..', 'testout', 'stack'); fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
(async () => {
  const files = [];
  for (const d of fs.readdirSync(src)) for (const f of fs.readdirSync(path.join(src, d))) files.push(path.join(src, d, f));
  // study order as the app does it: series number, then instance number
  const items = [];
  for (const p of files) {
    const parsed = await DA.dicom.parse(fs.readFileSync(p), { skipPixelData: true });
    if (!DA.dicom.getString(parsed.ds, 0x00100010).startsWith('MUSTERMANN')) continue;
    items.push({ p, se: DA.dicom.getNumber(parsed.ds, 0x00200011, 0), inst: DA.dicom.getNumber(parsed.ds, 0x00200013, 0) });
  }
  items.sort((a, b) => a.se - b.se || a.inst - b.inst);
  const preset = DA.engine.store.builtinPreset();
  preset.options.mergeStack = true;
  preset.rules['00080050'] = { a: 'counter' }; // AccessionNumber as counter (string VR) for the test
  const ctx = { uidMap: new Map(), valueMap: new Map(), stackUID: DA.anon.newUID() };
  let n = 0;
  for (const it of items) {
    n++;
    const r = await DA.engine.processFile(new Blob([fs.readFileSync(it.p)]), { rules: preset.rules, options: preset.options, pseudonym: 'ANON-0001', counter: n }, ctx, new Map());
    fs.writeFileSync(path.join(out, 'IM' + String(n).padStart(5, '0') + '.dcm'), r.bytes);
  }
  // binary VR counter
  const ds = new Map([[0x00189999, { tag: 0x00189999, vr: 'US', value: new Uint8Array([9, 9]) }], [0x00189998, { tag: 0x00189998, vr: 'UL', value: new Uint8Array(4) }]]);
  DA.anon.anonymise(ds, { rules: { '00189999': { a: 'counter' }, '00189998': { a: 'counter' } }, options: {}, pseudonym: 'X', counter: 300 }, { uidMap: new Map(), valueMap: new Map(), charset: '' });
  console.log('files', n, 'binary US/UL counter ->', DA.dicom.getNumber(ds, 0x00189999), DA.dicom.getNumber(ds, 0x00189998));
})();
