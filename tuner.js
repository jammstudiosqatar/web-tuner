// tuner.js
(async function() {
  // ——— Feature check ———
  if (!navigator.mediaDevices?.getUserMedia) {
    document.getElementById('tuner').innerHTML =
      '<p>Microphone not supported.</p>';
    return;
  }

  // ——— Grab DOM nodes ———
  const stringRow    = document.getElementById('stringRow');
  const prev2        = document.getElementById('prev2');
  const prev1        = document.getElementById('prev1');
  const noteMain     = document.getElementById('noteMain');
  const next1        = document.getElementById('next1');
  const next2        = document.getElementById('next2');
  const meterCanvas  = document.getElementById('meterCanvas');
  const needleCanvas = document.getElementById('needleCanvas');
  const waveformC    = document.getElementById('waveformCanvas');
  const freqDisplay  = document.getElementById('freqDisplay');
  const presetDesc   = document.getElementById('presetDesc');

  const meterCtx  = meterCanvas.getContext('2d');
  const needleCtx = needleCanvas.getContext('2d');
  const waveCtx   = waveformC.getContext('2d');

  // ——— State ———
  let referenceFrequency = 440;
  let currentPresetName  = Object.keys(window.tuningPresets)[0];
  let currentStrings     = window.tuningPresets[currentPresetName];
  let prevRms            = 0;
  let lastPluckTime      = 0;
  let smoothedDetune     = 0;
  let lastUiUpdate       = 0;
  const uiInterval       = 250;
  const noteStrings      = [
    'C','C#','D','D#','E','F','F#','G','G#','A','A#','B'
  ];

  // ——— Populate string buttons & preset desc ———
  function renderStringButtons() {
    stringRow.innerHTML = '';
    currentStrings.forEach(noteName => {
      const btn = document.createElement('button');
      btn.textContent = noteName;
      if (noteName === noteMain.textContent) btn.classList.add('active');
      stringRow.appendChild(btn);
    });
    presetDesc.textContent = 
      `Guitar, ${currentPresetName}, Equal tempered`;
  }
  renderStringButtons();

  // ——— Audio setup ———
  const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);
  const bufferLen    = analyser.fftSize;
  const dataArray    = new Float32Array(bufferLen);

  // ——— Draw static gauge ticks once ———
  const cw      = meterCanvas.width;
  const ch      = meterCanvas.height;
  const cx      = cw / 2;
  const cy      = ch;
  const radius  = cw * 0.45;
  function drawGaugeTicks() {
    meterCtx.clearRect(0, 0, cw, ch);
    for (let i = 0; i <= 20; i++) {
      const angle = Math.PI - (i / 20) * Math.PI;
      const inner = radius * 0.85;
      const x1    = cx + inner * Math.cos(angle);
      const y1    = cy + inner * Math.sin(angle);
      const x2    = cx + radius * Math.cos(angle);
      const y2    = cy + radius * Math.sin(angle);
      meterCtx.strokeStyle = '#444';
      meterCtx.lineWidth   = (i % 5 === 0 ? 3 : 1);
      meterCtx.beginPath();
      meterCtx.moveTo(x1, y1);
      meterCtx.lineTo(x2, y2);
      meterCtx.stroke();
    }
  }
  drawGaugeTicks();

  // ——— Autocorrelation pitch detection ———
  function autoCorrelate(buf, sampleRate) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.01) return -1;

    // trim silence
    let r1 = 0, r2 = buf.length - 1, th = 0.2;
    for (let i = 0; i < buf.length/2; i++)
      if (Math.abs(buf[i]) < th) { r1 = i; break; }
    for (let i = 1; i < buf.length/2; i++)
      if (Math.abs(buf[buf.length - i]) < th) { r2 = buf.length - i; break; }
    const slice = buf.slice(r1, r2);

    // autocorrelation
    const c = new Array(slice.length).fill(0);
    for (let i = 0; i < slice.length; i++)
      for (let j = 0; j + i < slice.length; j++)
        c[i] += slice[j] * slice[j + i];

    // find peak
    let d = 0;
    while (c[d] > c[d+1]) d++;
    let maxpos = d, maxval = -Infinity;
    for (let i = d; i < c.length; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }

    // refine by parabola
    const x1 = c[maxpos-1], x2 = c[maxpos], x3 = c[maxpos+1];
    const a = (x1 + x3 - 2*x2)/2;
    const b = (x3 - x1)/2;
    let T0 = maxpos;
    if (a) T0 = T0 - b/(2*a);

    return sampleRate / T0;
  }

  // ——— Main draw loop ———
  function draw() {
    requestAnimationFrame(draw);

    // 1) Waveform
    analyser.getFloatTimeDomainData(dataArray);
    waveCtx.fillStyle   = '#111';
    waveCtx.fillRect(0, 0, waveformC.width, waveformC.height);
    waveCtx.lineWidth   = 2;
    waveCtx.strokeStyle = '#0ff';
    waveCtx.beginPath();
    let x = 0, sliceW = waveformC.width / bufferLen;
    for (let i = 0; i < bufferLen; i++) {
      const v = dataArray[i] * 0.5 + 0.5;
      const y = v * waveformC.height;
      i === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
      x += sliceW;
    }
    waveCtx.stroke();

    // 2) Pitch & smoothing
    const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
    if (pitch > 0) {
      const noteNum = 12 * Math.log(pitch/referenceFrequency)/Math.log(2) + 69;
      const rounded = Math.round(noteNum);

      // onset detection
      let rms = 0;
      for (let i = 0; i < bufferLen; i++) rms += dataArray[i]*dataArray[i];
      rms = Math.sqrt(rms/bufferLen);
      if (rms > prevRms*1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rms;

      // adaptive smoothing
      const delta = audioContext.currentTime - lastPluckTime;
      const alpha = delta<0.05?0.02:delta<0.2?0.1:0.2;
      const detRaw = noteNum - rounded;
      smoothedDetune = alpha*detRaw + (1-alpha)*smoothedDetune;

      // 3) Draw dynamic arc & needle
      drawGaugeTicks();
      const detAngle = (smoothedDetune/0.5)*(Math.PI/2);
      meterCtx.save();
      meterCtx.translate(cx, cy);
      meterCtx.strokeStyle = '#0f0';
      meterCtx.lineWidth   = 5;
      meterCtx.beginPath();
      meterCtx.arc(0, 0, radius*0.9, Math.PI - detAngle, Math.PI + detAngle);
      meterCtx.stroke();
      meterCtx.restore();

      // 4) Throttled UI updates every 250ms
      const now = performance.now();
      if (now - lastUiUpdate > uiInterval) {
        // note context
        const center = rounded;
        [prev2, prev1, noteMain, next1, next2].forEach((el, idx) => {
          const offset = idx - 2;
          const n = center + offset;
          const name = noteStrings[(n%12+12)%12] + Math.floor(n/12);
          el.textContent = name;
          el.classList.toggle('note-large', offset===0);
        });

        // freq display
        freqDisplay.textContent = Math.round(pitch) + ' Hz';

        // highlight string closest to pitch
        let best = 0, bestD = Infinity;
        currentStrings.forEach((ns,i) => {
          const f = referenceFrequency * Math.pow(2, 
            (noteStrings.indexOf(ns.replace(/\d/,'')) + parseInt(ns.slice(-1))*12 - 69)/12
          );
          const d = Math.abs(pitch - f);
          if (d < bestD) { bestD = d; best = i; }
        });
        Array.from(stringRow.children).forEach((btn,i) => {
          btn.classList.toggle('active', i===best);
        });

        lastUiUpdate = now;
      }
    }
  }

  draw();
})();
