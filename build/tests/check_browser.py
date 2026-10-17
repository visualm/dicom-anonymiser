import os, glob, numpy as np, pydicom
B = os.path.join(os.path.dirname(__file__), '..', 'testout', 'browser')
def raw_has(path, words):
    data = open(path, 'rb').read().upper()
    return [w for w in words if w.encode() in data]
A_WORDS = ['MUSTERMANN', '12345678', '19600102', 'TESTSTADT', 'HAUSARZT']
B_WORDS = ['MUSTERFRAU', '87654321', '19751224', 'TESTSTADT', 'HAUSARZT']
ok = True
study_uids = set()
for p in sorted(glob.glob(B + '/OUTPUT/ANON-0001/*/*.dcm')):
    ds = pydicom.dcmread(p); hits = raw_has(p, A_WORDS)
    study_uids.add(ds.StudyInstanceUID)
    bad = hits or ds.PatientName != 'ANON-0001' or any(e.tag.is_private for e in ds.iterall())
    if ds.Modality == 'US':
        top = ds.pixel_array[3:86, 3:635]
        print('US', os.path.basename(os.path.dirname(p)), 'box max value:', top.max(), 'BurnedIn:', ds.BurnedInAnnotation, 'TS:', ds.file_meta.TransferSyntaxUID.name)
        bad = bad or top.max() > 0
    if bad: ok = False; print('BAD', p, hits, ds.PatientName)
print('copy mode: files', len(glob.glob(B + '/OUTPUT/ANON-0001/*/*.dcm')), 'study UIDs', study_uids)
for p in sorted(glob.glob(B + '/PACS_EXPORT/DICOM/*/*')):
    ds = pydicom.dcmread(p)
    if ds.PatientName == 'ANON-0002':
        hits = raw_has(p, B_WORDS)
        if hits or any(e.tag.is_private for e in ds.iterall()): ok = False; print('BAD', p, hits)
        if ds.Modality == 'NM':
            arr = ds.pixel_array
            print('NM frames', arr.shape, 'box region per frame min==max:', all(arr[f, 1:11, 4:15].max() == arr[f, 1:11, 4:15].min() for f in range(arr.shape[0])))
    elif 'MUSTERMANN' not in str(ds.PatientName): ok = False; print('unexpected', p, ds.PatientName)
print('ALL OK' if ok else 'PROBLEMS')
