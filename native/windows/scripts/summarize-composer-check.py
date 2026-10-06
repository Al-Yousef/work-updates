"""Summarize independent native control observations from the cursor pass."""
import hashlib
import json
import pathlib

root = pathlib.Path(__file__).resolve().parents[1]
directory = root / 'build/artifacts/composer-render-release-20261006'
records = json.loads((directory / 'composer.json').read_text('utf-8-sig'))
processes = json.loads((directory / 'test-processes.json').read_text('utf-8-sig'))

def panel(step):
    return next(window for window in records[step]['after']['windows']
                if window['class'] == 'NativeHoverPanel')

assert len(records) == 19
assert not panel(3)['audit']['composerFocused']
assert panel(5)['audit']['composerFocused']
assert panel(7)['composer']['text'] == 'PaddingCheck'
assert panel(9)['composer']['selection'] == [0, 12]
assert panel(11)['composer']['text'] == ''
assert panel(12)['composer']['lines'] == 1
assert panel(13)['composer']['lines'] == 2
assert panel(18)['composer']['text'] == 'W' * 48 + '\r\nNew line stays clear of Sen'
assert panel(18)['composer']['lines'] == 3
assert [panel(step)['audit']['composerHeight'] for step in (12, 13, 18)] == [40, 60, 80]
images = ['actual-panel.png', 'actual-composer.png']
image_hashes = {name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
                for name in images}
summary = {
    'verified': True,
    'nativeSha256': processes['exeSha256'],
    'scope': 'Actual native child controls and screenshots, separate persistent cursor, synthetic backend; no production messages',
    'commands': len(records),
    'paddingClickFocuses': True,
    'typingAfterPaddingWithoutAnotherClick': True,
    'ctrlASelection': panel(9)['composer']['selection'],
    'wrapping': [{'lines': panel(step)['composer']['lines'],
                  'composerHeight': panel(step)['audit']['composerHeight']}
                 for step in (12, 13, 18)],
    'finalText': panel(18)['composer']['text'],
    'editorBounds': panel(18)['composer']['bounds'],
    'formattingBounds': panel(18)['composer']['format'],
    'finalSelection': panel(18)['composer']['selection'],
    'screenshots': image_hashes,
    'cursorLimitation': 'Private typing requires the cursor tip over the focused native child. After the padding click, the cursor moved into that child without a second click.',
    'physicalWeatherGestureTested': False,
}
(directory / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'verified': summary['verified'], 'commands': summary['commands'], 'wrapping': summary['wrapping']}))
