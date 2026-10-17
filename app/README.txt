DICOM ANONYMISER - portable version
====================================

START
  Double-click index.html. It must open in Microsoft Edge or Google Chrome.
  If it opens in another browser: right-click index.html > Open with > Microsoft Edge
  (or double-click "Open in Edge.cmd").
  Nothing is installed, no admin rights are needed, and no data leaves the computer.
  The whole folder can live on a USB stick or a network drive. Keep all files together.

WORKFLOW
  1. Start page: optionally create/open a KEY FILE (CSV). Store it separately from the
     anonymised data - it links pseudonyms back to the real patient IDs.
  2. "Choose folder..." and pick the PACS export or CD folder (the one containing DICOMDIR).
     The browser asks for permission to view the folder - allow it.
  3. Pick a study. For each study:
     Step 1  Tags     - the suggested anonymisation (DICOM Basic Profile) is pre-selected.
                        Tick/untick tags and choose Keep / Empty / Remove / Random /
                        Fixed value / Pseudonym / Counter (1, 2, 3... per image).
                        Red rows contain the patient name or ID.
                        "Merge all images into one stack" gives every image of the
                        study one shared series (Series Number 1, images numbered
                        1..N), so viewers show a single scrollable stack.
                        Save your choices as a preset; the last preset used for a
                        modality is pre-selected next time.
     Step 2  Images   - check every series. Drag a box over burned-in text (left mouse).
                        Choose whether a box applies to this image, the whole series,
                        or all images of the same size, and whether it is filled
                        black or white. Right-drag = window/level.
     Step 3  Review   - original vs. anonymised image and tags, plus an automatic check
                        of all files. Then save a COPY to an output folder, or
                        OVERWRITE the originals (the DICOMDIR is then deleted).

MOVING SETTINGS TO ANOTHER COMPUTER
  Start page > Presets > "Export settings..." saves presets and the pseudonym counter
  to a .json file. Use "Import settings..." on the other computer.
  Presets are stored per browser; clearing browser data deletes them - export regularly.

LIMITATIONS
  - 12-bit JPEG (old "JPEG Extended" CT/MR), video-compressed ultrasound (MPEG/H.264),
    HTJ2K and 1-bit images cannot be displayed or redacted. Their tags are still
    anonymised; the series is marked "cannot display" - check those with another viewer.
  - Redacted compressed images are saved uncompressed (files get bigger).
  - Default rules empty or remove dates (no date shifting) and remove all private tags.
  - Always review the result before sharing data.
