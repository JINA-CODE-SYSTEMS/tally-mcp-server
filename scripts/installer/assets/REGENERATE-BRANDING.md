# Regenerating the Claudally installer branding

Master art: [`claudally-logo.svg`](claudally-logo.svg) — an orange app tile carrying a white Claude
spark over a Tally ledger. Regenerating **keeps the existing filenames**, so `tally-mcp.iss` needs no
changes — it already points at `tally-mcp.ico` and the wizard `.bmp`s.

Requires [ImageMagick 7](https://imagemagick.org) (`magick`) with SVG support (librsvg). Run from this
`scripts/installer/assets/` folder.

## 1. App / installer `.exe` icon  → `tally-mcp.ico`
This is `SetupIconFile` + `UninstallDisplayIcon` + every Start-Menu/desktop shortcut, so the compiled
`Claudally-Setup-*.exe` and the installed app show the Claudally mark.

```sh
magick -background none claudally-logo.svg -define icon:auto-resize=256,128,64,48,32,16 tally-mcp.ico
```

## 2. Wizard header icon (top-right of each page) → `wizard-small.bmp`
Inno wants a flat 24-bit BMP (no alpha), so we pad the square logo onto white at the exact sizes.

```sh
magick -background none claudally-logo.svg -resize 50x50   -gravity center -background white -extent 55x58   -type truecolor BMP3:wizard-small.bmp
magick -background none claudally-logo.svg -resize 100x100 -gravity center -background white -extent 110x138 -type truecolor BMP3:wizard-small@2x.bmp
```

## 3. Wizard sidebar (Welcome / Finished pages) → `wizard-sidebar.bmp`  *(leave as-is)*
**Keep the current sidebar** — it carries the **JINA CODE SYSTEMS LLP** logo, which is exactly the
publisher branding we want to keep visible in the wizard. Do not overwrite it.

*Optional*, only if you want the Claudally mark + publisher line ON the sidebar instead of the plain
JINA logo (portrait 164×314 / 328×628):

```sh
# 1x
magick -size 164x314 gradient:'#FF9A2E-#F5620A' \
  \( claudally-logo.svg -background none -resize 96x96 \) -gravity north -geometry +0+28 -composite \
  -gravity north -pointsize 20 -fill white -font Segoe-UI-Semibold -annotate +0+140 'Claudally' \
  -gravity south -pointsize 9  -fill '#FFF3E6' -annotate +0+18 'by JINA CODE SYSTEMS LLP' \
  -type truecolor BMP3:wizard-sidebar.bmp
# 2x — same command at -size 328x628 with doubled pointsizes/geometry
```

## Verify
- `.ico`: `magick identify tally-mcp.ico` → should list the 16…256 frames.
- `.bmp`: `magick identify wizard-small.bmp` → `BMP3 55x58 … 24-bit`. Inno rejects alpha/other depths.

The published app icon in `scripts/tray/assets/jina-logo.png` (the tray dashboard header) is separate
and intentionally left as the JINA logo.
