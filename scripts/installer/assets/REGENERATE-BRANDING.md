# Regenerating the Claudally installer branding

Two SVG masters live in this folder, and every raster the installer uses is rendered from them:

| Master | Renders to | Used for |
|---|---|---|
| [`claudally-logo.svg`](claudally-logo.svg) | `tally-mcp.ico`, `wizard-small-*.png` | The app and installer icon, and the small image at the top right of each wizard page |
| [`wizard-sidebar.svg`](wizard-sidebar.svg) | `wizard-sidebar-*.png` | The tall panel on the Welcome and Finished pages |

`tally-mcp.iss` names the PNG files directly, so regenerating **keeps the filenames** and the script
needs no change.

Requires `rsvg-convert` (librsvg) for the PNGs, and [ImageMagick 7](https://imagemagick.org)
(`magick`) for the `.ico` only. Run from this `scripts/installer/assets/` folder.

## 1. Wizard sidebar -> `wizard-sidebar-<width>.png`

One file per display-scaling step (100%, 150%, 200%, 250%). Setup picks the closest, so none is
upscaled. The sidebar area is 202x386 at 100%, aspect 164:314.

```sh
for w in 202 336 430 534; do
  rsvg-convert -w $w -h $(( (w * 386 + 101) / 202 )) wizard-sidebar.svg -o wizard-sidebar-$w.png
done
```

The text is drawn with the first of Segoe UI / Helvetica Neue / Helvetica / Arial that the rendering
machine has, and is baked into the PNG, so the result differs slightly between Windows and macOS.

The publisher mark at the foot is `scripts/tray/assets/jina-logo.png`, embedded in the SVG as a
360px base64 image so the master renders on its own. To replace it, swap that `<image>` data.

## 2. Wizard small image -> `wizard-small-<size>.png`

Square, transparent background, so it sits cleanly on the page colour of any wizard style.

```sh
for s in 58 97 124 159; do
  rsvg-convert -w $s -h $s claudally-logo.svg -o wizard-small-$s.png
done
```

## 3. App / installer `.exe` icon -> `tally-mcp.ico`

`SetupIconFile`, `UninstallDisplayIcon` and every Start Menu shortcut.

```sh
magick -background none claudally-logo.svg -define icon:auto-resize=256,128,64,48,32,16 tally-mcp.ico
```

## Verify

- `rsvg-convert` exits 0 and each PNG has the size in its name (`file wizard-*.png`).
- `magick identify tally-mcp.ico` lists the 16 to 256 frames.
- Compile the installer (`scripts/installer/check-iss.ps1`) and look at the Welcome page and one
  inner page at 100% and at 150% or more display scaling.

The tray dashboard header uses `scripts/tray/assets/jina-logo.png` directly and is separate.
