"""Independent verification of anonymised output with pydicom."""
import os, sys, numpy as np, pydicom
src, dst = sys.argv[1], sys.argv[2]
BOX = (10, 10, 60, 50)  # x0, y0, x1, y1
LOSSY = {'1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.91', '1.2.840.10008.1.2.4.81'}
problems = 0
for f in sorted(os.listdir(dst)):
    a = pydicom.dcmread(os.path.join(src, f), force=True); b = pydicom.dcmread(os.path.join(dst, f))
    msgs = []
    if b.get('PatientName') != 'ANON-TEST' or b.get('PatientID') != 'ANON-TEST': msgs.append(f'name/id {b.get("PatientName")!r}/{b.get("PatientID")!r}')
    if any(e.tag.is_private for e in b.iterall()): msgs.append('private tags remain')
    for kw in ['StudyInstanceUID', 'SeriesInstanceUID', 'SOPInstanceUID']:
        if kw in a and a.get(kw) == b.get(kw): msgs.append(kw + ' unchanged')
    if 'SOPInstanceUID' in b and b.file_meta.MediaStorageSOPInstanceUID != b.SOPInstanceUID: msgs.append('meta SOP UID mismatch')
    for kw in ['PatientBirthDate', 'InstitutionName', 'ReferringPhysicianName', 'AccessionNumber', 'StudyDate']:
        if b.get(kw): msgs.append(f'{kw}={b.get(kw)}')
    if b.get('PatientIdentityRemoved') != 'YES': msgs.append('PatientIdentityRemoved missing')
    if 'PixelData' in b and b.get('BurnedInAnnotation') == 'NO':
        try:
            pa = a.pixel_array; pb = b.pixel_array
            fa = pa[0] if a.get('NumberOfFrames', 1) > 1 else pa; fb = pb[0] if b.get('NumberOfFrames', 1) > 1 else pb
            x0, y0, x1, y1 = BOX
            reg = fb[y0:y1, x0:x1]
            if fb.ndim == 3:
                # pydicom returns RGB; black means all ~0
                ok = reg.max() <= 2 if b.PhotometricInterpretation in ('RGB', 'YBR_FULL', 'YBR_FULL_422') else True
            elif b.PhotometricInterpretation == 'PALETTE COLOR':
                ok = len(np.unique(reg)) == 1
            else:
                target = fa.max() if b.PhotometricInterpretation == 'MONOCHROME1' else fa.min()
                ok = np.all(reg == target) or np.all(reg == fb.min())
            if not ok: msgs.append(f'box not black: {np.unique(reg)[:5]}')
            mask = np.ones(fb.shape[:2], bool); mask[y0:y1, x0:x1] = False
            if fb.ndim == 3 and b.PhotometricInterpretation == 'RGB' and fa.shape == fb.shape:
                d = np.abs(fa.astype(int) - fb.astype(int))[mask].max()
            elif fa.shape == fb.shape:
                d = np.abs(fa.astype(int) - fb.astype(int))[mask].max()
            else: d = 'shape ' + str(fa.shape) + str(fb.shape)
            tsa = a.file_meta.TransferSyntaxUID
            tol = 3 if tsa in LOSSY else 0
            if d != 0 and not (isinstance(d, (int, np.integer)) and d <= tol): msgs.append(f'outside box changed by {d}')
        except Exception as e:
            msgs.append(f'pixel check error {e}')
    problems += bool(msgs)
    print('OK  ' if not msgs else 'BAD ', f.ljust(36), '; '.join(msgs)[:250])
print('problems:', problems)
