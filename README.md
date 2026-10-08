# Compress

Bulk image compression to WebP, PNG and JPG. Everything runs in the browser, so images never leave your machine and the site is just static files on GitHub Pages.

## What it does

- Drop in files or a whole folder (or paste from the clipboard)
- Output as WebP, JPG, PNG, or keep each file's original format
- Lossy or lossless compression
- Resize to a max width, or a max long edge for portrait shots. Smaller images are never enlarged
- Rename on export: prefix, suffix, lowercase, hyphens instead of spaces
- Before and after comparison slider, with a 100% zoom for checking detail
- Download one at a time or everything as a zip
- Settings are remembered between visits

Phone photos are rotated the right way up, metadata (EXIF, GPS) is stripped, and if a file can't get any smaller in its own format the original is kept rather than handing back something bigger.

## How the compression works

The encoders are the same ones Google's Squoosh uses, compiled to WebAssembly via [jSquash](https://github.com/jamsinclair/jSquash):

| Output | Lossy | Lossless |
| --- | --- | --- |
| WebP | libwebp, quality 80 | libwebp lossless |
| JPG | MozJPEG, quality 80 | MozJPEG, quality 92 (JPG has no true lossless mode) |
| PNG | libimagequant to 256 colours, then OxiPNG | OxiPNG |

Resizing uses Lanczos3 in linear light. All the numbers live in one `TUNING` object at the top of `src/compress.worker.js` if you want to adjust them. Images are processed in parallel across a small pool of Web Workers.

## Putting it on GitHub Pages

1. Create a new repository on GitHub and push this folder to the `main` branch.
2. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. The workflow in `.github/workflows/deploy.yml` builds and publishes on every push to `main`. The first run starts as soon as you push; after changing the Pages source you can rerun it from the **Actions** tab.

The site will be at `https://<your-username>.github.io/<repo-name>/`.

## Running it locally

Needs Node 20.19 or newer.

```sh
npm install
npm run dev
```

Then open the address it prints. `npm run build` makes the production files in `dist/`, and `npm run preview` serves that build.

## Files

```
index.html                 page markup
src/main.js                interface, queue, renaming, zip, compare view
src/compress.worker.js     decode, resize, encode (runs in a Web Worker)
src/pool.js                runs several workers at once
src/names.js               rename rules and size formatting
src/style.css              styles, light and dark
```

## Browser notes

- HEIC files open in Safari only, because that's the only browser that can decode them.
- Animated GIFs come out as a still of the first frame.
- SVGs are skipped, as they're already vector.

## Credits and licences

- [jSquash](https://github.com/jamsinclair/jSquash) codecs (MozJPEG, libwebp, OxiPNG, resize): Apache 2.0
- [libimagequant](https://github.com/ImageOptim/libimagequant) via libimagequant-wasm: libimagequant itself is GPL v3 or later, so if you add a licence to this repo, GPL v3 is the compatible choice
- [fflate](https://github.com/101arrowz/fflate) for zipping: MIT
- [Schibsted Grotesk](https://github.com/schibsted/schibsted-grotesk) typeface: SIL Open Font Licence
# compressor
