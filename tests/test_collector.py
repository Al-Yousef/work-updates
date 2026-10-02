import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('collector', Path(__file__).resolve().parent.parent / 'bridge' / 'collector.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class FeedTests(unittest.TestCase):
    def setUp(self):
        collector.SOURCE_CACHE.clear(); collector.TAIL_CACHE.clear()
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.now = int(time.time())
        self.iso = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.now))
        db = sqlite3.connect(self.home / 'state_5.sqlite')
        db.execute('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT, rollout_path TEXT, updated_at INTEGER, archived INTEGER, source TEXT)')
        db.commit(); db.close()
        self.config = {'codexHome': str(self.home), 'ignoredThreadIds': ['ignored'], 'recentDays': 14}

    def tearDown(self):
        self.temp.cleanup()

    def add(self, id, name, records, source='vscode', archived=0):
        path = self.home / (id + '.jsonl')
        path.write_text('\n'.join(json.dumps(r) for r in records) + '\n', encoding='utf-8')
        con = sqlite3.connect(self.home / 'state_5.sqlite')
        con.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)',
                    (id, name, 'Original prompt', '', '', str(path), self.now, archived, source))
        con.commit(); con.close()
        return path

    def record(self, text, phase='commentary'):
        return {'timestamp': self.iso, 'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'phase': phase, 'content': [{'type': 'output_text', 'text': text}]}}

    def test_actual_name_latest_message_and_readonly(self):
        path = self.add('one', 'The actual chat name', [self.record('Earlier'), self.record('Still working')])
        before = (self.home / 'state_5.sqlite').read_bytes()
        feed = collector.collect(self.config)
        self.assertEqual(feed['threads'][0]['title'], 'The actual chat name')
        self.assertEqual(feed['threads'][0]['body'], 'Still working')
        self.assertEqual(feed['threads'][0]['status'], 'working')
        self.assertEqual(before, (self.home / 'state_5.sqlite').read_bytes())
        self.assertEqual(path.read_text().count('response_item'), 2)

    def test_skip_ignored_archived_subagents(self):
        for id, source, archived in [('ignored','vscode',0), ('archived','cli',1), ('agent','{"subagent":{}}',0), ('visible','vscode',0)]:
            self.add(id, id, [self.record('Hi')], source, archived)
        self.assertEqual([t['id'] for t in collector.collect(self.config)['threads']], ['visible'])

    def test_completed_turn_is_update_not_completed_project(self):
        self.add('one', 'One', [self.record('Published the post. The next topic is still open.', 'final_answer'),
                               {'timestamp': self.iso, 'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'turn'}}])
        result = collector.collect(self.config)['threads'][0]
        self.assertEqual(result['status'], 'ready')
        self.assertTrue(result['readyForReview'])
        self.assertEqual(result['label'], 'Ready to review')

    def test_explicit_blockers_and_waiting(self):
        self.assertEqual(collector.determine_status('The remaining blocker is the permit.', 'final_answer', 'updated', 0)[0], 'blocked')
        self.assertEqual(collector.determine_status('Awaiting the reviewer confirmation.', 'final_answer', 'updated', 0)[0], 'waiting')
        self.assertEqual(collector.determine_status('Not waiting for a reply.', 'final_answer', 'updated', 0)[0], 'updated')
        self.assertEqual(collector.determine_status('Need your approval.', 'final_answer', 'updated', 0)[0], 'needs')
        self.assertEqual(collector.determine_status('It has your approval and it is working now.', 'final_answer', 'updated', 0)[0], 'updated')
        self.assertEqual(collector.determine_status('I fixed the blocked state.', 'commentary', 'working', 0)[0], 'working')

    def test_summary_surfaces_action_and_strips_product_citations(self):
        body = collector.plain('The permit was approved. :codex-file-citation{path="private.pdf" purpose="source"}\n\nThe remaining blocker is front/back photos of the permit.')
        self.assertNotIn('private.pdf', body)
        self.assertEqual(collector.summarize(body, 'blocked'), 'The remaining blocker is front/back photos of the permit.')

    def test_large_tail_partial_lines_and_no_timestamp_resurrection(self):
        p = self.add('one', 'One', [self.record('Awaiting a reply.', 'final_answer')])
        with p.open('ab') as f:
            f.write(b'{"tool":"' + b'x' * (collector.MAX_TAIL + 10) + b'"}\n')
            f.write((json.dumps(self.record('Newest context', 'final_answer')) + '\n').encode())
            f.write(b'{"unfinished":')
        a = collector.collect(self.config)['threads'][0]
        self.assertEqual(a['body'], 'Newest context')
        con = sqlite3.connect(self.home / 'state_5.sqlite'); con.execute('UPDATE threads SET updated_at=updated_at+100'); con.commit(); con.close()
        b = collector.collect(self.config)['threads'][0]
        self.assertEqual(a['fingerprint'], b['fingerprint'])

    def test_newer_rollout_overrides_stale_history(self):
        h = sqlite3.connect(self.home / 'thread_history_1.sqlite')
        h.execute('CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER)')
        h.execute('CREATE TABLE thread_items (thread_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER)')
        h.execute('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)', ('one','old','interrupted', self.now-300, self.now-200,1))
        h.execute('INSERT INTO thread_items VALUES (?,?,?,?,?,?)', ('one','old','agentMessage', json.dumps({'text':'Old interrupted turn','phase':'commentary'}),(self.now-210)*1000,1))
        h.commit();h.close()
        self.add('one', 'Forked chat', [self.record('Current fork is working')])
        result = collector.collect(self.config)['threads'][0]
        self.assertEqual(result['body'], 'Current fork is working')
        self.assertEqual(result['status'], 'working')

    def test_all_old_chats_are_watched_and_new_completion_is_detected(self):
        for i in range(75):
            self.add('old-'+str(i), 'Older '+str(i), [], 'exec' if i == 74 else 'vscode')
        con = sqlite3.connect(self.home / 'state_5.sqlite'); con.execute('UPDATE threads SET updated_at=?', (self.now-90*86400,)); con.commit(); con.close()
        first = collector.collect(self.config)
        self.assertEqual(len(first['threads']), 75)
        self.assertFalse(any(t['contextLoaded'] for t in first['threads']))
        path = self.home / 'old-74.jsonl'
        path.write_text(json.dumps({'timestamp':self.iso,'type':'event_msg','payload':{'type':'task_complete','turn_id':'resumed-old','last_agent_message':'This pass is ready.'}})+'\n',encoding='utf-8')
        latest = next(t for t in collector.collect(self.config)['threads'] if t['id']=='old-74')
        self.assertTrue(latest['readyForReview'])
        self.assertEqual(latest['body'], 'This pass is ready.')
        self.assertEqual(latest['notificationAt'], self.now)

    def test_final_message_waits_for_completion_and_commentary_does_not_notify(self):
        start = {'timestamp':self.iso,'type':'event_msg','payload':{'type':'task_started','turn_id':'turn-one'}}
        path = self.add('one','One',[start,self.record('First progress')])
        first = collector.collect(self.config)['threads'][0]
        with path.open('a',encoding='utf-8') as f:f.write(json.dumps(self.record('More progress'))+'\n')
        progress = collector.collect(self.config)['threads'][0]
        self.assertEqual(first['fingerprint'], progress['fingerprint'])
        self.assertEqual(progress['body'], 'More progress')
        with path.open('a',encoding='utf-8') as f:f.write(json.dumps(self.record('Ready.', 'final_answer'))+'\n')
        finishing = collector.collect(self.config)['threads'][0]
        self.assertFalse(finishing['readyForReview'])
        self.assertEqual(finishing['label'], 'Finishing')
        with path.open('a',encoding='utf-8') as f:f.write(json.dumps({'timestamp':self.iso,'type':'event_msg','payload':{'type':'task_complete','turn_id':'turn-one','last_agent_message':'Ready.'}})+'\n')
        completed = collector.collect(self.config)['threads'][0]
        self.assertTrue(completed['readyForReview'])
        self.assertNotEqual(first['fingerprint'], completed['fingerprint'])
        with path.open('a',encoding='utf-8') as f:
            f.write(json.dumps({'timestamp':self.iso,'type':'event_msg','payload':{'type':'task_started','turn_id':'turn-two'}})+'\n')
            f.write(json.dumps(self.record('A new pass is working'))+'\n')
        resumed = collector.collect(self.config)['threads'][0]
        self.assertFalse(resumed['readyForReview'])
        self.assertEqual(completed['fingerprint'], resumed['fingerprint'])

    def test_older_context_can_load_on_request(self):
        self.add('one','Older',[self.record('Historic answer','final_answer'),{'timestamp':self.iso,'type':'event_msg','payload':{'type':'task_complete','turn_id':'old'}}])
        con=sqlite3.connect(self.home/'state_5.sqlite');con.execute('UPDATE threads SET updated_at=?',(self.now-90*86400,));con.commit();con.close()
        initial=collector.collect(self.config)['threads'][0]
        self.assertFalse(initial['contextLoaded'])
        self.config['_requestedIds']=['one']
        loaded=collector.collect(self.config)['threads'][0]
        self.assertTrue(loaded['contextLoaded'])
        self.assertEqual(loaded['body'],'Historic answer')

    def user(self, text):
        return {'timestamp':self.iso,'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'input_text','text':text}]}}

    def test_task_title_tracks_request_and_preserves_source_and_review_version(self):
        path=self.add('one','Sample project',[self.user('Can you fix Sample quest labels?'),self.record('Verified.', 'final_answer'),{'timestamp':self.iso,'type':'event_msg','payload':{'type':'task_complete','turn_id':'one'}}])
        first=collector.collect(self.config)['threads'][0]
        self.assertEqual(first['taskTitle'],'Fix Sample quest labels')
        self.assertEqual(first['title'],'Sample project')
        with path.open('a',encoding='utf-8') as f:f.write(json.dumps(self.user('sure, bet'))+'\n')
        approved=collector.collect(self.config)['threads'][0]
        self.assertEqual(approved['taskTitle'],first['taskTitle'])
        self.assertEqual(approved['fingerprint'],first['fingerprint'])
        with path.open('a',encoding='utf-8') as f:f.write(json.dumps(self.user('Update Sample shop prices'))+'\n')
        switched=collector.collect(self.config)['threads'][0]
        self.assertEqual(switched['taskTitle'],'Update Sample shop prices')
        self.assertEqual(switched['fingerprint'],first['fingerprint'])
        with path.open('a',encoding='utf-8') as f:f.write(json.dumps(self.user('What should we do about that other thing?'))+'\n')
        self.assertEqual(collector.collect(self.config)['threads'][0]['taskTitle'],'')

    def test_task_title_falls_back_instead_of_guessing_or_copying_large_prose(self):
        for request in ['Fix it please','Move the thing where it was','Check everything','I think the design is okay','Check my chat with him','Check brother man','Check what they said','Build '+('a complex feature '*20),'Access https://example.com/password=secret']:
            self.assertEqual(collector.task_title(request),'',request)
        self.assertEqual(collector.task_title('## My request: Please review the launch documents.'),'Review the launch documents')
        self.assertEqual(collector.task_title('<environment_context>Fix a private system issue</environment_context>\nPlease fix Sample quest labels.'),'Fix Sample quest labels')
        self.assertEqual(collector.task_title('wait where did they send my new delivery receipt?'),'Locate new delivery receipt delivery')

    def test_task_title_reads_indexed_user_message_when_tail_is_large(self):
        h=sqlite3.connect(self.home/'thread_history_1.sqlite')
        h.execute('CREATE TABLE thread_turns (thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER)')
        h.execute('CREATE TABLE thread_items (thread_id TEXT,turn_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER)')
        h.execute('INSERT INTO thread_items VALUES (?,?,?,?,?,?)',('one','turn','userMessage',json.dumps({'content':[{'type':'text','text':'Review the launch documents'}]}),self.now*1000,1))
        h.commit();h.close()
        self.add('one','Planning chat',[self.record('Still working')])
        self.assertEqual(collector.collect(self.config)['threads'][0]['taskTitle'],'Review the launch documents')


if __name__ == '__main__':
    unittest.main()
