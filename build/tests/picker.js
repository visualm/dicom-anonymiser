// Checks that clicking "Choose folder" on file:// opens the native picker (it is not refused).
const puppeteer = require('puppeteer-core'); const path = require('path');
(async () => {
  const exe = process.argv[2] === 'chrome' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const b = await puppeteer.launch({ executablePath: exe, headless: true });
  const p = await b.newPage();
  await p.goto('file:///' + path.resolve(__dirname, '../../app/index.html').split(path.sep).join('/'));
  const cdp = await p.target().createCDPSession();
  await cdp.send('Page.enable');
  let opened = false;
  cdp.on('Page.fileChooserOpened', () => { opened = true; });
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => {});
  const res = p.evaluate(() => window.showDirectoryPicker().then(() => 'resolved', (e) => e.name + ': ' + e.message));
  await p.click('#openBtn').catch(() => {});
  const r = await Promise.race([res, new Promise((ok) => setTimeout(() => ok('pending (picker open)'), 4000))]);
  console.log(process.argv[2] || 'edge', '->', r, 'chooserEvent=' + opened);
  await b.close();
})();
