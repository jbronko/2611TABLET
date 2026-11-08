#!/usr/bin/env node
// Render an app's home-screen icons from <app>/icon.svg.
//
//   node tools/make-icons.js <app-folder>
//
// icon.svg should be a full-bleed 512×512 square with the important parts inside the middle
// circle (radius 205), so Android can crop it to any shape. Writes <app>/icons/:
//   icon-192.png, icon-512.png       rounded-corner icons ("any")
//   icon-maskable-512.png            full-bleed icon Android crops itself ("maskable")
//   apple-touch-icon.png             180×180 square
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const app = process.argv[2];
if (!app) { console.error('Usage: node tools/make-icons.js <app-folder>'); process.exit(1); }
const dir = path.resolve(__dirname, '..', app);
const src = path.join(dir, 'icon.svg');
if (!fs.existsSync(src)) { console.error(`${path.relative(process.cwd(), src)} not found.`); process.exit(1); }
const out = path.join(dir, 'icons');
fs.mkdirSync(out, { recursive: true });
const dataUrl = 'data:image/svg+xml;base64,' + fs.readFileSync(src).toString('base64');

const jobs = [
  ['icon-192.png', 192, true],
  ['icon-512.png', 512, true],
  ['icon-maskable-512.png', 512, false],
  ['apple-touch-icon.png', 180, false],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size, rounded] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    const radius = rounded ? Math.round(size * 0.1875) : 0;
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>` +
      `<img src="${dataUrl}" width="${size}" height="${size}" style="display:block;border-radius:${radius}px">`);
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(out, file), omitBackground: true });
  }
  await browser.close();
  console.log(`Wrote ${jobs.length} icons to ${path.relative(process.cwd(), out) || out}/`);
})().catch(err => { console.error(err.message); process.exit(1); });
