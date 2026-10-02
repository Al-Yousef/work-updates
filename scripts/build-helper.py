"""Build only the read-only collector; never include a user's Codex directory."""
import os
from pathlib import Path
import subprocess
import sys
import shutil

root = Path(__file__).resolve().parent.parent
output = root / 'build' / 'helper'
output.mkdir(parents=True, exist_ok=True)
shutil.copy2(root / 'bridge' / 'collector.py', output / 'collector.py')
subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--clean', '--onefile',
                '--name', 'collector', '--distpath', str(output),
                '--workpath', str(root / 'build' / 'pyinstaller'),
                '--specpath', str(root / 'build'), str(root / 'bridge' / 'collector.py')],
               cwd=root, check=True)
print('Read-only helper built for ' + sys.platform)
