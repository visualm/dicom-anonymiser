// Generates the self-contained vendor files in ../app/vendor.
// Run once on a development machine:  cd build && npm install && node build.js
// The resulting app/ folder needs no network, no install and no build at runtime.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'app', 'vendor');
fs.mkdirSync(OUT, { recursive: true });
const nm = (p) => path.join(__dirname, 'node_modules', p);

// 1. DICOM data dictionary (tag -> VR + keyword) taken from dcmjs.
const { nameMap } = require('dcmjs').data.DicomMetaDictionary;
const VR_FIX = { ox: 'OW', xs: 'US', lt: 'OW', up: 'UL' };
const dict = {};
for (const e of Object.values(nameMap)) {
  const m = /^\(([0-9A-Fa-f]{4}),([0-9A-Fa-f]{4})\)$/.exec(e.tag);
  if (!m || e.vr === 'na') continue;
  const vr = VR_FIX[e.vr] || e.vr;
  dict[(m[1] + m[2]).toUpperCase()] = vr + '|' + e.name;
}
fs.writeFileSync(path.join(OUT, 'dict.js'),
  '// DICOM data dictionary generated from dcmjs (MIT). tag -> "VR|Keyword"\n' +
  'window.DA_DICT=' + JSON.stringify(dict) + ';\n');
console.log('dict.js:', Object.keys(dict).length, 'entries');

// 2. WebAssembly codecs. Each wasm binary is inlined as base64 so the app
//    works from file:// where fetch() of local files is blocked.
const codecs = [
  ['@cornerstonejs/codec-libjpeg-turbo-8bit/dist/libjpegturbowasm_decode', 'libjpegturbowasm_decode', 'jpeg'],
  ['@cornerstonejs/codec-charls/dist/charlswasm_decode', 'CharLSWASM', 'jpegls'],
  ['@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode', 'OpenJPEGWASM', 'j2k'],
];
let codecJs = '// Image codecs: libjpeg-turbo, CharLS, OpenJPEG (cornerstonejs builds, MIT/BSD)\n' +
  '// and jpeg-lossless-decoder-js (MIT). WASM binaries inlined as base64.\n' +
  'window.DA_CODECS = window.DA_CODECS || {};\n';
for (const [base, globalName, key] of codecs) {
  let js = fs.readFileSync(nm(base + '.js'), 'utf8');
  if (!js.includes('var ' + globalName + ' =')) throw new Error('unexpected codec format: ' + base);
  const wasm = fs.readFileSync(nm(base + '.wasm')).toString('base64');
  codecJs += '\n;(function(){\nvar module, exports, define;\n' + js +
    '\nwindow.DA_CODECS.' + key + ' = { factory: ' + globalName + ', wasm: "' + wasm + '" };\n})();\n';
}
let ll = fs.readFileSync(nm('jpeg-lossless-decoder-js/release/lossless.js'), 'utf8');
ll = ll.replace(/export\s*\{[\s\S]*?\};?\s*(\/\/# sourceMappingURL.*)?\s*$/, '');
codecJs += '\n;(function(){\n' + ll + '\nwindow.DA_CODECS.lossless = { Decoder: Decoder };\n})();\n';
fs.writeFileSync(path.join(OUT, 'codecs.js'), codecJs);
console.log('codecs.js:', Math.round(codecJs.length / 1024), 'KB');

// 3. Third-party notices for the bundled code.
const notices = [
  ['dcmjs (DICOM data dictionary only)', 'MIT', 'dcmjs/License.txt'],
  ['@cornerstonejs/codec-libjpeg-turbo-8bit (libjpeg-turbo, IJG + BSD-3-Clause)', 'ISC', null],
  ['@cornerstonejs/codec-charls (CharLS, BSD-3-Clause)', 'MIT', '@cornerstonejs/codec-charls/LICENSE'],
  ['@cornerstonejs/codec-openjpeg (OpenJPEG, BSD-2-Clause)', 'MIT', null],
  ['jpeg-lossless-decoder-js', 'MIT', 'jpeg-lossless-decoder-js/LICENSE'],
];
let text = 'DICOM Anonymiser bundles the following open-source components:\n\n';
for (const [name, lic, file] of notices) {
  text += '=== ' + name + ' — license: ' + lic + '\n';
  if (file && fs.existsSync(nm(file))) text += fs.readFileSync(nm(file), 'utf8').trim() + '\n';
  text += '\n';
}
text += 'Default anonymisation rules are based on DICOM PS3.15 Annex E (NEMA).\n';
fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_NOTICES.txt'), text);
console.log('THIRD_PARTY_NOTICES.txt written');
