const DA = require('./load');
const fs = require('fs'), path = require('path');
const dir = path.join(__dirname, '..', 'testdata'); const out = path.join(__dirname, '..', 'testout', 'rt'); fs.mkdirSync(out, { recursive: true });
(async () => {
  for (const f of fs.readdirSync(dir)) {
    try {
      const p = await DA.dicom.parse(fs.readFileSync(path.join(dir, f)));
      const ds = p.ds;
      const cls = DA.dicom.getString(ds, 0x00080016), inst = DA.dicom.getString(ds, 0x00080018);
      const ts = ds.get(0x7fe00010) && ds.get(0x7fe00010).frags ? p.ts : DA.dicom.TS.EXPLICIT;
      fs.writeFileSync(path.join(out, f), DA.dicom.write(ds, ts, cls, inst));
      console.log('ok  ', f.padEnd(36), p.ts, ds.size, 'elements');
    } catch (e) { console.log('FAIL', f, e.message); }
  }
})();
