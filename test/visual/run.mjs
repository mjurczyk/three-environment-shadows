/**
 * Visual tests: one screenshot per environment and renderer, compared with the validation set and
 * between the renderers.
 *
 *   npm run test:visual              compare (validation set: max 1 %, WebGL vs WebGPU: max 0.1 %)
 *   npm run test:visual -- --update  store the new screenshots as the validation set
 *
 * Needs Google Chrome with GPU access (WebGPU). Set CHROME_PATH if it is not in the default place.
 * The difference of two screenshots is the percent of pixels that differ visibly (pixelmatch, threshold 0.1).
 * test/visual/output also gets pair-<environment>.png per environment (WebGL left, WebGPU right).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const VALIDATION = join(ROOT, 'test/visual/validation_set');
const OUTPUT = join(ROOT, 'test/visual/output');

const RENDERERS = ['webgl', 'webgpu'];
const ENVIRONMENTS = ['sky_midday', 'sky_dusk', 'sky_cloudy', 'sky_night', 'studio_rgb'];

// NOTE 3:4, 1024 px high
const WIDTH = 768;
const HEIGHT = 1024;

const MAX_VALIDATION_DIFF = 1;
const MAX_RENDERER_DIFF = 0.1;

const PORT = Number(process.env.VISUAL_PORT ?? 5310);
const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UPDATE = process.argv.includes('--update');

const name = (renderer, environment) => `${renderer}-${environment}.png`;

// NOTE The example dev server, the same page as `npm run dev`
async function startServer() {
  const server = spawn(
    'npx',
    ['vite', '--config', './dev.config.js', '--port', String(PORT), '--strictPort'],
    {
      cwd: join(ROOT, 'examples'),
      stdio: ['ignore', 'pipe', 'pipe'],
      // NOTE Own process group, so stopping it also stops vite under npx
      detached: true,
    },
  );

  const stop = () => {
    try {
      process.kill(-server.pid);
    } catch {
      // NOTE Already stopped
    }
  };

  const url = `http://localhost:${PORT}/`;

  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return { stop, url };
    } catch {
      // NOTE Not up yet
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  stop();
  throw new Error(`The example server did not start on port ${PORT}`);
}

async function screenshot(browser, url, renderer, environment) {
  const page = await browser.newPage();
  const errors = [];

  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(`${url}?renderer=${renderer}&env=${environment}&test=1`);

  try {
    await page.waitForFunction(() => window.environmentShadowsTest?.isReady(), {
      timeout: 120000,
      polling: 100,
    });
  } catch (error) {
    await page.close();
    throw new Error(
      `${renderer} / ${environment}: not ready (${errors.join('; ') || error.message})`,
    );
  }

  // NOTE Two more frames, so the canvas shows the finished lightmap
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );

  const png = await page.screenshot({ type: 'png' });
  await page.close();

  return { png: Buffer.from(png), errors };
}

// NOTE Places images in a grid ( rows of PNG buffers ), all images have the same size
function grid(rows) {
  const images = rows.map((row) => row.map((png) => PNG.sync.read(png)));
  const { width, height } = images[0][0];
  const columns = Math.max(...images.map((row) => row.length));
  const out = new PNG({ width: width * columns, height: height * images.length });

  images.forEach((row, r) => {
    row.forEach((image, c) => {
      PNG.bitblt(image, out, 0, 0, width, height, c * width, r * height);
    });
  });

  return PNG.sync.write(out);
}

// NOTE Percent of pixels that differ visibly, writes the diff image
function compare(a, b, diffPath) {
  const imageA = PNG.sync.read(a);
  const imageB = PNG.sync.read(b);

  if (imageA.width !== imageB.width || imageA.height !== imageB.height) return 100;

  const diff = new PNG({ width: imageA.width, height: imageA.height });
  const mismatched = pixelmatch(imageA.data, imageB.data, diff.data, imageA.width, imageA.height, {
    threshold: 0.1,
  });

  writeFileSync(diffPath, PNG.sync.write(diff));

  return (100 * mismatched) / (imageA.width * imageA.height);
}

async function main() {
  mkdirSync(OUTPUT, { recursive: true });

  const { stop, url } = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
  });

  const shots = {};
  const failures = [];

  try {
    for (const renderer of RENDERERS) {
      for (const environment of ENVIRONMENTS) {
        const { png, errors } = await screenshot(browser, url, renderer, environment);

        shots[name(renderer, environment)] = png;
        writeFileSync(join(OUTPUT, name(renderer, environment)), png);

        if (errors.length > 0)
          failures.push(`${renderer} / ${environment}: page errors: ${errors.join('; ')}`);

        console.log(`captured ${name(renderer, environment)}`);
      }
    }
  } finally {
    await browser.close();
    stop();
  }

  const report = { validation: [], renderers: [] };

  // NOTE 1) Against the validation set, if there is one
  const hasValidationSet = existsSync(VALIDATION);

  if (hasValidationSet) {
    for (const [file, png] of Object.entries(shots)) {
      const reference = join(VALIDATION, file);

      if (!existsSync(reference)) {
        report.validation.push({ file, diff: null, pass: false });
        failures.push(`${file}: missing in the validation set`);
        continue;
      }

      const diff = compare(readFileSync(reference), png, join(OUTPUT, `diff-validation-${file}`));
      const pass = diff <= MAX_VALIDATION_DIFF;

      report.validation.push({ file, diff: +diff.toFixed(3), pass });

      if (!pass)
        failures.push(
          `${file}: ${diff.toFixed(3)} % different from the validation set (max ${MAX_VALIDATION_DIFF} %)`,
        );
    }
  }

  // NOTE WebGL (left) and WebGPU (right) side by side, one image per environment
  const pairs = ENVIRONMENTS.map((environment) => [
    shots[name('webgl', environment)],
    shots[name('webgpu', environment)],
  ]);

  ENVIRONMENTS.forEach((environment, i) =>
    writeFileSync(join(OUTPUT, `pair-${environment}.png`), grid([pairs[i]])),
  );

  // NOTE 2) WebGL (GLSL) against WebGPU (TSL)
  for (const environment of ENVIRONMENTS) {
    const diff = compare(
      shots[name('webgl', environment)],
      shots[name('webgpu', environment)],
      join(OUTPUT, `diff-renderers-${environment}.png`),
    );
    const pass = diff <= MAX_RENDERER_DIFF;

    report.renderers.push({ environment, diff: +diff.toFixed(3), pass });

    if (!pass)
      failures.push(
        `${environment}: WebGL and WebGPU ${diff.toFixed(3)} % different (max ${MAX_RENDERER_DIFF} %)`,
      );
  }

  writeFileSync(join(OUTPUT, 'report.json'), JSON.stringify(report, null, 2));

  console.log('\nValidation set (max 1 %):');

  if (hasValidationSet) console.table(report.validation);
  else console.log('  no validation set, skipped (create it with --update)');

  console.log('WebGL vs WebGPU (max 0.1 %):');
  console.table(report.renderers);

  if (UPDATE) {
    mkdirSync(VALIDATION, { recursive: true });

    for (const [file, png] of Object.entries(shots)) writeFileSync(join(VALIDATION, file), png);

    console.log(`\nValidation set updated: ${VALIDATION}`);
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} mismatch(es):`);
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll screenshots match.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
