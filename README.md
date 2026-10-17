# DICOM Anonymiser

A browser-based DICOM anonymiser for all modalities (CR/DX, CT, MR, US, NM, SC, …).
It runs from a plain folder in Edge or Chrome, needs no installation or admin rights, and keeps all data on the computer.

## Use

Open `app/index.html` in Microsoft Edge or Google Chrome. User instructions are in [app/README.txt](app/README.txt).

**Portable version:** copy the `app/` folder anywhere you like: USB stick, network drive or user folder. The ready-made ZIP is `dist/DICOM-Anonymiser-portable.zip`.

## Features

- **Input:**
  - Reads whole folders (PACS exports, patient CDs with a DICOMDIR) and files without extensions.
  - Groups the files into studies and series.
- **Supported formats:**
  - Implicit/explicit VR little endian, big endian and deflate.
  - Compressed images: JPEG baseline, JPEG lossless, JPEG-LS, JPEG 2000 and RLE.
- **Step 1: tags.**
  - All tags in the study are listed with their values.
  - Defaults follow the PS3.15 Basic Profile.
  - Each tag can be set to Keep, Empty, Remove, Random, Fixed value, Pseudonym or Counter (1, 2, 3… per image in study order).
  - Optionally, all images of a study can be merged into one stack: one shared Series UID, Series Number 1, Instance Numbers 1…N.
  - Rows that contain the patient name or ID are highlighted.
  - Choices can be saved as named presets. The last preset used for a modality is pre-selected next time.
  - Presets can be exported and imported (JSON).
- **Step 2: images.**
  - You can view every series, including multi-frame cine/NM.
  - Series likely to contain burned-in text are flagged (Burned In Annotation, US, SC, …).
  - Redaction boxes can apply to one image, the whole series, or all same-size images in the study.
  - Each box is filled black or white.
- **Step 3: review.**
  - Shows a before/after image and a before/after tag diff. The "after" side is decoded from the generated file.
  - Every file is anonymised in memory, read back and searched for the original identifiers.
  - You then save a copy or overwrite the originals. Overwriting also deletes the DICOMDIR.
- **Pseudonyms:**
  - An automatic counter (ANON-0001, ANON-0002, …).
  - A known patient gets the same pseudonym again.
  - An optional CSV key file (semicolon-separated, for Excel) records the mapping.
- **UIDs:** replaced by new `2.25.…` UIDs, consistently within a session, so references between series stay intact.

## Project layout

| Path | What it is |
|---|---|
| `app/` | The application. This is everything needed to run it. |
| `app/js/dicom.js` | DICOM Part 10 reader/writer |
| `app/js/anon.js`, `profile.js` | Tag rules (Basic Profile), anonymisation and leak check |
| `app/js/pixels.js` | Frame decoding, rendering, redaction |
| `app/js/engine.js` | Per-file pipeline, presets/settings, CSV key file |
| `app/js/viewer.js`, `app.js` | User interface |
| `app/vendor/` | Generated: DICOM dictionary and WebAssembly codecs (inlined base64, so it works from `file://`) |
| `build/` | Build script and tests (development machine only) |

## Development

```bash
cd build && npm install && node build.js
```

This regenerates `app/vendor/`.

Tests (need Python with pydicom in `build/.venv`; pydicom is used as an independent reference):

```bash
cd build && node tests/roundtrip.js && .venv/Scripts/python tests/compare.py testdata testout/rt
```

```bash
cd build && node tests/decode.js && .venv/Scripts/python tests/compare_decode.py testout/dec testdata
```

```bash
cd build && node tests/anon.js && .venv/Scripts/python tests/check_anon.py testdata testout/anon
```

`tests/make_study.py` builds a fake two-patient PACS export. `tests/filemode.js` and `tests/picker.js` check the app in the installed Edge/Chrome via `file://`.
