'use strict';
const api = window.hyphenVoice,
  $ = (id) => document.getElementById(id);
let call = null,
  epoch = 0,
  muted = false;
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
}
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
  status('Voice disconnected. Start again with new consent.');
  $('microphone').checked = false;
  $('billing').checked = false;
  if (old?.id)
    try {
      await invoke('disconnected', { id: old.id });
    } catch {}
}
api.onStop((id) => {
  if (!id || call?.id === id) {
    stopLocal();
    status('Voice ended. Other work continues.');
    $('microphone').checked = false;
    $('billing').checked = false;
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
  try {
    const info = await invoke('begin', {
      maxSeconds: Number($('seconds').value),
      tokenReservation: Number($('tokens').value),
      billingConfirmed: $('billing').checked,
      microphoneConfirmed: $('microphone').checked,
    });
    if (generation !== epoch) {
      await invoke('end', { id: info.sessionId });
      return;
    }
    call = { id: info.sessionId };
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
  $('microphone').checked = false;
  $('billing').checked = false;
  try {
    if (old?.id) await invoke('end', { id: old.id });
    status('Voice ended locally. Remote termination is not verified. Other work continues.');
  } catch (e) {
    status(e.message);
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
    $('provider').textContent = s.support.configured
      ? 'Encrypted provider configured; account access unverified'
      : 'No voice provider configured';
  })
  .catch((e) => status(e.message));
window.addEventListener('beforeunload', () => stopLocal());
