// End-to-end test in the real installed browser, opening app/index.html via file://
// (exactly how it runs on the hospital PC). Folder pickers are replaced by the
// browser's private storage (OPFS), everything else is the real app.
// Usage: node tests/filemode.js [edge|chrome]
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const BROWSERS = {
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
};
const which = process.argv[2] || 'edge';
const appUrl = 'file:///' + path.resolve(__dirname, '..', '..', 'app', 'index.html').replace(/\\/g, '/');
const exportDir = path.join(__dirname, '..', 'testexport');

(async () => {
  const browser = await puppeteer.launch({ executablePath: BROWSERS[which], headless: true, args: ['--no-first-run'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(appUrl);
  const env = await page.evaluate(async () => {
    const out = { secure: window.isSecureContext, fsApi: typeof window.showDirectoryPicker, modules: Object.keys(DA).join(',') };
    try { localStorage.setItem('x', '1'); out.localStorage = localStorage.getItem('x') === '1'; } catch (e) { out.localStorage = e.message; }
    try { await navigator.storage.getDirectory(); out.opfs = true; } catch (e) { out.opfs = e.message; }
    return out;
  });
  console.log(which, 'environment:', env);
  if (env.opfs !== true) { console.log('OPFS not available on file:// - skipping workflow'); await browser.close(); return; }

  // Copy the test export into OPFS
  const files = JSON.parse(fs.readFileSync(path.join(exportDir, 'manifest.json'), 'utf8'));
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    for await (const [n] of root.entries()) await root.removeEntry(n, { recursive: true });
  });
  for (const f of files) {
    const b64 = fs.readFileSync(path.join(exportDir, f)).toString('base64');
    await page.evaluate(async (p, data) => {
      const root = await navigator.storage.getDirectory();
      let d = await root.getDirectoryHandle('PACS', { create: true });
      const parts = p.split('/');
      for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1), { create: true })).createWritable();
      await w.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
      await w.close();
    }, f, b64);
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const click = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);

  await page.evaluate(async () => DA.openFolder(await (await navigator.storage.getDirectory()).getDirectoryHandle('PACS')));
  console.log('studies:', await page.evaluate(() => DA.state.studies.map((s) => s.patientName + ' ' + s.files.length).join(' | ')));
  await click('[data-open]');
  await sleep(500);
  await click('#toImages');
  await sleep(300);
  if (await page.$('#modal:not([hidden])')) { await page.evaluate(() => [...document.querySelectorAll('#modalBox button')].at(-1).click()); }
  await sleep(1500);
  // Draw a box with real mouse events on the canvas
  const r = await page.evaluate(() => { const b = document.getElementById('view').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
  await page.mouse.move(r.x + r.w * 0.3, r.y + r.h * 0.3);
  await page.mouse.down();
  await page.mouse.move(r.x + r.w * 0.5, r.y + r.h * 0.4, { steps: 5 });
  await page.mouse.up();
  console.log('boxes after drag:', await page.evaluate(() => DA.state.cur.boxes.map((b) => `${b.w}x${b.h}@${b.x},${b.y}`)));
  // Visit all series, then review
  const n = await page.evaluate(() => document.querySelectorAll('#seriesList .series').length);
  for (let i = 0; i < n; i++) { await page.evaluate((k) => document.querySelectorAll('#seriesList .series')[k].click(), i); await sleep(400); }
  await click('#toReview');
  await sleep(500);
  if (await page.$('#modal:not([hidden])')) { await page.evaluate(() => [...document.querySelectorAll('#modalBox button')].at(-1).click()); }
  await page.waitForFunction(() => DA.state.cur && DA.state.cur.verify && DA.state.cur.verify.finished, { timeout: 120000 });
  console.log('verify:', await page.evaluate(() => document.getElementById('vResult').innerText.replace(/\n+/g, ' / ')));
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    DA.state.outDir = await root.getDirectoryHandle('OUT', { create: true });
    DA.state.key = await new DA.engine.KeyFile(await root.getFileHandle('key.csv', { create: true })).open();
    document.querySelector('input[name=mode][value=copy]').click();
  });
  await sleep(200);
  await click('#saveBtn');
  await sleep(500);
  if (await page.$('#modal:not([hidden])')) { await page.evaluate(() => [...document.querySelectorAll('#modalBox button')].at(-1).click()); }
  await page.waitForFunction(() => /Study anonymised|Saved with problems/.test(document.querySelector('main').innerText), { timeout: 120000 });
  console.log('result:', await page.evaluate(() => document.querySelector('main h1').innerText + ' / ' + document.querySelector('main p').innerText));
  // Settings export round trip
  const exported = await page.evaluate(() => DA.engine.store.exportSettings());
  console.log('settings export:', JSON.parse(exported).counter, Object.keys(JSON.parse(exported).modalityPreset));
  console.log(errors.length ? 'CONSOLE ERRORS:\n' + errors.join('\n') : 'no console errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
