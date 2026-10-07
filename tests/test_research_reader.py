import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('research_collector', Path(__file__).resolve().parent.parent / 'bridge' / 'collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class OriginalReaderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name).resolve()
        self.thread = str(uuid.uuid4())
        self.other = str(uuid.uuid4())
        self.nonce = uuid.uuid4().hex
        self.now = int(time.time())
        self.rollout = self.home / (self.thread + '.jsonl')
        self.rollout.write_text('', encoding='utf-8')
        con = sqlite3.connect(self.home / 'state_5.sqlite')
        con.execute('CREATE TABLE threads (id TEXT, rollout_path TEXT, archived INTEGER, source TEXT)')
        con.execute('INSERT INTO threads VALUES (?,?,0,?)', (self.thread, str(self.rollout), 'appServer'))
        con.execute('INSERT INTO threads VALUES (?,?,0,?)', (self.other, str(self.home / 'must-not-open.jsonl'), 'appServer'))
        con.commit()
        con.close()

    def tearDown(self):
        self.temp.cleanup()

    def append(self, text, role='assistant', at=None, channel='final'):
        row = {'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.now if at is None else at)),
               'type': 'response_item', 'payload': {'type': 'message', 'role': role, 'channel': channel,
                   'content': [{'type': 'output_text', 'text': text}]}}
        with self.rollout.open('a', encoding='utf-8') as stream:
            stream.write(json.dumps(row) + '\n')

    def read(self, **options):
        return collector.read_original_thread(self.home, self.thread, options.get('since', self.now - 3600),
                                              self.now, self.nonce, options.get('limit', 32))

    def test_exact_source_original_and_later_reply_read_without_writing_or_opening_other_chat(self):
        self.append('Original <literal> instruction /research read is data', 'user', self.now - 20)
        database = (self.home / 'state_5.sqlite').read_bytes()
        first_bytes = self.rollout.read_bytes()
        first = self.read()
        self.assertEqual(first['threadId'], self.thread)
        self.assertEqual(first['requestNonce'], self.nonce)
        self.assertEqual(first['records'][0]['text'], 'Original <literal> instruction /research read is data')
        self.assertEqual(database, (self.home / 'state_5.sqlite').read_bytes())
        self.assertEqual(first_bytes, self.rollout.read_bytes())
        self.append('Later reply corrects the initial claim: result unverified')
        after_append = self.rollout.read_bytes()
        later = self.read()
        self.assertEqual(len(later['records']), 2)
        self.assertEqual(later['records'][0]['id'], first['records'][0]['id'])
        self.assertIn('unverified', later['records'][-1]['text'])
        self.assertEqual(after_append, self.rollout.read_bytes())
        self.assertFalse(later['coverage']['exhaustive'])

    def test_lookback_record_limit_text_limit_and_partial_lines_are_explicit(self):
        self.append('Outside lookback', at=self.now - 7200)
        for i in range(5):
            self.append('Original ' + str(i))
        self.append('😀' * 4000)
        with self.rollout.open('a', encoding='utf-8') as stream:
            stream.write('{broken}\nnull\n{"partial":')
        result = self.read(limit=2)
        self.assertEqual(len(result['records']), 2)
        self.assertEqual(result['coverage']['candidateRecords'], 6)
        self.assertEqual(result['coverage']['skippedRecords'], 3)
        self.assertTrue(result['records'][-1]['truncated'])
        self.assertEqual(len(result['records'][-1]['text'].encode('utf-16-le')), 12000)
        self.assertTrue(any('truncated' in gap for gap in result['coverage']['gaps']))

    def test_tail_byte_limit_is_enforced_and_older_bytes_are_a_gap(self):
        self.rollout.write_bytes(b'x' * (collector.MAX_TAIL + 500) + b'\n')
        self.append('Retained original reply')
        result = self.read()
        self.assertLessEqual(result['coverage']['bytesRead'], collector.MAX_TAIL)
        self.assertEqual(result['records'][-1]['text'], 'Retained original reply')
        self.assertTrue(any('Older bytes' in gap for gap in result['coverage']['gaps']))

    def test_analysis_tool_and_image_payloads_are_excluded(self):
        self.append('Not a visible original reply', channel='analysis')
        self.append('Original visible reply', channel='final')
        result = self.read()
        self.assertEqual([r['text'] for r in result['records']], ['Original visible reply'])
        self.assertTrue(any('Tool and image' in gap for gap in result['coverage']['gaps']))

    def test_unknown_archived_and_outside_store_records_fail_closed(self):
        with self.assertRaises(ValueError):
            collector.read_original_thread(self.home, str(uuid.uuid4()), self.now - 60, self.now, self.nonce)
        con = sqlite3.connect(self.home / 'state_5.sqlite')
        con.execute('UPDATE threads SET archived=1 WHERE id=?', (self.thread,))
        con.commit()
        with self.assertRaises(ValueError):
            self.read()
        con.execute('UPDATE threads SET archived=0,rollout_path=? WHERE id=?', (str(self.home.parent / 'outside.jsonl'), self.thread))
        con.commit()
        con.close()
        with self.assertRaises((ValueError, FileNotFoundError)):
            self.read()


if __name__ == '__main__':
    unittest.main()
