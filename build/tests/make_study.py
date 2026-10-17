"""Builds a fake PACS export (two patients, CT/US/MR/NM/DX, compressed + uncompressed) from public pydicom samples."""
import os, shutil, copy, numpy as np, pydicom
from pydicom.uid import generate_uid, ExplicitVRLittleEndian
SRC = 'testdata'; OUT = 'testexport'
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT + '/DICOM')
shutil.copy(SRC + '/DICOMDIR', OUT + '/DICOMDIR')
n = [0]
def put(ds, sub):
    n[0] += 1
    d = os.path.join(OUT, 'DICOM', sub); os.makedirs(d, exist_ok=True)
    ds.save_as(os.path.join(d, 'IM_%04d' % n[0]), enforce_file_format=True)
def patient(ds, name, pid, birth, study_uid, series_uid, series_no, modality, desc, inst):
    ds.PatientName = name; ds.PatientID = pid; ds.PatientBirthDate = birth; ds.PatientSex = 'M'
    ds.StudyInstanceUID = study_uid; ds.SeriesInstanceUID = series_uid; ds.SeriesNumber = series_no
    ds.SOPInstanceUID = generate_uid(); ds.file_meta.MediaStorageSOPInstanceUID = ds.SOPInstanceUID
    ds.Modality = modality; ds.SeriesDescription = desc; ds.InstanceNumber = inst
    ds.StudyDate = '20240311'; ds.StudyTime = '101500'; ds.AccessionNumber = 'ACC' + pid
    ds.InstitutionName = 'Klinikum Teststadt'; ds.ReferringPhysicianName = 'Dr^Hausarzt'
    ds.OtherPatientIDs = 'X-' + pid; ds.StudyDescription = 'Test study ' + modality
    ds.add_new(0x00291010, 'LO', 'Philips private: ' + str(name))
    ds.add_new(0x00290010, 'LO', 'PHILIPS IMAGING DD 001')
    seq = pydicom.Dataset(); seq.ReferencedSOPClassUID = '1.2.840.10008.3.1.2.3.1'; seq.ReferencedSOPInstanceUID = generate_uid()
    ds.ReferencedPatientSequence = [copy.deepcopy(seq)]
    ds.ReferencedStudySequence = [seq]
    ds.ImageComments = 'Patient ' + str(name).split('^')[0] + ' seen today'
    return ds
A = ('MUSTERMANN^MAX', '12345678', '19600102', generate_uid())
B = ('MUSTERFRAU^ERIKA', '87654321', '19751224', generate_uid())
# Patient A: CT stack (20 slices), US with burned-in text, US J2K, SC JPEG
s = generate_uid()
for i in range(20):
    ds = pydicom.dcmread(SRC + '/CT_small.dcm'); ds.SliceLocation = i; put(patient(ds, *A[:3], A[3], s, 2, 'CT', 'Thorax', i + 1), 'CT')
ds = pydicom.dcmread(SRC + '/US1_UNCR.dcm'); arr = ds.pixel_array.copy()
arr[5:25, 10:300] = 255  # white "text" bar where an US header would be
arr[8:22, 14:296:6] = 0
ds.PixelData = arr.tobytes(); ds.BurnedInAnnotation = 'YES'
put(patient(ds, *A[:3], A[3], generate_uid(), 3, 'US', 'Abdomen', 1), 'US')
ds = pydicom.dcmread(SRC + '/US1_J2KR.dcm'); put(patient(ds, *A[:3], A[3], generate_uid(), 4, 'US', 'Abdomen J2K', 1), 'US')
ds = pydicom.dcmread(SRC + '/SC_rgb_jpeg_dcmtk.dcm'); put(patient(ds, *A[:3], A[3], generate_uid(), 5, 'OT', 'Dose report', 1), 'SC')
# Patient B: MR (RLE + JPEG-LS), NM multi-frame, DX JPEG lossless
s = generate_uid()
for i, f in enumerate(['MR_small.dcm', 'MR_small_RLE.dcm', 'MR_small_jpeg_ls_lossless.dcm', 'MR_small.dcm']):
    ds = pydicom.dcmread(SRC + '/' + f); put(patient(ds, *B[:3], B[3], s, 1, 'MR', 'T1 sag', i + 1), 'MR')
ds = pydicom.dcmread(SRC + '/emri_small.dcm'); ds.SOPClassUID = '1.2.840.10008.5.1.4.1.1.20'; ds.file_meta.MediaStorageSOPClassUID = ds.SOPClassUID
put(patient(ds, *B[:3], B[3], generate_uid(), 2, 'NM', 'Bone scan dynamic', 1), 'NM')
ds = pydicom.dcmread(SRC + '/JPEG-LL.dcm'); put(patient(ds, *B[:3], B[3], generate_uid(), 3, 'DX', 'Chest PA', 1), 'DX')
ds = pydicom.dcmread(SRC + '/JPEG2000.dcm'); put(patient(ds, *B[:3], B[3], generate_uid(), 4, 'CT', 'J2K CT', 1), 'CT')
with open(os.path.join(OUT, 'README.TXT'), 'w') as fh: fh.write('not dicom')
print('files:', n[0])
