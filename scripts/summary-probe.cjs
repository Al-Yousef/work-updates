'use strict';
// Synthetic inference only: never print live chat excerpts or credentials.
const path = require('node:path');
const { Codex } = require('../src/codex.cjs');
const { CodexSummaryProvider } = require('../src/summary-provider.cjs');
(async () => {
  const provider = new CodexSummaryProvider({
    directory: path.resolve('artifacts/summary-probe/workspace'),
    timeoutMs: 45000,
    clientFactory: () => {
      const client = new Codex({ requestTimeoutMs: 15000 });
      client.on('notification', (m) => {
        console.log(
          JSON.stringify({
            method: m.method,
            type: m.params?.item?.type,
            keys: Object.keys(m.params || {}),
            error: m.params?.error?.message,
          }),
        );
      });
      return client;
    },
  });
  try {
    console.log(
      JSON.stringify(
        await provider.summarize({
          chatName: 'App work',
          request: 'Fix queue titles and install updated app',
          update:
            'Added cached AI task summaries. Unit checks passed; the updated desktop app has not been installed yet. Needs installation verification next.',
        }),
      ),
    );
  } finally {
    provider.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
