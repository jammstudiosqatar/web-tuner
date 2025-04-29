// tuner.js
(async function() {
  // —— 1) Feature check ——  
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone not supported.</p>';
    return;
  }

  // —— 2) Pitch detector (ACF2+) ——  
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;  // too quiet

    // Trim silent head/tail
    let r1 = 0, r2 = SIZE - 1, th = 0.2;
    for (let i = 0; i < SIZE/2; i++) if (Math.abs(buf[i]) < th) { r1 = i; break; }
    for (let i = 1; i < SIZE/2; i++) if (Math.abs(buf[SIZE-i]) < th) { r2 = SIZE-i; break; }
    buf = buf.slice(r1, r2);

    // Autocorrelation
    const N = buf.length;
    const c = new Array(N).fill(0);
    for (let i = 0; i < N; i++)
      for (let j = 0; j + i < N; j++)
        c[i] += buf[j] * buf[j + i];

    // Find peak
    let d = 0;
    while (c[d] > c[d+1]) d++;
    let maxpos = d, maxval = -Infinity;
    for (let i = d; i < N; i++) {
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

  // —— 3) DOM refs & canvas contexts ——  
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

  // —— 4) State & constants ——  
  let referenceFrequency = 440;
  let currentPresetName  = Object.keys(window.tuningPresets)[0];
  let currentStrings     = window.tuningPresets[currentPresetName];
  let prevRms            = 0;
  let lastPluckTime      = 0;
  let smoothedDetune     = 0;
  let lastUiUpdate       = 0;
  const uiInterval       = 250;    // ms
  const noteStrings      = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // —— 5) Populate and render string‐row & desc ——  
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

  // —— 6) Setup audio stream ——  
  const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext||window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);
  const bufferLen    = analyser.fftSize;
  const dataArray    = new Float32Array(bufferLen);

  // —— 7) Gauge geometry ——  
  const cw        = meterCanvas.width;
  const ch        = meterCanvas.height;
  const cx        = cw / 2;
  const cy        = ch;
  const radius    = ch * 0.9;         // use 90% of height
  const tickCount = 20;               // 10c steps
  const maxAngle  = Math.PI / 6;      // ±30°

  // —— 8) Draw static ticks & labels on non-linear scale ——  
  function drawGaugeTicks() {
    meterCtx.clearRect(0,0,cw,ch);
    meterCtx.lineCap = 'round';
    for (let i = 0; i <= tickCount; i++) {
      const cents = -100 + (i*(200/tickCount));
      const sgn   = cents < 0 ? -1 : 1;
      const rnorm = Math.abs(cents)/100;
      const curve = Math.sqrt(rnorm);
      const angOff = sgn * curve * maxAngle;            // offset from vertical
      const ang    = Math.PI/2 + angOff;                // from +x axis
      const innerR = radius * 0.85;
      const outerR = radius;
      // Compute endpoints
      const x1 = cx + innerR * Math.sin(ang);
      const y1 = cy - innerR * Math.cos(ang);
      const x2 = cx + outerR * Math.sin(ang);
      const y2 = cy - outerR * Math.cos(ang);
      // Draw tick
      meterCtx.strokeStyle = '#444';
      meterCtx.lineWidth   = (i % 5 === 0 ? 3 : 1);
      meterCtx.beginPath();
      meterCtx.moveTo(x1,y1);
      meterCtx.lineTo(x2,y2);
      meterCtx.stroke();
      // Label majors
      if (i % 5 === 0) {
        meterCtx.fillStyle    = '#888';
        meterCtx.font         = '12px Arial';
        meterCtx.textAlign    = 'center';
        meterCtx.textBaseline = 'middle';
        const labelR = radius * 0.7;
        const lx = cx + labelR * Math.sin(ang);
        const ly = cy - labelR * Math.cos(ang);
        const txt = (cents > 0 ? '+' : '') + cents;
        meterCtx.fillText(txt, lx, ly);
      }
    }
  }
  drawGaugeTicks();

  // —— 9) Main draw loop ——  
  function draw() {
    requestAnimationFrame(draw);

    // — a) Waveform —
    analyser.getFloatTimeDomainData(dataArray);
    waveCtx.fillStyle   = '#111';
    waveCtx.fillRect(0,0,waveformC.width,waveformC.height);
    waveCtx.lineWidth   = 2;
    waveCtx.strokeStyle = '#0ff';
    waveCtx.beginPath();
    let x = 0, sliceW = waveformC.width / bufferLen;
    for (let i = 0; i < bufferLen; i++) {
      const v = dataArray[i]*0.5 + 0.5;
      const y = v * waveformC.height;
      i===0 ? waveCtx.moveTo(x,y) : waveCtx.lineTo(x,y);
      x += sliceW;
    }
    waveCtx.stroke();

    // — b) Pitch detect & transient smoothing —
    const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
    if (pitch > 0) {
      // Compute nearest MIDI note
      const noteNum = 12*(Math.log(pitch/referenceFrequency)/Math.log(2)) + 69;
      const rounded = Math.round(noteNum);

      // Onset (RMS delta)
      let rmsVal = 0;
      for (let i=0;i<bufferLen;i++) rmsVal += dataArray[i]*dataArray[i];
      rmsVal = Math.sqrt(rmsVal/bufferLen);
      if (rmsVal > prevRms * 1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rmsVal;

      // —— Slower α stages ——
      const dt = audioContext.currentTime - lastPluckTime;
      let alpha;
      if (dt < 0.05)       alpha = 0.005;
      else if (dt < 0.2)   alpha = 0.02;
      else                  alpha = 0.05;

      // Smooth semitone detune
      const detRaw = noteNum - rounded;
      smoothedDetune = alpha * detRaw + (1 - alpha) * smoothedDetune;

      // —— Non-linear mapping to ±30° ——  
      const centsNorm = Math.max(-100, Math.min(100, smoothedDetune*100));
      const sgn       = centsNorm < 0 ? -1 : 1;
      const rnorm2    = Math.abs(centsNorm)/100;
      const curve2    = Math.sqrt(rnorm2);
      const angOff2   = sgn * curve2 * maxAngle;
      const angNeedle = Math.PI/2 + angOff2;

      // — c) Draw needle only —
      needleCtx.clearRect(0,0,needleCanvas.width,needleCanvas.height);
      needleCtx.save();
      needleCtx.translate(cx, cy);
      needleCtx.rotate(angNeedle);
      needleCtx.lineWidth   = 4;
      needleCtx.strokeStyle = '#f0f';
      needleCtx.beginPath();
      needleCtx.moveTo(0,0);
      needleCtx.lineTo(0, -radius*0.85);
      needleCtx.stroke();
      needleCtx.restore();

      // — d) Throttled UI updates —
      const now = performance.now();
      if (now - lastUiUpdate > uiInterval) {
        // Note context strip
        const center = rounded;
        [prev2,prev1,noteMain,next1,next2].forEach((el,i) => {
          const off = i - 2;
          const n   = center + off;
          el.textContent = noteStrings[(n%12+12)%12] + Math.floor(n/12);
          el.classList.toggle('note-large', off===0);
        });
        // Frequency readout
        freqDisplay.textContent = Math.round(pitch) + ' Hz';
        // Highlight nearest string
        let bestI=0, bestD=Infinity;
        currentStrings.forEach((nm,i) => {
          const pc   = nm.match(/^[A-G]#?/)[0];
          const oct  = parseInt(nm.slice(-1),10);
          const semi = noteStrings.indexOf(pc) + oct*12;
          const fstr = referenceFrequency * Math.pow(2,(semi-69)/12);
          const dval = Math.abs(pitch - fstr);
          if (dval < bestD) { bestD = dval; bestI = i; }
        });
        Array.from(stringRow.children).forEach((btn,i) => {
          btn.classList.toggle('active', i===bestI);
        });

        lastUiUpdate = now;
      }
    } // end pitch>0
  }

  draw();
})();
