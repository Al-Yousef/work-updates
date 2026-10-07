'use strict';
const $ = (id) => document.getElementById(id);
async function call(value) {
  const r = await window.hyphenChannels.call(value);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
async function refresh() {
  const selectedHost = $('host').value;
  const state = await call({ method: 'state' });
  $('host').replaceChildren(...state.addresses.map((host) => new Option(host, host)));
  if (state.addresses.includes(selectedHost)) $('host').value = selectedHost;
  $('grants').replaceChildren();
  for (const grant of state.channels) {
    const row = document.createElement('fieldset'),
      legend = document.createElement('legend');
    legend.textContent = grant.label;
    row.append(legend);
    const text = document.createElement('p');
    text.textContent =
      grant.access +
      (grant.expired ? ' · expired' : '') +
      ' · ends ' +
      new Date(grant.until).toLocaleString();
    row.append(text);
    const label = document.createElement('label'),
      confirm = document.createElement('input');
    confirm.type = 'checkbox';
    label.append(confirm, ' Confirm this exact grant');
    row.append(label);
    for (const [method, title] of [
      ['revoke', 'Revoke access'],
      ['clear', 'Clear this conversation'],
    ]) {
      const button = document.createElement('button');
      button.textContent = title;
      button.disabled = method === 'revoke' && grant.access === 'revoked';
      button.onclick = async () => {
        try {
          await call({ method, id: grant.id, confirmed: confirm.checked });
          $('status').textContent =
            method === 'clear'
              ? 'This channel conversation was cleared. Replay receipts remain.'
              : 'This grant was revoked. Accepted work and other clients remain separate.';
          $('code').value = '';
          await refresh();
        } catch (e) {
          $('status').textContent = e.message;
        }
      };
      row.append(button);
    }
    $('grants').append(row);
  }
}
$('invite').onclick = async () => {
  try {
    const result = await call({
      method: 'invite',
      input: {
        host: $('host').value,
        label: $('label').value,
        days: Number($('days').value),
        privateContextConfirmed: $('consent').checked,
      },
    });
    $('code').value = result.code;
    $('consent').checked = false;
    $('status').textContent = 'One private device grant created. Keep this code private.';
    await refresh();
  } catch (e) {
    $('status').textContent = e.message;
  }
};
$('copy').onclick = async () => {
  try {
    if ($('code').value) await navigator.clipboard.writeText($('code').value);
  } catch {
    $('status').textContent = 'Select and copy the displayed code manually.';
  }
};
$('refresh').onclick = () => refresh().catch((e) => ($('status').textContent = e.message));
refresh().catch((e) => ($('status').textContent = e.message));
