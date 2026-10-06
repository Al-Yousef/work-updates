'use strict';
const path = require('node:path');
const { build, Platform, Arch } = require('electron-builder');
const root = path.resolve(__dirname, '..');
const protocolFixtures = process.argv.includes('--protocol-fixtures');
const buildDirectory = protocolFixtures ? 'desktop-protocol-build' : 'desktop-build';
const fs = require('node:fs');
const temporary = path.join(root, 'artifacts', 'dot-inbox', 'build-temporary');
fs.mkdirSync(temporary, { recursive: true });
process.env.TEMP = temporary;
process.env.TMP = temporary;
const reviewData = path.join(
  root,
  'artifacts',
  'dot-inbox',
  buildDirectory,
  'win-unpacked',
  'review-data',
);
let preserved;
if (fs.existsSync(reviewData)) {
  if (fs.lstatSync(reviewData).isSymbolicLink())
    throw new Error('Review data cannot be redirected.');
  const history = path.join(root, 'artifacts', 'dot-inbox', 'preserved-desktop-builds');
  fs.mkdirSync(history, { recursive: true });
  preserved = fs.mkdtempSync(path.join(history, 'before-build-'));
  fs.cpSync(reviewData, path.join(preserved, 'review-data'), {
    recursive: true,
    dereference: false,
  });
}
build({
  projectDir: root,
  targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64),
  config: {
    extends: null,
    appId: 'io.workupdates.desktop.review' + (protocolFixtures ? '.protocol' : ''),
    productName: protocolFixtures ? 'Work Updates Protocol Review' : 'Work Updates Review',
    electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
    directories: { output: path.join(root, 'artifacts', 'dot-inbox', buildDirectory) },
    files: [
      'candidate/dot-inbox/app.js',
      'candidate/dot-inbox/model.js',
      'candidate/dot-inbox/server.cjs',
      'candidate/dot-inbox/fixture.cjs',
      'candidate/dot-inbox/protocol-fixture.cjs',
      'candidate/dot-inbox/journal.cjs',
      'candidate/dot-inbox/style.css',
      'candidate/dot-inbox/index.html',
      'candidate/dot-inbox/desktop/*.cjs',
      'candidate/dot-inbox/desktop/desktop.css',
      'src/**',
      'ui/style.css',
      'assets/**',
      'package.json',
      'LICENSE',
    ],
    extraMetadata: {
      name: protocolFixtures ? 'work-updates-protocol-review' : 'work-updates-review',
      main: 'candidate/dot-inbox/desktop/main.cjs',
      dotInboxProtocolFixtures: protocolFixtures,
    },
    extraResources: [],
    asar: true,
    publish: null,
    win: { icon: 'assets/icon.ico', signAndEditExecutable: false },
  },
})
  .then(() => {
    if (preserved && !fs.existsSync(reviewData))
      fs.cpSync(path.join(preserved, 'review-data'), reviewData, {
        recursive: true,
        dereference: false,
      });
    process.stdout.write(
      'Separate local desktop review bundle built. No installer or publication. Existing review recovery was preserved.\n',
    );
  })
  .catch((error) => {
    process.stderr.write(error.stack + '\n');
    process.exitCode = 1;
  });
