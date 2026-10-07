"""Create only synthetic records for the owned whole-process benchmark."""
import argparse
import json
import sqlite3
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("directory")
parser.add_argument("count", type=int, choices=[100, 500, 1500])
args = parser.parse_args()
root = Path(args.directory).resolve()
root.mkdir(parents=True, exist_ok=False)
database = sqlite3.connect(root / "state_5.sqlite")
database.execute("CREATE TABLE threads (id TEXT,name TEXT,title TEXT,preview TEXT,cwd TEXT,rollout_path TEXT,updated_at INTEGER,archived INTEGER,source TEXT)")
now = int(time.time())
for index in range(args.count):
    identity = f"10000000-0000-4000-8000-{index+1:012d}"
    rollout = root / f"{identity}.jsonl"
    events = [
        {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "type": "session_meta", "payload": {"id": identity, "cwd": "", "source": "cli"}},
        {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "type": "event_msg", "payload": {"type": "task_started", "turn_id": f"synthetic-{index}"}},
        {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "type": "event_msg", "payload": {"type": "user_message", "message": f"Review synthetic benchmark result {index}."}},
        {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "type": "event_msg", "payload": {"type": "agent_message", "message": "Synthetic result ready for review."}},
        {"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)), "type": "event_msg", "payload": {"type": "task_complete", "turn_id": f"synthetic-{index}"}},
    ]
    rollout.write_text("".join(json.dumps(e)+"\n" for e in events), encoding="utf-8")
    database.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)", (identity, f"Benchmark chat {index}", f"Synthetic task {index}", "Synthetic result ready for review.", "", str(rollout), now, 0, "cli"))
database.commit()
database.close()
print(json.dumps({"schema": 1, "synthetic": True, "records": args.count, "accountsUsed": 0}))
