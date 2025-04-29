// tuner.js
(async function() {
  // —— Feature check ——  
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone not supported.</p>';
    return;
  }

  // —— Autocorrelation pitch detector (ACF2+) ——  
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;

    // trim silence edges
    let r1 = 0, r2 = SIZE - 1, thres = 0.2;
    for (let i = 0; i < SIZE/2; i++)
      if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    for (let i = 1; i < SIZE/2; i++)
      if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
    buf = buf.slice(r1, r2);

    // autocorrelation
    const newSize = buf.length;
    const c = new Array(newSize).fill(0);
    for (let i = 0; i < newSize; i++)
      for (let j = 0; j < newSize - i; j++)
        c[i] += buf[j] * buf[j + i];

    // find peak
    let d = 0;
    while (c[d] > c[d+1]) d++;
    let maxpos = d, maxval = -Infinity;
    for (let i = d; i < newSize; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }

    // parabolic interpolation
    let T0 = maxpos;
    const x1 = c[T0-1], x2 = c[T0], x3 = c[T0+1];
    const a = (x1 + x3 - 2*x2)/2;
    const b = (x3 - x1)/2;
    if (a) T0 = T0 - b/(2*a);

    return sampleRate / T0;
  }

  // —— Grab DOM nodes ——  
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

  // —— State ——  
  let referenceFrequency = 440;
  let currentPresetName  = Object.keys(window.tuningPresets)[0];
  let currentStrings     = window.tuningPresets[currentPresetName];
  let prevRms            = 0;
  let lastPluckTime      = 0;
  let smoothedDetune     = 0;
  let lastUiUpdate       = 0;
  const uiInterval       = 250; // ms
  const noteStrings      = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

  // —— Set up preset description & string buttons ——  
  function renderStringButtons() {
    stringRow.innerHTML = '';
    currentStrings.forEach(noteName => {
      const btn = document.createElement('button');
      btn.textContent = noteName;
      if (noteName === noteMain.textContent) btn.classList.add('active');
      stringRow.appendChild(btn);
    });
    presetDesc.textContent = `Guitar, ${currentPresetName}, Equal tempered`;
  }
  renderStringButtons();

  // —— Audio setup ——  
  const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext||window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);
  const bufferLen    = analyser.fftSize;
  const dataArray    = new Float32Array(bufferLen);

  // —— Gauge tick layout ——  
  const cw     = meterCanvas.width;
  const ch     = meterCanvas.height;
  const cx     = cw/2;
  const cy     = ch;
  const radius = cw * 0.45;
  function drawGaugeTicks() {
    meterCtx.clearRect(0,0,cw,ch);
    for (let i=0; i<=20; i++) {
      const ang = Math.PI - (i/20)*Math.PI;
      const r1  = radius*0.85;
      const x1  = cx + r1*Math.cos(ang);
      const y1  = cy + r1*Math.sin(ang);
      const x2  = cx + radius*Math.cos(ang);
      const y2  = cy + radius*Math.sin(ang);
      meterCtx.strokeStyle = '#444';
      meterCtx.lineWidth   = (i%5===0?3:1);
      meterCtx.beginPath();
      meterCtx.moveTo(x1,y1);
      meterCtx.lineTo(x2,y2);
      meterCtx.stroke();
    }
  }
  drawGaugeTicks();

  // —— Main draw loop ——  
  function draw() {
    requestAnimationFrame(draw);

    // 1) Waveform  
    analyser.getFloatTimeDomainData(dataArray);
    waveCtx.fillStyle   = '#111';
    waveCtx.fillRect(0,0,waveformC.width,waveformC.height);
    waveCtx.lineWidth   = 2;
    waveCtx.strokeStyle = '#0ff';
    waveCtx.beginPath();
    let x = 0, sliceW = waveformC.width / bufferLen;
    for (let i=0; i<bufferLen; i++) {
      const v = dataArray[i]*0.5 + 0.5;
      const y = v * waveformC.height;
      i===0? waveCtx.moveTo(x,y) : waveCtx.lineTo(x,y);
      x += sliceW;
    }
    waveCtx.stroke();

    // 2) Pitch detection & transient smoothing  
    const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
    if (pitch > 0) {
      // nearest MIDI note  
      const noteNum = 12*(Math.log(pitch/referenceFrequency)/Math.log(2)) + 69;
      const rounded = Math.round(noteNum);

      // RMS onset  
      let rms=0;
      for (let i=0;i<bufferLen;i++) rms+=dataArray[i]*dataArray[i];
      rms = Math.sqrt(rms/bufferLen);
      if (rms > prevRms*1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rms;

      // —— SLOWER smoothing α ——  
      const delta = audioContext.currentTime - lastPluckTime;
      let alpha;
      if (delta < 0.05)        alpha = 0.005;
      else if (delta < 0.2)    alpha = 0.02;
      else                     alpha = 0.05;

      // raw semitone detune  
      const detRaw = noteNum - rounded;
      smoothedDetune = alpha*detRaw + (1-alpha)*smoothedDetune;

      // —— Non‐linear angle mapping ——  
      const centsNorm = Math.max(-100, Math.min(100, smoothedDetune*100));
      const r         = Math.abs(centsNorm)/100;
      const curved    = Math.sqrt(r);
      const angle     = Math.sign(centsNorm) * curved * (Math.PI/2);

      // redraw the base ticks  
      drawGaugeTicks();

      // 3) Draw dynamic green arc  
      meterCtx.save();
      meterCtx.translate(cx, cy);
      meterCtx.strokeStyle = '#0f0';
      meterCtx.lineWidth   = 5;
      meterCtx.beginPath();
      meterCtx.arc(0,0,radius*0.9,
        Math.PI - angle,
        Math.PI + angle
      );
      meterCtx.stroke();
      meterCtx.restore();

      // 4) Draw the needle  
      needleCtx.clearRect(0,0,needleCanvas.width,needleCanvas.height);
      needleCtx.save();
      needleCtx.translate(cx, cy);
      needleCtx.rotate(angle);
      needleCtx.lineWidth   = 4;
      needleCtx.strokeStyle = '#f0f';
      needleCtx.beginPath();
      needleCtx.moveTo(0,0);
      needleCtx.lineTo(0,-radius*0.75);
      needleCtx.stroke();
      needleCtx.restore();

      // 5) Throttled UI updates  
      const now = performance.now();
      if (now - lastUiUpdate > uiInterval) {
        // note context strip  
        const center = rounded;
        [prev2,prev1,noteMain,next1,next2].forEach((el, idx) => {
          const off = idx - 2;
          const n   = center + off;
          el.textContent = noteStrings[(n%12+12)%12] + Math.floor(n/12);
          el.classList.toggle('note-large', off===0);
        });

        // frequency display  
        freqDisplay.textContent = Math.round(pitch) + ' Hz';

        // highlight closest string  
        let bestIdx=0, bestD=Infinity;
        currentStrings.forEach((ns,i) => {
          const pc       = ns.match(/^[A-G]#?/)[0];
          const oct      = parseInt(ns.slice(-1),10);
          const semi     = noteStrings.indexOf(pc) + oct*12;
          const freqStr  = referenceFrequency * Math.pow(2,(semi-69)/12);
          const d        = Math.abs(pitch - freqStr);
          if (d < bestD) { bestD = d; bestIdx = i; }
        });
        Array.from(stringRow.children).forEach((btn,i) => {
          btn.classList.toggle('active', i===bestIdx);
        });

        lastUiUpdate = now;
      }
    }
  }

  draw();
})();
