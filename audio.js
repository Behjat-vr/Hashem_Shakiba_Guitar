/* Guitar audio engine: sampled nylon guitar with a self-contained plucked-string fallback. */
(function (global) {
  'use strict';

  var AC = global.AudioContext || global.webkitAudioContext;
  var ctx = null;
  var master = null;
  var wet = null;
  var compressor = null;
  var reverb = null;
  var muted = false;
  var volume = 0.82;
  var ready = false;
  var currentSource = 'synthesis';
  var unlockPromise = null;
  var buffers = Object.create(null);
  var failed = Object.create(null);
  var voices = [];
  var MAX_VOICES = 16;
  var strings = [64, 59, 55, 50, 45, 40];
  var names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function midiName(m) { return names[m % 12] + (Math.floor(m / 12) - 1); }
  function midiFrequency(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function emit() {
    try { global.dispatchEvent(new CustomEvent('guitar-audio-state', { detail: { source: currentSource, ready: ready } })); } catch (_) {}
  }
  function soundfont() {
    try { return global.MIDI && global.MIDI.Soundfont && global.MIDI.Soundfont.acoustic_guitar_nylon; } catch (_) { return null; }
  }
  function sampleEntry(m) {
    var sf = soundfont();
    if (!sf) return null;
    var exact = midiName(m);
    if (sf[exact] != null) return { value: sf[exact], midi: m };
    // Some soundfont builds use flats or lowercase note names.
    var alt = exact.replace('C#', 'Db').replace('D#', 'Eb').replace('F#', 'Gb').replace('G#', 'Ab').replace('A#', 'Bb');
    if (sf[alt] != null) return { value: sf[alt], midi: m };
    var keys = Object.keys(sf), best = null, distance = Infinity;
    for (var i = 0; i < keys.length; i++) {
      var match = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(keys[i]);
      if (!match) continue;
      var pitch = names.indexOf(match[1].toUpperCase() + (match[2] === 'b' ? '' : match[2]));
      if (match[2] === 'b') pitch = (pitch + 11) % 12;
      if (pitch < 0) continue;
      var km = (parseInt(match[3], 10) + 1) * 12 + pitch;
      if (sf[keys[i]] != null && Math.abs(km - m) < distance) { distance = Math.abs(km - m); best = { value: sf[keys[i]], midi: km }; }
    }
    return best;
  }
  function bytesFromData(value) {
    if (typeof value !== 'string') return null;
    var comma = value.indexOf(',');
    var encoded = comma >= 0 ? value.slice(comma + 1) : value;
    if (comma >= 0 && /;base64/i.test(value.slice(0, comma)) === false) {
      try { return new TextEncoder().encode(decodeURIComponent(encoded)).buffer; } catch (_) {}
    }
    try {
      var raw = global.atob(encoded.replace(/\s/g, '')), out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out.buffer;
    } catch (_) { return null; }
  }
  function decodeSample(m) {
    if (!ctx) return Promise.resolve(null);
    if (buffers[m]) return Promise.resolve(buffers[m]);
    if (failed[m]) return Promise.resolve(null);
    var entry = sampleEntry(m);
    if (!entry) { failed[m] = true; return Promise.resolve(null); }
    var bytes = bytesFromData(entry.value);
    if (!bytes) { failed[m] = true; return Promise.resolve(null); }
    return ctx.decodeAudioData(bytes.slice(0)).then(function (buffer) {
      buffers[m] = { buffer: buffer, midi: entry.midi };
      return buffers[m];
    }, function () { failed[m] = true; return null; });
  }
  function makeImpulse() {
    var length = Math.floor(ctx.sampleRate * 1.15), impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (var c = 0; c < 2; c++) {
      var data = impulse.getChannelData(c);
      for (var i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.7) * 0.28;
    }
    return impulse;
  }
  function setup() {
    if (ctx) return;
    if (!AC) throw new Error('Web Audio is unavailable');
    ctx = new AC();
    master = ctx.createGain();
    wet = ctx.createGain();
    compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18; compressor.knee.value = 18; compressor.ratio.value = 3.2;
    compressor.attack.value = 0.003; compressor.release.value = 0.22;
    reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse();
    wet.gain.value = 0.16;
    master.gain.value = muted ? 0 : volume;
    reverb.connect(wet); wet.connect(master); master.connect(compressor); compressor.connect(ctx.destination);
    currentSource = soundfont() ? 'sample' : 'synthesis';
  }
  function unlock() {
    if (unlockPromise && (!ctx || ctx.state === 'running')) return unlockPromise;
    unlockPromise = Promise.resolve().then(function () {
      setup();
      return ctx.resume ? ctx.resume() : undefined;
    }).then(function () {
      ready = true; currentSource = soundfont() ? 'sample' : 'synthesis'; emit();
      return true;
    }).catch(function (error) {
      unlockPromise = null; ready = false; emit(); throw error;
    });
    return unlockPromise;
  }
  function removeVoice(v) { var i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); }
  function addVoice(source, gain) {
    var v = { source: source, gain: gain, ended: false };
    voices.push(v);
    source.onended = function () { v.ended = true; removeVoice(v); };
    while (voices.length > MAX_VOICES) { var old = voices.shift(); try { old.source.stop(); } catch (_) {} }
  }
  function stringColor(source, amp, index, fret) {
    // Equal pitches on different strings retain the same tuning, but not the same timbre.
    var color = ctx.createBiquadFilter(); color.type = 'lowpass';
    color.frequency.value = Math.max(1700, 8500 - index * 930 - fret * 55); color.Q.value = 0.55;
    source.connect(color); color.connect(amp);
    source.addEventListener('ended', function () { source.disconnect(); color.disconnect(); amp.disconnect(); }, { once: true });
  }
  function synthesis(m, velocity, stringIndex, fret) {
    var rate = midiFrequency(m), duration = Math.min(2.3, Math.max(0.65, 38 / rate));
    var n = Math.max(2, Math.round(ctx.sampleRate / rate)), length = Math.ceil(ctx.sampleRate * duration);
    var b = ctx.createBuffer(1, length, ctx.sampleRate), data = b.getChannelData(0), ring = new Float32Array(n), i;
    for (i = 0; i < n; i++) ring[i] = (Math.random() * 2 - 1) * (0.75 + Math.random() * 0.25);
    var p = 0;
    for (i = 0; i < length; i++) { var next = (ring[p] + ring[(p + 1) % n]) * 0.4985; data[i] = ring[p]; ring[p] = next; p = (p + 1) % n; }
    var source = ctx.createBufferSource(), amp = ctx.createGain(); source.buffer = b;
    amp.gain.setValueAtTime(0.0001, ctx.currentTime); amp.gain.exponentialRampToValueAtTime(Math.max(0.02, velocity * 0.58), ctx.currentTime + 0.008); amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    stringColor(source, amp, stringIndex, fret); amp.connect(master); amp.connect(reverb); source.start(); source.stop(ctx.currentTime + duration + 0.03); addVoice(source, amp);
    return source;
  }
  function play(stringIndex, fret, velocity) {
    velocity = velocity == null ? 0.8 : Number(velocity);
    stringIndex = Math.floor(Number(stringIndex)); fret = Math.floor(Number(fret));
    var m = strings[stringIndex] + fret;
    if (!Number.isFinite(m) || stringIndex < 0 || stringIndex > 5 || fret < 0 || fret > 19) return Promise.resolve(null);
    velocity = Math.max(0, Math.min(1, Number.isFinite(velocity) ? velocity : 0.8));
    return unlock().then(function () {
      var item = null;
      if (soundfont()) return decodeSample(m).then(function (sample) { item = sample; return item; });
      return null;
    }).then(function (item) {
      var sourceType = item ? 'sample' : 'synthesis'; currentSource = sourceType; emit();
      if (item) {
        var source = ctx.createBufferSource(), amp = ctx.createGain(); source.buffer = item.buffer; source.playbackRate.value = Math.pow(2, (m - item.midi) / 12);
        amp.gain.setValueAtTime(0.0001, ctx.currentTime); amp.gain.exponentialRampToValueAtTime(Math.max(0.025, velocity * 0.62), ctx.currentTime + 0.006); amp.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + Math.min(3, item.buffer.duration));
        stringColor(source, amp, stringIndex, fret); amp.connect(master); amp.connect(reverb); source.start(); addVoice(source, amp);
      } else synthesis(m, velocity, stringIndex, fret);
      return { midi: m, note: midiName(m), frequency: midiFrequency(m), source: sourceType };
    });
  }
  function setVolume(v) { volume = Math.max(0, Math.min(1, Number(v) || 0)); if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.012); }
  function mute(value) { muted = !!value; if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.012); }
  function stop() { voices.slice().forEach(function (v) { try { v.source.stop(); } catch (_) {} }); voices.length = 0; }
  function getStatus() { return { source: currentSource, ready: ready }; }
  global.GuitarAudio = { unlock: unlock, play: play, setVolume: setVolume, mute: mute, stop: stop, getStatus: getStatus };
}(window));
