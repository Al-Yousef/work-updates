'use strict';
const api = window.hyphenVoice,
  $ = (id) => document.getElementById(id);
let call = null,
  epoch = 0,
  muted = false,
  contextPreview = null,
  contextGeneration = 0;
let terminationId = null;
function termination(result) {
  terminationId = result?.sessionId || null;
  $('terminationStatus').textContent =
    result?.state === 'initiated'
      ? 'The provider accepted the end request. Final usage and billing remain unknown.'
      : result?.state === 'pending'
        ? 'Local audio is off. Waiting for the provider end request.'
        : result
          ? 'Local audio is off. The provider end request is unconfirmed; final usage remains unknown.'
          : '';
  $('retryTermination').hidden = !result?.retryAvailable;
}
async function invoke(name, value) {
  const r = await api.call(name, value);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}
function status(text) {
  $('status').textContent = text;
}
function controls(active) {
  $('start').disabled = active;
  for (const id of ['mute', 'end', 'steer']) $(id).disabled = !active;
  for (const id of ['context', 'refreshContext', 'contextConsent']) $(id).disabled = active;
}
function resetConsent() {
  $('microphone').checked = false;
  $('billing').checked = false;
  $('contextConsent').checked = false;
}
async function choices() {
  const state = await invoke('state');
  const select = $('context'),
    old = select.value;
  select.replaceChildren(new Option('Voice conversation only', ''));
  for (const c of state.contextChoices.choices)
    select.add(
      new Option(c.title + ' · ' + c.device + ' · ' + c.coverage, JSON.stringify(c.selection)),
    );
  if ([...select.options].some((o) => o.value === old)) select.value = old;
  await preview();
}
async function preview() {
  const generation = ++contextGeneration;
  contextPreview = null;
  $('contextConsent').checked = false;
  $('contextPreview').textContent = '';
  $('contextWarning').textContent = 'No task context selected.';
  if (!$('context').value) return;
  try {
    const result = await invoke('context', { selection: JSON.parse($('context').value) });
    if (generation !== contextGeneration) return;
    contextPreview = result;
    const d = result.data;
    $('contextPreview').textContent = [
      d.chatName,
      'Task: ' + d.task,
      'Status at capture: ' + d.status,
      (d.summaryProvenance === 'generated_summary' ? 'Generated summary: ' : 'Recorded summary: ') +
        d.summary,
      ...(d.excerpt ? ['Task excerpt:', d.excerpt] : []),
      ...(d.conversation || []).flatMap((m) => [
        m.role === 'user' ? 'User excerpt:' : 'Assistant excerpt:',
        m.text,
      ]),
      'Coverage: ' +
        (!d.coverage.excerptIncluded && !d.coverage.conversationIncluded
          ? 'Task history is unavailable. '
          : 'Only bounded excerpts. ') +
        (d.coverage.truncated ? 'Some context was truncated. ' : '') +
        'Full history is not shared.',
    ].join('\n\n');
    $('contextWarning').textContent = result.warning;
  } catch (e) {
    if (generation === contextGeneration) $('contextWarning').textContent = e.message;
  }
}
$('context').onchange = preview;
$('refreshContext').onclick = () => choices().catch((e) => status(e.message));
function stopLocal() {
  epoch++;
  const previous = call;
  call = null;
  if (previous) {
    for (const t of previous.stream?.getTracks() || []) t.stop();
    previous.channel?.close();
    previous.peer?.close();
  }
  $('audio').srcObject = null;
  controls(false);
  muted = false;
  $('mute').textContent = 'Mute microphone';
  return previous;
}
async function disconnect() {
  const old = stopLocal();
  const generation = epoch;
  status('Voice disconnected. Start again with new consent.');
  resetConsent();
  if (old?.id) termination({ sessionId: old.id, state: 'pending' });
  if (old?.id)
    try {
      await invoke('disconnected', { id: old.id });
      const state = await invoke('state');
      if (epoch === generation && !call)
        termination(state.providerTermination?.find((s) => s.sessionId === old.id));
    } catch {}
}
api.onStop((id) => {
  if (!id || call?.id === id) {
    const old = stopLocal();
    if (old?.id) termination({ sessionId: old.id, state: 'pending' });
    status('Voice ended locally. Other work continues.');
    resetConsent();
  }
});
$('configure').onclick = async () => {
  try {
    const support = await invoke('configure', { key: $('key').value });
    $('provider').textContent = support.configured
      ? 'Encrypted provider saved. Account access is checked only when you start a call.'
      : 'Provider unavailable';
  } catch (e) {
    status(e.message);
  } finally {
    $('key').value = '';
  }
};
$('start').onclick = async () => {
  const generation = ++epoch;
  controls(true);
  status('Requesting microphone access…');
  termination(null);
  $('captions').textContent = '';
  try {
    const info = await invoke('begin', {
      maxSeconds: Number($('seconds').value),
      tokenReservation: Number($('tokens').value),
      billingConfirmed: $('billing').checked,
      microphoneConfirmed: $('microphone').checked,
      ...($('context').value
        ? {
            selectedContext: {
              selection: JSON.parse($('context').value),
              digest: contextPreview?.digest,
              confirmed: $('contextConsent').checked,
            },
          }
        : {}),
    });
    if (generation !== epoch) {
      await invoke('end', { id: info.sessionId });
      return;
    }
    call = { id: info.sessionId, selection: contextPreview?.selection || null };
    $('contextWarning').textContent =
      info.context +
      '; evidence captured at call start. Task updates are not automatically shared.';
    const active = call;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    if (generation !== epoch || call !== active) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    active.stream = stream;
    const track = stream.getAudioTracks()[0];
    $('device').textContent = 'Microphone: ' + (track?.label || 'system default');
    const peer = (active.peer = new RTCPeerConnection());
    for (const t of stream.getTracks()) peer.addTrack(t, stream);
    peer.ontrack = (e) => {
      if (call === active) $('audio').srcObject = e.streams[0];
    };
    peer.onconnectionstatechange = () => {
      if (call === active && ['failed', 'disconnected', 'closed'].includes(peer.connectionState))
        disconnect();
    };
    const channel = (active.channel = peer.createDataChannel('oai-events'));
    channel.onopen = () => {
      if (call === active) {
        status('Voice connected');
        controls(true);
      }
    };
    channel.onmessage = async (e) => {
      if (call !== active || typeof e.data !== 'string' || e.data.length > 128000) return;
      let event;
      try {
        event = JSON.parse(e.data);
      } catch {
        return;
      }
      if (['response.created', 'response.done'].includes(event.type)) {
        try {
          await invoke('event', { id: active.id, event });
        } catch {
          await disconnect();
          return;
        }
      }
      if (call !== active) return;
      if (
        [
          'response.output_audio_transcript.delta',
          'conversation.item.input_audio_transcription.delta',
        ].includes(event.type)
      )
        $('captions').textContent = ($('captions').textContent + String(event.delta || '')).slice(
          -12000,
        );
      if (event.type === 'error')
        status('The voice provider reported an error. End voice before trying again.');
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const answer = await invoke('connect', { id: active.id, sdp: offer.sdp });
    if (generation !== epoch || call !== active) return;
    await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    status('Voice connection accepted; waiting for audio');
  } catch (e) {
    if (generation !== epoch) return;
    const old = stopLocal();
    if (old?.id)
      try {
        await invoke('end', { id: old.id });
      } catch {}
    status(e.message);
    resetConsent();
  }
};
$('mute').onclick = async () => {
  try {
    if (!call) return;
    const active = call;
    await invoke('mute', { id: active.id, muted: !muted });
    if (call !== active) return;
    muted = !muted;
    for (const t of active.stream?.getAudioTracks() || []) t.enabled = !muted;
    $('mute').textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    status(muted ? 'Microphone muted; provider session continues' : 'Voice connected');
  } catch (e) {
    status(e.message);
  }
};
$('end').onclick = async () => {
  const old = stopLocal();
  const endedEpoch = epoch;
  resetConsent();
  status('Voice ended locally. Other work continues.');
  if (old?.id) termination({ sessionId: old.id, state: 'pending' });
  try {
    const result = old?.id ? await invoke('end', { id: old.id }) : null;
    if (epoch === endedEpoch && !call) termination(result?.providerTermination);
  } catch (e) {
    if (epoch === endedEpoch && !call) status(e.message);
  }
};
$('retryTermination').onclick = async () => {
  if (!terminationId || call) return;
  const id = terminationId,
    generation = epoch;
  $('retryTermination').disabled = true;
  try {
    const result = await invoke('end', { id, retryTermination: true });
    if (epoch === generation && !call && terminationId === id)
      termination(result.providerTermination);
  } catch (e) {
    if (epoch === generation && !call) status(e.message);
  } finally {
    $('retryTermination').disabled = false;
  }
};
$('steer').onclick = async () => {
  try {
    const active = call;
    if (!active || active.channel?.readyState !== 'open')
      throw new Error('Wait for the current voice connection.');
    const result = await invoke('steer', { id: active.id, text: $('text').value });
    if (call !== active) return;
    for (const event of result.events) active.channel.send(JSON.stringify(event));
    $('text').value = '';
  } catch (e) {
    status(e.message);
  }
};
invoke('state')
  .then((s) => {
    const last = s.providerTermination?.at(-1);
    if (last && ['pending', 'unconfirmed', 'initiated'].includes(last.state)) termination(last);
    $('provider').textContent = s.support.configured
      ? 'Encrypted provider configured; account access unverified'
      : 'No voice provider configured';
    return choices();
  })
  .catch((e) => status(e.message));
window.addEventListener('beforeunload', () => stopLocal());
setInterval(async () => {
  const active = call;
  if (!active?.selection && !terminationId) return;
  try {
    const state = await invoke('state');
    if (!call && terminationId) {
      const result = state.providerTermination?.find((s) => s.sessionId === terminationId);
      if (result) termination(result);
    }
    if (call !== active) return;
    if (!active?.selection) return;
    const selected = state.contextChoices.choices.find(
      (c) =>
        c.selection.sourceId === active.selection.sourceId &&
        c.selection.ownerId === active.selection.ownerId,
    );
    $('progress').textContent = selected
      ? 'Current task status on this device: ' +
        selected.status +
        '. Voice retains the call-start snapshot.'
      : 'Current task context is unavailable. Voice is being held.';
  } catch {}
}, 5000);
