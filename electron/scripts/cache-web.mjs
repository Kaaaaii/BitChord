import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://bitchord-8bw.pages.dev';
const TARGET_DIR = path.resolve(__dirname, '../cached-web');

async function downloadFile(url, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  console.log(`Downloading: ${url} -> ${path.relative(TARGET_DIR, destPath)}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function main() {
  console.log(`Fetching BitChord web app from ${BASE_URL}...`);
  fs.mkdirSync(TARGET_DIR, { recursive: true });

  const htmlRes = await fetch(`${BASE_URL}/home`);
  if (!htmlRes.ok) {
    throw new Error(`Failed to fetch ${BASE_URL}/home: ${htmlRes.statusText}`);
  }
  let html = await htmlRes.text();

  // Find all assets: scripts, styles, icons, manifest
  const assetRegex = /(?:src|href)=["']([^"']+\.(?:js|css|png|svg|ico|json|woff2?|webmanifest))["']/g;
  const assetUrls = new Set();
  let match;

  while ((match = assetRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    if (rawUrl && !rawUrl.startsWith('http') && !rawUrl.startsWith('data:')) {
      assetUrls.add(rawUrl);
    }
  }

  console.log(`Found ${assetUrls.size} static assets to cache.`);

  for (const assetPath of assetUrls) {
    const cleanPath = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    const fullUrl = `${BASE_URL}/${cleanPath}`;
    const localDest = path.join(TARGET_DIR, cleanPath);

    try {
      await downloadFile(fullUrl, localDest);
    } catch (err) {
      console.warn(`Could not cache asset ${assetPath}:`, err.message);
    }
  }

  // Make paths relative for local file loading
  html = html
    .replaceAll('src="/assets/', 'src="./assets/')
    .replaceAll('href="/assets/', 'href="./assets/')
    .replaceAll('href="/favicon.svg"', 'href="./favicon.svg"');

  // Save index.html
  const indexPath = path.join(TARGET_DIR, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf-8');
  console.log(`\nSuccessfully cached web app into ${TARGET_DIR}`);
  console.log('You can run the app offline using: BITCHORD_OFFLINE=1 npm start');
}

main().catch((err) => {
  console.error('Caching failed:', err);
  process.exit(1);
});
