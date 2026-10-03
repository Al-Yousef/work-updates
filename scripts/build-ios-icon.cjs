'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({
      viewport: { width: 1024, height: 1024 },
      deviceScaleFactor: 1,
    });
    await page.setContent(
      '<style>html,body{margin:0;width:1024px;height:1024px;background:#105078}svg{width:1024px;height:1024px;display:block}</style>' +
        fs.readFileSync(path.join(root, 'assets/icon.svg'), 'utf8'),
    );
    await page.screenshot({
      path: path.join(root, 'ios/App/Assets.xcassets/AppIcon.appiconset/icon.png'),
      animations: 'disabled',
    });
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
