'use strict';
// Rasterize our vector sources with Chromium; no generated artwork or image edits.
const { chromium } = require('playwright');
const fs = require('node:fs'),
  path = require('node:path');
const assets = path.resolve(__dirname, '../assets');
async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 512, height: 512 },
      deviceScaleFactor: 1,
    });
    const raster = async (source, size, color = '#000') => {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        '<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh;color:' +
          color +
          '}</style>' +
          source,
      );
      return page.screenshot({ omitBackground: true });
    };
    const source = fs.readFileSync(path.join(assets, 'icon.svg'), 'utf8');
    fs.writeFileSync(path.join(assets, 'icon.png'), await raster(source, 512));
    const sizes = [16, 24, 32, 48, 64, 128, 256];
    const images = [];
    for (const size of sizes) images.push(await raster(source, size));
    const header = Buffer.alloc(6 + sizes.length * 16);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sizes.length, 4);
    let offset = header.length;
    sizes.forEach((size, index) => {
      const at = 6 + index * 16;
      header[at] = header[at + 1] = size === 256 ? 0 : size;
      header.writeUInt16LE(1, at + 4);
      header.writeUInt16LE(32, at + 6);
      header.writeUInt32LE(images[index].length, at + 8);
      header.writeUInt32LE(offset, at + 12);
      offset += images[index].length;
    });
    fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([header, ...images]));
    const tray = fs.readFileSync(path.join(assets, 'tray.svg'), 'utf8');
    for (const [tone, color] of [
      ['light', '#fff'],
      ['dark', '#17243b'],
    ])
      for (const factor of [1, 2, 3])
        fs.writeFileSync(
          path.join(assets, 'tray-' + tone + (factor === 1 ? '' : '@' + factor + 'x') + '.png'),
          await raster(tray, 16 * factor, color),
        );
    console.log('App icon, Windows ICO and 1x/2x/3x tray assets rendered from SVG.');
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
