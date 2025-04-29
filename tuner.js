// tuner.js
(async function() {
  // ── 1. Feature check ───────────────────────────────────
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported.</p>';
    return;
  }

  // ── 2. Pitch detection (Autocorrelation ACF2+) ─────────
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;  // Too quiet

    // Trim buffer to region above threshold
    let r1 = 0, r2 = SIZE - 1, thres = 0.2;
    for (let i = 0; i < SIZE/2; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    for (let i = 1; i < SIZE/2; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
    buf = buf.slice(r1, r2);

    // Autocorrelation
    const newSize = buf.length;
    const c = new Array(newSize).fill(0);
    for (let i = 0; i < newSize; i++)
      for (let j = 0; j < newSize - i; j++)
        c[i] += buf[j] * buf[j + i];

    let d = 0;
    while (c[d] > c[d+1]) d++;
    let maxpos = d, maxval = -Infinity;
    for (let i = d; i < newSize; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }

    // Parabolic interpolation
    let T0 = maxpos;
    const x1 = c[T0-1], x2 = c[T0], x3 = c[T0+1];
    const a = (x1 + x3 - 2*x2)/2;
    const b = (x3 - x1)/2;
    if (a) T0 = T0 - b/(2*a);

    return sampleRate / T0;
  }

  // ── 3. Grab DOM elements ─────────────────────────────────
  const settingsBtn     = document.getElementById('settingsButton');
  const overlay         = document.getElementById('settingsOverlay');
  const closeSettings   = document.getElementById('closeSettings');
  const refFreqInput    = document.getElementById('refFreqInput');
  const presetSelect    = document.getElementById('presetSelect');
  const stringButtonsDiv= document.getElementById('stringButtons');
  const noteCharElem    = document.getElementById('noteChar');
  const noteStatusElem  = document.getElementById('noteStatus');
  const waveformCanvas  = document.getElementById('waveform');
  const waveformCtx     = waveformCanvas.getContext('2d');
  const needleCanvas    = document.getElementById('needle');
  const needleCtx       = needleCanvas.getContext('2d');
  const meterCanvas     = document.getElementById('meterGauge');
  const meterCtx        = meterCanvas.getContext('2d');

  // ── 4. State variables ──────────────────────────────────
  let referenceFrequency = 440;
  let currentStrings     = [];
  let targetString       = null;
  let prevRms            = 0;
  let lastPluckTime      = 0;
  let smoothedDetune     = 0;
  let lastUiUpdate       = 0;
  const uiInterval       = 250; // ms throttle
  const noteStrings      = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // ── 5. Populate presets dropdown ─────────────────────────
  Object.keys(window.tuningPresets).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    presetSelect.appendChild(opt);
  });
  const presetNames = Object.keys(window.tuningPresets);
  if (presetNames.length) {
    presetSelect.value = presetNames[0];
    currentStrings = window.tuningPresets[presetNames[0]];
    targetString = null;
  }
  refFreqInput.value = referenceFrequency;

  // ── 6. Render string buttons ────────────────────────────
  function renderStringButtons() {
    stringButtonsDiv.innerHTML = '';
    currentStrings.forEach(noteName => {
      const btn = document.createElement('button');
      btn.textContent = noteName;
      btn.dataset.note = noteName;
      if (noteName === targetString) btn.classList.add('active');
      btn.addEventListener('click', () => {
        targetString = noteName;
        renderStringButtons();
      });
      stringButtonsDiv.appendChild(btn);
    });
  }
  renderStringButtons();

  // ── 7. Settings overlay wiring ──────────────────────────
  settingsBtn   .addEventListener('click',   ()=> overlay.classList.add('open'));
  closeSettings .addEventListener('click',   ()=> overlay.classList.remove('open'));
  refFreqInput  .addEventListener('input',   ()=> {
    referenceFrequency = parseFloat(refFreqInput.value) || referenceFrequency;
  });
  presetSelect  .addEventListener('change',  ()=> {
    const name = presetSelect.value;
    currentStrings = window.tuningPresets[name] || [];
    if (!currentStrings.includes(targetString)) targetString = null;
    renderStringButtons();
  });

  // Convert note name ➔ frequency
  function noteToFreq(noteName) {
    const pitchClass = noteName.match(/^[A-G]#?/)[0];
    const octave     = parseInt(noteName.slice(-1), 10);
    const semitone   = noteStrings.indexOf(pitchClass) + octave * 12;
    return referenceFrequency * Math.pow(2, (semitone - 69) / 12);
  }

  // ── 8. Audio setup ──────────────────────────────────────
  const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);
  const bufferLen    = analyser.fftSize;
  const dataArray    = new Float32Array(bufferLen);

  // ── 9. Main draw loop ───────────────────────────────────
  function draw() {
    requestAnimationFrame(draw);

    // — Waveform —
    analyser.getFloatTimeDomainData(dataArray);
    waveformCtx.fillStyle   = '#111';
    waveformCtx.fillRect(0, 0, waveformCanvas.width, waveformCanvas.height);
    waveformCtx.lineWidth   = 2;
    waveformCtx.strokeStyle = '#0ff';
    waveformCtx.beginPath();
    const sliceW = waveformCanvas.width / bufferLen;
    let x = 0;
    for (let i = 0; i < bufferLen; i++) {
      const v = dataArray[i] * 0.5 + 0.5;
      const y = v * waveformCanvas.height;
      i === 0 ? waveformCtx.moveTo(x, y) : waveformCtx.lineTo(x, y);
      x += sliceW;
    }
    waveformCtx.stroke();

    // — Pitch detection & transient smoothing —
    const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
    if (pitch !== -1) {
      const noteNum = 12 * (Math.log(pitch / referenceFrequency) / Math.log(2)) + 69;
      const rounded = Math.round(noteNum);

      // RMS for onset
      let rms = 0;
      for (let i = 0; i < bufferLen; i++) rms += dataArray[i] * dataArray[i];
      rms = Math.sqrt(rms / bufferLen);
      if (rms > prevRms * 1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rms;

      // Adaptive smoothing α
      const delta = audioContext.currentTime - lastPluckTime;
      const alpha = delta < 0.05 ? 0.02 : delta < 0.2 ? 0.1 : 0.2;

      // Smooth detune
      const detuneRaw     = noteNum - rounded;
      smoothedDetune      = alpha * detuneRaw + (1 - alpha) * smoothedDetune;
      const angle         = smoothedDetune * (Math.PI / 4);

      // — Needle —
      needleCtx.clearRect(0, 0, needleCanvas.width, needleCanvas.height);
      needleCtx.save();
      needleCtx.translate(needleCanvas.width / 2, needleCanvas.height);
      needleCtx.rotate(angle);
      needleCtx.lineWidth   = 4;
      needleCtx.strokeStyle = '#f0f';
      needleCtx.beginPath();
      needleCtx.moveTo(0, 0);
      needleCtx.lineTo(0, -80);
      needleCtx.stroke();
      needleCtx.restore();

      // — Throttled UI updates —
      const now = performance.now();
      if (now - lastUiUpdate > uiInterval) {
        // Note letter
        noteCharElem.textContent = noteStrings[rounded % 12];
        // Status text
        const cents = Math.round(smoothedDetune * 100);
        noteStatusElem.textContent = Math.abs(cents) < 5
          ? 'IN TUNE'
          : (cents > 0 ? 'SHARP' : 'FLAT');

        // Highlight closest string button
        if (currentStrings.length) {
          const freqs = currentStrings.map(noteToFreq);
          const diffs = freqs.map(f => Math.abs(pitch - f));
          const idx   = diffs.indexOf(Math.min(...diffs));
          targetString = currentStrings[idx];
          renderStringButtons();
        }

        lastUiUpdate = now;
      }
    } else {
      // No pitch → clear needle
      needleCtx.clearRect(0, 0, needleCanvas.width, needleCanvas.height);
    }
  }

  draw();
})();
