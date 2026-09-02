/**
 * Turn one photo into every icon the Home Screen install needs.
 *
 *   npm run icons                                  # uses public/source-icon.jpg
 *   npm run icons -- --focus=top                   # keep the top of a portrait shot
 *   npm run icons -- --file=path/to/photo.heic
 *
 * iOS crops nothing for you: hand it a 3:4 photo and it squashes it. This takes
 * a square crop, resizes to each size Apple and Android ask for, and writes
 * them into `public/`, which Next.js serves from the site root.
 *
 * Written in Node rather than Python deliberately. Python is needed for the
 * analytics job, but a machine can easily have several Pythons on its PATH and
 * only one of them carrying Pillow — which makes `npm run icons` fail in one
 * terminal and work in another. sharp is a project dependency, so `npm run
 * icons` resolves the same way everywhere.
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { args } from './_util';

const argv = args();

/** apple-touch-icon is what iOS uses; 192/512 are the PWA manifest sizes. */
const SIZES: Array<[string, number]> = [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['favicon-32.png', 32],
];

type Focus = 'top' | 'centre' | 'bottom' | 'attention';

/** Anything sharp can decode, including HEIC straight off an iPhone. */
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp', '.avif', '.tif', '.tiff']);

async function findSource(): Promise<string> {
  if (typeof argv.file === 'string') return argv.file;

  const dir = 'public';
  const entries = await readdir(dir).catch(() => [] as string[]);

  // The documented name first, then any other image in public/ that is not one
  // of the icons this script itself produces.
  const preferred = entries.find((f) => /^source-icon\./i.test(f));
  if (preferred) return path.join(dir, preferred);

  const generated = new Set([...SIZES.map(([n]) => n), 'favicon.ico']);
  const candidates = entries.filter(
    (f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()) && !generated.has(f),
  );
  if (candidates.length === 1) return path.join(dir, candidates[0]!);
  if (candidates.length > 1) {
    throw new Error(
      `several images in public/ (${candidates.join(', ')}).\n` +
        'Rename the one you want to source-icon.jpg, or pass --file=public/<name>.',
    );
  }

  throw new Error(
    'no source image found.\n\n' +
      '  Save your photo as public/source-icon.jpg (or .png/.heic), then run again.\n' +
      '  Or point at it directly:  npm run icons -- --file=C:/path/to/photo.jpg',
  );
}

async function main() {
  const source = await findSource();
  await stat(source).catch(() => {
    throw new Error(`${source} not found`);
  });

  const focus = ((typeof argv.focus === 'string' ? argv.focus : 'attention') as Focus) ?? 'attention';
  const image = sharp(source, { failOn: 'none' })
    // Phone photos carry an EXIF rotation flag; without this a portrait shot
    // comes out on its side.
    .rotate();

  const meta = await image.metadata();
  console.log(`[icons] source ${source}  ${meta.width}x${meta.height}  ${meta.format}`);

  // sharp's 'attention' strategy picks the most visually salient square, which
  // on a photo of an animal lands on the head far more reliably than a centre
  // crop does. The named positions are there for when it guesses wrong.
  const position =
    focus === 'attention'
      ? sharp.strategy.attention
      : focus === 'top'
        ? 'top'
        : focus === 'bottom'
          ? 'bottom'
          : 'centre';

  const side = Math.min(meta.width ?? 0, meta.height ?? 0);
  if (side === 0) throw new Error('could not read the image dimensions');

  const square = await image
    .resize(side, side, { fit: 'cover', position })
    .png()
    .toBuffer();
  console.log(`[icons] square crop ${side}x${side} (focus: ${focus})`);

  for (const [name, size] of SIZES) {
    const target = path.join('public', name);
    const info = await sharp(square)
      .resize(size, size, { kernel: 'lanczos3' })
      .png({ compressionLevel: 9 })
      .toFile(target);
    console.log(`[icons]   ${target.padEnd(32)} ${size}x${size}  ${Math.round(info.size / 1024)} KB`);
  }

  // Browsers accept a PNG served as .ico, and it avoids a second encoder.
  await sharp(square).resize(48, 48, { kernel: 'lanczos3' }).png().toFile('public/favicon.ico');
  console.log('[icons]   public/favicon.ico');

  console.log(
    '\n[icons] Done. Now:\n' +
      '  git add public && git commit -m "Home screen icon" && git push\n' +
      '  Then on the phone: open the site in Safari -> Share -> Add to Home Screen.\n' +
      '  If it is already on your Home Screen, delete it and add it again — iOS\n' +
      '  caches the old icon indefinitely.',
  );
}

main().catch((err: unknown) => {
  console.error(`\n[icons] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
