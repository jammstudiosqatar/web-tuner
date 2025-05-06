// tuner.js
(async function() {
  // 1) Feature check
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported.</p>';
    return;
  }

  // 2) Autocorrelation pitch detector (ACF2+)
  function autoCorrelate(buf, sr) {
    const N = buf.length;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / N);
    if (rms < 0.01) return -1;

    // trim quiet edges
    let r1 = 0, r2 = N - 1, th = 0.2;
    for (let i = 0; i < N/2; i++) if (Math.abs(buf[i]) < th) { r1 = i; break; }
    for (let i = 1; i < N/2; i++) if (Math.abs(buf[N-i]) < th) { r2 = N-i; break; }
    const slice = buf.slice(r1, r2);

    // autocorrelation
    const C = new Array(slice.length).fill(0);
    for (let i = 0; i < slice.length; i++)
      for (let j = 0; j + i < slice.length; j++)
        C[i] += slice[j] * slice[j + i];

    // find peak
    let d = 0;
    while (C[d] > C[d+1]) d++;
    let maxpos = d, maxv = -Infinity;
    for (let i = d; i < C.length; i++) {
      if (C[i] > maxv) { maxv = C[i]; maxpos = i; }
    }

    // parabolic interpolation
    let T0 = maxpos;
    const x1 = C[T0-1], x2 = C[T0], x3 = C[T0+1];
    const a  = (x1 + x3 - 2*x2)/2;
    const b  = (x3 - x1)/2;
    if (a) T0 -= b/(2*a);

    return sr / T0;
  }

  // 3) DOM refs & contexts
  const prev2       = document.getElementById('prev2');
  const prev1       = document.getElementById('prev1');
  const noteMain    = document.getElementById('noteMain');
  const next1       = document.getElementById('next1');
  const next2       = document.getElementById('next2');
  const meterCanvas = document.getElementById('meterCanvas');
  const needleCanvas= document.getElementById('needleCanvas');
  const waveformC   = document.getElementById('waveformCanvas');
  const freqDisplay = document.getElementById('freqDisplay');
  const presetDesc  = document.getElementById('presetDesc');

  const meterCtx  = meterCanvas.getContext('2d');
  const needleCtx = needleCanvas.getContext('2d');
  const waveCtx   = waveformC.getContext('2d');

  // 4) State & consts
  let referenceFrequency = 440;
  let prevRms            = 0;
  let lastPluckTime      = 0;
  let smoothedDetune     = 0;
  let lastUiUpdate       = 0;
  let deadzoneStartTime  = null;

  const uiInterval  = 250;    // ms text throttle
  const noteStrings = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  const exponent    = 0.3;    // compress extremes
  const maxAngle    = Math.PI/3;  // 60°

  // initialize description
  presetDesc.textContent = 'Guitar, 6-String Standard, Equal tempered';

  // 5) Audio setup
  const stream       = await navigator.mediaDevices.getUserMedia({ audio: true });
  const audioContext = new (window.AudioContext||window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);

  const bufferLen = analyser.fftSize;
  const dataArray = new Float32Array(bufferLen);

  // 6) Gauge geometry
  const cw    = meterCanvas.width;   // e.g. 1440
  const ch    = meterCanvas.height;  // e.g. 720
  const cx    = cw/2;
  const cy    = ch;                  // pivot at bottom edge
  const radius= cw/(2*Math.cos(maxAngle));
  const innerR= radius*0.85;
  const outerR= radius*0.95;
  const ticks = 20;                  // 10-cent steps

  // draw static ticks + labels
  function drawGaugeTicks() {
    meterCtx.clearRect(0,0,cw,ch);
    meterCtx.lineCap = 'round';

    for (let i=0; i<=ticks; i++) {
      const cents = -100 + (i*(200/ticks));
      const norm  = cents/100;
      const sgn   = norm<0 ? -1 : 1;
      const rpos  = sgn * Math.pow(Math.abs(norm), exponent);
      const off   = rpos * maxAngle;
      const theta = -Math.PI/2 + off;

      // endpoints
      const x1 = cx + innerR * Math.cos(theta);
      const y1 = cy + innerR * Math.sin(theta);
      const x2 = cx + outerR * Math.cos(theta);
      const y2 = cy + outerR * Math.sin(theta);

      const isMajor = (i%5===0);
      meterCtx.strokeStyle = isMajor
        ? 'rgba(255,255,255,0.6)'
        : 'rgba(255,255,255,0.2)';
      meterCtx.lineWidth = isMajor ? 4 : 2;
      meterCtx.beginPath();
      meterCtx.moveTo(x1,y1);
      meterCtx.lineTo(x2,y2);
      meterCtx.stroke();

      // label majors
      if (isMajor) {
        meterCtx.fillStyle    = '#ccc';
        meterCtx.font         = '14px Arial';
        meterCtx.textAlign    = 'center';
        meterCtx.textBaseline = 'middle';
        const labelR = radius * 0.47;
        const lx     = cx + labelR * Math.cos(theta);
        const ly     = cy + labelR * Math.sin(theta);
        const txt    = (cents>0?'+':'') + cents;
        meterCtx.fillText(txt, lx, ly);
      }
    }
  }
  drawGaugeTicks();

  // 7) Main draw loop
  function draw() {
    requestAnimationFrame(draw);

    // a) waveform
    analyser.getFloatTimeDomainData(dataArray);
    waveCtx.fillStyle   = '#111';
    waveCtx.fillRect(0,0,waveformC.width,waveformC.height);
    waveCtx.lineWidth   = 2;
    waveCtx.strokeStyle = '#0ff';
    waveCtx.beginPath();
    let x = 0, step = waveformC.width/bufferLen;
    for (let i=0; i<bufferLen; i++) {
      const v = dataArray[i]*0.5 + 0.5;
      const y = v*waveformC.height;
      i===0 ? waveCtx.moveTo(x,y) : waveCtx.lineTo(x,y);
      x += step;
    }
    waveCtx.stroke();

    // b) pitch detect & smoothing
    const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
    if (pitch>0) {
      const noteNum = 12*(Math.log(pitch/referenceFrequency)/Math.log(2))+69;
      const rounded = Math.round(noteNum);

      // onset RMS
      let rms=0;
      for (let i=0;i<bufferLen;i++) rms+=dataArray[i]*dataArray[i];
      rms = Math.sqrt(rms/bufferLen);
      if (rms>prevRms*1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rms;

      // split-alpha smoothing
      const dt    = audioContext.currentTime - lastPluckTime;
      const alpha = dt<0.05  ? 0.00075
                  : dt<0.5   ? 0.001875
                  :             0.00375;
      const detRaw = noteNum - rounded;
      smoothedDetune = alpha*detRaw + (1-alpha)*smoothedDetune;

      // dead-zone ±0.2c after 200 ms
      const cents = smoothedDetune*100;
      const nowMs = performance.now();
      let displayDetune = smoothedDetune;
      if (Math.abs(cents)<0.2) {
        if (deadzoneStartTime===null) deadzoneStartTime = nowMs;
        if (nowMs - deadzoneStartTime >= 200) {
          displayDetune = 0;
          noteMain.classList.add('tuned');
        } else {
          noteMain.classList.remove('tuned');
        }
      } else {
        deadzoneStartTime = null;
        noteMain.classList.remove('tuned');
      }

      // c) piecewise angle mapping
      const centVal = Math.max(-100, Math.min(100, displayDetune*100));
      const sign    = centVal<0 ? -1 : 1;
      const absC    = Math.abs(centVal);
      let off;
      const midDeg = Math.PI/18;  // 10°
      const fullDeg= maxAngle;    // 30°
      if (absC <= 2) {
        // linear ±2c → ±10°
        off = (absC/2)*midDeg * sign;
      } else {
        // outside: compress ±98c → ±20°
        const remNorm = (absC-2)/98;
        off = sign*( midDeg + Math.pow(remNorm, exponent)*(fullDeg-midDeg) );
      }

      // draw needle
      needleCtx.clearRect(0,0,needleCanvas.width,needleCanvas.height);
      needleCtx.save();
      needleCtx.translate(cx, cy);
      needleCtx.rotate(off);
      needleCtx.lineWidth   = 4;
      needleCtx.strokeStyle = '#f0f';
      needleCtx.beginPath();
      needleCtx.moveTo(0,0);
      needleCtx.lineTo(0, -outerR);
      needleCtx.stroke();
      needleCtx.restore();

      // d) throttled UI
      if (nowMs - lastUiUpdate > uiInterval) {
        const center = rounded;
        [prev2,prev1,noteMain,next1,next2].forEach((el,i) => {
          const d = i-2, n = center+d;
          el.textContent = noteStrings[(n%12+12)%12] + Math.floor(n/12);
          el.classList.toggle('note-large', d===0);
        });
        freqDisplay.textContent = Math.round(pitch)+' Hz';
        lastUiUpdate = nowMs;
      }
    }
  }

  draw();
})();
