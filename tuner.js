// tuner.js
(async function() {
  // 1) Feature check
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported.</p>';
    return;
  }

  // 2) Autocorrelation pitch detector (ACF2+)
  function autoCorrelate(buf, sampleRate) {
    const N = buf.length;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / N);
    if (rms < 0.01) return -1;  // too quiet

    // trim silence
    let r1 = 0, r2 = N - 1, th = 0.2;
    for (let i = 0; i < N/2; i++) if (Math.abs(buf[i]) < th) { r1 = i; break; }
    for (let i = 1; i < N/2; i++) if (Math.abs(buf[N-i]) < th) { r2 = N - i; break; }
    const slice = buf.slice(r1, r2);

    // autocorrelation
    const C = new Array(slice.length).fill(0);
    for (let i = 0; i < slice.length; i++)
      for (let j = 0; j + i < slice.length; j++)
        C[i] += slice[j] * slice[j + i];

    // find peak
    let d = 0;
    while (C[d] > C[d+1]) d++;
    let maxpos = d, maxval = -Infinity;
    for (let i = d; i < C.length; i++) {
      if (C[i] > maxval) { maxval = C[i]; maxpos = i; }
    }

    // parabolic interpolation
    let T0 = maxpos;
    const x1 = C[T0-1], x2 = C[T0], x3 = C[T0+1];
    const a = (x1 + x3 - 2*x2)/2;
    const b = (x3 - x1)/2;
    if (a) T0 = T0 - b/(2*a);

    return sampleRate / T0;
  }

  // 3) DOM refs
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

  // 4) State & constants
  let referenceFrequency = 440;
  let currentPresetName  = Object.keys(window.tuningPresets)[0];
  let currentStrings     = window.tuningPresets[currentPresetName];
  let prevRms            = 0;
  let lastPluckTime      = 0;
  let smoothedDetune     = 0;
  let lastUiUpdate       = 0;
  const uiInterval       = 250;  // ms
  const noteStrings      = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // Render string buttons & description
  function renderStringButtons() {
    stringRow.innerHTML = '';
    currentStrings.forEach(nm => {
      const btn = document.createElement('button');
      btn.textContent = nm;
      if (nm === noteMain.textContent) btn.classList.add('active');
      stringRow.appendChild(btn);
    });
    presetDesc.textContent = `Guitar, ${currentPresetName}, Equal tempered`;
  }
  renderStringButtons();

  // 5) Audio setup
  const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext||window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);
  const bufferLen    = analyser.fftSize;
  const dataArray    = new Float32Array(bufferLen);

  // 6) Gauge geometry (wider)
  const cw       = meterCanvas.width;                     // e.g. 720
  const ch       = meterCanvas.height;                    // e.g. 360
  const cx       = cw / 2;
  const cy       = ch;                                    // pivot at bottom edge
  const maxAngle = Math.PI / 6;                          // ±30°
  // radius so that ±30° arc spans full canvas width
  const radius   = cw / (2 * Math.cos(maxAngle));
  const innerR   = radius * 0.85;
  const outerR   = radius * 0.95;
  const ticks    = 20;   // 10-cent steps

  // Draw static non-linear ticks & labels
  function drawGaugeTicks() {
    meterCtx.clearRect(0, 0, cw, ch);
    meterCtx.lineCap = 'round';
    for (let i = 0; i <= ticks; i++) {
      const cents = -100 + (i * 200 / ticks);
      const norm  = cents / 100;
      const sgn   = norm < 0 ? -1 : 1;
      const rpos  = sgn * Math.sqrt(Math.abs(norm));
      const off   = rpos * maxAngle;
      const theta = -Math.PI/2 + off;  // vertical = -90°

      // Tick endpoints
      const x1 = cx + innerR * Math.cos(theta);
      const y1 = cy + innerR * Math.sin(theta);
      const x2 = cx + outerR * Math.cos(theta);
      const y2 = cy + outerR * Math.sin(theta);

      meterCtx.strokeStyle = '#444';
      meterCtx.lineWidth   = (i % 5 === 0 ? 3 : 1);
      meterCtx.beginPath();
      meterCtx.moveTo(x1, y1);
      meterCtx.lineTo(x2, y2);
      meterCtx.stroke();

      // Labels at ±100, ±50, 0
      if (i % 5 === 0) {
        meterCtx.fillStyle    = '#888';
        meterCtx.font         = '12px Arial';
        meterCtx.textAlign    = 'center';
        meterCtx.textBaseline = 'middle';
        const labelR = radius * 0.47;
        const lx     = cx + labelR * Math.cos(theta);
        const ly     = cy + labelR * Math.sin(theta);
        const txt    = (cents > 0 ? '+' : '') + cents;
        meterCtx.fillText(txt, lx, ly);
      }
    }
  }
  drawGaugeTicks();

  // 7) Main draw loop
  function draw() {
    requestAnimationFrame(draw);

    // a) Waveform
    analyser.getFloatTimeDomainData(dataArray);
    waveCtx.fillStyle   = '#111';
    waveCtx.fillRect(0, 0, waveformC.width, waveformC.height);
    waveCtx.lineWidth   = 2;
    waveCtx.strokeStyle = '#0ff';
    waveCtx.beginPath();
    let x = 0, step = waveformC.width / bufferLen;
    for (let i = 0; i < bufferLen; i++) {
      const v = dataArray[i]*0.5 + 0.5;
      const y = v * waveformC.height;
      i===0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
      x += step;
    }
    waveCtx.stroke();

    // b) Pitch detect & transient smoothing
    const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
    if (pitch > 0) {
      const noteNum = 12 * (Math.log(pitch/referenceFrequency)/Math.log(2)) + 69;
      const rounded = Math.round(noteNum);

      // onset detection
      let rms=0;
      for (let i=0;i<bufferLen;i++) rms+=dataArray[i]*dataArray[i];
      rms = Math.sqrt(rms/bufferLen);
      if (rms > prevRms*1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rms;

      // much slower smoothing α
      const dt    = audioContext.currentTime - lastPluckTime;
      let alpha   = dt < 0.1  ? 0.002
                  : dt < 0.5  ? 0.005
                  :             0.01;

      const detRaw       = noteNum - rounded;
      smoothedDetune     = alpha * detRaw + (1 - alpha) * smoothedDetune;

      // map detune to ±30° off vertical
      const centsNorm    = Math.max(-100, Math.min(100, smoothedDetune*100));
      const sgn          = centsNorm < 0 ? -1 : 1;
      const rpos         = sgn * Math.sqrt(Math.abs(centsNorm)/100);
      const off          = rpos * maxAngle;
      const theta        = -Math.PI/2 + off;

      // c) Draw the long needle
      needleCtx.clearRect(0, 0, needleCanvas.width, needleCanvas.height);
      needleCtx.save();
      needleCtx.translate(cx, cy);
      needleCtx.rotate(off);
      needleCtx.lineWidth   = 4;
      needleCtx.strokeStyle = '#f0f';
      needleCtx.beginPath();
      needleCtx.moveTo(0, 0);
      needleCtx.lineTo(0, -outerR * 1.0);
      needleCtx.stroke();
      needleCtx.restore();

      // d) Throttled UI updates (every 250ms)
      const now = performance.now();
      if (now - lastUiUpdate > uiInterval) {
        // note context strip
        const center = rounded;
        [prev2,prev1,noteMain,next1,next2].forEach((el,i) => {
          const delta = i - 2;
          const n     = center + delta;
          el.textContent = noteStrings[(n%12+12)%12] + Math.floor(n/12);
          el.classList.toggle('note-large', delta===0);
        });
        // frequency
        freqDisplay.textContent = Math.round(pitch) + ' Hz';
        // highlight closest string
        let best=0, bd=Infinity;
        currentStrings.forEach((nm,i) => {
          const pc   = nm.match(/^[A-G]#?/)[0];
          const oct  = parseInt(nm.slice(-1),10);
          const semi = noteStrings.indexOf(pc) + oct*12;
          const fstr = referenceFrequency * Math.pow(2,(semi-69)/12);
          const dval = Math.abs(pitch - fstr);
          if (dval < bd) { bd = dval; best = i; }
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
