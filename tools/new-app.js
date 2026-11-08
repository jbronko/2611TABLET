#!/usr/bin/env node
// Create a new installable app from _template/.
//
//   node tools/new-app.js <slug> "<App Name>" [--color #2f6f8f] [--description "One sentence."]
//
// Copies _template/ to <slug>/, fills in the placeholders, renders the icons and adds the
// app to apps.json (which the launcher page at the site root lists).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const color = flag('--color') || '#2f6f8f';
const description = flag('--description') || '';
const [slug, name] = args;

if (!slug || !name) {
  console.error('Usage: node tools/new-app.js <slug> "<App Name>" [--color #hex] [--description "..."]');
  process.exit(1);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  console.error(`Slug "${slug}" must be lowercase letters, digits and hyphens, like "word-garden".`);
  process.exit(1);
}
if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
  console.error(`Color "${color}" must be a 6-digit hex color like #2f6f8f.`);
  process.exit(1);
}
const dest = path.join(ROOT, slug);
if (fs.existsSync(dest)) {
  console.error(`${slug}/ already exists. Pick another slug or edit that app directly.`);
  process.exit(1);
}

// Light background: the theme color mixed heavily with white. Dark background: mixed with near-black.
const mix = (hex, other, t) => '#' + [1, 3, 5].map(i => {
  const a = parseInt(hex.slice(i, i + 2), 16), b = parseInt(other.slice(i, i + 2), 16);
  return Math.round(a + (b - a) * t).toString(16).padStart(2, '0');
}).join('');
const values = {
  __APP_SLUG__: slug,
  __APP_NAME__: name,
  __APP_DESCRIPTION__: description || name,
  __THEME_COLOR__: color,
  __BG_COLOR__: mix(color, '#ffffff', 0.9),
  __BG_COLOR_DARK__: mix(color, '#0b0f12', 0.88),
};
const fill = text => text.replace(/__[A-Z_]+__/g, k => (k in values ? values[k] : k));

fs.mkdirSync(dest);
for (const file of fs.readdirSync(path.join(ROOT, '_template'))) {
  const text = fs.readFileSync(path.join(ROOT, '_template', file), 'utf8');
  fs.writeFileSync(path.join(dest, file), fill(text));
}

execFileSync(process.execPath, [path.join(__dirname, 'make-icons.js'), slug], { stdio: 'inherit' });

const appsFile = path.join(ROOT, 'apps.json');
const apps = fs.existsSync(appsFile) ? JSON.parse(fs.readFileSync(appsFile, 'utf8')) : [];
apps.push({ slug, name, description: description || '' });
fs.writeFileSync(appsFile, JSON.stringify(apps, null, 2) + '\n');

console.log(`Created ${slug}/ and added it to apps.json.`);
console.log(`Next: build the app in ${slug}/index.html, redraw ${slug}/icon.svg, then run`);
console.log(`  node tools/make-icons.js ${slug} && node tools/check-pwa.js ${slug}`);
