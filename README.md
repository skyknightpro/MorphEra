# MorphEra

<img width="1180" height="780" alt="image" src="https://github.com/user-attachments/assets/7ed32877-0cfe-4a27-90df-85acc9d7c439" />


<p align="center">
  <img src="build/icon.png" width="96" alt="MorphEra icon">
</p>

<p align="center">
  <strong>Fast, private, unlimited file conversion for Windows.</strong><br>
  Everything runs on your computer. No uploads, accounts, watermarks, or file-size limits.
</p>

<p align="center">
  <strong>Version 1.0.0</strong> &nbsp;·&nbsp; Windows 10/11 (64-bit) &nbsp;·&nbsp; Offline after setup
</p>

MorphEra is a portable desktop app for converting images, audio, video, PDFs, and
office documents. It combines native desktop tooling with FFmpeg, Sharp, MuPDF,
PDF.js, Tesseract, and LibreOffice so everyday file tasks stay on your machine.

---

## Highlights

| Tool | What it does |
| --- | --- |
| **Convert** | Batch-convert images, audio, video, PDFs, and office documents. |
| **Compress** | Shrink images, video, audio, and PDFs by quality or an exact target size. |
| **Image Studio** | Crop, rotate, resize, enhance, remove backgrounds, add watermarks, and export. |
| **Video & Audio** | Trim clips, convert formats, extract audio, and merge multiple media files. |
| **PDF Tools** | Organize pages, merge, split, export images, create PDFs from images, run OCR, add watermarks, and lock or unlock files. |
| **Presets** | One-click rules for WhatsApp, email, YouTube, and print workflows. |
| **Watch Folder** | Automatically convert new files dropped into a folder you choose. |
| **Activity & History** | Follow running jobs, cancel or retry work, clear finished jobs, and reopen recent outputs. |

### Built for local work

- Files are processed locally and are never uploaded.
- There are no accounts, subscriptions, watermarks, or artificial conversion limits.
- Batch jobs run in the background while you keep using the app.
- Preferences, watch-folder settings, and recent history stay on the same computer.
- The portable build does not install a service or require administrator access to
  run. Installing LibreOffice does require the normal Windows elevation prompt.

---

## Requirements

### To run the portable app

- Windows 10 or Windows 11, 64-bit.
- **LibreOffice** installed and working. MorphEra uses it for Word, Excel,
  PowerPoint, OpenDocument, and RTF conversions.
- At least 3 GB of free disk space is recommended for the app, temporary files,
  and converted output.
- 4 GB of RAM or more is recommended for video, OCR, and large PDF jobs.

### To build from source

- Node.js 22 LTS or newer.
- npm 10 or newer.
- Windows 10/11 for producing the portable Windows executable.
- LibreOffice for testing document conversions after the build.

---

## Install and run

1. Download `MorphEra.exe` from the repository's Releases page.
2. Put it in a folder where you have write access. MorphEra is portable; it does
   not create a Program Files installation.
3. Run `MorphEra.exe`. On startup, MorphEra checks for LibreOffice.
4. If LibreOffice is missing, use the setup screen to download and install the
   official release, locate an existing installation, or retry the check.

The first launch may take a few seconds while the app verifies the bundled tools.

### About LibreOffice

LibreOffice is a hard requirement because it provides the document conversion
engine. MorphEra verifies it again before document jobs and periodically while
the app is running. If LibreOffice is uninstalled or moved, the setup screen
returns and document jobs fail with a clear message instead of producing a
partial or corrupt file. Reinstall or relocate LibreOffice to unlock the
workspace again.

The download/install path uses the official LibreOffice distribution. MorphEra
does not use LibreOffice to edit files and does not send any document anywhere.

---

## Using MorphEra

1. Drop files onto the active page or choose **Choose files**.
2. Pick an output format or target size.
3. Start the job.
4. Follow progress in **Activity**; completed files are also listed in
   **History**.

By default, output is written next to `MorphEra.exe`. If that folder is
read-only, MorphEra falls back to a `MorphEra Files` folder on your Desktop. You
can choose another destination in **Settings**.

The **Activity** panel keeps queued and running jobs visible. Finished jobs can
be removed with **Clear** without interrupting work that is still in progress.

### Presets

- **WhatsApp** prepares compact photos, video, and audio for sharing.
- **Email** uses smaller limits for attachments.
- **YouTube** creates high-quality 1080p MP4 video, thumbnails, and audio.
- **Print** keeps full resolution and uses print-friendly image settings.

Presets can be used directly or as a starting point for your own settings.

### Watch Folder

Choose a folder, enable watching, and set a rule for images, video, audio, and
documents. New files are converted as they appear. Watched conversions use the
same queue, cancellation, and history behavior as manual jobs.

---

## Build from source

```powershell
git clone <repository-url>
cd MorphEra-Source
npm ci
npm run dev
```

`npm run dev` starts Vite and opens the Electron window with live reload.

### Production build

```powershell
npm run dist
```

This command regenerates the app icon, builds the renderer, and packages a
single portable executable:

- `release/MorphEra.exe` — portable Windows build for distribution.
- `release/win-unpacked/` — unpacked build useful for debugging.

To build only the unpacked folder, run:

```powershell
npm run dist:folder
```

`BUILD-WINDOWS.bat` provides the same production flow for a local Windows
machine and opens the release folder when it finishes.

> Background removal is provided by an optional dependency. A normal `npm ci`
> installs it. If optional dependencies are deliberately omitted, the rest of
> Image Studio still works and the background-removal action explains that the
> feature is unavailable.

### Source layout

```text
electron/          Electron main process, job queue, engines, and preload bridge
src/               React renderer and application styles
scripts/           Build helper scripts
build/             Application icon sources and generated icon files
index.html         Renderer entry point
vite.config.js     Vite configuration
package.json       Scripts, dependencies, and electron-builder configuration
```

---

## Troubleshooting

**The LibreOffice setup screen keeps appearing**

LibreOffice may have been uninstalled, moved, or replaced by a version MorphEra
cannot launch. Use **Locate LibreOffice** and select `soffice.exe` (or the
equivalent program on your system), or run the installer again.

**A conversion says the output folder is not writable**

The portable executable is probably in a protected folder. Move it somewhere
under your user profile or choose a writable destination in **Settings**.

**Windows shows a SmartScreen warning**

Release builds are currently unsigned. Use the SHA-256 checksum published with
the release to verify the download before running it. Code signing can be added
to the release process without changing the application code.

**I need to reset settings or history**

Close MorphEra, then remove `settings.json` or `history.json` from the app's
user-data folder, normally `%APPDATA%\MorphEra`. Converted files are never
deleted by MorphEra; remove them manually if needed.

**A large video or PDF job fails**

Close other memory-intensive applications and try again. The **Activity** panel
shows the failing job's error message. If the same input fails consistently,
test the file with a shorter clip or a smaller document to isolate the cause.

---

## Release notes

MorphEra is currently at **1.0.0**. The application version is defined in
`package.json`; packaging scripts and release documentation should keep that
version synchronized.
