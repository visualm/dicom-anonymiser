// Loads the browser scripts into Node for testing.
global.window = global;
const path = require('path');
const app = path.join(__dirname, '..', '..', 'app');
for (const f of ['vendor/dict.js', 'vendor/codecs.js', 'js/dicom.js', 'js/profile.js', 'js/anon.js', 'js/pixels.js', 'js/engine.js']) {
  try { require(path.join(app, f)); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
}
module.exports = global.DA;
