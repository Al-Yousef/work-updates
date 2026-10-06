'use strict';
const path = require('node:path');
const { startPreview } = require('../candidate/dot-inbox/server.cjs');
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
(async () => {
  const liveRoot = value('--live-root');
  const protocolFixtures = args.includes('--protocol-fixtures');
  const preview = await startPreview({
    liveRoot: liveRoot ? path.resolve(liveRoot) : null,
    port: Number(value('--port') || (protocolFixtures ? 51847 : 51845)),
    recoveryRoot: path.resolve(
      value('--recovery-root') ||
        (protocolFixtures
          ? 'artifacts/dot-inbox/protocol-recovery'
          : 'artifacts/dot-inbox/recovery'),
    ),
    protocolFixtures,
    collectLocal: value('--collect-local') ? path.resolve(value('--collect-local')) : null,
    privacyReview: args.includes('--privacy-review'),
  });
  console.log('Local dot inbox: ' + preview.origin);
  console.log(
    'Fixtures are synthetic. ' +
      (liveRoot ? 'Installed queue is read-only.' : 'No installed-app data is loaded.'),
  );
  const stop = async () => {
    await preview.close();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
