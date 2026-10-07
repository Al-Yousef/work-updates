'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict'),
  { execFileSync } = require('node:child_process');
const { fixture } = require('../tests/fixtures/research-profile.cjs'),
  { reader } = require('../src/research-reader.cjs'),
  { atomicJSON } = require('../src/private-store.cjs');
async function audit({ helper } = {}) {
  const root = path.resolve(__dirname, '..'),
    reportFile = path.join(
      root,
      helper
        ? 'artifacts/research-packaged/verification.json'
        : 'artifacts/research-audit/verification.json',
    );
  fs.rmSync(reportFile, { force: true });
  const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
  if (process.argv.includes('--require-clean') && sourceDirty)
    throw new Error('Research audit requires clean source');
  const f = fixture(),
    home = path.join(f.directory, 'reader-store'),
    python = process.env.WORK_UPDATES_PYTHON || 'python';
  let reads = 0;
  try {
    const prepare = (mode) =>
      execFileSync(
        python,
        [
          path.join(root, 'tests/fixtures/research-store.py'),
          '--root',
          f.directory,
          '--thread-id',
          f.source.id,
          '--mode',
          mode,
        ],
        { windowsHide: true, timeout: 10000, stdio: 'pipe' },
      );
    prepare('initial');
    // CI's Windows TEMP can use an 8.3 alias. Exercise that spelling when the
    // filesystem provides one, without exposing the private fixture path.
    const readerHome =
      process.platform === 'win32'
        ? execFileSync(
            python,
            [
              '-c',
              'import ctypes,sys; b=ctypes.create_unicode_buffer(32768); n=ctypes.windll.kernel32.GetShortPathNameW(sys.argv[1],b,len(b)); print(b.value if n else sys.argv[1])',
              home,
            ],
            { windowsHide: true, timeout: 10000, encoding: 'utf8' },
          ).trim()
        : home;
    let readCheck = null;
    const actual = reader({ codexHome: readerHome, ...(helper ? { helper } : { python }) }),
      read = actual.read;
    actual.read = async (request) => {
      reads++;
      try {
        const result = await read(request);
        readCheck = {
          storeMatches: result.storeId === request.storeId,
          sourceMatches: result.threadId === request.scope.sourceId,
          nonceMatches: result.requestNonce === request.nonce,
          boundsMatch: result.since === request.since && result.until === request.until,
          recordCount: result.records?.length,
        };
        return result;
      } catch (error) {
        readCheck = {
          failureCode: ['RESEARCH_READ_FAILED', 'RESEARCH_READ_INVALID'].includes(error.code)
            ? error.code
            : 'READER_FAILED',
        };
        throw error;
      }
    };
    f.research.options.reader = actual;
    f.wall();
    const enabled = await f.enable(),
      id = enabled.researchId;
    assert.equal(enabled.status, 'completed', enabled.answer);
    assert.equal(reads, 0);
    const files = [path.join(home, 'state_5.sqlite'), path.join(home, f.source.id + '.jsonl')],
      bytes = files.map((file) => fs.readFileSync(file));
    await f.ask('/research read ' + id);
    assert.equal(reads, 1);
    assert.equal(
      f.research.entry(id).records.length,
      2,
      JSON.stringify({
        phase: f.research.entry(id).phase,
        scanStatus: f.research.entry(id).scans.at(-1)?.status,
        readCheck,
      }),
    );
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), bytes[i]));
    const firstIds = f.research.entry(id).records.map((r) => r.id);
    prepare('later');
    f.wall();
    const laterBytes = files.map((file) => fs.readFileSync(file));
    await f.ask('/research read ' + id);
    assert.equal(reads, 2);
    const result = f.research.entry(id);
    assert.equal(result.records.length, 4);
    assert.deepEqual(
      result.records.slice(0, 2).map((r) => r.id),
      firstIds,
    );
    assert.ok(result.records.at(-1).text.includes('unverified'));
    assert.equal(result.scans.at(-1).coverage.exhaustive, false);
    files.forEach((file, i) => assert.deepEqual(fs.readFileSync(file), laterBytes[i]));
    f.restart();
    assert.equal(f.research.entry(id).records.length, 4);
    assert.equal(f.calls, 0);
    assert.equal(f.questions, 0);
    await f.ask('/research revoke ' + id);
    await f.ask('/research read ' + id);
    assert.equal(reads, 2);
    const report = {
      schema: 1,
      passed: true,
      synthetic: true,
      sourceRevision,
      sourceDirty,
      packagedCollector: !!helper,
      actualScopedReaderProcesses: reads,
      originalAndLaterRepliesRetained: true,
      sourceStoreUnchangedByRead: true,
      stableRecordCursorsAndDeduplication: true,
      coverageAlwaysBounded: true,
      revocationPreventedFurtherReads: true,
      sourceDispatches: 0,
      accountsUsed: 0,
      modelCalls: 0,
      installedAppChanged: false,
      resultSha256: crypto
        .createHash('sha256')
        .update(JSON.stringify(result.records))
        .digest('hex'),
      limits:
        'Owned disposable SQLite and rollout records. This proves scoped original-reader behavior, not separately authorized real-account access, exhaustive history, inferred assignment or independently verified completion. No new source subscriptions, sends, browser control or model inference.',
    };
    atomicJSON(reportFile, report);
    console.log(JSON.stringify(report));
    return report;
  } finally {
    f.close();
  }
}
if (require.main === module)
  audit().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
module.exports = { audit };
