import json, os, sys, numpy as np, pydicom
from pydicom.pixels import convert_color_space
d = sys.argv[1]; src = sys.argv[2]
meta = json.load(open(os.path.join(d, 'meta.json')))
for f, m in meta.items():
    ds = pydicom.dcmread(os.path.join(src, f))
    try:
        ref = ds.pixel_array
    except Exception as e:
        print('SKIP', f, 'pydicom cannot decode:', str(e)[:80]); continue
    if m['frames'] > 1: ref = ref[0]
    ours = np.fromfile(os.path.join(d, f + '.bin'), dtype=np.float64).reshape(ref.shape)
    pp = ds.PhotometricInterpretation
    if m['photometric'] == 'RGB' and pp.startswith('YBR') and m['spp'] == 3 and 'YBR' in pp:
        # pydicom keeps YBR for some; convert theirs for comparison
        try:
            ref = convert_color_space(ref, 'YBR_FULL', 'RGB') if not np.allclose(ref, ours, atol=8) else ref
        except Exception: pass
    if m['photometric'] == 'YBR_FULL' and m['spp'] == 3:
        ours = convert_color_space(ours.astype(np.uint8), 'YBR_FULL', 'RGB').astype(np.float64)
    diff = np.abs(ref.astype(np.float64) - ours)
    print(('OK  ' if diff.max() <= 2 else 'DIFF'), f.ljust(36), m['ts'].ljust(24), 'maxdiff', diff.max(), 'mean', round(diff.mean(), 3))
