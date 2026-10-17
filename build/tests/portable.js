// Opens an unzipped portable copy via file:// in Edge and checks that it starts and the codecs load.
// Usage: node tests/portable.js <folder containing index.html>
const puppeteer = require('puppeteer-core');
const path = require('path');
(async () => {
  const dir = path.resolve(process.argv[2]);
  const b = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const pg = await b.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await pg.goto('file:///' + path.join(dir, 'index.html').split(path.sep).join('/'));
  const r = await pg.evaluate(async () => {
    const out = { title: document.querySelector('.big').textContent, secure: isSecureContext };
    for (const k of ['jpeg', 'jpegls', 'j2k']) {
      const c = DA_CODECS[k];
      const m = await c.factory({ wasmBinary: Uint8Array.from(atob(c.wasm), (x) => x.charCodeAt(0)) });
      out[k] = Object.keys(m).some((x) => /Decoder/.test(x));
    }
    return out;
  });
  console.log(r, errs.length ? errs : 'no errors');
  await b.close();
})();
