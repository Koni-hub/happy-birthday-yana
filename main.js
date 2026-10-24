/* ============================================================
   For Yana — wishes, memories & love
   Vanilla JS + Three.js (classic build, so it runs from a file)
   ============================================================ */
(function () {
  'use strict';

  const THREE = window.THREE;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (selector, scope) => (scope || document).querySelector(selector);
  const $$ = (selector, scope) => Array.from((scope || document).querySelectorAll(selector));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
  const rand = (min, max) => min + Math.random() * (max - min);
  const app = { girls: null, cake: null, confetti: null };

  // Keep phones, tablets and older laptops smooth. The scenes are atmospheric,
  // so a slightly lower internal resolution reads better than dropped frames.
  const lowPower = (() => {
    const coarse = window.matchMedia
      ? window.matchMedia('(pointer: coarse) and (max-width: 900px)').matches
      : false;
    const cores = navigator.hardwareConcurrency || 8;
    const memory = navigator.deviceMemory || 8;
    return coarse || cores <= 4 || memory <= 4;
  })();
  // Render at most one pixel per CSS pixel: on a retina display 1.25x meant
  // ~1.6x the pixels for a difference nobody sees on a soft, atmospheric
  // scene — it was pure GPU cost. Phones drop below 1 and upscale.
  const maxPixelRatio = lowPower ? 0.8 : 1;
  const shadowMapSize = lowPower ? 512 : 1024;
  // Live cap, so the adaptive lite mode keeps holding after a resize.
  let pixelCap = maxPixelRatio;
  let reducedEffects = lowPower;
  if (lowPower) document.documentElement.classList.add('is-low-power');

  if (!THREE) {
    console.error('Three.js did not load.');
    document.body.classList.add('is-ready', 'has-no-3d');
    if (window.YanaLoader) window.YanaLoader.finish();
    else {
      const loader = $('#loader');
      if (loader) loader.classList.add('is-hidden');
    }
    return;
  }

  /* ————————————————————————————————
     Tiny audio world — slow, reverb-soaked Happy Birthday
     ———————————————————————————————— */
  const Sound = (() => {
    let ctx = null;
    let master = null;
    let bus = null;
    let sfx = null;
    let sfxOut = null;
    let musicTimer = null;
    let loopActive = false;
    let musicStarted = false;
    const STORAGE_KEY = 'yana-music-enabled';
    const LEGACY_STORAGE_KEY = 'yana-sound-enabled';
    const ENTRY_KEY = 'yana-music-entry';
    const musicActive = [];
    const sfxActive = [];

    function readPreference() {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored === '0') return false;
        if (stored === '1') return true;
        const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy === '0') return false;
        if (legacy === '1') return true;
      } catch (error) {}
      return true;
    }

    function savePreference(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
      } catch (error) {}
    }

    let musicEnabled = readPreference();
    // Interface sounds are always on and independent of the music preference.
    const sfxEnabled = true;

    const NOTES = {
      C3: 130.81,
      F3: 174.61,
      G3: 196.0,
      G4: 392.0,
      A4: 440.0,
      B4: 493.88,
      C5: 523.25,
      D5: 587.33,
      E5: 659.25,
      F5: 698.46,
      G5: 783.99
    };

    // Happy Birthday — 3/4, played very slowly.
    const melody = [
      ['G4', 0.5], ['G4', 0.5], ['A4', 1], ['G4', 1], ['C5', 1], ['B4', 2],
      ['G4', 0.5], ['G4', 0.5], ['A4', 1], ['G4', 1], ['D5', 1], ['C5', 2],
      ['G4', 0.5], ['G4', 0.5], ['G5', 1], ['E5', 1], ['C5', 1], ['B4', 1], ['A4', 2],
      ['F5', 0.5], ['F5', 0.5], ['E5', 1], ['C5', 1], ['D5', 1], ['C5', 2]
    ];

    const BEAT = 1.05;

    function makeImpulse(duration, decay) {
      const length = Math.floor(ctx.sampleRate * duration);
      const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
      for (let channel = 0; channel < 2; channel++) {
        const data = impulse.getChannelData(channel);
        for (let i = 0; i < length; i++) {
          data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
        }
      }
      return impulse;
    }

    function init() {
      if (ctx) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      try {
        ctx = new AudioContext();
      } catch (error) {
        return;
      }

      master = ctx.createGain();
      master.gain.value = 0;
      const warmth = ctx.createBiquadFilter();
      warmth.type = 'lowpass';
      warmth.frequency.value = 4300;
      warmth.Q.value = 0.35;
      master.connect(warmth);
      warmth.connect(ctx.destination);

      bus = ctx.createGain();

      const dry = ctx.createGain();
      dry.gain.value = 0.66;
      bus.connect(dry);
      dry.connect(master);

      const reverb = ctx.createConvolver();
      reverb.buffer = makeImpulse(lowPower ? 1.4 : 3, 2.4);
      const wet = ctx.createGain();
      wet.gain.value = 0.9;
      bus.connect(reverb);
      reverb.connect(wet);
      wet.connect(master);

      // Crisp interface layer: bypass the music fade and low-pass so UI sounds
      // stay bright and audible even during the first music swell.
      sfxOut = ctx.createGain();
      sfxOut.gain.value = 0.5;
      sfxOut.connect(ctx.destination);
      sfx = ctx.createGain();
      sfx.gain.value = 0.9;
      sfx.connect(sfxOut);
      const sfxSend = ctx.createGain();
      sfxSend.gain.value = 0.05;
      sfx.connect(sfxSend);
      sfxSend.connect(reverb);
    }

    function track(source, list) {
      const collection = list || musicActive;
      collection.push(source);
      source.onended = () => {
        const index = collection.indexOf(source);
        if (index >= 0) collection.splice(index, 1);
      };
    }

    function note(frequency, when, duration, volume, type) {
      if (!ctx || !bus) return;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(frequency, when);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), when + 0.06);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      osc.connect(gain);
      gain.connect(bus);
      osc.start(when);
      osc.stop(when + duration + 0.05);
      track(osc, musicActive);
    }

    function melodyNote(frequency, when, duration, volume) {
      if (!ctx || !bus) return;
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2100, when);

      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(volume, when + 0.09);
      gain.gain.exponentialRampToValueAtTime(volume * 0.55, when + duration * 0.55);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration + 0.75);
      filter.connect(gain);
      gain.connect(bus);

      const fundamental = ctx.createOscillator();
      fundamental.type = 'triangle';
      fundamental.frequency.setValueAtTime(frequency, when);
      fundamental.connect(filter);
      fundamental.start(when);
      fundamental.stop(when + duration + 0.85);
      track(fundamental, musicActive);

      const shimmer = ctx.createOscillator();
      const shimmerGain = ctx.createGain();
      shimmer.type = 'sine';
      shimmer.frequency.setValueAtTime(frequency * 2, when);
      shimmerGain.gain.value = 0.16;
      shimmer.connect(shimmerGain);
      shimmerGain.connect(filter);
      shimmer.start(when);
      shimmer.stop(when + duration + 0.6);
      track(shimmer, musicActive);

      const warmth = ctx.createOscillator();
      const warmthGain = ctx.createGain();
      warmth.type = 'sine';
      warmth.frequency.setValueAtTime(frequency / 2, when);
      warmthGain.gain.value = 0.1;
      warmth.connect(warmthGain);
      warmthGain.connect(filter);
      warmth.start(when);
      warmth.stop(when + duration + 0.6);
      track(warmth, musicActive);
    }

    function padNote(frequency, when, duration, volume) {
      if (!ctx || !bus) return;
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 520;
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(volume, when + 1.6);
      gain.gain.setValueAtTime(volume, when + duration * 0.7);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration + 1.8);
      filter.connect(gain);
      gain.connect(bus);
      [1, 1.5].forEach((ratio, index) => {
        const osc = ctx.createOscillator();
        const mix = ctx.createGain();
        osc.type = index === 0 ? 'sine' : 'triangle';
        osc.frequency.setValueAtTime(frequency * ratio, when);
        mix.gain.value = index === 0 ? 1 : 0.22;
        osc.connect(mix);
        mix.connect(filter);
        osc.start(when);
        osc.stop(when + duration + 2);
        track(osc, musicActive);
      });
    }

    function scheduleLoop() {
      if (!musicEnabled || !ctx || ctx.state !== 'running') {
        loopActive = false;
        return;
      }
      window.clearTimeout(musicTimer);
      const start = ctx.currentTime + 0.12;
      let cursor = 0;

      melody.forEach(([name, beats]) => {
        const duration = beats * BEAT;
        melodyNote(NOTES[name], start + cursor, duration * 0.92, 0.052);
        cursor += duration;
      });

      padNote(NOTES.C3, start, 12 * BEAT, 0.032);
      padNote(NOTES.G3, start + 12 * BEAT, 7 * BEAT, 0.026);
      padNote(NOTES.C3, start + 19 * BEAT, 6 * BEAT, 0.03);

      const total = cursor + 3.2;
      musicTimer = window.setTimeout(scheduleLoop, total * 1000);
    }

    function beginPlayback() {
      if (!ctx || !musicEnabled || !musicStarted) return;
      if (ctx.state !== 'running') {
        const resuming = ctx.resume();
        if (resuming && resuming.then) {
          resuming.then(() => {
            if (musicEnabled && musicStarted && ctx.state === 'running') beginPlayback();
          }).catch(() => {});
        }
        return;
      }
      if (loopActive) return;
      loopActive = true;
      scheduleLoop();
    }

    function fadeMusicIn() {
      if (!ctx || !master) return;
      master.gain.cancelScheduledValues(ctx.currentTime);
      master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), ctx.currentTime);
      master.gain.exponentialRampToValueAtTime(0.58, ctx.currentTime + 1.8);
    }

    function startMusic() {
      init();
      if (!ctx) return false;
      musicEnabled = true;
      musicStarted = true;
      savePreference(true);
      if (ctx.state === 'suspended') {
        const resuming = ctx.resume();
        if (resuming && resuming.catch) resuming.catch(() => {});
      }
      fadeMusicIn();
      beginPlayback();
      return true;
    }

    function armMusic() {
      if (!musicEnabled) return false;
      init();
      if (!ctx) return false;
      musicStarted = true;
      fadeMusicIn();
      beginPlayback();
      return true;
    }

    function markEntry() {
      try { window.sessionStorage.setItem(ENTRY_KEY, '1'); } catch (error) {}
    }

    function consumeEntry() {
      try {
        const entered = window.sessionStorage.getItem(ENTRY_KEY) === '1';
        if (entered) window.sessionStorage.removeItem(ENTRY_KEY);
        return entered;
      } catch (error) {
        return false;
      }
    }

    function resume() {
      if (!ctx) return;
      if (ctx.state === 'suspended' && ctx.resume) {
        const resuming = ctx.resume();
        if (resuming && resuming.catch) resuming.catch(() => {});
      }
      if (musicEnabled && musicStarted) beginPlayback();
    }

    function stopMusic() {
      musicEnabled = false;
      musicStarted = false;
      loopActive = false;
      savePreference(false);
      window.clearTimeout(musicTimer);
      if (ctx && master) {
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), ctx.currentTime);
        master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.8);
        musicActive.forEach(source => {
          try { source.stop(ctx.currentTime + 0.05); } catch (e) {}
        });
        musicActive.length = 0;
      }
    }

    function withSfx(play) {
      if (!sfxEnabled) return;
      init();
      if (!ctx) return;
      if (ctx.state === 'running') {
        play();
        return;
      }
      if (ctx.state === 'suspended' && ctx.resume) {
        const resuming = ctx.resume();
        if (resuming && resuming.then) {
          resuming.then(() => {
            if (sfxEnabled) play();
          }).catch(() => {});
        }
      }
    }

    function chime(freq, volume, delay) {
      withSfx(() => {
        const when = ctx.currentTime + (delay || 0);
        const level = volume || 0.06;
        sfxTone({ when, duration: 1.5, frequency: freq || 880, volume: level, type: 'sine', pan: 0 });
        sfxTone({ when: when + 0.08, duration: 1.2, frequency: (freq || 880) * 1.5, volume: level * 0.55, type: 'sine', pan: 0 });
      });
    }

    function celebration() {
      withSfx(() => {
        const now = ctx.currentTime;
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
          sfxTone({ when: now + i * 0.11, duration: 1.7, frequency: f, volume: 0.06, type: 'sine', pan: 0 });
        });
      });
    }

    function blow(pan) {
      withSfx(() => {
        const when = ctx.currentTime + 0.004;
        const duration = 0.32;
        const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
          data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        }
        const source = ctx.createBufferSource();
        const filter = ctx.createBiquadFilter();
        const gain = ctx.createGain();
        source.buffer = buffer;
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        gain.gain.value = 0.035;
        source.connect(filter);
        filter.connect(gain);
        connectSfx(gain, 0, when);
        source.start(when);
        track(source, sfxActive);
      });
    }

    function clampPan(value) {
      return Math.max(-0.7, Math.min(0.7, typeof value === 'number' ? value : 0));
    }

    function connectSfx(node, pan, when) {
      if (typeof ctx.createStereoPanner === 'function') {
        const panner = ctx.createStereoPanner();
        panner.pan.setValueAtTime(clampPan(pan), when);
        node.connect(panner);
        panner.connect(sfx);
      } else {
        node.connect(sfx);
      }
    }

    function sfxTone(options) {
      if (!ctx || !sfx) return;
      const when = options.when;
      const duration = Math.max(0.03, options.duration || 0.12);
      const frequency = Math.max(30, options.frequency || 660);
      const endFrequency = Math.max(30, options.endFrequency || frequency);
      const volume = Math.max(0.0002, options.volume || 0.02);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = options.type || 'sine';
      osc.frequency.setValueAtTime(frequency, when);
      if (endFrequency !== frequency) {
        osc.frequency.exponentialRampToValueAtTime(endFrequency, when + duration);
      }
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(volume, when + Math.min(0.012, duration * 0.35));
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      osc.connect(gain);
      connectSfx(gain, options.pan, when);
      osc.start(when);
      osc.stop(when + duration + 0.02);
      track(osc, sfxActive);
    }

    function sfxNoise(options) {
      if (!ctx || !sfx) return;
      const when = options.when;
      const duration = Math.max(0.03, options.duration || 0.12);
      const volume = Math.max(0.0001, options.volume || 0.012);
      const startFrequency = Math.max(80, options.startFrequency || 1800);
      const endFrequency = Math.max(80, options.endFrequency || 500);
      const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        const fade = Math.sin((i / length) * Math.PI);
        data[i] = (Math.random() * 2 - 1) * fade;
      }
      const source = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      source.buffer = buffer;
      filter.type = options.filterType || 'bandpass';
      filter.Q.value = options.q || 0.8;
      filter.frequency.setValueAtTime(startFrequency, when);
      filter.frequency.exponentialRampToValueAtTime(endFrequency, when + duration);
      gain.gain.setValueAtTime(0.0001, when);
      gain.gain.exponentialRampToValueAtTime(volume, when + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
      source.connect(filter);
      filter.connect(gain);
      connectSfx(gain, options.pan, when);
      source.start(when);
      source.stop(when + duration + 0.02);
      track(source, sfxActive);
    }

    function playUi(kind, pan) {
      if (!ctx || !sfx) return;
      const t = ctx.currentTime + 0.004;
      const p = clampPan(pan);
      const color = (Math.random() * 2 - 1) * 34;

      switch (kind) {
        case 'hover':
          sfxTone({ when: t, duration: 0.055, frequency: 1960 + color, endFrequency: 2180 + color, volume: 0.006, type: 'sine', pan: p });
          break;
        case 'toggle':
          sfxTone({ when: t, duration: 0.07, frequency: 760, endFrequency: 920, volume: 0.014, type: 'triangle', pan: p });
          sfxTone({ when: t + 0.045, duration: 0.09, frequency: 1180, endFrequency: 1420, volume: 0.008, type: 'sine', pan: p });
          break;
        case 'open':
          sfxNoise({ when: t, duration: 0.24, volume: 0.011, startFrequency: 520, endFrequency: 2600, q: 0.7, pan: p });
          sfxTone({ when: t + 0.01, duration: 0.28, frequency: 392, endFrequency: 587.33, volume: 0.015, type: 'sine', pan: p });
          sfxTone({ when: t + 0.05, duration: 0.24, frequency: 783.99, endFrequency: 1174.66, volume: 0.007, type: 'sine', pan: p });
          break;
        case 'close':
          sfxNoise({ when: t, duration: 0.2, volume: 0.008, startFrequency: 2300, endFrequency: 420, q: 0.8, pan: p });
          sfxTone({ when: t, duration: 0.2, frequency: 587.33, endFrequency: 392, volume: 0.012, type: 'sine', pan: p });
          break;
        case 'swipe':
          sfxNoise({ when: t, duration: 0.18, volume: 0.012, startFrequency: 1900, endFrequency: 360, q: 0.9, pan: p });
          sfxTone({ when: t, duration: 0.14, frequency: 190, endFrequency: 120, volume: 0.007, type: 'sine', pan: p });
          break;
        case 'success':
          [659.25, 783.99, 987.77, 1318.51].forEach((frequency, index) => {
            sfxTone({ when: t + index * 0.075, duration: 0.5, frequency: frequency, endFrequency: frequency, volume: 0.012, type: 'sine', pan: p });
          });
          break;
        case 'tap':
        default:
          sfxNoise({ when: t, duration: 0.02, volume: 0.007, startFrequency: 4200, endFrequency: 2600, q: 0.9, pan: p });
          sfxTone({ when: t, duration: 0.09, frequency: 620 + color, endFrequency: 480, volume: 0.018, type: 'triangle', pan: p });
          sfxTone({ when: t + 0.004, duration: 0.06, frequency: 1240 + color, endFrequency: 960, volume: 0.005, type: 'sine', pan: p });
          break;
      }
    }

    function ui(kind, pan) {
      withSfx(() => playUi(kind, pan));
    }

    return {
      toggleMusic: () => {
        if (musicEnabled) { stopMusic(); return false; }
        return startMusic();
      },
      startMusic,
      armMusic,
      markEntry,
      consumeEntry,
      resume,
      chime,
      celebration,
      blow,
      ui,
      // Build the audio graph while the loader is still up, so the first
      // hover does not pay for it in one hitch.
      warm: () => init(),
      isMusicEnabled: () => musicEnabled
    };
  })();

  /* ————————————————————————————————
     Confetti
     ———————————————————————————————— */
  class Confetti {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.particles = [];
      this.running = false;
      this.last = 0;
      this.colors = ['#f6bfca', '#ed9caf', '#e7c18b', '#fff3e4', '#bd7895', '#f3d7d0'];
      this.resize = this.resize.bind(this);
      this.tick = this.tick.bind(this);
      window.addEventListener('resize', this.resize);
      this.resize();
    }

    resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, reducedEffects ? 1 : 2);
      this.canvas.width = window.innerWidth * ratio;
      this.canvas.height = window.innerHeight * ratio;
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    }

    burst(amount, fromCenter) {
      const count = Math.round((amount || 140) * (reducedEffects ? 0.55 : 1));
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (let i = 0; i < count; i++) {
        const originX = fromCenter ? w * rand(0.25, 0.75) : rand(0, w);
        const originY = fromCenter ? h * rand(0.28, 0.48) : rand(-h * 0.2, 0);
        const angle = rand(-Math.PI * 0.85, -Math.PI * 0.15);
        const speed = rand(4, 13);
        this.particles.push({
          x: originX,
          y: originY,
          vx: Math.cos(angle) * speed + rand(-2, 2),
          vy: Math.sin(angle) * speed + (fromCenter ? rand(-2, 2) : rand(-1, 3)),
          w: rand(4, 9),
          h: rand(7, 16),
          rot: rand(0, Math.PI * 2),
          vr: rand(-0.16, 0.16),
          color: this.colors[Math.floor(Math.random() * this.colors.length)],
          life: rand(4, 8),
          age: 0,
          heart: Math.random() < 0.12
        });
      }
      if (!this.running) {
        this.running = true;
        this.last = performance.now();
        requestAnimationFrame(this.tick);
      }
    }

    drawHeart(ctx, x, y, size, rot, color) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(rot);
      ctx.scale(size / 10, size / 10);
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.bezierCurveTo(-7, -3, -7, 5, 0, 10);
      ctx.bezierCurveTo(7, 5, 7, -3, 0, 3);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
    }

    tick(now) {
      const dt = Math.min((now - this.last) / 1000, 0.05);
      this.last = now;
      const ctx = this.ctx;
      const w = window.innerWidth;
      const h = window.innerHeight;
      ctx.clearRect(0, 0, w, h);
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.age += dt;
        p.vy += 16 * dt;
        p.vx *= 0.994;
        p.x += p.vx * dt * 60;
        p.y += p.vy * dt * 60;
        p.rot += p.vr;
        if (p.age > p.life || p.y > h + 60) {
          this.particles.splice(i, 1);
          continue;
        }
        const fade = clamp(1 - (p.age - p.life * 0.7) / (p.life * 0.3), 0, 1);
        ctx.globalAlpha = fade;
        if (p.heart) {
          this.drawHeart(ctx, p.x, p.y, p.w * 1.8, p.rot, p.color);
        } else {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.rot * 1.3)) + 2);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;
      if (this.particles.length) {
        requestAnimationFrame(this.tick);
      } else {
        this.running = false;
      }
    }
  }

  /* ————————————————————————————————
     Shared canvas textures and materials
     ———————————————————————————————— */
  function softCircleTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.22, 'rgba(255,255,255,0.85)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.24)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function shadowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(128, 128, 4, 128, 128, 126);
    gradient.addColorStop(0, 'rgba(0,0,0,0.62)');
    gradient.addColorStop(0.42, 'rgba(0,0,0,0.3)');
    gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(canvas);
    return tex;
  }

  const SOFT_TEXTURE = softCircleTexture();
  const SHADOW_TEXTURE = shadowTexture();

  function physical(color, options) {
    // Standard PBR keeps the soft studio look but avoids the heavier clearcoat
    // and sheen shaders. That is a large win on mobile GPUs and older laptops.
    const clean = {};
    Object.keys(options || {}).forEach(key => {
      if (
        key !== 'clearcoat' &&
        key !== 'clearcoatRoughness' &&
        key !== 'sheen' &&
        key !== 'sheenColor' &&
        key !== 'sheenRoughness' &&
        key !== 'specularIntensity' &&
        key !== 'specularColor'
      ) {
        clean[key] = options[key];
      }
    });
    return new THREE.MeshStandardMaterial(Object.assign({
      color: color,
      roughness: 0.5,
      metalness: 0.0
    }, clean));
  }

  function standard(color, options) {
    return new THREE.MeshStandardMaterial(Object.assign({
      color: color,
      roughness: 0.65,
      metalness: 0.0
    }, options || {}));
  }

  function glowSprite(color, opacity, scaleX, scaleY) {
    const material = new THREE.SpriteMaterial({
      map: SOFT_TEXTURE,
      color: color,
      transparent: true,
      opacity: opacity == null ? 0.5 : opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(scaleX || 1, scaleY || scaleX || 1, 1);
    return sprite;
  }

  function addShadowPlane(parent, x, z, scale, opacity) {
    const material = new THREE.MeshBasicMaterial({
      map: SHADOW_TEXTURE,
      transparent: true,
      opacity: opacity == null ? 0.55 : opacity,
      depthWrite: false,
      toneMapped: false
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    plane.rotation.x = -Math.PI / 2;
    plane.scale.setScalar(scale || 1);
    plane.position.set(x || 0, -0.382, z || 0);
    parent.add(plane);
    return plane;
  }

  function createEnvironment(renderer) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    const base = ctx.createLinearGradient(0, 0, 0, 512);
    base.addColorStop(0, '#3e274b');
    base.addColorStop(0.42, '#21152b');
    base.addColorStop(0.7, '#160e1e');
    base.addColorStop(1, '#08050c');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 1024, 512);

    const warm = ctx.createRadialGradient(210, 220, 0, 210, 220, 330);
    warm.addColorStop(0, 'rgba(255,205,170,0.72)');
    warm.addColorStop(0.35, 'rgba(255,159,155,0.26)');
    warm.addColorStop(1, 'rgba(255,159,155,0)');
    ctx.fillStyle = warm;
    ctx.fillRect(0, 0, 1024, 512);

    const cool = ctx.createRadialGradient(810, 250, 0, 810, 250, 310);
    cool.addColorStop(0, 'rgba(141,177,255,0.48)');
    cool.addColorStop(1, 'rgba(141,177,255,0)');
    ctx.fillStyle = cool;
    ctx.fillRect(0, 0, 1024, 512);

    const top = ctx.createRadialGradient(520, 30, 0, 520, 30, 500);
    top.addColorStop(0, 'rgba(255,239,224,0.65)');
    top.addColorStop(1, 'rgba(255,239,224,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, 1024, 512);

    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const target = pmrem.fromEquirectangular(texture);
    texture.dispose();
    pmrem.dispose();
    return target.texture;
  }

  function makeRenderer(canvas, stage) {
    // On very large stages the canvas is downscaled by the pixel budget, and
    // MSAA on 8MP of surface is the most expensive line in the whole frame.
    const stagePixels = stage ? stage.clientWidth * stage.clientHeight : 0;
    const renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: !lowPower && stagePixels <= PIXEL_BUDGET,
      precision: lowPower ? 'mediump' : 'highp',
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, maxPixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.shadowMap.enabled = !lowPower;
    // PCF (not PCFSoft): soft shadows sample 16 taps per lit fragment across
    // the whole canvas; PCF's 4 taps look identical at this scale.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // The scenes refresh needsUpdate on their own schedule (see render()).
    renderer.shadowMap.autoUpdate = false;
    return renderer;
  }

  function resizeRenderer(renderer, camera, width, height) {
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  // Fill-rate budget in device pixels. On a 4K display the stage is the whole
  // screen, so the old "1 pixel per CSS pixel" rule meant rendering 8MP per
  // frame for a subject only a few hundred pixels tall.
  const PIXEL_BUDGET = 2100000;

  function qualityRatio(width, height) {
    const budgeted = Math.sqrt(PIXEL_BUDGET / (width * height));
    return clamp(Math.min(pixelCap, budgeted), 0.6, pixelCap);
  }

  function capsuleBetween(a, b, radius, material) {
    const start = new THREE.Vector3(a[0], a[1], a[2]);
    const end = new THREE.Vector3(b[0], b[1], b[2]);
    const direction = new THREE.Vector3().subVectors(end, start);
    const distance = direction.length();
    const geometry = new THREE.CapsuleGeometry(radius, Math.max(0.01, distance - radius * 2), 5, 12);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    return mesh;
  }

  function tube(points, radius, material, segments) {
    const vectors = points.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(vectors);
    const geometry = new THREE.TubeGeometry(curve, segments || 36, radius, 7, false);
    return new THREE.Mesh(geometry, material);
  }

  function heartGeometry(size) {
    const shape = new THREE.Shape();
    shape.moveTo(0, -1);
    shape.bezierCurveTo(-1.2, -0.35, -1.78, 0.14, -1.32, 0.7);
    shape.bezierCurveTo(-0.98, 1.17, -0.27, 1.14, 0, 0.58);
    shape.bezierCurveTo(0.27, 1.14, 0.98, 1.17, 1.32, 0.7);
    shape.bezierCurveTo(1.78, 0.14, 1.2, -0.35, 0, -1);
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.3,
      bevelEnabled: true,
      bevelSegments: 5,
      steps: 1,
      bevelSize: 0.09,
      bevelThickness: 0.09,
      curveSegments: 20
    });
    geometry.center();
    geometry.scale(size || 0.2, size || 0.2, size || 0.2);
    return geometry;
  }

  function starGeometry(size) {
    const shape = new THREE.Shape();
    const spikes = 5;
    const outer = 1;
    const inner = 0.44;
    for (let i = 0; i < spikes * 2; i++) {
      const radius = i % 2 === 0 ? outer : inner;
      const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: 0.1,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: 0.03,
      bevelThickness: 0.03
    });
    geometry.center();
    geometry.scale(size || 0.1, size || 0.1, size || 0.1);
    return geometry;
  }

  function makeLabelTexture(name, subtitle) {
    const canvas = document.createElement('canvas');
    canvas.width = 768;
    canvas.height = 220;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 768, 220);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(10,5,14,0.7)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = '#fff4e9';
    ctx.font = '500 66px "Cormorant Garamond", Georgia, serif';
    ctx.fillText(name, 384, 88);
    ctx.shadowBlur = 8;
    ctx.fillStyle = 'rgba(241,196,196,0.85)';
    ctx.font = '600 19px "Manrope", sans-serif';
    ctx.fillText(subtitle.toUpperCase(), 384, 150);
    ctx.strokeStyle = 'rgba(228,192,138,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(324, 185);
    ctx.lineTo(444, 185);
    ctx.stroke();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  }

  /* ————————————————————————————————
     Decor helpers
     ———————————————————————————————— */
  function addBalloon(parent, x, y, z, color, scale, phase) {
    const group = new THREE.Group();
    const balloonMaterial = physical(color, {
      roughness: 0.26,
      metalness: 0.06,
      clearcoat: 1,
      clearcoatRoughness: 0.16,
      envMapIntensity: 1.15
    });
    const balloon = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 24), balloonMaterial);
    balloon.scale.set(1, 1.25, 0.97);
    group.add(balloon);

    const knot = new THREE.Mesh(new THREE.ConeGeometry(0.038, 0.09, 10), balloonMaterial);
    knot.position.y = -0.39;
    group.add(knot);

    const stringPoints = [];
    for (let i = 0; i <= 6; i++) {
      stringPoints.push(new THREE.Vector3(
        Math.sin(i * 0.7) * 0.025,
        -0.43 - i * 0.16,
        Math.cos(i * 0.6) * 0.02
      ));
    }
    const stringGeometry = new THREE.BufferGeometry().setFromPoints(stringPoints);
    const string = new THREE.Line(stringGeometry, new THREE.LineBasicMaterial({
      color: 0xf0d7cf,
      transparent: true,
      opacity: 0.24
    }));
    group.add(string);

    const shine = glowSprite(0xffffff, 0.26, 0.11, 0.2);
    shine.position.set(-0.1, 0.17, 0.22);
    group.add(shine);

    group.position.set(x, y, z);
    group.scale.setScalar(scale || 1);
    group.userData.baseY = y;
    group.userData.baseX = x;
    group.userData.baseScale = scale || 1;
    group.userData.material = balloonMaterial;
    group.userData.phase = phase || Math.random() * 6.28;
    // The landing page starts with the balloons tied down and dim, then the
    // first gift sets them free.
    balloonMaterial.transparent = true;
    balloonMaterial.opacity = 1;
    parent.add(group);
    return group;
  }

  function addGift(parent, x, z, size, color, ribbonColor, rotation) {
    const group = new THREE.Group();
    const boxMaterial = physical(color, { roughness: 0.36, metalness: 0.05, clearcoat: 0.7 });
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(size, size * 0.8, size),
      boxMaterial
    );
    box.position.y = size * 0.4;
    group.add(box);

    const ribbonMat = physical(ribbonColor, { roughness: 0.28, metalness: 0.5, clearcoat: 0.9 });
    const ribbonA = new THREE.Mesh(new THREE.BoxGeometry(size * 0.14, size * 0.84, size * 1.02), ribbonMat);
    ribbonA.position.y = size * 0.4;
    group.add(ribbonA);
    const ribbonB = new THREE.Mesh(new THREE.BoxGeometry(size * 1.02, size * 0.84, size * 0.14), ribbonMat);
    ribbonB.position.y = size * 0.4;
    group.add(ribbonB);

    // The lid lives in its own group so the landing-page gifts can actually
    // open. It holds the lid panel, the bow loops and the knot.
    const lid = new THREE.Group();
    lid.position.y = size * 0.8;
    group.add(lid);
    const lidBox = new THREE.Mesh(
      new THREE.BoxGeometry(size * 1.05, size * 0.17, size * 1.05),
      boxMaterial
    );
    lidBox.position.y = size * 0.085;
    lid.add(lidBox);

    for (const side of [-1, 1]) {
      const loop = new THREE.Mesh(new THREE.SphereGeometry(size * 0.16, 16, 12), ribbonMat);
      loop.scale.set(1.25, 0.62, 0.55);
      loop.position.set(side * size * 0.14, size * 0.06, 0);
      loop.rotation.z = side * 0.35;
      lid.add(loop);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(size * 0.07, 12, 10), ribbonMat);
    knot.position.y = size * 0.05;
    lid.add(knot);

    // A soft glow marks the gift that is waiting to be opened.
    const glow = glowSprite(ribbonColor, 0, size * 3.4, size * 3.4);
    glow.position.y = size * 0.55;
    group.add(glow);

    group.position.set(x, -0.38, z);
    group.rotation.y = rotation || 0;
    parent.add(group);
    return {
      group,
      lid,
      glow,
      size,
      lidBaseY: size * 0.8,
      position: new THREE.Vector3(x, -0.38, z),
      opened: false
    };
  }

  function addPetals(parent, origin) {
    const materials = [
      physical(0xef9caf, { roughness: 0.3, emissive: 0x5b1e31, emissiveIntensity: 0.25, clearcoat: 1 }),
      physical(0xe4c08a, { roughness: 0.28, metalness: 0.5, clearcoat: 1 }),
      physical(0xc995a9, { roughness: 0.3, emissive: 0x3b1828, emissiveIntensity: 0.2, clearcoat: 1 })
    ];
    const petals = [];
    const source = origin
      ? new THREE.Vector3(origin[0], origin[1], origin[2])
      : new THREE.Vector3(0, 2, 0);
    const positions = [
      [-1.5, 3.05, -0.75], [1.45, 2.9, -0.7], [-1.1, 4.0, -1.1],
      [1.15, 4.12, -1.15], [-1.62, 2.2, -0.35], [1.6, 2.32, -0.3],
      [0.72, 4.5, -1.35], [-0.6, 4.35, -1.25]
    ];
    positions.forEach((pos, i) => {
      const heart = new THREE.Mesh(heartGeometry(rand(0.11, 0.19)), materials[i % materials.length]);
      const target = new THREE.Vector3(pos[0], pos[1], pos[2]);
      const start = source.clone().add(new THREE.Vector3(
        rand(-0.16, 0.16),
        rand(-0.08, 0.16),
        rand(-0.16, 0.16)
      ));
      heart.position.copy(start);
      heart.scale.setScalar(0.001);
      heart.rotation.set(rand(-0.5, 0.5), rand(-0.8, 0.8), rand(-0.25, 0.25));
      heart.userData.baseY = pos[1];
      heart.userData.phase = rand(0, 6.28);
      heart.userData.target = target;
      heart.userData.origin = start;
      parent.add(heart);
      petals.push(heart);
    });
    return petals;
  }

  function addStarField(scene, count, spread, height, zRange) {
    const positions = [];
    const colors = [];
    const palette = [new THREE.Color(0xfff0dc), new THREE.Color(0xffc6d3), new THREE.Color(0xe4c08a), new THREE.Color(0xbcc7ff)];
    for (let i = 0; i < count; i++) {
      positions.push(rand(-spread, spread), rand(0.2, height), rand(zRange[0], zRange[1]));
      const c = palette[Math.floor(Math.random() * palette.length)];
      colors.push(c.r, c.g, c.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 0.045,
      map: SOFT_TEXTURE,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
      toneMapped: false
    });
    const points = new THREE.Points(geometry, material);
    scene.add(points);
    return points;
  }

  /* ————————————————————————————————
     The little birthday girl and her cake
     ———————————————————————————————— */
  function createMiniCake(palette) {
    const group = new THREE.Group();
    const gold = physical(0xd9b477, { metalness: 0.85, roughness: 0.25, clearcoat: 1 });
    const cakeMat = physical(palette.cake, { roughness: 0.62, clearcoat: 0.2 });
    const frostingMat = physical(palette.frosting, { roughness: 0.5, clearcoat: 0.38 });
    const candleMat = physical(palette.candle, { roughness: 0.35, clearcoat: 0.7 });
    const flameMat = new THREE.MeshBasicMaterial({
      color: 0xffc46f,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const flameCoreMat = new THREE.MeshBasicMaterial({
      color: 0xfff3c0,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });

    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.024, 40), gold);
    plate.position.y = 0.012;
    group.add(plate);

    const tier = new THREE.Mesh(new THREE.CylinderGeometry(0.235, 0.255, 0.15, 40), cakeMat);
    tier.position.y = 0.1;
    group.add(tier);

    const frosting = new THREE.Mesh(new THREE.CylinderGeometry(0.248, 0.24, 0.04, 40), frostingMat);
    frosting.position.y = 0.19;
    group.add(frosting);

    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const drip = new THREE.Mesh(new THREE.SphereGeometry(0.036, 10, 8), frostingMat);
      drip.position.set(Math.cos(angle) * 0.235, 0.18 - (i % 3) * 0.018, Math.sin(angle) * 0.235);
      drip.scale.set(1, 1.65 + (i % 2) * 0.5, 1);
      group.add(drip);
    }

    const topTier = new THREE.Mesh(new THREE.CylinderGeometry(0.145, 0.17, 0.12, 32), cakeMat);
    topTier.position.y = 0.26;
    group.add(topTier);

    const topFrosting = new THREE.Mesh(new THREE.CylinderGeometry(0.152, 0.148, 0.035, 32), frostingMat);
    topFrosting.position.y = 0.335;
    group.add(topFrosting);

    for (let i = 0; i < 9; i++) {
      const angle = (i / 9) * Math.PI * 2 + 0.2;
      const drip = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), frostingMat);
      drip.position.set(Math.cos(angle) * 0.15, 0.32 - (i % 2) * 0.014, Math.sin(angle) * 0.15);
      drip.scale.set(1, 1.7, 1);
      group.add(drip);
    }

    const sprinkles = [0xef9caf, 0xe4c08a, 0xfff4e7];
    for (let i = 0; i < 14; i++) {
      const angle = rand(0, Math.PI * 2);
      const radius = rand(0.02, 0.135);
      const sprinkle = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.007, 0.025, 3, 6),
        standard(sprinkles[i % sprinkles.length], { roughness: 0.4 })
      );
      sprinkle.position.set(Math.cos(angle) * radius, 0.36, Math.sin(angle) * radius);
      sprinkle.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      group.add(sprinkle);
    }

    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.023, 0.2, 16), candleMat);
    candle.position.y = 0.45;
    group.add(candle);
    const wick = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 0.045, 6),
      standard(0x2a1d18, { roughness: 0.9 })
    );
    wick.position.y = 0.57;
    group.add(wick);

    const flameGroup = new THREE.Group();
    flameGroup.position.set(0, 0.62, 0);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), flameMat);
    flame.scale.set(1, 1.8, 1);
    flameGroup.add(flame);
    const flameCore = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), flameCoreMat);
    flameCore.position.y = -0.005;
    flameCore.scale.set(1, 1.8, 1);
    flameGroup.add(flameCore);
    const glow = glowSprite(0xffa45d, 0.65, 0.3, 0.3);
    flameGroup.add(glow);
    const flameLight = new THREE.PointLight(0xffa565, 1.6, 1.6, 2);
    flameLight.position.set(0, 0.03, 0);
    flameGroup.add(flameLight);
    group.add(flameGroup);

    return { group, flameGroup, flameLight, flame };
  }

  function createGirl(config, index) {
    const root = new THREE.Group();
    const figure = new THREE.Group();
    root.add(figure);

    const skin = physical(config.skin, {
      roughness: 0.58,
      clearcoat: 0.1,
      clearcoatRoughness: 0.55,
      sheen: 0.35,
      sheenColor: new THREE.Color(0xffb7b5),
      sheenRoughness: 0.8
    });
    const dress = physical(config.dress, {
      roughness: 0.4,
      metalness: 0.12,
      clearcoat: 0.62,
      clearcoatRoughness: 0.28,
      sheen: 0.28,
      sheenColor: new THREE.Color(config.dressSheen || 0xffcbd8),
      sheenRoughness: 0.7
    });
    const hair = physical(config.hair, {
      roughness: 0.4,
      metalness: 0.04,
      clearcoat: 0.38,
      clearcoatRoughness: 0.32
    });
    const hairLight = physical(config.hairLight || 0x5b3931, { roughness: 0.45, clearcoat: 0.3 });
    const shoe = physical(0x18121b, { roughness: 0.3, clearcoat: 0.9 });
    const gold = physical(0xd9b477, { metalness: 0.85, roughness: 0.23, clearcoat: 1, clearcoatRoughness: 0.15 });
    const pearl = physical(0xfff5e8, { roughness: 0.14, metalness: 0.12, clearcoat: 1, clearcoatRoughness: 0.06 });

    /* pedestal */
    const pedestal = new THREE.Group();
    const pedestalMat = physical(0x211525, {
      roughness: 0.18,
      metalness: 0.62,
      clearcoat: 1,
      clearcoatRoughness: 0.12,
      envMapIntensity: 1.2
    });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.9, 0.34, 64), pedestalMat);
    base.position.y = -0.17;
    base.receiveShadow = true;
    pedestal.add(base);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.84, 0.84, 0.035, 64), physical(0x1b1122, {
      roughness: 0.14,
      metalness: 0.55,
      clearcoat: 1
    }));
    top.position.y = -0.002;
    top.receiveShadow = true;
    pedestal.add(top);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.825, 0.012, 8, 64), gold);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.019;
    pedestal.add(rim);
    const lowerRim = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.009, 8, 64), gold);
    lowerRim.rotation.x = Math.PI / 2;
    lowerRim.position.y = -0.33;
    pedestal.add(lowerRim);
    const emblem = new THREE.Mesh(starGeometry(0.075), gold);
    emblem.position.set(0, -0.16, 0.91);
    pedestal.add(emblem);
    root.add(pedestal);

    addShadowPlane(root, 0, 0.05, 2.15, 0.5);

    /* legs and shoes */
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.073, 0.092, 0.62, 20), skin);
      leg.position.set(side * 0.155, 0.36, 0.01);
      figure.add(leg);

      const pump = new THREE.Mesh(new THREE.SphereGeometry(0.12, 24, 16), shoe);
      pump.scale.set(0.87, 0.53, 1.68);
      pump.position.set(side * 0.155, 0.075, 0.065);
      figure.add(pump);

      const heel = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.04, 0.11, 10), shoe);
      heel.position.set(side * 0.155, 0.02, -0.07);
      figure.add(heel);
    }

    /* skirt and bodice */
    const fitted = config.silhouette === 'fitted';
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.335, fitted ? 0.52 : 0.7, 1.34, 64, 1, false),
      dress
    );
    skirt.position.y = 1.35;
    figure.add(skirt);

    if (config.tulle !== false) {
      const tulle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.39, 0.73, 1.18, lowPower ? 28 : 48, 1, true),
        physical(config.tulle || 0xffdfe2, {
          transparent: true,
          opacity: 0.1,
          roughness: 0.25,
          metalness: 0.1,
          side: THREE.DoubleSide,
          depthWrite: false,
          clearcoat: 1
        })
      );
      tulle.position.y = 1.37;
      figure.add(tulle);
    }

    if (config.trim !== false) {
      const hem = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.009, 6, 64), gold);
      hem.rotation.x = Math.PI / 2;
      hem.position.y = 0.69;
      figure.add(hem);
    }

    const waist = new THREE.Mesh(
      new THREE.TorusGeometry(0.335, config.trim === false ? 0.012 : 0.018, 8, 48),
      config.trim === false ? dress : gold
    );
    waist.rotation.x = Math.PI / 2;
    waist.position.y = 2.02;
    figure.add(waist);

    const bodice = new THREE.Mesh(new THREE.CylinderGeometry(0.265, 0.34, 0.72, 48), dress);
    bodice.position.y = 2.37;
    figure.add(bodice);

    for (const side of [-1, 1]) {
      const bust = new THREE.Mesh(new THREE.SphereGeometry(0.155, 24, 18), dress);
      bust.scale.set(1.02, 0.8, 0.66);
      bust.position.set(side * 0.135, 2.54, 0.1);
      figure.add(bust);
    }

    if (config.vNeck) {
      const chest = new THREE.Mesh(new THREE.SphereGeometry(0.155, 28, 22), skin);
      chest.scale.set(0.96, 1.3, 0.52);
      chest.position.set(0, 2.58, 0.245);
      figure.add(chest);

      for (const side of [-1, 1]) {
        const lapel = tube([
          [side * 0.17, 2.7, 0.22],
          [side * 0.09, 2.52, 0.315],
          [side * 0.018, 2.35, 0.345]
        ], 0.033, dress, 18);
        figure.add(lapel);
      }
    }

    if (config.necklace !== false) {
      if (config.vNeck && config.necklace === 'gold') {
        for (const side of [-1, 1]) {
          const chain = tube([
            [side * 0.118, 2.72, 0.31],
            [side * 0.058, 2.58, 0.332],
            [0, 2.47, 0.338]
          ], 0.006, gold, 14);
          figure.add(chain);
        }
      } else {
        const neckline = new THREE.Mesh(
          new THREE.TorusGeometry(0.155, 0.006, 6, 40, Math.PI * 1.15),
          config.necklace === 'gold' ? gold : pearl
        );
        neckline.rotation.set(Math.PI / 2, 0, -Math.PI * 0.075);
        neckline.position.set(0, 2.713, 0.055);
        figure.add(neckline);
      }
    }

    /* sleeves, arms and hands */
    for (const side of [-1, 1]) {
      const sleeve = new THREE.Mesh(new THREE.SphereGeometry(0.15, 20, 16), dress);
      sleeve.scale.set(0.9, 0.74, 0.86);
      sleeve.position.set(side * 0.35, 2.645, 0.005);
      figure.add(sleeve);

      const upperArm = capsuleBetween(
        [side * 0.43, 2.65, 0.01],
        [side * 0.51, 2.26, 0.19],
        0.058,
        skin
      );
      figure.add(upperArm);

      const forearm = capsuleBetween(
        [side * 0.51, 2.26, 0.19],
        [side * 0.25, 2.1, 0.49],
        0.049,
        skin
      );
      figure.add(forearm);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.068, 18, 12), skin);
      hand.scale.set(1.05, 0.68, 1.25);
      hand.position.set(side * 0.225, 2.075, 0.54);
      figure.add(hand);

      if (config.bracelets !== false) {
        const bracelet = new THREE.Mesh(new THREE.TorusGeometry(0.056, 0.007, 6, 24), gold);
        bracelet.rotation.x = 1.2;
        bracelet.position.set(side * 0.31, 2.14, 0.44);
        figure.add(bracelet);
      }
    }

    /* neck */
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.11, 0.27, 24), skin);
    neck.position.y = 2.86;
    figure.add(neck);

    /* head */
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 3.36, 0.01);
    headGroup.rotation.y = config.headTurn || 0;
    figure.add(headGroup);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.44, 48, 40), skin);
    head.scale.set(0.96, 1.07, 0.93);
    headGroup.add(head);

    /* ears */
    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.SphereGeometry(0.072, 16, 12), skin);
      ear.scale.set(0.55, 1, 0.66);
      ear.position.set(side * 0.4, -0.015, 0.015);
      headGroup.add(ear);
    }

    /* hair back and sides */
    const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.465, 40, 32), hair);
    backHair.scale.set(1.035, 1.055, 0.99);
    backHair.position.set(0, 0.03, -0.095);
    headGroup.add(backHair);

    if (config.hairStyle === 'long') {
      const longHair = new THREE.Mesh(new THREE.SphereGeometry(0.42, 36, 28), hair);
      longHair.scale.set(1.02, 1.44, 0.6);
      longHair.position.set(0, -0.22, -0.13);
      headGroup.add(longHair);
      for (const side of [-1, 1]) {
        const lock = tube([
          [side * 0.36, 0.25, -0.02],
          [side * 0.49, -0.02, -0.01],
          [side * 0.5, -0.3, 0.02],
          [side * 0.42, -0.58, 0.05],
          [side * 0.31, -0.8, 0.05]
        ], side === 1 ? 0.086 : 0.095, hair, 45);
        headGroup.add(lock);

        const wisp = tube([
          [side * 0.46, -0.08, 0.04],
          [side * 0.53, -0.34, 0.06],
          [side * 0.41, -0.61, 0.08],
          [side * 0.32, -0.8, 0.07]
        ], 0.022, hairLight, 20);
        headGroup.add(wisp);
      }
    } else {
      for (const side of [-1, 1]) {
        const lock = tube([
          [side * 0.37, 0.25, -0.01],
          [side * 0.47, 0.06, 0.0],
          [side * 0.46, -0.18, 0.03],
          [side * 0.36, -0.37, 0.06]
        ], side === 1 ? 0.089 : 0.1, hair, 35);
        headGroup.add(lock);
        const flick = tube([
          [side * 0.36, -0.31, 0.03],
          [side * 0.48, -0.38, 0.04],
          [side * 0.44, -0.48, 0.06]
        ], 0.04, hair, 16);
        headGroup.add(flick);
      }
    }

    /* centre-parted curtain fringe */
    const fringePaths = [
      [[0.015, 0.39, 0.29], [-0.08, 0.34, 0.39], [-0.22, 0.24, 0.39], [-0.36, 0.08, 0.31]],
      [[-0.015, 0.39, 0.29], [0.08, 0.34, 0.39], [0.22, 0.24, 0.39], [0.36, 0.08, 0.31]],
      [[0.0, 0.41, 0.27], [-0.04, 0.38, 0.36], [-0.12, 0.31, 0.4], [-0.2, 0.21, 0.37]],
      [[0.0, 0.41, 0.27], [0.04, 0.38, 0.36], [0.12, 0.31, 0.4], [0.2, 0.21, 0.37]]
    ];
    fringePaths.forEach((path, i) => {
      const strand = tube(path, i < 2 ? 0.05 : 0.038, hair, 26);
      headGroup.add(strand);
    });
    const crownHighlight = tube([
      [-0.27, 0.36, 0.14],
      [-0.05, 0.46, 0.18],
      [0.28, 0.37, 0.12]
    ], 0.013, hairLight, 22);
    headGroup.add(crownHighlight);

    /* face */
    const eyeWhiteMat = standard(0xfff9f3, { roughness: 0.24 });
    const irisMat = physical(config.eyeColor || 0x4a2e27, { roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    const pupilMat = standard(0x161011, { roughness: 0.2 });
    const highlightMat = new THREE.MeshBasicMaterial({ color: 0xfffdf8, toneMapped: false });
    const lashMat = standard(0x281819, { roughness: 0.7 });
    const browMat = standard(0x35211e, { roughness: 0.8 });
    const lipMat = physical(config.lip || 0xbb6671, { roughness: 0.34, clearcoat: 0.6, sheen: 0.4, sheenColor: new THREE.Color(0xffb8b0) });
    const blushMat = new THREE.MeshBasicMaterial({
      color: 0xe98693,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      toneMapped: false
    });

    for (const side of [-1, 1]) {
      const isWink = config.wink && side === 1;
      if (isWink) {
        const closed = tube([
          [0.08, 0.032, 0.39],
          [0.155, 0.018, 0.405],
          [0.235, 0.04, 0.385]
        ], 0.009, lashMat, 14);
        headGroup.add(closed);
        for (let lash = 0; lash < 3; lash++) {
          const lashLine = tube([
            [0.22 + lash * 0.008, 0.038, 0.39],
            [0.25 + lash * 0.012, 0.062 + lash * 0.004, 0.382]
          ], 0.004, lashMat, 6);
          headGroup.add(lashLine);
        }
      } else {
        const white = new THREE.Mesh(new THREE.SphereGeometry(0.074, 24, 18), eyeWhiteMat);
        white.scale.set(1.03, 0.61, 0.28);
        white.position.set(side * 0.157, 0.012, 0.373);
        headGroup.add(white);

        const iris = new THREE.Mesh(new THREE.SphereGeometry(0.039, 20, 16), irisMat);
        iris.scale.set(1, 1.08, 0.32);
        iris.position.set(side * 0.157, 0.009, 0.395);
        headGroup.add(iris);

        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.021, 16, 12), pupilMat);
        pupil.scale.set(1, 1.06, 0.28);
        pupil.position.set(side * 0.157, 0.008, 0.408);
        headGroup.add(pupil);

        const spark = new THREE.Mesh(new THREE.SphereGeometry(0.0095, 10, 8), highlightMat);
        spark.position.set(side * 0.146, 0.027, 0.416);
        headGroup.add(spark);
        const sparkSmall = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 8, 6), highlightMat);
        sparkSmall.position.set(side * 0.17, -0.008, 0.416);
        headGroup.add(sparkSmall);

        const eyeliner = tube([
          [side * 0.238, 0.028, 0.385],
          [side * 0.16, 0.066, 0.398],
          [side * 0.083, 0.033, 0.39]
        ], 0.0095, lashMat, 16);
        headGroup.add(eyeliner);

        const outerLash = tube([
          [side * 0.234, 0.035, 0.389],
          [side * 0.26, 0.064, 0.382],
          [side * 0.276, 0.08, 0.373]
        ], 0.004, lashMat, 8);
        headGroup.add(outerLash);
      }

      const brow = tube([
        [side * 0.075, 0.118, 0.382],
        [side * 0.16, 0.137, 0.389],
        [side * 0.252, 0.114, 0.375]
      ], 0.008, browMat, 14);
      headGroup.add(brow);

      const blush = new THREE.Mesh(new THREE.SphereGeometry(0.07, 18, 12), blushMat);
      blush.scale.set(1, 0.5, 0.16);
      blush.position.set(side * 0.235, -0.105, 0.345);
      headGroup.add(blush);
    }

    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 12), physical(config.skinShade || 0xe7b49e, { roughness: 0.62 }));
    nose.scale.set(1, 0.82, 0.85);
    nose.position.set(0, -0.095, 0.404);
    headGroup.add(nose);

    const upperLip = new THREE.Mesh(new THREE.SphereGeometry(0.061, 20, 12), lipMat);
    upperLip.scale.set(1.16, 0.37, 0.34);
    upperLip.position.set(0, -0.2, 0.381);
    headGroup.add(upperLip);
    const lowerLip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 20, 12), lipMat);
    lowerLip.scale.set(1.05, 0.48, 0.38);
    lowerLip.position.set(0, -0.225, 0.381);
    headGroup.add(lowerLip);
    if (config.smile) {
      const smile = tube([
        [-0.05, -0.218, 0.392],
        [0, -0.232, 0.399],
        [0.05, -0.218, 0.392]
      ], 0.0045, physical(0x793a43, { roughness: 0.5 }), 10);
      headGroup.add(smile);
    }

    if (config.beautyMark) {
      const mark = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 6), standard(0x5a2d31, { roughness: 0.7 }));
      mark.position.set(-0.245, -0.045, 0.363);
      headGroup.add(mark);
    }

    /* earrings */
    for (const side of [-1, 1]) {
      if (config.earrings === 'pearl') {
        const pearlEarring = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12), pearl);
        pearlEarring.position.set(side * 0.415, -0.105, 0.015);
        headGroup.add(pearlEarring);
        if (config.longEarrings) {
          const drop = new THREE.Mesh(new THREE.SphereGeometry(0.022, 14, 10), pearl);
          drop.position.set(side * 0.42, -0.17, 0.015);
          headGroup.add(drop);
        }
      } else if (config.earrings === 'gold') {
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.034, 0.005, 6, 20), gold);
        hoop.position.set(side * 0.415, -0.115, 0.02);
        hoop.rotation.y = Math.PI / 2;
        headGroup.add(hoop);
      }
    }

    /* hats and hair accessories */
    if (config.hat === 'snow') {
      const fur = physical(config.hatColor || 0xf5efe4, { roughness: 0.96, clearcoat: 0.02, sheen: 0.5, sheenColor: new THREE.Color(0xffffff) });
      const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.52, 0.26, 40), fur);
      crown.position.y = 0.43;
      headGroup.add(crown);
      const crownTop = new THREE.Mesh(new THREE.SphereGeometry(0.51, 32, 18), fur);
      crownTop.scale.set(1, 0.5, 1);
      crownTop.position.y = 0.56;
      headGroup.add(crownTop);
      const brim = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.09, 12, 48), fur);
      brim.rotation.x = Math.PI / 2;
      brim.position.y = 0.29;
      headGroup.add(brim);
      const fluffSegments = lowPower ? [8, 6] : [12, 10];
      const fluffCounts = lowPower ? [12, 8, 4] : [26, 18, 8];
      // One instanced draw call instead of ~50 separate shadow-casting
      // spheres — the biggest draw-call saving on the landing page.
      const fluffTotal = fluffCounts[0] + fluffCounts[1] + fluffCounts[2];
      const fluff = new THREE.InstancedMesh(
        new THREE.SphereGeometry(1, fluffSegments[0], fluffSegments[1]),
        fur,
        fluffTotal
      );
      const fluffMatrix = new THREE.Matrix4();
      const fluffQuat = new THREE.Quaternion();
      const fluffPos = new THREE.Vector3();
      const fluffScale = new THREE.Vector3();
      let fluffIndex = 0;
      const placeFluff = (x, y, z, radius) => {
        fluffPos.set(x, y, z);
        fluffScale.setScalar(radius);
        fluffMatrix.compose(fluffPos, fluffQuat, fluffScale);
        fluff.setMatrixAt(fluffIndex++, fluffMatrix);
      };
      for (let i = 0; i < fluffCounts[0]; i++) {
        const angle = (i / fluffCounts[0]) * Math.PI * 2;
        placeFluff(
          Math.cos(angle) * 0.55,
          0.29 + rand(-0.04, 0.04),
          Math.sin(angle) * 0.55,
          rand(0.055, 0.098)
        );
      }
      for (let i = 0; i < fluffCounts[1]; i++) {
        const angle = (i / fluffCounts[1]) * Math.PI * 2;
        placeFluff(
          Math.cos(angle) * rand(0.46, 0.51),
          0.44 + rand(-0.06, 0.11),
          Math.sin(angle) * rand(0.46, 0.51),
          rand(0.05, 0.085)
        );
      }
      for (let i = 0; i < fluffCounts[2]; i++) {
        const angle = (i / fluffCounts[2]) * Math.PI * 2;
        placeFluff(
          Math.cos(angle) * 0.24,
          0.78 + rand(-0.01, 0.02),
          Math.sin(angle) * 0.24,
          rand(0.045, 0.065)
        );
      }
      fluff.instanceMatrix.needsUpdate = true;
      fluff.computeBoundingSphere();
      headGroup.add(fluff);
    } else if (config.hat === 'cat') {
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.27, 4), dress);
        ear.position.set(side * 0.245, 0.565, -0.01);
        ear.rotation.z = side * -0.18;
        ear.rotation.y = side * 0.28;
        headGroup.add(ear);
        const inner = new THREE.Mesh(new THREE.ConeGeometry(0.073, 0.17, 4), physical(0xf5b7c3, { roughness: 0.6 }));
        inner.position.set(side * 0.245, 0.572, 0.034);
        inner.rotation.z = side * -0.18;
        inner.rotation.y = side * 0.28;
        headGroup.add(inner);
      }
      const bow = new THREE.Group();
      for (const side of [-1, 1]) {
        const loop = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), physical(0xef9caf, { roughness: 0.4, clearcoat: 0.6 }));
        loop.scale.set(1.2, 0.7, 0.55);
        loop.position.x = side * 0.065;
        bow.add(loop);
      }
      const knot = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 10), gold);
      bow.add(knot);
      bow.position.set(0.31, 0.31, 0.29);
      bow.rotation.z = -0.25;
      headGroup.add(bow);
    } else {
      const pin = new THREE.Mesh(starGeometry(0.075), gold);
      pin.position.set(0.255, 0.25, 0.265);
      pin.rotation.set(-0.2, 0.4, 0.2);
      headGroup.add(pin);
      const pinPearl = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), pearl);
      pinPearl.position.set(0.318, 0.215, 0.265);
      headGroup.add(pinPearl);
    }

    /* her little cake */
    const miniCake = createMiniCake(config.cake);
    miniCake.group.position.set(0, 2.11, 0.535);
    miniCake.group.scale.setScalar(1.1);
    figure.add(miniCake.group);

    /* name label */
    const labelTexture = makeLabelTexture(config.name, config.subtitle);
    const labelMaterial = new THREE.SpriteMaterial({
      map: labelTexture,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      toneMapped: false
    });
    const label = new THREE.Sprite(labelMaterial);
    label.scale.set(1.0, 0.286, 1);
    label.position.set(0, 0.3, 1.06);
    label.raycast = function () {};
    root.add(label);

    /* selection halo */
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0xffb7c4,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const selectionRing = new THREE.Mesh(new THREE.TorusGeometry(0.74, 0.012, 8, 64), ringMaterial);
    selectionRing.rotation.x = Math.PI / 2;
    selectionRing.position.y = 0.04;
    root.add(selectionRing);
    const halo = glowSprite(0xff93a8, 0.16, 2.6, 2.8);
    halo.position.set(0, 2.05, -0.6);
    root.add(halo);

    /* Invisible picking proxy — a single cheap cylinder instead of a
       recursive raycast through every sculpted part on each pointer move. */
    const hitArea = new THREE.Mesh(
      new THREE.CylinderGeometry(0.8, 0.95, 4.6, 10, 1, true),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    hitArea.position.y = 2.15;
    root.add(hitArea);

    root.position.set(config.x, 0, config.z);
    root.rotation.y = -config.x * 0.105;

    /* Only silhouette-sized parts cast shadows. The face details, jewellery
       and hair wisps used to re-render into the shadow map every frame for
       shadows nobody could see — most of the shadow pass for nothing. */
    figure.traverse(obj => {
      if (!obj.isMesh) return;
      obj.receiveShadow = true;
      const geometry = obj.geometry;
      if (geometry && !geometry.boundingSphere) geometry.computeBoundingSphere();
      obj.castShadow = !!(geometry && geometry.boundingSphere && geometry.boundingSphere.radius >= 0.12);
    });

    return {
      root,
      figure,
      label,
      selectionRing,
      halo,
      hitArea,
      miniCake,
      phase: config.phase,
      baseY: 0,
      selected: false,
      hover: false,
      name: config.name
    };
  }

  /* ————————————————————————————————
     Scene one · the birthday girl
     ———————————————————————————————— */
  const girlConfigs = [
    /* Styled after the reference photo: fluffy cream hat, dark hair, black deep-V top.
       The little cake she holds is intentionally left untouched. */
    {
      name: 'Yana',
      subtitle: 'the birthday girl',
      kicker: 'The birthday girl',
      message: 'For the girl who makes an ordinary evening feel like the best part of my life. Every candle is a wish for you.',
      x: 0,
      z: 0.06,
      skin: 0xf2c6b3,
      skinShade: 0xe4ae9a,
      dress: 0x1b1620,
      dressSheen: 0x9b8f9b,
      tulle: false,
      trim: false,
      silhouette: 'fitted',
      hair: 0x241817,
      hairLight: 0x4d332d,
      hairStyle: 'long',
      hat: 'snow',
      hatColor: 0xf7f1e6,
      earrings: null,
      longEarrings: false,
      lip: 0xc27780,
      eyeColor: 0x3b2922,
      necklace: 'gold',
      bracelets: false,
      vNeck: true,
      beautyMark: false,
      smile: false,
      phase: 2.1,
      cake: { cake: 0xf4b6c5, frosting: 0xffe3eb, candle: 0xef9caf }
    }
  ];

  function setupGirlsScene() {
    const canvas = $('#girls-canvas');
    const stage = $('#girls-stage');
    if (!canvas || !stage) return null;

    const renderer = makeRenderer(canvas, stage);
    const scene = new THREE.Scene();
    scene.environment = createEnvironment(renderer);
    scene.environmentIntensity = 0.84;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 60);
    camera.position.set(0, 2.8, 8.4);

    const hemi = new THREE.HemisphereLight(0xffdfe8, 0x0b0710, 1.35);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffe3cd, 3.2);
    key.position.set(3.5, 6.5, 5.5);
    key.castShadow = !lowPower;
    key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    key.shadow.camera.left = -5;
    key.shadow.camera.right = 5;
    key.shadow.camera.top = 6;
    key.shadow.camera.bottom = -1.5;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 16;
    key.shadow.bias = -0.0015;
    key.shadow.normalBias = 0.02;
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xff7d9f, 2.1);
    rim.position.set(-4, 4.2, -2.5);
    scene.add(rim);

    const cool = new THREE.DirectionalLight(0x8eb4ff, 1.15);
    cool.position.set(4.5, 3.2, -3);
    if (!lowPower) scene.add(cool);

    const warmFill = new THREE.PointLight(0xffc39f, 18, 9, 2);
    warmFill.position.set(0.5, 2.5, 3.8);
    scene.add(warmFill);

    // Optional lights: they are the first thing dropped when the scene is
    // already struggling, since every light widens the per-fragment loop.
    scene.userData.perfLights = lowPower ? [] : [cool, warmFill];

    /* floor and celestial architecture */
    const floorMaterial = physical(0x0f0915, {
      roughness: 0.2,
      metalness: 0.72,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      envMapIntensity: 0.72,
      transparent: true,
      opacity: 0.86
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(6, 80), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.39;
    floor.receiveShadow = true;
    scene.add(floor);

    const floorGlow = glowSprite(0xed8fa8, 0.2, 8.5, 6.5);
    floorGlow.position.set(0, -0.36, 0.1);
    floorGlow.material.depthTest = false;
    scene.add(floorGlow);

    const floorRingMat = new THREE.MeshBasicMaterial({
      color: 0xd8aa83,
      transparent: true,
      opacity: 0.18,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const floorRing = new THREE.Mesh(new THREE.TorusGeometry(1.52, 0.006, 6, 100), floorRingMat);
    floorRing.rotation.x = Math.PI / 2;
    floorRing.position.y = -0.385;
    scene.add(floorRing);

    const floorRing2 = new THREE.Mesh(new THREE.TorusGeometry(2.35, 0.005, 6, 120), floorRingMat.clone());
    floorRing2.material.opacity = 0.09;
    floorRing2.rotation.x = Math.PI / 2;
    floorRing2.position.y = -0.386;
    scene.add(floorRing2);

    const archMaterial = new THREE.MeshBasicMaterial({
      color: 0xe4c08a,
      transparent: true,
      opacity: 0.16,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const arch = new THREE.Mesh(new THREE.TorusGeometry(1.86, 0.009, 8, 120), archMaterial);
    arch.position.set(0, 2.4, -1.9);
    scene.add(arch);
    const arch2 = new THREE.Mesh(new THREE.TorusGeometry(1.72, 0.005, 8, 120), archMaterial.clone());
    arch2.material.opacity = 0.08;
    arch2.position.set(0, 2.4, -1.92);
    scene.add(arch2);

    const stars = addStarField(scene, lowPower ? 170 : 320, 5.5, 9, [-6, 1.4]);
    stars.material.opacity = 0.62;

    const balloons = [
      addBalloon(scene, -1.46, 3.6, -1.02, 0xd37d95, 0.82, 0.2),
      addBalloon(scene, -1.68, 4.2, -1.55, 0xe4c08a, 0.56, 1.2),
      addBalloon(scene, -1.55, 2.72, -0.26, 0xf1d9c5, 0.46, 2.2),
      addBalloon(scene, 1.52, 3.4, -0.98, 0xb28ac1, 0.74, 3.4),
      addBalloon(scene, 1.73, 4.18, -1.5, 0xefb4c0, 0.56, 4.3),
      addBalloon(scene, 1.57, 2.64, -0.22, 0xd18c9f, 0.44, 5.1)
    ];

    const gifts = [
      addGift(scene, -1.12, 0.64, 0.32, 0x5b2b41, 0xd9b477, -0.2),
      addGift(scene, 1.13, 0.5, 0.27, 0x6a2f45, 0xe4c08a, 0.32),
      addGift(scene, 0.87, 0.96, 0.18, 0x3b213f, 0xef9caf, -0.4)
    ];
    gifts.forEach((gift, index) => { gift.group.userData.giftIndex = index; });

    const petals = addPetals(scene, [
      gifts[1].position.x,
      gifts[1].position.y + 0.55,
      gifts[1].position.z
    ]);

    const girls = girlConfigs.map((config, index) => {
      const girl = createGirl(config, index);
      girl.root.userData.girlIndex = index;
      girl.hitArea.userData.girlIndex = index;
      scene.add(girl.root);
      return girl;
    });
    // Picking reads only these cheap proxy cylinders instead of the whole
    // sculpted figure, which used to cost hundreds of triangle tests per event.
    const hitAreas = girls.map(girl => girl.hitArea);

    // Her cake begins unlit on the landing page: the third gift lights it.
    girls.forEach(girl => {
      girl.miniCake.flameGroup.visible = false;
      girl.miniCake.flameGroup.scale.setScalar(0.001);
      girl.miniCake.flameLight.intensity = 0;
    });

    // The little setup ritual before the surprise page: gift 1 releases the
    // balloons, gift 2 lets the petals fly, gift 3 lights her candle.
    const gate = {
      step: 0,
      progress: [0, 0, 0],
      target: [0, 0, 0],
      lid: [0, 0, 0]
    };

    /* interaction state */
    const state = {
      selected: -1,
      hovered: -1,
      dragging: false,
      pointerDown: false,
      lastX: 0,
      lastY: 0,
      moved: 0,
      targetAz: 0,
      az: 0,
      targetEl: 0,
      el: 0,
      dist: 9.25,
      targetDist: 9.25,
      visible: true,
      onSelect: null,
      onGiftScreen: null
    };
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function setPointerFromEvent(event) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }

    function pickGirl() {
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(hitAreas, false);
      return intersects.length ? intersects[0].object.userData.girlIndex : -1;
    }

    function applySelectionUI() {
      girls.forEach((girl, index) => {
        girl.selected = index === state.selected;
        girl.label.material.opacity = state.selected === -1 || girl.selected ? 1 : 0.42;
      });
    }

    function select(index) {
      if (index < 0 || index >= girls.length) return;
      state.selected = index;
      state.hovered = -1;
      applySelectionUI();
      Sound.chime(660 + index * 120, 0.05);
      if (typeof state.onSelect === 'function') state.onSelect(index, girlConfigs[index]);
    }

    function clearSelection() {
      state.selected = -1;
      applySelectionUI();
      if (typeof state.onSelect === 'function') state.onSelect(-1, null);
    }

    function openGift(index) {
      if (index !== gate.step || index < 0 || index >= gifts.length) return false;
      gate.step = index + 1;
      gate.target[index] = 1;
      gifts[index].opened = true;
      return true;
    }

    // Used by the "skip the setup" safety net: everything comes alive at once.
    function completeGifts() {
      gate.step = gifts.length;
      gifts.forEach((gift, index) => {
        gift.opened = true;
        gate.target[index] = 1;
      });
    }

    // Hover picking is throttled: pointermove can fire faster than the scene
    // renders, and each pick has to be transformed through the camera.
    let hoverTimer = 0;
    let lastHoverAt = 0;
    function cancelHoverTimer() {
      if (!hoverTimer) return;
      window.clearTimeout(hoverTimer);
      hoverTimer = 0;
    }
    function updateHover() {
      if (state.pointerDown) return;
      const now = performance.now();
      const wait = 70 - (now - lastHoverAt);
      if (wait > 0) {
        if (!hoverTimer) {
          hoverTimer = window.setTimeout(() => {
            hoverTimer = 0;
            updateHover();
          }, wait);
        }
        return;
      }
      lastHoverAt = now;
      const hit = pickGirl();
      if (hit !== state.hovered) {
        state.hovered = hit;
        girls.forEach((girl, index) => { girl.hover = index === hit; });
        canvas.classList.toggle('is-hovering', hit !== -1);
      }
    }

    canvas.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      cancelHoverTimer();
      state.pointerDown = true;
      state.dragging = false;
      state.moved = 0;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      canvas.classList.add('is-grabbing');
      try { canvas.setPointerCapture(event.pointerId); } catch (e) {}
    });

    canvas.addEventListener('pointermove', event => {
      if (!state.pointerDown) {
        setPointerFromEvent(event);
        updateHover();
        return;
      }
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      state.moved += Math.abs(dx) + Math.abs(dy);
      if (state.moved > 4) state.dragging = true;
      if (Math.abs(dx) > Math.abs(dy) * 0.65) {
        state.targetAz = clamp(state.targetAz + dx * 0.0042, -0.62, 0.62);
      }
      state.targetEl = clamp(state.targetEl - dy * 0.0024, -0.1, 0.12);
    });

    function endPointer(event) {
      if (!state.pointerDown) return;
      state.pointerDown = false;
      canvas.classList.remove('is-grabbing');
      if (state.moved < 7) {
        setPointerFromEvent(event);
        const hit = pickGirl();
        if (hit !== -1) select(hit);
        else if (girls.length === 1) select(0);
      }
      state.dragging = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch (e) {}
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', () => {
      cancelHoverTimer();
      if (!state.pointerDown) {
        state.hovered = -1;
        girls.forEach(girl => { girl.hover = false; });
        canvas.classList.remove('is-hovering');
      }
    });

    function resize() {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height) return;
      renderer.setPixelRatio(qualityRatio(width, height));
      resizeRenderer(renderer, camera, width, height);
      updateCamera(0, true);
    }

    function updateCamera(t, snap) {
      const aspect = Math.max(0.45, camera.aspect || 1);
      const targetDist = aspect < 0.6 ? 10.3 : 9.25;
      state.targetDist = targetDist;
      if (snap) state.dist = targetDist;
      const az = state.az + (reduceMotion || state.dragging ? 0 : Math.sin(t * 0.12) * 0.025);
      const y = 2.62 + state.el * 3.1;
      const xShift = aspect > 0.68 && aspect < 1.18 ? -0.85 : 0;
      camera.position.set(xShift + Math.sin(az) * state.dist, y, Math.cos(az) * state.dist);
      camera.lookAt(xShift * 0.72, 1.95 + state.el * 0.9, 0);
    }

    function update(t, dt) {
      state.az = damp(state.az, state.targetAz, 3.2, dt);
      state.el = damp(state.el, state.targetEl, 3.4, dt);
      state.dist = damp(state.dist, state.targetDist, 3.2, dt);
      updateCamera(t, false);

      // Gift reveal ramps. Everything is driven by one 0→1 value per gift so
      // the setup ritual stays in sync with the guide UI.
      gate.progress.forEach((value, index) => {
        gate.progress[index] = damp(value, gate.target[index], 2.2, dt);
      });

      const balloonEase = gate.progress[0] * gate.progress[0] * (3 - 2 * gate.progress[0]);
      const petalEase = gate.progress[1] * gate.progress[1] * (3 - 2 * gate.progress[1]);
      const candleEase = gate.progress[2] * gate.progress[2] * (3 - 2 * gate.progress[2]);

      gifts.forEach((gift, index) => {
        gate.lid[index] = damp(gate.lid[index], gate.target[index], 3, dt);
        const lidEase = gate.lid[index] * gate.lid[index] * (3 - 2 * gate.lid[index]);
        gift.lid.position.y = gift.lidBaseY + lidEase * gift.size * 1.35;
        gift.lid.rotation.z = lidEase * 0.85;
        gift.lid.rotation.x = lidEase * -0.25;

        let glowTarget = 0;
        if (gift.opened) {
          glowTarget = Math.max(0, 0.5 * (1 - lidEase));
        } else if (index === gate.step) {
          glowTarget = 0.17 + Math.sin(t * 2.4) * 0.06;
        }
        gift.glow.material.opacity = damp(gift.glow.material.opacity, glowTarget, 4, dt);
      });

      girls.forEach((girl, index) => {
        const phase = girl.phase;
        const bob = reduceMotion ? 0 : Math.sin(t * 0.9 + phase) * 0.018;
        girl.figure.position.y = bob;
        girl.figure.rotation.z = reduceMotion ? 0 : Math.sin(t * 0.52 + phase) * 0.006;
        girl.figure.rotation.y = reduceMotion ? 0 : Math.sin(t * 0.32 + phase) * 0.012;

        const targetScale = girl.selected ? 1.035 : girl.hover ? 1.014 : 1;
        const nextScale = damp(girl.root.scale.x, targetScale, 7, dt);
        girl.root.scale.setScalar(nextScale);

        const ringTarget = girl.selected ? 0.95 : 0;
        girl.selectionRing.material.opacity = damp(girl.selectionRing.material.opacity, ringTarget, 7, dt);
        girl.selectionRing.rotation.z += dt * (girl.selected ? 0.35 : 0.1);

        const haloBase = girl.selected ? 0.29 : girl.hover ? 0.22 : 0.15;
        girl.halo.material.opacity = damp(girl.halo.material.opacity, haloBase, 4, dt);

        const cakeBob = reduceMotion ? 0 : Math.sin(t * 1.25 + phase + 0.4) * 0.011;
        girl.miniCake.group.position.y = 2.11 + cakeBob;

        const flicker = 0.9 + Math.sin(t * 13 + phase * 8) * 0.09 + Math.sin(t * 21 + phase * 3) * 0.05;
        const flame = girl.miniCake.flameGroup;
        flame.visible = candleEase > 0.015;
        const candleScale = 0.45 + candleEase * 0.55;
        flame.scale.set(
          flicker * candleScale,
          (0.9 + flicker * 0.12) * candleScale,
          flicker * candleScale
        );
        girl.miniCake.flameLight.intensity = (1.4 + flicker * 0.35) * candleEase;
      });

      balloons.forEach(balloon => {
        const bob = reduceMotion ? 0 : Math.sin(t * 0.55 + balloon.userData.phase) * 0.08;
        balloon.position.y = balloon.userData.baseY - (1 - balloonEase) * 2.1 + bob;
        balloon.position.x = balloon.userData.baseX + (reduceMotion ? 0 : Math.sin(t * 0.3 + balloon.userData.phase) * 0.02);
        balloon.scale.setScalar(balloon.userData.baseScale * (0.62 + 0.38 * balloonEase));
        balloon.userData.material.opacity = 0.22 + 0.78 * balloonEase;
        if (reduceMotion) return;
        balloon.rotation.z = Math.sin(t * 0.35 + balloon.userData.phase) * 0.04;
        balloon.rotation.x = Math.cos(t * 0.28 + balloon.userData.phase) * 0.025;
      });

      petals.forEach(petal => {
        const target = petal.userData.target;
        const origin = petal.userData.origin;
        petal.position.lerpVectors(origin, target, petalEase);
        petal.scale.setScalar(0.001 + petalEase * 0.999);
        if (reduceMotion) return;
        petal.position.y += Math.sin(t * 0.7 + petal.userData.phase) * 0.12 * petalEase;
        petal.rotation.y += dt * 0.22 * petalEase;
        petal.rotation.z = Math.sin(t * 0.5 + petal.userData.phase) * 0.18 * petalEase;
      });

      stars.rotation.y = t * 0.004;
      arch.rotation.z = t * 0.012;
      arch2.rotation.z = -t * 0.009;
      floorRing.rotation.z = t * 0.012;
      floorRing2.rotation.z = -t * 0.008;

      if (typeof state.onGiftScreen === 'function') {
        const projected = new THREE.Vector3();
        state.onGiftScreen(gifts.map(gift => {
          projected.set(
            gift.position.x,
            gift.position.y + gift.size * 1.05,
            gift.position.z
          );
          projected.project(camera);
          return {
            x: projected.x * 0.5 + 0.5,
            y: -projected.y * 0.5 + 0.5,
            behind: projected.z > 1
          };
        }));
      }
    }

    let shadowFrame = 0;
    function render() {
      // The shadow map only depends on the lights and casters, never on the
      // camera, so refreshing it every third frame costs a third of the pass
      // and is invisible at this animation speed.
      if (renderer.shadowMap.enabled && shadowFrame++ % 3 === 0) {
        renderer.shadowMap.needsUpdate = true;
      }
      renderer.render(scene, camera);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    window.addEventListener('resize', resize);
    resize();

    const visibilityObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => { state.visible = entry.isIntersecting; });
    }, { rootMargin: '180px 0px' });
    visibilityObserver.observe(stage);

    applySelectionUI();
    updateCamera(0, true);
    render();
    update(0, 0.016);

    return {
      scene,
      camera,
      renderer,
      girls,
      gifts,
      gate,
      state,
      select,
      clear: clearSelection,
      openGift,
      completeGifts,
      update,
      render,
      resize,
      isVisible: () => state.visible
    };
  }

  /* ————————————————————————————————
     Scene two · the wish cake
     ———————————————————————————————— */
  function makeCakeTopperTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 260;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 640, 260);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255,194,178,0.8)';
    ctx.shadowBlur = 32;
    const gradient = ctx.createLinearGradient(160, 0, 500, 0);
    gradient.addColorStop(0, '#f5d8a8');
    gradient.addColorStop(0.5, '#fff3dd');
    gradient.addColorStop(1, '#e9b9a7');
    ctx.fillStyle = gradient;
    ctx.font = '400 148px "Great Vibes", cursive';
    ctx.fillText('Yana', 320, 118);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,240,222,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(220, 198);
    ctx.bezierCurveTo(270, 212, 370, 212, 420, 198);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,233,214,0.7)';
    ctx.font = '500 17px "Manrope", sans-serif';
    ctx.fillText('MAKE A WISH', 320, 226);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  }

  function setupCakeScene() {
    const canvas = $('#cake-canvas');
    const stage = $('#wish-stage');
    if (!canvas || !stage) return null;

    const renderer = makeRenderer(canvas, stage);
    const scene = new THREE.Scene();
    scene.environment = createEnvironment(renderer);
    scene.environmentIntensity = 0.86;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    camera.position.set(0, 2.85, 7.6);

    const hemi = new THREE.HemisphereLight(0xffd8de, 0x09050c, 1.2);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffe0c4, 3.4);
    key.position.set(3.8, 6.5, 4.5);
    key.castShadow = !lowPower;
    key.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 5;
    key.shadow.camera.bottom = -2;
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 16;
    key.shadow.bias = -0.0018;
    key.shadow.normalBias = 0.02;
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xff7596, 2.2);
    rim.position.set(-4, 3.3, -3);
    scene.add(rim);

    const blue = new THREE.DirectionalLight(0x86abff, 1.25);
    blue.position.set(4, 2.4, -3);
    if (!lowPower) scene.add(blue);

    const fill = new THREE.PointLight(0xffb58d, 16, 8, 2);
    fill.position.set(0.4, 2.3, 4.2);
    scene.add(fill);

    /* table */
    const tableMaterial = physical(0x211220, {
      roughness: 0.17,
      metalness: 0.62,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.9
    });
    const table = new THREE.Mesh(new THREE.CylinderGeometry(2.62, 2.78, 0.24, 72), tableMaterial);
    table.position.y = -0.16;
    table.receiveShadow = true;
    scene.add(table);

    const tableRim = new THREE.Mesh(
      new THREE.TorusGeometry(2.61, 0.012, 8, 100),
      physical(0xd9b477, { metalness: 0.85, roughness: 0.24, clearcoat: 1 })
    );
    tableRim.rotation.x = Math.PI / 2;
    tableRim.position.y = -0.042;
    scene.add(tableRim);

    const tableGlow = glowSprite(0xe59a9d, 0.17, 5.2, 5.2);
    tableGlow.position.set(0, 0.01, 0);
    tableGlow.material.depthTest = false;
    scene.add(tableGlow);

    addShadowPlane(scene, 0, 0.12, 3.2, 0.52).position.y = 0.008;

    const stars = addStarField(scene, lowPower ? 110 : 210, 6.5, 8, [-6, 0]);
    stars.material.opacity = 0.5;
    stars.position.y = -0.1;

    const balloons = [
      addBalloon(scene, -2.55, 2.55, -1.45, 0xd17c96, 0.82, 0.8),
      addBalloon(scene, -2.15, 3.28, -2.0, 0xe4c08a, 0.6, 2.3),
      addBalloon(scene, 2.55, 2.35, -1.25, 0xb28ac1, 0.75, 3.7),
      addBalloon(scene, 2.15, 3.15, -1.85, 0xefb4c0, 0.6, 5.1)
    ];

    /* cake */
    const cakeRoot = new THREE.Group();
    cakeRoot.position.y = 0.03;
    scene.add(cakeRoot);

    const gold = physical(0xd9b477, { metalness: 0.9, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.1 });
    const ivory = physical(0xf6e6d3, { roughness: 0.55, clearcoat: 0.32, sheen: 0.5, sheenColor: new THREE.Color(0xffe4d9) });
    const blush = physical(0xf1c1c5, { roughness: 0.56, clearcoat: 0.35, sheen: 0.55, sheenColor: new THREE.Color(0xffd5d4) });
    const dustyRose = physical(0xd8959f, { roughness: 0.52, clearcoat: 0.4 });
    const cream = physical(0xfff5e8, { roughness: 0.48, clearcoat: 0.45 });
    const candleColors = [0xefacb8, 0xf2ddbf, 0xf8eadd, 0xd58c9d, 0xe8c995];

    const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.52, 1.58, 0.055, 72), gold);
    plate.position.y = 0.06;
    plate.receiveShadow = true;
    cakeRoot.add(plate);

    const plateUnder = new THREE.Mesh(new THREE.CylinderGeometry(1.62, 1.67, 0.035, 72), physical(0xb78b5e, { metalness: 0.8, roughness: 0.3 }));
    plateUnder.position.y = 0.025;
    cakeRoot.add(plateUnder);

    function addTier(radiusTop, radiusBottom, height, y, material, frostingColor) {
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, 72), material);
      tier.position.y = y;
      tier.castShadow = true;
      tier.receiveShadow = true;
      cakeRoot.add(tier);
      const frostingMaterial = physical(frostingColor, {
        roughness: 0.45,
        clearcoat: 0.58,
        clearcoatRoughness: 0.25,
        sheen: 0.6,
        sheenColor: new THREE.Color(0xfff3eb)
      });
      const top = new THREE.Mesh(new THREE.CylinderGeometry(radiusTop + 0.035, radiusTop + 0.01, 0.07, 72), frostingMaterial);
      top.position.y = y + height / 2 + 0.018;
      top.castShadow = true;
      top.receiveShadow = true;
      cakeRoot.add(top);
      return { tier, frostingMaterial, topY: top.position.y + 0.035, radius: radiusTop };
    }

    const bottomTier = addTier(1.08, 1.14, 0.58, 0.36, ivory, 0xf1b8c1);
    const middleTier = addTier(0.85, 0.92, 0.48, 0.93, blush, 0xfff0e4);
    const topTier = addTier(0.61, 0.67, 0.4, 1.43, ivory, 0xe9a4b0);

    function addDrips(radius, y, count, color, length) {
      const material = physical(color, { roughness: 0.4, clearcoat: 0.65 });
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + 0.12;
        const dripLength = length * (0.65 + ((i * 7) % 5) / 5 * 0.7);
        const drip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 10), material);
        drip.scale.set(0.72, dripLength / 0.055, 0.72);
        drip.position.set(
          Math.cos(angle) * (radius + 0.016),
          y - dripLength * 0.48,
          Math.sin(angle) * (radius + 0.016)
        );
        drip.castShadow = true;
        cakeRoot.add(drip);
      }
    }

    addDrips(1.1, bottomTier.topY - 0.03, 26, 0xf1b8c1, 0.16);
    addDrips(0.87, middleTier.topY - 0.03, 21, 0xfff0e4, 0.13);
    addDrips(0.615, topTier.topY - 0.03, 16, 0xe9a4b0, 0.1);

    /* piped pearls */
    for (let i = 0; i < 30; i++) {
      const angle = (i / 30) * Math.PI * 2;
      const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.039, 12, 10), cream);
      pearl.position.set(Math.cos(angle) * 1.095, 0.06 + 0.58 + 0.07, Math.sin(angle) * 1.095);
      cakeRoot.add(pearl);
    }
    for (let i = 0; i < 22; i++) {
      const angle = (i / 22) * Math.PI * 2 + 0.1;
      const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), cream);
      pearl.position.set(Math.cos(angle) * 0.88, 0.93 + 0.24 + 0.07, Math.sin(angle) * 0.88);
      cakeRoot.add(pearl);
    }

    /* little heart decorations */
    const heartAccentMat = physical(0xe5a4b2, { roughness: 0.35, clearcoat: 0.8, emissive: 0x451723, emissiveIntensity: 0.12 });
    for (let i = 0; i < 3; i++) {
      const heart = new THREE.Mesh(heartGeometry(0.085), heartAccentMat);
      const angle = i * (Math.PI * 2 / 3) + 0.3;
      heart.position.set(Math.cos(angle) * 1.087, 0.33 + (i % 2) * 0.08, Math.sin(angle) * 1.087);
      heart.rotation.y = -angle + Math.PI / 2;
      heart.rotation.z = (i - 1) * 0.12;
      cakeRoot.add(heart);
    }

    /* sprinkles */
    const sprinkleColors = [0xe29aa9, 0xe4c08a, 0xfff4e8, 0xb77b94];
    for (let i = 0; i < 44; i++) {
      const onTop = i < 26;
      const radius = onTop ? rand(0.08, 0.54) : rand(0.72, 0.83);
      const angle = rand(0, Math.PI * 2);
      const sprinkle = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.012, 0.052, 3, 6),
        physical(sprinkleColors[i % sprinkleColors.length], { roughness: 0.4, clearcoat: 0.4 })
      );
      sprinkle.position.set(
        Math.cos(angle) * radius,
        onTop ? topTier.topY + 0.02 : middleTier.topY + 0.012,
        Math.sin(angle) * radius
      );
      sprinkle.rotation.set(rand(-1.2, 1.2), rand(0, 6.28), rand(-1.2, 1.2));
      cakeRoot.add(sprinkle);
    }

    /* candles */
    const candles = [];
    const candleHitMeshes = [];
    const flameOuterMat = new THREE.MeshBasicMaterial({
      color: 0xffb35f,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const flameInnerMat = new THREE.MeshBasicMaterial({
      color: 0xfff6cf,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const wickMat = standard(0x211512, { roughness: 0.8 });

    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2 + 0.25;
      const radius = 0.37;
      const group = new THREE.Group();
      group.position.set(Math.cos(angle) * radius, topTier.topY + 0.03, Math.sin(angle) * radius);

      const candleMaterial = physical(candleColors[i], {
        roughness: 0.35,
        clearcoat: 0.7,
        clearcoatRoughness: 0.2
      });
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.047, 0.05, 0.5, 18), candleMaterial);
      body.position.y = 0.25;
      body.castShadow = true;
      group.add(body);

      const stripeMat = physical(0xfff3e5, { roughness: 0.4, clearcoat: 0.6 });
      for (let s = 0; s < 3; s++) {
        const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.049, 0.049, 0.022, 18), stripeMat);
        stripe.position.y = 0.13 + s * 0.12;
        group.add(stripe);
      }

      const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.07, 6), wickMat);
      wick.position.y = 0.535;
      group.add(wick);

      const flameGroup = new THREE.Group();
      flameGroup.position.y = 0.58;
      const outer = new THREE.Mesh(new THREE.SphereGeometry(0.062, 14, 12), flameOuterMat);
      outer.scale.set(1, 1.9, 1);
      flameGroup.add(outer);
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.034, 12, 10), flameInnerMat);
      inner.scale.set(1, 1.8, 1);
      inner.position.y = -0.01;
      flameGroup.add(inner);
      const glow = glowSprite(0xffa25a, 0.6, 0.58, 0.58);
      flameGroup.add(glow);
      const light = new THREE.PointLight(0xffa05b, 2.5, 3, 2);
      light.position.y = 0.03;
      // Five extra point lights are costly on phones; the emissive flames still
      // read as five candles while three shared glows keep the cake warm.
      if (!lowPower || i < 3) flameGroup.add(light);
      group.add(flameGroup);

      cakeRoot.add(group);

      [body, outer, inner].forEach(mesh => {
        mesh.userData.candleIndex = i;
        candleHitMeshes.push(mesh);
      });
      body.userData.candleIndex = i;

      const sparkle = glowSprite(0xffe5b8, 0.2, 0.13, 0.13);
      sparkle.position.set(rand(-0.12, 0.12), 0.17, rand(-0.12, 0.12));
      group.add(sparkle);

      candles.push({
        group,
        flameGroup,
        light,
        outer,
        inner,
        out: false,
        phase: rand(0, 6.28)
      });
    }

    /* floating cake topper */
    const topperTexture = makeCakeTopperTexture();
    const topper = new THREE.Sprite(new THREE.SpriteMaterial({
      map: topperTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    }));
    topper.scale.set(1.64, 0.66, 1);
    topper.position.set(0, 2.88, 0.02);
    cakeRoot.add(topper);
    const topperGlow = glowSprite(0xffb5a1, 0.18, 2.4, 1.4);
    topperGlow.position.set(0, 2.84, -0.08);
    cakeRoot.add(topperGlow);

    /* celebration hearts */
    const heartsGroup = new THREE.Group();
    heartsGroup.visible = false;
    scene.add(heartsGroup);
    const celebrationHearts = [];
    const heartMaterials = [
      physical(0xef9caf, { roughness: 0.25, emissive: 0x5f1c2f, emissiveIntensity: 0.3, clearcoat: 1 }),
      physical(0xe4c08a, { roughness: 0.22, metalness: 0.4, emissive: 0x4a3211, emissiveIntensity: 0.25, clearcoat: 1 }),
      physical(0xffd7c2, { roughness: 0.28, emissive: 0x5a2b24, emissiveIntensity: 0.16, clearcoat: 1 })
    ];
    for (let i = 0; i < 15; i++) {
      const heart = new THREE.Mesh(heartGeometry(rand(0.07, 0.14)), heartMaterials[i % heartMaterials.length]);
      const angle = rand(0, Math.PI * 2);
      heart.position.set(Math.cos(angle) * rand(0.4, 2.1), rand(0.8, 2.4), Math.sin(angle) * rand(0.4, 1.7));
      heart.userData = { angle, radius: rand(0.4, 2.1), speed: rand(0.15, 0.38), phase: rand(0, 6.28), baseY: heart.position.y };
      heart.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      heartsGroup.add(heart);
      celebrationHearts.push(heart);
    }

    /* state + interaction */
    const state = {
      lit: 5,
      total: 5,
      allOut: false,
      visible: true,
      hovered: -1,
      dragging: false,
      pointerDown: false,
      moved: 0,
      lastX: 0,
      pointerNX: 0,
      pointerNY: 0,
      targetSpin: 0,
      spin: 0,
      targetDist: 7.8,
      dist: 7.8,
      onCandleChange: null,
      onComplete: null
    };
    const smoke = [];
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    function makeSmoke(position) {
      for (let i = 0; i < 4; i++) {
        const sprite = glowSprite(0xb9a7ad, 0.2, 0.22, 0.22);
        sprite.material.blending = THREE.NormalBlending;
        sprite.position.copy(position);
        sprite.position.x += rand(-0.03, 0.03);
        sprite.position.y += rand(-0.02, 0.04);
        sprite.position.z += rand(-0.03, 0.03);
        scene.add(sprite);
        smoke.push({ sprite, age: 0, drift: rand(-1, 1), speed: rand(0.16, 0.3) });
      }
    }

    function notifyCandleChange() {
      if (typeof state.onCandleChange === 'function') state.onCandleChange(state.lit, state.total);
    }

    function extinguishCandle(index) {
      const candle = candles[index];
      if (!candle || candle.out) return;
      candle.out = true;
      candle.flameGroup.visible = false;
      candle.light.intensity = 0;
      state.lit = Math.max(0, state.lit - 1);
      const worldPosition = new THREE.Vector3();
      candle.group.getWorldPosition(worldPosition);
      worldPosition.y += 0.6;
      makeSmoke(worldPosition);
      const pan = ((index / Math.max(1, state.total - 1)) - 0.5) * 0.6;
      Sound.blow(pan);
      notifyCandleChange();
      if (state.lit === 0 && !state.allOut) {
        state.allOut = true;
        window.setTimeout(() => {
          heartsGroup.visible = true;
          celebrationHearts.forEach(h => { h.visible = true; });
          if (app.confetti) {
            app.confetti.burst(190, true);
            window.setTimeout(() => app.confetti.burst(90, false), 800);
          }
          Sound.celebration();
          if (typeof state.onComplete === 'function') state.onComplete();
        }, 550);
      }
    }

    function blowAll() {
      if (state.allOut) return;
      let delay = 0;
      candles.forEach((candle, index) => {
        if (candle.out) return;
        window.setTimeout(() => extinguishCandle(index), delay);
        delay += 260;
      });
    }

    function relight() {
      state.lit = state.total;
      state.allOut = false;
      heartsGroup.visible = false;
      candles.forEach(candle => {
        candle.out = false;
        candle.flameGroup.visible = true;
        candle.light.intensity = 2.5;
      });
      notifyCandleChange();
    }

    function pickCandle() {
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(candleHitMeshes, false);
      for (let i = 0; i < hits.length; i++) {
        const idx = hits[i].object.userData.candleIndex;
        if (idx !== undefined && !candles[idx].out) return idx;
      }
      return -1;
    }

    function setPointerFromEvent(event) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      state.pointerNX = pointer.x;
      state.pointerNY = pointer.y;
    }

    canvas.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      state.pointerDown = true;
      state.dragging = false;
      state.moved = 0;
      state.lastX = event.clientX;
      canvas.classList.add('is-grabbing');
      try { canvas.setPointerCapture(event.pointerId); } catch (e) {}
    });

    canvas.addEventListener('pointermove', event => {
      setPointerFromEvent(event);
      if (state.pointerDown) {
        const dx = event.clientX - state.lastX;
        state.lastX = event.clientX;
        state.moved += Math.abs(dx);
        if (state.moved > 4) state.dragging = true;
        state.targetSpin += dx * 0.0065;
        return;
      }
      const hit = pickCandle();
      if (hit !== state.hovered) {
        state.hovered = hit;
        canvas.classList.toggle('is-hovering', hit !== -1);
      }
    });

    function endPointer(event) {
      if (!state.pointerDown) return;
      state.pointerDown = false;
      canvas.classList.remove('is-grabbing');
      if (state.moved < 6) {
        setPointerFromEvent(event);
        const hit = pickCandle();
        if (hit !== -1) extinguishCandle(hit);
      }
      state.dragging = false;
      try { canvas.releasePointerCapture(event.pointerId); } catch (e) {}
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('pointerleave', () => {
      if (!state.pointerDown) {
        state.hovered = -1;
        canvas.classList.remove('is-hovering');
        state.pointerNX = 0;
        state.pointerNY = 0;
      }
    });

    function resize() {
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      if (!width || !height) return;
      renderer.setPixelRatio(qualityRatio(width, height));
      resizeRenderer(renderer, camera, width, height);
      updateCamera(0, true);
    }

    function updateCamera(t, snap) {
      const aspect = Math.max(0.45, camera.aspect || 1);
      const baseHeight = aspect > 1.7 ? 4.9 : 5.3;
      const desiredHeight = Math.max(baseHeight, 3.9 / aspect);
      const targetDist = Math.max(6.8, desiredHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))));
      state.targetDist = targetDist;
      if (snap) state.dist = targetDist;
      const sway = reduceMotion ? 0 : Math.sin(t * 0.13) * 0.14;

      const visibleWidth = desiredHeight * aspect;
      let xShift = 0;
      if (aspect >= 1.2) {
        const cakeHalfWidth = 1.72;
        const centerFraction = 0.5 + cakeHalfWidth / visibleWidth;
        xShift = -(centerFraction - 0.5) * visibleWidth;
      }

      const lookY = aspect < 0.7 ? 0.55 : aspect < 1.2 ? 1.15 : 1.5;
      camera.position.x = xShift + state.pointerNX * 0.36 + sway;
      camera.position.y = lookY + 1.45 - state.pointerNY * 0.22;
      camera.position.z = state.dist;
      camera.lookAt(xShift, lookY, 0);
    }

    function update(t, dt) {
      if (!state.dragging && state.hovered === -1 && !reduceMotion) {
        state.targetSpin += dt * 0.055;
      }
      state.spin = damp(state.spin, state.targetSpin, 4.5, dt);
      cakeRoot.rotation.y = state.spin;
      state.dist = damp(state.dist, state.targetDist, 3, dt);
      updateCamera(t, false);

      candles.forEach((candle, index) => {
        if (candle.out) return;
        const flicker = 0.84 + Math.sin(t * 12.5 + candle.phase) * 0.1 + Math.sin(t * 21.7 + candle.phase * 2.4) * 0.06;
        const horizontal = Math.sin(t * 7 + candle.phase) * 0.08;
        candle.outer.scale.set(0.9 + horizontal, 1.8 + flicker * 0.15, 0.9 + horizontal);
        candle.inner.scale.set(1, 1.7 + flicker * 0.2, 1);
        candle.light.intensity = 2.2 + flicker * 0.6;
      });

      const topperBob = reduceMotion ? 0 : Math.sin(t * 1.2) * 0.03;
      topper.position.y = 2.88 + topperBob;
      topper.material.rotation = reduceMotion ? 0 : Math.sin(t * 0.8) * 0.012;

      balloons.forEach(balloon => {
        if (reduceMotion) return;
        balloon.position.y = balloon.userData.baseY + Math.sin(t * 0.5 + balloon.userData.phase) * 0.075;
        balloon.rotation.z = Math.sin(t * 0.32 + balloon.userData.phase) * 0.035;
      });

      stars.rotation.y = t * 0.006;

      for (let i = smoke.length - 1; i >= 0; i--) {
        const puff = smoke[i];
        puff.age += dt;
        puff.sprite.position.y += dt * puff.speed;
        puff.sprite.position.x += Math.sin(puff.age * 2 + puff.drift) * dt * 0.06;
        puff.sprite.scale.setScalar(0.22 + puff.age * 0.22);
        puff.sprite.material.opacity = clamp(0.22 * (1 - puff.age / 1.7), 0, 0.22);
        if (puff.age > 1.7) {
          scene.remove(puff.sprite);
          puff.sprite.material.dispose();
          smoke.splice(i, 1);
        }
      }

      if (heartsGroup.visible) {
        celebrationHearts.forEach(heart => {
          if (reduceMotion) return;
          heart.userData.phase += dt * heart.userData.speed;
          const angle = heart.userData.angle + heart.userData.phase;
          heart.position.x = Math.cos(angle) * heart.userData.radius;
          heart.position.z = Math.sin(angle) * heart.userData.radius;
          heart.position.y = heart.userData.baseY + Math.sin(t * 0.8 + heart.userData.phase) * 0.18 + 0.15;
          heart.rotation.y += dt * 0.45;
          heart.rotation.z += dt * 0.15;
        });
      }
    }

    let shadowFrame = 0;
    function render() {
      // The shadow map only depends on the lights and casters, never on the
      // camera, so refreshing it every third frame costs a third of the pass
      // and is invisible at this animation speed.
      if (renderer.shadowMap.enabled && shadowFrame++ % 3 === 0) {
        renderer.shadowMap.needsUpdate = true;
      }
      renderer.render(scene, camera);
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    window.addEventListener('resize', resize);
    resize();

    const visibilityObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => { state.visible = entry.isIntersecting; });
    }, { rootMargin: '180px 0px' });
    visibilityObserver.observe(stage);

    updateCamera(0, true);
    render();
    update(0, 0.016);

    return {
      scene,
      camera,
      renderer,
      state,
      candles,
      blowAll,
      relight,
      update,
      render,
      resize,
      isVisible: () => state.visible
    };
  }

  /* ————————————————————————————————
     UI, navigation, carousel, lightbox
     ———————————————————————————————— */
  let activeSection = 'girls';
  let carouselUpdate = null;
  let toastTimer = null;
  let openLightbox = function () {};

  function showToast(message, duration) {
    const toast = $('#toast');
    if (!toast) return;
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), duration || 3200);
  }

  function setActiveSection(id) {
    if (!id || id === activeSection) return;
    activeSection = id;
    $$('.main-nav a').forEach(link => link.classList.toggle('is-active', link.dataset.nav === id));
    $$('.section-dots a').forEach(link => link.classList.toggle('is-active', link.dataset.dot === id));
    document.body.classList.toggle('on-light', id === 'memories');
  }

  function setupNavigation() {
    const sections = $$('main [data-section]');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) setActiveSection(entry.target.dataset.section);
      });
    }, { rootMargin: '-43% 0px -52% 0px', threshold: 0 });
    sections.forEach(section => observer.observe(section));
  }

  let leavingPage = false;
  let landingReady = false;
  let nudgeLanding = function () {};

  function goToSurprise(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (leavingPage) return;
    if (!landingReady) {
      nudgeLanding();
      return;
    }
    leavingPage = true;
    Sound.chime(784, 0.055);
    Sound.markEntry();
    Sound.armMusic();
    document.body.classList.add('is-leaving');
    const overlay = $('#page-transition');
    if (overlay) overlay.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => {
      window.location.href = 'wishes.html';
    }, 980);
  }

  function setupHeroUI() {
    $$('[data-transition]').forEach(link => {
      link.addEventListener('click', goToSurprise);
    });

    if (!app.girls) return;
    app.girls.state.onSelect = (index) => {
      if (index < 0) return;
      if (landingReady) goToSurprise();
      else nudgeLanding();
    };

    const stageCanvas = $('#girls-canvas');
    if (stageCanvas) {
      stageCanvas.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (landingReady) goToSurprise();
          else nudgeLanding();
        }
      });
    }
  }

  /* ————————————————————————————————
     Landing gate — she sets up her own birthday
     ———————————————————————————————— */
  const GIFT_STEPS = [
    {
      name: 'the balloons',
      hint: 'tap the glowing gift on the left',
      action: 'Open gift one: release the balloons'
    },
    {
      name: 'the petals',
      hint: 'now the gift on the right',
      action: 'Open gift two: let the petals fly'
    },
    {
      name: 'her candle',
      hint: 'one last gift, hidden behind her cake',
      action: 'Open gift three: light her candle'
    }
  ];

  function setupLandingGate() {
    const layer = $('#landing-layer');
    const guide = $('#setup-guide');
    const hint = $('#setup-guide-hint');
    const steps = $$('#setup-guide .setup-step');
    const markers = $$('.gift-marker');
    const cta = $('#landing-cta');
    const skip = $('#landing-skip');
    const hero = $('.hero');

    // No gate markup (e.g. on wishes.html) means nothing to lock.
    if (!layer || !hero || !markers.length) {
      landingReady = true;
      return;
    }

    const flow = { step: 0, done: false };

    if (!app.girls) {
      // Without WebGL there is no scene to set up. Never trap her here.
      flow.step = 3;
      unlockLanding(true);
      return;
    }

    function screenPositions(positions) {
      const rect = hero.getBoundingClientRect();
      markers.forEach((marker, index) => {
        const point = positions[index];
        if (!point || point.behind) return;
        marker.style.left = `${clamp(point.x, 0.06, 0.94) * rect.width}px`;
        marker.style.top = `${clamp(point.y, 0.1, 0.9) * rect.height}px`;
      });
    }

    function syncGuide() {
      steps.forEach((step, index) => {
        step.classList.toggle('is-done', index < flow.step);
        step.classList.toggle('is-active', index === flow.step && !flow.done);
      });
      markers.forEach((marker, index) => {
        marker.classList.toggle('is-active', index === flow.step && !flow.done);
      });
      if (hint) {
        hint.textContent = (flow.done || flow.step >= GIFT_STEPS.length)
          ? 'her birthday is ready ✦'
          : GIFT_STEPS[flow.step].hint;
      }
      if (guide) guide.classList.toggle('is-complete', flow.done);
    }

    function unlockLanding(instant) {
      if (flow.done) return;
      flow.done = true;
      flow.step = 3;
      landingReady = true;
      document.body.classList.add('is-birthday-ready');
      syncGuide();
      if (skip) skip.hidden = true;
      if (cta) {
        cta.hidden = false;
        cta.classList.add('is-in');
      }
      if (!instant) {
        Sound.celebration();
        if (app.confetti) app.confetti.burst(130, true);
      }
    }

    function tryOpenGift(index) {
      if (flow.done || leavingPage) return;
      if (index !== flow.step) {
        showToast('one gift at a time, my love ✦', 2200);
        return;
      }
      if (!app.girls.openGift(index)) return;

      flow.step = index + 1;
      Sound.ui('success');

      if (index === 1 && app.confetti) {
        app.confetti.burst(reducedEffects ? 45 : 85, true);
      }
      if (index === 2) {
        Sound.chime(987.77, 0.05);
      }

      syncGuide();

      if (flow.step >= GIFT_STEPS.length) {
        window.setTimeout(() => unlockLanding(false), 900);
      }
    }

    app.girls.state.onGiftScreen = screenPositions;

    markers.forEach((marker, index) => {
      marker.setAttribute('aria-label', GIFT_STEPS[index].action);
      marker.addEventListener('click', () => tryOpenGift(index));
      marker.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          tryOpenGift(index);
        }
      });
    });

    if (cta) cta.addEventListener('click', goToSurprise);

    nudgeLanding = function () {
      if (leavingPage) return;
      if (landingReady) {
        goToSurprise();
        return;
      }
      showToast('set up her birthday first — tap the glowing gift ✦', 2800);
      if (guide) {
        guide.classList.remove('is-nudged');
        void guide.offsetWidth;
        guide.classList.add('is-nudged');
      }
    };

    if (skip) {
      skip.addEventListener('click', () => {
        if (flow.done) return;
        app.girls.completeGifts();
        flow.step = 3;
        unlockLanding(true);
        showToast('her birthday is ready ✦', 2400);
      });
      window.setTimeout(() => {
        if (!flow.done) skip.hidden = false;
      }, 25000);
    }

    syncGuide();
  }

  function setupReferenceViewer() {
    const viewer = $('#reference-viewer');
    const openButton = $('#reference-photo-button');
    const closeButton = $('#reference-viewer-close');
    if (!viewer || !openButton || !closeButton) return;
    let lastFocused = null;

    function openViewer() {
      lastFocused = document.activeElement;
      viewer.classList.add('is-open');
      viewer.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-locked');
      closeButton.focus();
      Sound.ui('open', 0.12);
    }

    function closeViewer() {
      viewer.classList.remove('is-open');
      viewer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('is-locked');
      if (lastFocused && lastFocused.focus) lastFocused.focus();
      Sound.ui('close', 0.12);
    }

    openButton.addEventListener('click', openViewer);
    closeButton.addEventListener('click', closeViewer);
    viewer.addEventListener('click', event => {
      if (event.target === viewer) closeViewer();
    });

    document.addEventListener('keydown', event => {
      if (!viewer.classList.contains('is-open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeViewer();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.focus();
      }
    });
  }

  function setupWishUI() {
    const relightButton = $('#relight-button');
    const status = $('#candle-status');
    const complete = $('#wish-complete');
    const wishSection = $('#wish');
    if (!app.cake || !relightButton) return;

    const numbers = ['zero', 'one', 'two', 'three', 'four', 'five'];

    function updateStatus(lit, total) {
      status.classList.toggle('is-done', lit === 0);
      if (lit === 0) {
        status.innerHTML = '<span class="status-dot"></span> All five wishes are safe ✦';
      } else {
        const label = lit === 1 ? 'One candle still glowing' : (numbers[lit] ? numbers[lit][0].toUpperCase() + numbers[lit].slice(1) : lit) + ' candles still glowing';
        status.innerHTML = '<span class="status-dot"></span> ' + label;
      }
    }

    app.cake.state.onCandleChange = updateStatus;
    app.cake.state.onComplete = () => {
      status.classList.add('is-done');
      status.innerHTML = '<span class="status-dot"></span> Wish sealed · all five candles out';
      complete.classList.add('is-visible');
      if (wishSection) wishSection.classList.add('is-complete');
      relightButton.hidden = false;
      showToast('The candles are out. May every wish come true. ✦', 4200);
    };

    relightButton.addEventListener('click', () => {
      app.cake.relight();
      complete.classList.remove('is-visible');
      if (wishSection) wishSection.classList.remove('is-complete');
      relightButton.hidden = true;
      updateStatus(app.cake.state.total, app.cake.state.total);
    });

    document.addEventListener('keydown', event => {
      if (event.code !== 'Space' || activeSection !== 'wish') return;
      if (document.body.classList.contains('is-locked')) return;
      const tag = (event.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'a') return;
      if (app.cake.state.allOut) return;
      event.preventDefault();
      app.cake.blowAll();
    });

    updateStatus(app.cake.state.total, app.cake.state.total);
  }

  function setupCarousel() {
    const carousel = $('#photo-carousel');
    const ring = $('#carousel-ring');
    if (!carousel || !ring) return;

    let angle = -8;
    let targetAngle = angle;
    let dragging = false;
    let moved = 0;
    let lastX = 0;
    let hovered = false;
    let visible = true;
    let suppressedClick = false;
    let swipeSounded = false;

    const visibilityObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => { visible = entry.isIntersecting; });
    }, { rootMargin: '120px 0px' });
    visibilityObserver.observe(carousel);

    carousel.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      dragging = true;
      moved = 0;
      swipeSounded = false;
      lastX = event.clientX;
      carousel.classList.add('is-grabbing');
      try { carousel.setPointerCapture(event.pointerId); } catch (e) {}
    });

    carousel.addEventListener('pointermove', event => {
      if (!dragging) return;
      const dx = event.clientX - lastX;
      lastX = event.clientX;
      moved += Math.abs(dx);
      if (moved > 5) suppressedClick = true;
      if (!swipeSounded && moved > 22) {
        swipeSounded = true;
        const width = window.innerWidth || 1;
        Sound.ui('swipe', Math.max(-0.55, Math.min(0.55, (event.clientX / width - 0.5) * 0.9)));
      }
      targetAngle += dx * 0.28;
    });

    function releaseCarousel(event) {
      if (!dragging) return;
      dragging = false;
      carousel.classList.remove('is-grabbing');
      try { carousel.releasePointerCapture(event.pointerId); } catch (e) {}
      window.setTimeout(() => { suppressedClick = false; }, 80);
    }

    carousel.addEventListener('pointerup', releaseCarousel);
    carousel.addEventListener('pointercancel', releaseCarousel);
    carousel.addEventListener('pointerenter', () => { hovered = true; });
    carousel.addEventListener('pointerleave', () => { hovered = false; });

    carousel.addEventListener('click', event => {
      if (suppressedClick) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const card = event.target.closest('.polaroid');
      if (card) openLightbox(Number(card.dataset.photo));
    }, true);

    carouselUpdate = (dt) => {
      if (!visible) return;
      if (!dragging && !hovered && !reduceMotion && !reducedEffects) targetAngle += dt * 2.4;
      const nextAngle = damp(angle, targetAngle, 4.2, dt);
      if (Math.abs(nextAngle - angle) < 0.0005) return;
      angle = nextAngle;
      ring.style.transform = 'translateZ(-38px) rotateX(-2deg) rotateY(' + angle.toFixed(3) + 'deg)';
    };

    ring.style.transform = 'translateZ(-38px) rotateX(-2deg) rotateY(' + angle + 'deg)';

    window.addEventListener('keydown', event => {
      if (activeSection !== 'memories') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        targetAngle += event.key === 'ArrowLeft' ? -24 : 24;
      }
    });
  }

  function setupLightbox() {
    const lightbox = $('#lightbox');
    const image = $('#lightbox-image');
    const caption = $('#lightbox-caption');
    const close = $('#lightbox-close');
    if (!lightbox || !image) return;
    let lastFocused = null;

    openLightbox = function (index) {
      const card = $('.polaroid[data-photo="' + index + '"]');
      if (!card) return;
      const img = $('img', card);
      const text = $('.polaroid-caption', card).textContent;
      image.src = img.src;
      image.alt = img.alt;
      caption.textContent = text;
      lastFocused = document.activeElement;
      lightbox.classList.add('is-open');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-locked');
      close.focus();
      Sound.ui('open', -0.1);
    };

    function closeLightbox() {
      lightbox.classList.remove('is-open');
      lightbox.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('is-locked');
      if (lastFocused && lastFocused.focus) lastFocused.focus();
      Sound.ui('close', -0.1);
    }

    close.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', event => {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && lightbox.classList.contains('is-open')) closeLightbox();
    });
    window.closeLightbox = closeLightbox;
  }

  function setupPersonalNote() {
    const modal = $('#personal-note');
    const openButton = $('#personal-note-button');
    const closeButton = $('#personal-note-close');
    if (!modal || !openButton || !closeButton) return;
    const backdrop = $('.note-backdrop', modal);
    let lastFocused = null;

    function openNote() {
      lastFocused = document.activeElement;
      modal.classList.add('is-open');
      modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('is-locked');
      closeButton.focus();
      Sound.chime(659.25, 0.05);
    }

    function closeNote() {
      modal.classList.remove('is-open');
      modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('is-locked');
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    openButton.addEventListener('click', openNote);
    closeButton.addEventListener('click', closeNote);
    if (backdrop) backdrop.addEventListener('click', closeNote);

    document.addEventListener('keydown', event => {
      if (!modal.classList.contains('is-open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNote();
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.focus();
      }
    });
  }

  // Chapter four — five little love notes. The copy lives here so the
  // messages stay easy to edit in one place.
  const LITTLE_NOTES = [
    {
      kicker: 'note one',
      title: 'when life feels heavy',
      copy: "it's okay to pause, my love. put it down, breathe for a while, and let me hold the heavy parts until you're ready."
    },
    {
      kicker: 'note two',
      title: 'when you doubt yourself',
      copy: "i already know how this one ends: you doubting yourself, and me still completely certain about you."
    },
    {
      kicker: 'note three',
      title: 'when you feel lonely',
      copy: 'if the room feels quiet, keep this one open. i am right here, and i am always happy when you come back.'
    },
    {
      kicker: 'note four',
      title: 'when you forget how special you are',
      copy: "you notice the small things and you remember what people tell you. that has always been your magic, my love."
    },
    {
      kicker: 'note five',
      title: 'when you need a little hope',
      copy: "today has not finished writing tomorrow yet. there is still so much good coming your way."
    }
  ];

  function setupLittleThings() {
    const section = $('#little-things');
    const grid = $('#lt-grid');
    const reader = $('#lt-reader');
    if (!section || !grid || !reader) return;

    const cards = $$('.lt-note', grid);
    const kicker = $('#lt-reader-kicker');
    const title = $('#lt-reader-title');
    const copy = $('#lt-reader-copy');
    const another = $('#lt-another');
    const sparks = $('.lt-sparks', reader);
    const finalButton = $('#lt-final-button');
    const finalMessage = $('#lt-final');
    let openIndex = -1;

    // The hidden entrance state is added by JS, so with scripts off the
    // notes are simply there, visible.
    if (!reduceMotion) section.classList.add('lt-anim');

    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          section.classList.add('is-inview');
          observer.disconnect();
        });
      }, { threshold: 0.12 });
      observer.observe(section);
    } else {
      section.classList.add('is-inview');
    }

    function burstSparks() {
      if (!sparks || reduceMotion || reducedEffects) return;
      for (let i = 0; i < 9; i++) {
        const spark = document.createElement('span');
        spark.className = 'lt-spark';
        spark.textContent = i % 3 === 0 ? '♡' : '✦';
        spark.style.setProperty('--dx', Math.round(rand(-95, 95)) + 'px');
        spark.style.setProperty('--dy', Math.round(rand(-125, -35)) + 'px');
        spark.style.animationDelay = (i * 0.05).toFixed(3) + 's';
        sparks.appendChild(spark);
        spark.addEventListener('animationend', () => spark.remove(), { once: true });
      }
    }

    function openNote(index) {
      const note = LITTLE_NOTES[index];
      if (!note) return;
      openIndex = index;
      if (kicker) kicker.textContent = '✦ ' + note.kicker + ' ✦';
      if (title) title.textContent = note.title;
      if (copy) copy.textContent = note.copy;
      cards.forEach((card, i) => card.setAttribute('aria-expanded', i === index ? 'true' : 'false'));
      grid.classList.add('has-open');
      reader.hidden = false;
      reader.focus({ preventScroll: true });
      if (reader.scrollIntoView) {
        reader.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      }
      burstSparks();
      Sound.ui('open', 0);
    }

    function closeNote() {
      if (reader.hidden) return;
      const previous = openIndex;
      openIndex = -1;
      reader.hidden = true;
      grid.classList.remove('has-open');
      cards.forEach(card => card.setAttribute('aria-expanded', 'false'));
      if (sparks) sparks.innerHTML = '';
      Sound.ui('close', 0);
      return previous;
    }

    cards.forEach((card, index) => {
      card.addEventListener('click', () => {
        if (openIndex === index) {
          const previous = closeNote();
          if (cards[previous]) cards[previous].focus();
          return;
        }
        openNote(index);
      });
    });

    if (another) {
      another.addEventListener('click', () => {
        const previous = closeNote();
        const next = cards[(previous + 1) % cards.length];
        if (next) next.focus();
      });
    }

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || reader.hidden) return;
      event.preventDefault();
      const previous = closeNote();
      if (cards[previous]) cards[previous].focus();
    });

    if (finalButton && finalMessage) {
      finalButton.addEventListener('click', () => {
        const isExpanded = finalButton.getAttribute('aria-expanded') === 'true';
        if (isExpanded) {
          finalMessage.hidden = true;
          finalButton.setAttribute('aria-expanded', 'false');
          Sound.ui('close', 0);
          finalButton.focus({ preventScroll: true });
        } else {
          finalMessage.hidden = false;
          finalButton.setAttribute('aria-expanded', 'true');
          Sound.chime(659.25, 0.05);
        }
      });
    }
  }

  function setupSoundUI() {
    const button = $('#sound-toggle');
    if (!button) return;
    const label = $('.sound-label', button);

    function syncSoundUI(on) {
      button.setAttribute('aria-pressed', on ? 'true' : 'false');
      button.setAttribute('aria-label', on ? 'Turn birthday music off' : 'Turn birthday music on');
      if (label) label.textContent = on ? 'Music on' : 'Music off';
    }

    syncSoundUI(Sound.isMusicEnabled());

    // Music is only armed by the first-page Begin CTA. On wishes.html that
    // intent arrives through session storage; if autoplay is blocked, the
    // first gesture finishes the job. The landing page discards stale intent.
    const entered = document.body.classList.contains('wishes-page');
    if (!entered) {
      Sound.consumeEntry();
    } else if (Sound.consumeEntry() && Sound.isMusicEnabled()) {
      Sound.armMusic();
      const resumeMusic = () => {
        Sound.armMusic();
        window.removeEventListener('pointerdown', resumeMusic);
        window.removeEventListener('touchstart', resumeMusic);
        window.removeEventListener('keydown', resumeMusic);
        window.removeEventListener('wheel', resumeMusic);
      };
      window.addEventListener('pointerdown', resumeMusic, { passive: true });
      window.addEventListener('touchstart', resumeMusic, { passive: true });
      window.addEventListener('keydown', resumeMusic);
      window.addEventListener('wheel', resumeMusic, { passive: true });
    }

    button.addEventListener('click', () => {
      Sound.ui('toggle');
      const on = Sound.toggleMusic();
      syncSoundUI(on);
      if (on) showToast('Happy Birthday, slow & dreamy ✦', 2800);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) Sound.resume();
    });
  }

  function setupInteractionSounds() {
    const selector = 'a, button, [role="button"], input, select, textarea, label, summary';
    const finePointer = window.matchMedia
      ? window.matchMedia('(hover: hover) and (pointer: fine)').matches
      : false;

    function interactiveTarget(event) {
      const target = event.target;
      if (!target || !target.closest) return null;
      return target.closest(selector);
    }

    function panFor(event) {
      const width = window.innerWidth || 1;
      const x = typeof event.clientX === 'number' ? event.clientX : width / 2;
      return Math.max(-0.55, Math.min(0.55, (x / width - 0.5) * 0.9));
    }

    document.addEventListener('pointerdown', event => {
      const target = interactiveTarget(event);
      if (!target || target.closest('#sound-toggle')) return;
      Sound.ui('tap', panFor(event));
    }, { passive: true });

    // Keyboard activations produce a click with detail 0; pointer clicks are
    // already covered by pointerdown, so this avoids double taps.
    document.addEventListener('click', event => {
      const target = interactiveTarget(event);
      if (event.detail !== 0 || !target || target.closest('#sound-toggle')) return;
      Sound.ui('tap', 0);
    });

    if (finePointer) {
      let lastHoverAt = 0;
      let lastHoverTarget = null;
      document.addEventListener('pointerover', event => {
        const target = interactiveTarget(event);
        if (!target || target === lastHoverTarget) return;
        if (event.relatedTarget && target.contains(event.relatedTarget)) {
          lastHoverTarget = target;
          return;
        }
        const now = performance.now();
        if (now - lastHoverAt < 90) return;
        lastHoverAt = now;
        lastHoverTarget = target;
        Sound.ui('hover', panFor(event));
      }, { passive: true });
    }
  }

  function setupKissButton() {
    const button = $('#kiss-button');
    const heart = $('.letter-heart');
    if (!button) return;
    button.addEventListener('click', () => {
      Sound.chime(784, 0.06);
      if (app.confetti) app.confetti.burst(90, true);
      showToast('💋 caught it. Right back at you, birthday girl.', 3200);
      if (heart) {
        heart.classList.remove('is-kissed');
        void heart.offsetWidth;
        heart.classList.add('is-kissed');
      }
    });
  }

  /* ————————————————————————————————
     Boot + render loop
     ———————————————————————————————— */
  function wait(ms) {
    return new Promise(resolve => window.setTimeout(resolve, ms));
  }

  function whenWindowLoaded(limit) {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        window.removeEventListener('load', done);
        resolve();
      };
      window.addEventListener('load', done, { once: true });
      window.setTimeout(done, limit || 2500);
    });
  }

  function celebrateLoader() {
    document.body.classList.add('is-ready');
    if (app.girls) app.girls.render();
    if (app.cake) app.cake.render();
    if (window.YanaLoader) {
      window.YanaLoader.finish();
      return;
    }
    const loader = $('#loader');
    if (loader) {
      window.setTimeout(() => loader.classList.add('is-hidden'), 320);
    }
  }

  let renderLoopStarted = false;
  // Flips on the first quality decision so boot can wait for it while the
  // loader still covers the screen.
  let qualitySettled = false;

  function startRenderLoop() {
    if (renderLoopStarted) return;
    renderLoopStarted = true;
    let last = performance.now();
    let frameCap = 0;
    let lite = false;
    let readyAt = last + 600;
    let windowStart = 0;
    let sampleFrames = 0;
    let sampleTotal = 0;

    function enableLite() {
      if (lite) return;
      lite = true;
      reducedEffects = true;
      frameCap = 1000 / 30;
      pixelCap = 0.75;
      document.documentElement.classList.add('is-low-power');
      [app.girls, app.cake].forEach(scene => {
        if (!scene || !scene.renderer) return;
        if (scene.resize) scene.resize();
        else scene.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 0.75));
        scene.renderer.shadowMap.enabled = false;
        const scene3d = scene.scene;
        const extras = scene3d && scene3d.userData.perfLights;
        if (extras) {
          extras.forEach(light => scene3d.remove(light));
          scene3d.userData.perfLights = null;
        }
      });
      if (app.confetti) app.confetti.resize();
    }

    function loop(now) {
      if (frameCap && now - last < frameCap - 2) {
        window.requestAnimationFrame(loop);
        return;
      }

      const raw = now - last;
      const dt = Math.min(raw / 1000, 0.05);
      last = now;
      const time = now / 1000;

      // Once the transition starts, the final frame stays on the canvas, so
      // keep rendering off: it freed the GPU right when the page animates.
      if (!document.hidden && !leavingPage) {
        let active = false;
        if (app.girls && app.girls.isVisible()) {
          active = true;
          app.girls.update(time, dt);
          app.girls.render();
        }
        if (app.cake && app.cake.isVisible()) {
          active = true;
          app.cake.update(time, dt);
          app.cake.render();
        }
        if (carouselUpdate) carouselUpdate(dt);

        if (!lite && active && now > readyAt) {
          if (!windowStart) windowStart = now;
          sampleFrames++;
          // Clamp stalls (first frame after a hidden tab) so one long frame
          // cannot force the low-power mode on by itself.
          sampleTotal += Math.min(raw, 100);
          // Decide on elapsed time too, so a scene that is already struggling
          // downgrades within a second instead of after 50 frames.
          if (sampleFrames >= 24 || now - windowStart >= 600) {
            if (sampleTotal / sampleFrames > 24) enableLite();
            qualitySettled = true;
            sampleFrames = 0;
            sampleTotal = 0;
            windowStart = 0;
          }
        } else if (!active) {
          sampleFrames = 0;
          sampleTotal = 0;
          windowStart = 0;
          readyAt = now + 400;
        }
      }
      window.requestAnimationFrame(loop);
    }

    window.requestAnimationFrame(loop);
  }

  // Run the real loop while the loader still covers the page. Shader program
  // compiles, the first shadow map, the framebuffer allocation and any quality
  // downgrade all cost frames — doing them here means the first *visible*
  // frames are already steady instead of stuttering for a second or two.
  function warmRenderLoop() {
    if (!app.girls && !app.cake) return Promise.resolve();
    startRenderLoop();
    const frame = () => Promise.race([
      // A background tab pauses rAF, so the timer has to win there.
      new Promise(resolve => window.requestAnimationFrame(resolve)),
      wait(120)
    ]);
    return (async () => {
      const deadline = performance.now() + 1800;
      while (!qualitySettled && performance.now() < deadline) await frame();
      // Let a recompile from the downgrade finish out of sight too.
      for (let i = 0; i < 8; i++) await frame();
    })();
  }

  // Let the loader paint before the heavier 3D work starts. A timer backs up
  // requestAnimationFrame, which is paused entirely in a background tab — that
  // used to leave the loader spinning until the hard stop.
  function afterPaint() {
    return new Promise(resolve => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      window.requestAnimationFrame(() => window.requestAnimationFrame(done));
      window.setTimeout(done, 140);
    });
  }

  async function boot() {
    const Loader = window.YanaLoader;

    if (Loader) Loader.setStatus('gathering little bits of sunshine');
    await afterPaint();
    // Audio graph starts now instead of on the first hover.
    Sound.warm();

    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready.catch(() => {}),
        wait(900)
      ]);
    }

    if (Loader) Loader.setStatus('lighting the candles');

    try {
      const confettiCanvas = $('#confetti-canvas');
      if (confettiCanvas) app.confetti = new Confetti(confettiCanvas);

      try {
        app.girls = setupGirlsScene();
      } catch (error) {
        console.error('The birthday girl scene had trouble starting:', error);
      }

      try {
        app.cake = setupCakeScene();
      } catch (error) {
        console.error('The cake scene had trouble starting:', error);
      }

      setupNavigation();
      setupHeroUI();
      setupLandingGate();
      setupReferenceViewer();
      setupWishUI();
      setupCarousel();
      setupLightbox();
      setupPersonalNote();
      setupLittleThings();
      setupSoundUI();
      setupInteractionSounds();
      setupKissButton();

      const referencePhoto = $('.reference-photo img');
      if (referencePhoto && referencePhoto.decode && !referencePhoto.complete) {
        await Promise.race([referencePhoto.decode().catch(() => {}), wait(500)]);
      }

      if (Loader) Loader.setStatus('something special is coming, my love...');
      await whenWindowLoaded(1500);
      // Render under the loader first: the expensive first frames and any
      // quality downgrade must never be the ones the user actually sees.
      await warmRenderLoop();
      celebrateLoader();
    } catch (error) {
      console.error('The birthday page had trouble starting:', error);
      document.body.classList.add('has-no-3d');
      if (Loader) {
        Loader.setStatus('showing the quiet version');
        Loader.finish();
      } else {
        celebrateLoader();
      }
    }

    startRenderLoop();
  }

  boot();

  /* __NEXT_PART__ */
})();
