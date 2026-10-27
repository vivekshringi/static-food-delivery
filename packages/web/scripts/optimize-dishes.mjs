#!/usr/bin/env node
/**
 * Optimises the dish photographs used by the home page showcase.
 *
 * The 1080x1080 source PNGs live in `assets/dishes-source` (not `public/`, so Vite does not copy
 * them into the build) and weigh roughly 2 MB each. Shipping all 24 that way would add ~50 MB to
 * the bundle, so this script re-encodes them into the formats the browser can choose between and
 * writes the result to `public/dishes`.
 *
 * For every numbered source PNG it writes:
 *   - 400px and 800px wide WebP (the showcase renders at most ~400 CSS px, so 800 covers 2x)
 *   - a JPEG fallback at each width for browsers without WebP
 *   - a tiny placeholder JPEG used while the real photo loads
 *
 * The photos are square and have the dish name printed into the artwork, so nothing is cropped.
 *
 * Usage:
 *   npm run dishes -w @restaurant/web
 *
 * Re-run it after replacing a source PNG — named `NN_name.png`, where NN is the display order. It
 * always rewrites the manifest that `src/dishes.js` consumes, so the showcase picks new photos up
 * automatically.
 */

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(HERE, "..");
const SOURCE_DIR = join(WEB_ROOT, "assets", "dishes-source");
const OUTPUT_DIR = join(WEB_ROOT, "public", "dishes");
const MANIFEST = join(WEB_ROOT, "src", "dishes.js");

// The showcase never needs more than ~400 CSS px; 800 keeps it sharp on a 2x screen.
const WIDTHS = [400, 800];
const PLACEHOLDER_WIDTH = 32;

/**
 * Derives a stable slug and a human caption from a raw file name.
 *
 * The files are named `01_butter_chicken_curry (1).png`, so the leading index is kept as the
 * sort key, the duplicate suffix ` (1)` is dropped, and underscores become words. The caption is
 * used for the alt text only; the dish name printed inside the photo remains the authority.
 *
 * @param {string} fileName Base name including the extension.
 * @returns {{ order: number, slug: string, caption: string } | null} `null` when the file is not a
 *   numbered dish photo.
 */
function describe(fileName) {
  const match = /^(\d{2})_(.+)\.png$/i.exec(fileName);
  if (!match) return null;

  const [, order, rawName] = match;
  const cleaned = rawName.replace(/\s*\(\d+\)$/, "").trim();
  const words = cleaned.split("_").filter(Boolean);
  const caption = words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

  return { order: Number(order), slug: `dish-${order}`, caption };
}

/**
 * Re-encodes one image into a single variant and returns its public path.
 *
 * @param {import('sharp').Sharp} image Source pipeline; cloned so it can be reused per variant.
 * @param {string} file Output file name inside `public/dishes`.
 * @param {number} width Target width in pixels.
 * @param {"webp"|"jpeg"} format
 * @param {object} options Encoder options.
 * @returns {Promise<string>} Path the browser requests, e.g. `/dishes/dish-03-800.webp`.
 */
async function emit(image, file, width, format, options) {
  const target = join(OUTPUT_DIR, file);
  await image
    .clone()
    .resize({ width, withoutEnlargement: true })
    [format](options)
    .toFile(target);
  return `/dishes/${file}`;
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const entries = (await readdir(SOURCE_DIR)).sort();
  const dishes = [];
  let sourceBytes = 0;
  let outputBytes = 0;

  for (const fileName of entries) {
    const info = describe(fileName);
    if (!info) continue;

    const sourcePath = join(SOURCE_DIR, fileName);
    const image = sharp(sourcePath);
    const meta = await image.metadata();
    sourceBytes += (await stat(sourcePath)).size;

    const webp = {};
    const jpg = {};
    for (const width of WIDTHS) {
      webp[width] = await emit(image, `${info.slug}-${width}.webp`, width, "webp", {
        quality: 78,
        effort: 5,
      });
      jpg[width] = await emit(image, `${info.slug}-${width}.jpg`, width, "jpeg", {
        quality: 80,
        mozjpeg: true,
      });
    }

    const placeholder = await emit(
      image,
      `${info.slug}-placeholder.jpg`,
      PLACEHOLDER_WIDTH,
      "jpeg",
      { quality: 45, mozjpeg: true }
    );

    for (const width of WIDTHS) {
      outputBytes += (await stat(join(OUTPUT_DIR, `${info.slug}-${width}.webp`))).size;
      outputBytes += (await stat(join(OUTPUT_DIR, `${info.slug}-${width}.jpg`))).size;
    }
    outputBytes += (await stat(join(OUTPUT_DIR, `${info.slug}-placeholder.jpg`))).size;

    dishes.push({
      slug: info.slug,
      caption: info.caption,
      width: meta.width,
      height: meta.height,
      placeholder,
      webp,
      jpg,
    });
  }

  if (!dishes.length) {
    throw new Error(`No numbered dish images found in ${SOURCE_DIR}`);
  }

  dishes.sort((a, b) => a.slug.localeCompare(b.slug));

  const header = `/**
 * Dish photographs for the home page showcase.
 *
 * GENERATED by \`scripts/optimize-dishes.mjs\` — do not edit by hand. Re-run \`npm run dishes\` after
 * replacing a source PNG in \`public/images\`; it rewrites this file together with the encoded
 * variants in \`public/dishes\`.
 *
 * Each entry carries the renditions the showcase needs (WebP for modern browsers, JPEG as the
 * fallback) plus a placeholder shown until the real photo decodes. The photos are square with the
 * dish name printed into the artwork, so they are displayed uncropped.
 *
 * @typedef {object} Dish
 * @property {string} slug Stable identifier, also the file-name stem in \`public/dishes\`.
 * @property {string} caption Title-cased name, used for the alt text.
 * @property {number} width Intrinsic width of the source photo.
 * @property {number} height Intrinsic height of the source photo.
 * @property {string} placeholder Tiny JPEG shown while the full photo loads.
 * @property {Record<number, string>} webp WebP rendition per width.
 * @property {Record<number, string>} jpg JPEG rendition per width.
 */

/** @type {Dish[]} */
const dishes = `;

  await writeFile(MANIFEST, `${header}${JSON.stringify(dishes, null, 2)};\n\nexport default dishes;\n`, "utf-8");

  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + " MB";
  console.log(`dish photos : ${dishes.length}`);
  console.log(`source size : ${mb(sourceBytes)} (PNG)`);
  console.log(`output size : ${mb(outputBytes)} (webp + jpeg + placeholders)`);
  console.log(`manifest    : ${MANIFEST}`);
  console.log(`output dir  : ${OUTPUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
