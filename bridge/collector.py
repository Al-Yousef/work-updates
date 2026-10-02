"""Read-only local Codex feed. No network access and no writes to Codex stores."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import atexit

MAX_TAIL = 4 * 1024 * 1024
MAX_LINE = 256 * 1024
TAIL_CACHE = {}
SOURCE_CACHE = {}
TASK_TITLE_VERSION = 3
TASK_VERBS = r'(?:fix|update|build|add|remove|check|review|compare|test|verify|find|locate|search|research|apply|access|request|implement|move|rename|investigate|organize|create|design|publish|rewrite|draft|send|upload|download|install|develop|plan|finish|complete|adjust|change|improve|resolve|repair|rebuild)'
NEEDS_PATTERN = r'\b(need your|needs your|waiting on you|waiting for you|(?:requires?|awaiting|waiting for) your approval|please (send|provide|upload|confirm))\b'


def timestamp(value):
    try:
        return int(dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp())
    except (ValueError, AttributeError):
        return 0


def plain(text):
    # Local text is data; never render HTML or execute embedded links/commands.
    text = re.sub(r'<oai-mem-citation>[\s\S]*?</oai-mem-citation>', '', text)
    text = re.sub(r':{1,2}[\w-]+\{[^\n]*\}', '', text)
    text = re.sub(r'[^]*', '', text)
    text = re.sub(r'!\[([^\]]*)\]\([^\n]*?\)', r'\1', text)
    text = re.sub(r'\[([^\]]+)\]\([^\n]*?\)', r'\1', text)
    text = re.sub(r'(?m)^\s*#{1,6}\s*', '', text)
    return re.sub(r'[ \t]+', ' ', text.replace('**', '').replace('`', '')).strip()


def rollout_tail(path):
    """Bound reads even for large tool/image lines and skip incomplete writes."""
    events = []
    if not path:
        return events
    try:
        stat = Path(path).stat()
        key = (stat.st_mtime_ns, stat.st_size)
        cached = TAIL_CACHE.get(path)
        if cached and cached[0] == key:
            return cached[1]
        with Path(path).open('rb') as f:
            size = f.seek(0, 2)
            start = max(0, size - MAX_TAIL)
            f.seek(start)
            data = f.read(MAX_TAIL)
        lines = data.split(b'\n')
        if start:
            lines = lines[1:]
        for line in lines:
            if not line or len(line) > MAX_LINE:
                continue
            try:
                row = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            p = row.get('payload') or {}
            when = timestamp(row.get('timestamp'))
            if row.get('type') == 'event_msg' and p.get('type') in (
                    'task_started', 'task_complete', 'turn_aborted'):
                events.append({'kind': p['type'], 'at': when,
                               'turn': p.get('turn_id', ''),
                               'text': p.get('last_agent_message', '')})
            elif row.get('type') == 'event_msg' and p.get('type') == 'user_message':
                events.append({'kind': 'request', 'at': when, 'text': p.get('message', '')})
            elif row.get('type') == 'response_item' and p.get('type') == 'message':
                role = p.get('role')
                if role in ('assistant', 'user'):
                    parts = [x.get('text', '') for x in p.get('content', [])
                             if x.get('type') in ('output_text', 'input_text', 'text')]
                    value = '\n'.join(parts).strip()
                    if value:
                        events.append({'kind': 'message' if role == 'assistant' else 'request', 'at': when,
                                       'phase': p.get('phase') or 'commentary',
                                       'text': value})
        TAIL_CACHE[path] = (key, events)
    except (OSError, ValueError):
        pass
    return events


def readonly(path):
    c = sqlite3.connect(Path(path).as_uri() + '?mode=ro', uri=True, timeout=2)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    return c


def history_latest(con, thread_id):
    if con is None:
        return None, None
    turn = con.execute('SELECT turn_id,status,started_at,completed_at FROM thread_turns '
                       'WHERE thread_id=? ORDER BY rollout_ordinal DESC LIMIT 1',
                       (thread_id,)).fetchone()
    if not turn:
        return None, None
    item = con.execute("SELECT item_json,created_at_ms FROM thread_items WHERE thread_id=? "
                       "AND turn_id=? AND item_type='agentMessage' "
                       'ORDER BY rollout_ordinal DESC LIMIT 1',
                       (thread_id, turn['turn_id'])).fetchone()
    message = None
    if item:
        p = json.loads(item['item_json'])
        message = {'text': p.get('text', ''), 'phase': p.get('phase', 'commentary'),
                   'at': int((item['created_at_ms'] or 0) / 1000)}
    return dict(turn), message


def determine_status(text, phase, activity, age):
    if activity == 'working':
        return ('working', 'Working') if age < 3600 else ('unknown', 'Check status')
    if activity == 'interrupted':
        return 'unknown', 'Interrupted'
    if activity == 'finishing':
        return 'working', 'Finishing'
    if phase != 'final_answer':
        return 'updated', 'Updated'
    # Explicit phrases only. These describe what the chat reported, not an independent audit.
    head = text[:1800].lower()
    if re.search(r'\b(remaining blocker|still blocked|blocked by|blocked until|blocked on)\b', head):
        return 'blocked', 'Blocked'
    if re.search(NEEDS_PATTERN, head):
        return 'needs', 'Needs you'
    if not re.search(r'\b(no longer|not|isn.t) (awaiting|waiting)\b', head) and re.search(r'\b(awaiting|waiting for|waiting on)\b', head):
        return 'waiting', 'Waiting'
    return 'updated', 'Updated'


def summarize(body, status):
    patterns = {
        'blocked': r'\b(remaining blocker|still blocked|blocked by|blocked until|blocked on)\b',
        'waiting': r'\b(awaiting|waiting for|waiting on)\b',
        'needs': NEEDS_PATTERN
    }
    value = body
    if status in patterns:
        paragraphs = re.split(r'\n\s*\n', body)
        for i, paragraph in enumerate(paragraphs):
            if re.search(patterns[status], paragraph, re.I):
                value = paragraph
                if len(value) < 50 and i + 1 < len(paragraphs):
                    value += ' ' + paragraphs[i + 1]
                break
    value = re.sub(r'\s+', ' ', value)
    return value if len(value) <= 230 else value[:230].rsplit(' ', 1)[0] + '…'


def request_text(text):
    # Ambient app context is not the user's task. Never turn it into a title.
    text = re.sub(r'<([\w-]+)\b[^>]*>[\s\S]*?</\1>', '', text)
    text = re.sub(r'(?im)^\s*#{1,6}\s*my request:\s*', '', text)
    return plain(text).strip()


def continuation(text):
    return bool(re.fullmatch(r"(?:yes|yeah|yep|yup|ok|okay|sure|bet|perfect|great|thanks|thank you|go|go ahead|go for it|do it|let'?s go|let'?s do it|continue|keep going|proceed|please)[\s,!.]*"
                             r"(?:(?:yes|yeah|ok|okay|sure|bet|perfect|thanks|go for it|please)[\s,!.]*)*", text, re.I))


def task_title(text):
    """Use a short, explicit request; ambiguous prose falls back to the chat name."""
    value = request_text(text)
    if not value or continuation(value):
        return None  # Approval/progress chatter keeps the current task.
    if (re.match(r'^(?:perfect|great|thanks)\b', value, re.I) and not re.search(r'\b' + TASK_VERBS + r'\b', value, re.I)
            or len(re.findall(r'\d', value)) >= 5 and not re.search(r'\b' + TASK_VERBS + r'\b', value, re.I)):
        return None  # Approval chatter and numeric task data are not new objectives.
    value = re.sub(r'^(?:wait|okay|ok|yeah|also)[,\s]+', '', value, flags=re.I)
    value = re.sub(r'^(?:(?:can|could|would|will) (?:you|we)\s+|(?:please|help me)\s+|(?:i (?:want|need)(?: you)? to|let[\x27’]?s)\s+)', '', value, flags=re.I)
    value = value.split('\n\n')[0].strip()
    value = re.split(r'(?<=[.!?])\s+', value, maxsplit=1)[0].rstrip('.?! ')
    locate = re.fullmatch(r'where (?:did|will|have) (?:they|you) (?:send|sent|mail|mailed|deliver|delivered) (?:my|the) (.+)', value, re.I)
    compare = re.fullmatch(r'(?:do|does) (.+?) (?:match|align)(?:\s+.*)?', value, re.I)
    if locate:
        value = 'Locate ' + locate[1] + ' delivery'
    elif compare:
        value = 'Compare ' + re.sub(r'^the\s+', '', compare[1], flags=re.I)
    if not re.match(r'^' + TASK_VERBS + r'\s+', value, re.I):
        return ''
    value = re.split(r'\s+(?:because|so (?:i|we|you|it|they)|in order to)\b', value, maxsplit=1, flags=re.I)[0]
    value = re.split(r',\s+(?:' + TASK_VERBS + r'|put|when|so)\b', value, maxsplit=1, flags=re.I)[0]
    value = re.sub(r'\s+(?:and (?:whatnot|everything)|please|right now|rn|i guess|tho)$', '', value, flags=re.I)
    value = re.sub(r'\b(?:[A-Z]{4,}|ALL|FOR|THE|AND)\b', lambda m: m[0].lower(), value)
    value = re.sub(r'\s+', ' ', value).strip(' .?!,')
    subject = value.split(' ', 1)[1]
    # Do not guess the referent, expose pasted code/URLs, or crop an oversized prompt.
    if (len(value) > 80 or len(value.split()) > 14 or len(subject.split()) < 2
            or re.match(r'^(?:it|this|that|these|those|them|him|her|something|everything|anything|what|who|which|when|where|how|why|a way|the thing)\b', subject, re.I)
            or re.search(r'\b(?:him|her|them|it|this|that)\b', subject, re.I)
            or subject.lower() in ('the design', 'the app', 'the task', 'the changes', 'all of them', 'brother man')
            or re.search(r'https?://|[<>{}\\]|\b(?:password|secret|token)\s*[:=]', value)):
        return ''
    return value[0].upper() + value[1:]


def current_task(history, id, path, previous=''):
    requests = []
    if history:
        try:
            rows = history.execute("SELECT substr(item_json,1,262144) AS item_json,created_at_ms FROM thread_items WHERE thread_id=? AND item_type='userMessage' ORDER BY rollout_ordinal DESC LIMIT 12", (id,)).fetchall()
            for row in reversed(rows):
                p = json.loads(row['item_json'])
                text = '\n'.join(c.get('text', '') for c in p.get('content', []) if c.get('type') in ('text', 'input_text'))
                requests.append((int((row['created_at_ms'] or 0) / 1000), text))
        except (sqlite3.Error, ValueError):
            pass
    requests.extend((e['at'], e['text']) for e in rollout_tail(path) if e['kind'] == 'request')
    seen = set()
    for _, (at, text) in sorted(enumerate(requests), key=lambda x: (x[1][0], x[0]), reverse=True):
        text = request_text(text)
        if text in seen:
            continue
        seen.add(text)
        title = task_title(text)
        if title is not None:
            return title
    return previous


def collect(config):
    now = int(time.time())
    home = Path(config['codexHome'])
    state = readonly(home / 'state_5.sqlite')
    history = None
    warnings = []
    try:
        if (home / 'thread_history_1.sqlite').exists():
            history = readonly(home / 'thread_history_1.sqlite')
        # The entire local catalogue stays watched, including older CLI sessions.
        columns = {r['name'] for r in state.execute('PRAGMA table_info(threads)')}
        extra = " AND COALESCE(thread_source,'user') NOT IN ('subagent','guardian_review')" if 'thread_source' in columns else ''
        rows = state.execute("SELECT id,name,title,preview,cwd,rollout_path,updated_at "
                             "FROM threads WHERE archived=0 AND source IN ('exec','vscode','cli','appServer')" + extra +
                             ' ORDER BY updated_at DESC').fetchall()
        ignored = set(config.get('ignoredThreadIds', []))
        requested = set(config.get('_requestedIds', []))
        context_since = int(config.get('_contextSince', now - 7 * 86400))
        result = []
        for r in rows:
            if r['id'] in ignored:
                continue
            try:
                stat = Path(r['rollout_path']).stat()
                file_key = [stat.st_mtime_ns, stat.st_size]
            except (OSError, TypeError):
                file_key = [0, 0]
            signature = [int(r['updated_at']), r['rollout_path'], *file_key]
            cached = SOURCE_CACHE.get(r['id'])
            requested_context = r['id'] in requested
            if cached and cached.get('signature') == signature and not (requested_context and not cached['record'].get('contextLoaded')):
                record = dict(cached['record'])
                record['title'] = r['name'] or r['title'][:120]
                if cached.get('taskTitleVersion') != TASK_TITLE_VERSION:
                    record['taskTitle'] = current_task(history, r['id'], r['rollout_path']) if record.get('contextLoaded') else ''
                    cached['record'] = record; cached['taskTitleVersion'] = TASK_TITLE_VERSION
                if record.get('lifecycle') == 'working' and now - record.get('notificationAt', 0) >= 3600:
                    record['status'], record['label'] = 'unknown', 'Check status'
                result.append(record)
                continue
            # Old chats are registered immediately without scanning gigabytes of historic tools.
            # Any later change loads their actual events, regardless of age or list position.
            load_context = requested_context or bool(cached) or int(r['updated_at']) >= context_since
            if not load_context:
                record = {'id': r['id'], 'title': r['name'] or r['title'][:120],
                          'summary': '', 'body': '', 'updatedAt': int(r['updated_at']),
                          'notificationAt': 0, 'completedAt': 0, 'readyForReview': False,
                          'lifecycle': 'unknown', 'status': 'unknown', 'label': 'Older chat',
                          'contextLoaded': False, 'fingerprint': 'catalogue:' + r['id'],
                          'phase': '', 'turnId': '', 'cwd': (r['cwd'] or '').removeprefix('\\\\?\\'),
                          'uri': 'codex://threads/' + r['id'], 'evidence': 'Local chat catalogue'}
                record['taskTitle'] = ''
                SOURCE_CACHE[r['id']] = {'signature': signature, 'record': record, 'taskTitleVersion': TASK_TITLE_VERSION}
                result.append(record)
                continue
            try:
                turn, message = history_latest(history, r['id'])
            except (sqlite3.Error, ValueError):
                turn, message = None, None
            activity = 'unknown'
            evidence_at = 0
            completed_at = 0
            turn_id = ''
            if turn:
                turn_id = turn['turn_id']
                evidence_at = turn.get('completed_at') or turn.get('started_at') or 0
                activity = {'inProgress': 'working', 'completed': 'updated',
                            'interrupted': 'interrupted'}.get(turn['status'], 'unknown')
                completed_at = int(turn.get('completed_at') or 0) if turn['status'] == 'completed' else 0
            if cached and cached['signature'][1] == r['rollout_path'] and cached['record'].get('notificationAt', 0) > evidence_at:
                previous = cached['record']
                evidence_at = previous['notificationAt']
                completed_at = previous.get('completedAt', 0)
                turn_id = previous.get('turnId', '')
                activity = {'completed': 'updated', 'working': 'working', 'interrupted': 'interrupted'}.get(previous.get('lifecycle'), 'unknown')
                if previous.get('contextLoaded'):
                    message = {'text': previous['body'], 'phase': previous.get('phase', ''), 'at': evidence_at}
            # Rollout can be newer than the indexed history, particularly after a fork.
            for e in rollout_tail(r['rollout_path']):
                if e['kind'] == 'request':
                    continue
                if e['kind'] == 'message' and (not message or e['at'] >= message['at']):
                    message = e
                if e['at'] >= evidence_at:
                    evidence_at = e['at']
                    if e['kind'] == 'task_started':
                        activity = 'working'; turn_id = e['turn']; completed_at = 0
                    elif e['kind'] == 'task_complete':
                        activity = 'updated'; turn_id = e['turn']; completed_at = e['at']
                        if e.get('text'):
                            message = {'text': e['text'], 'at': e['at'], 'phase': 'final_answer'}
                    elif e['kind'] == 'turn_aborted':
                        activity = 'interrupted'; completed_at = 0
                    elif e['kind'] == 'message':
                        if not completed_at or e['at'] > completed_at:
                            activity = 'finishing' if e['phase'] == 'final_answer' else 'working'
                            completed_at = 0
            body = plain(message['text'] if message else (r['preview'] or 'Open this chat to see its latest context.'))[:10000]
            when = max(int(r['updated_at']), message['at'] if message else 0)
            phase = message.get('phase', '') if message else ''
            status, label = determine_status(body, phase, activity, now - evidence_at)
            lifecycle = 'completed' if completed_at else 'working' if activity in ('working', 'finishing') else 'interrupted' if activity == 'interrupted' else 'unknown'
            ready = lifecycle == 'completed'
            if ready and status == 'updated':
                status, label = 'ready', 'Ready to review'
            # Commentary is context, not a new notification. Completion changes the version.
            if ready:
                fp = hashlib.sha256((turn_id + '\0completed\0' + body).encode()).hexdigest()[:24]
            elif lifecycle == 'interrupted':
                fp = hashlib.sha256((turn_id + '\0interrupted').encode()).hexdigest()[:24]
            else:
                # Starting another pass doesn't resurrect an already reviewed notification.
                previous_fp = cached['record'].get('fingerprint', '') if cached else ''
                fp = previous_fp if previous_fp and not previous_fp.startswith('catalogue:') else 'pending:' + r['id']
            summary = summarize(body, status)
            record = {'id': r['id'], 'title': r['name'] or r['title'][:120],
                           'taskTitle': current_task(history, r['id'], r['rollout_path'], cached['record'].get('taskTitle', '') if cached else ''),
                           'summary': summary, 'body': body, 'updatedAt': when,
                           'notificationAt': int(completed_at or evidence_at), 'completedAt': int(completed_at),
                           'readyForReview': ready, 'lifecycle': lifecycle, 'contextLoaded': True, 'turnId': turn_id,
                           'status': status, 'label': label, 'fingerprint': fp,
                           'phase': phase, 'cwd': (r['cwd'] or '').removeprefix('\\\\?\\'),
                           'uri': 'codex://threads/' + r['id'], 'evidence': 'Recorded completion event' if ready else 'Local recorded chat activity'}
            SOURCE_CACHE[r['id']] = {'signature': signature, 'record': record, 'taskTitleVersion': TASK_TITLE_VERSION}
            result.append(record)
        live_ids = {r['id'] for r in rows}
        for id in list(SOURCE_CACHE):
            if id not in live_ids:
                del SOURCE_CACHE[id]
        return {'schemaVersion': 2, 'collectedAt': now, 'scope': 'Local Codex chats',
                'threads': result, 'monitoredCount': len(result), 'warnings': warnings}
    finally:
        state.close()
        if history:
            history.close()


def atomic(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    os.replace(temp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True)
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--parent-pid', type=int)
    args = ap.parse_args()
    root = Path(args.root)
    cache_path = root / 'data' / 'source-cache.json'
    try:
        SOURCE_CACHE.update(json.loads(cache_path.read_text(encoding='utf-8')))
    except (OSError, ValueError):
        pass
    parent_alive = lambda: True
    if args.parent_pid and os.name != 'nt':
        def parent_alive():
            try:
                os.kill(args.parent_pid, 0)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                return True
    if args.parent_pid and os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, args.parent_pid)
        if not handle:
            return 1
        parent_alive = lambda: kernel.WaitForSingleObject(handle, 0) == 0x00000102
        atexit.register(lambda: kernel.CloseHandle(handle))
    while True:
        if not parent_alive():
            return 0
        try:
            config = json.loads((root / 'config.json').read_text(encoding='utf-8-sig'))
            requests = root / 'data' / 'details-request.json'
            if requests.exists():
                try:
                    config['_requestedIds'] = json.loads(requests.read_text(encoding='utf-8')).get('threadIds', [])
                    requests.unlink(missing_ok=True)
                except (OSError, ValueError):
                    pass
            feed = collect(config)
            atomic(root / 'data' / 'feed.json', feed)
            atomic(cache_path, SOURCE_CACHE)
            atomic(root / 'data' / 'health.json', {'ok': True, 'at': int(time.time()), 'message': ''})
        except Exception as e:
            # Keep last good feed; health makes disconnection visible.
            atomic(root / 'data' / 'health.json', {'ok': False, 'at': int(time.time()),
                                                  'message': type(e).__name__ + ': ' + str(e)[:180]})
            if args.once:
                return 1
        if args.once:
            return 0
        for _ in range(max(1, int(config.get('pollSeconds', 3)))):
            time.sleep(1)
            if not parent_alive():
                return 0
            refresh = root / 'data' / 'refresh.flag'
            stop = root / 'data' / 'stop.flag'
            if stop.exists():
                stop.unlink(missing_ok=True)
                return 0
            if refresh.exists():
                refresh.unlink(missing_ok=True)
                break


if __name__ == '__main__':
    sys.exit(main())
