"""Independent check with pydicom: compare original vs. written file (tags + pixels)."""
import sys, os, numpy as np, pydicom
a_dir, b_dir = sys.argv[1], sys.argv[2]
bad = 0
for f in sorted(os.listdir(b_dir)):
    if f == 'DICOMDIR': continue
    try:
        a = pydicom.dcmread(os.path.join(a_dir, f), force=True); b = pydicom.dcmread(os.path.join(b_dir, f))
        diffs = []
        for el in a.iterall():
            pass
        ka = {e.tag for e in a if e.tag.element != 0}; kb = {e.tag for e in b if e.tag.element != 0}
        if ka != kb: diffs.append(f'tags differ {ka ^ kb}')
        for t in ka & kb:
            if t == 0x7fe00010: continue
            if a[t].VR != 'SQ' and a[t].value != b[t].value and str(a[t].value).strip() != str(b[t].value).strip(): diffs.append(f'{t} {a[t].value!r:.40} != {b[t].value!r:.40}')
        if 'PixelData' in a:
            try:
                pa = a.pixel_array; pb = b.pixel_array
                if not np.array_equal(pa, pb): diffs.append('pixels differ')
            except Exception as e: diffs.append(f'pixel decode: {e}')
        print('OK  ' if not diffs else 'DIFF', f, '; '.join(diffs)[:300]); bad += bool(diffs)
    except Exception as e:
        print('ERR ', f, e); bad += 1
print('problems:', bad)
