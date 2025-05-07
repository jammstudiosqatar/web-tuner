// tuner.js
(async function() {
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported.</p>';
    return;
  }

  // Autocorrelation (ACF2+)
  function autoCorrelate(buf, sr) {
    const N = buf.length;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / N);
    if (rms < 0.01) return -1;

    let r1=0, r2=N-1, th=0.2;
    for (let i=0; i<N/2; i++) if (Math.abs(buf[i])<th) { r1=i; break; }
    for (let i=1; i<N/2; i++) if (Math.abs(buf[N-i])<th) { r2=N-i; break; }
    const slice = buf.slice(r1, r2);

    const C = new Array(slice.length).fill(0);
    for (let i=0; i<slice.length; i++)
      for (let j=0; j+i<slice.length; j++)
        C[i] += slice[j] * slice[j+i];

    let d=0;
    while (C[d] > C[d+1]) d++;
    let maxpos=d, maxv=-Infinity;
    for (let i=d; i<C.length; i++) {
      if (C[i] > maxv) { maxv=C[i]; maxpos=i; }
    }

    let T0 = maxpos;
    const x1=C[T0-1], x2=C[T0], x3=C[T0+1];
    const a=(x1+x3-2*x2)/2, b=(x3-x1)/2;
    if (a) T0 -= b/(2*a);

    return sr / T0;
  }

  // DOM refs
  const [prev2,prev1,noteMain,next1,next2] =
    ['prev2','prev1','noteMain','next1','next2'].map(id=>document.getElementById(id));
  const meterCanvas = document.getElementById('meterCanvas');
  const needleCanvas= document.getElementById('needleCanvas');
  const waveformC   = document.getElementById('waveformCanvas');
  const freqDisplay = document.getElementById('freqDisplay');
  const presetDesc  = document.getElementById('presetDesc');

  const meterCtx  = meterCanvas.getContext('2d');
  const needleCtx = needleCanvas.getContext('2d');
  const waveCtx   = waveformC.getContext('2d');

  // State & consts
  let referenceFrequency = 440,
      prevRms = 0,
      lastPluckTime = 0,
      smoothedDetune = 0,
      lastUiUpdate = 0,
      deadzoneStartTime = null;

  const uiInterval  = 250,
        noteStrings = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'],
        exponent    = 0.3,
        maxAngle    = Math.PI/3; // ±60°

  presetDesc.textContent = 'Guitar, 6-String Standard, Equal tempered';

  // Audio setup
  const stream       = await navigator.mediaDevices.getUserMedia({audio:true});
  const audioContext = new (window.AudioContext||window.webkitAudioContext)();
  const source       = audioContext.createMediaStreamSource(stream);
  const analyser     = audioContext.createAnalyser();
  analyser.fftSize   = 2048;
  source.connect(analyser);

  const bufferLen = analyser.fftSize;
  const dataArray = new Float32Array(bufferLen);

  // Gauge geometry (square canvas: 1440×1440)
  const cw    = meterCanvas.width,
        ch    = meterCanvas.height,
        cx    = cw/2,
        cy    = ch,
        radius= cw / (2 * Math.cos(maxAngle)),
        innerR= radius * 0.6,
        outerR= radius * 0.9,
        ticks = 20;

  // Precompute the arc gradient
  const grad = meterCtx.createLinearGradient(0, cy - outerR, 0, cy);
  grad.addColorStop(0, '#0ff');
  grad.addColorStop(0.5, '#0aa');
  grad.addColorStop(1, '#033');

  // Draw neon arc + ticks
  function drawGauge() {
    meterCtx.clearRect(0,0,cw,ch);
    meterCtx.lineCap = 'round';

    // 1) glowing arc
    meterCtx.save();
    meterCtx.shadowBlur   = 24;
    meterCtx.shadowColor  = 'rgba(0,255,255,0.8)';
    meterCtx.lineWidth    = 12;
    meterCtx.strokeStyle  = grad;
    meterCtx.beginPath();
    meterCtx.arc(cx, cy, outerR, Math.PI/2 + maxAngle, Math.PI/2 - maxAngle, true);
    meterCtx.stroke();
    meterCtx.restore();

    // 2) inner ticks (darker)
    for (let i=0; i<=ticks; i++) {
      const cents = -100 + (i*200/ticks),
            norm  = cents/100,
            sgn   = norm<0?-1:1,
            rpos  = sgn*Math.pow(Math.abs(norm), exponent),
            off   = rpos*maxAngle,
            theta = -Math.PI/2 + off;

      const x1 = cx + innerR*Math.cos(theta),
            y1 = cy + innerR*Math.sin(theta),
            x2 = cx + outerR*Math.cos(theta),
            y2 = cy + outerR*Math.sin(theta),
            isMajor = (i%5===0);

      meterCtx.strokeStyle = isMajor ? '#bbb' : '#444';
      meterCtx.lineWidth   = isMajor ? 4 : 2;
      meterCtx.beginPath();
      meterCtx.moveTo(x1,y1);
      meterCtx.lineTo(x2,y2);
      meterCtx.stroke();

      if (isMajor) {
        meterCtx.fillStyle    = '#bbb';
        meterCtx.font         = '18px Arial';
        meterCtx.textAlign    = 'center';
        meterCtx.textBaseline = 'middle';
        const labelR = radius*0.45,
              lx     = cx + labelR*Math.cos(theta),
              ly     = cy + labelR*Math.sin(theta),
              txt    = (cents>0?'+':'')+cents;
        meterCtx.fillText(txt, lx, ly);
      }
    }
  }
  drawGauge();

  // Animation loop
  function draw() {
    requestAnimationFrame(draw);

    // waveform
    analyser.getFloatTimeDomainData(dataArray);
    waveCtx.clearRect(0,0,waveformC.width,waveformC.height);
    waveCtx.lineWidth   = 2;
    waveCtx.strokeStyle = '#0ff';
    waveCtx.beginPath();
    for (let i=0,x=0; i<bufferLen; i++, x+=waveformC.width/bufferLen) {
      const v = dataArray[i]*0.5+0.5,
            y = v*waveformC.height;
      i===0 ? waveCtx.moveTo(x,y) : waveCtx.lineTo(x,y);
    }
    waveCtx.stroke();

    // pitch & smoothing
    const pitch = autoCorrelate(dataArray,audioContext.sampleRate);
    if (pitch>0) {
      const noteNum = 12*(Math.log(pitch/referenceFrequency)/Math.log(2))+69,
            rounded = Math.round(noteNum);

      // onset
      let rms=0;
      for (let i=0;i<bufferLen;i++) rms+=dataArray[i]**2;
      rms=Math.sqrt(rms/bufferLen);
      if (rms>prevRms*1.3) lastPluckTime = audioContext.currentTime;
      prevRms = rms;

      // smoothing
      const dt    = audioContext.currentTime-lastPluckTime,
            alpha = dt<0.05?0.00075:dt<0.5?0.001875:0.00375,
            detRaw=noteNum-rounded;
      smoothedDetune = alpha*detRaw + (1-alpha)*smoothedDetune;

      // deadzone ±0.2c after 200ms
      const cents = smoothedDetune*100,
            nowMs = performance.now();
      let displayDetune = smoothedDetune;
      if (Math.abs(cents)<0.2) {
        if (!deadzoneStartTime) deadzoneStartTime = nowMs;
        if (nowMs-deadzoneStartTime>=200) {
          displayDetune = 0;
          noteMain.classList.add('tuned');
        } else noteMain.classList.remove('tuned');
      } else {
        deadzoneStartTime = null;
        noteMain.classList.remove('tuned');
      }

      // needle
      const normC = Math.max(-100,Math.min(100,displayDetune*100)),
            sgn   = normC<0?-1:1,
            absC  = Math.abs(normC),
            midDeg= maxAngle/3;
      let off;
      if (absC<=2) off = (absC/2)*midDeg*sgn;
      else {
        const rem=(absC-2)/98;
        off = sgn*(midDeg+Math.pow(rem,exponent)*(maxAngle-midDeg));
      }

      needleCtx.clearRect(0,0,needleCanvas.width,needleCanvas.height);
      needleCtx.save();
      needleCtx.translate(cx,cy);
      needleCtx.rotate(off);
      needleCtx.lineWidth   = 4;
      needleCtx.strokeStyle = '#f0f';
      needleCtx.shadowBlur   = 12;
      needleCtx.shadowColor  = 'rgba(255,0,255,0.6)';
      needleCtx.beginPath();
      needleCtx.moveTo(0,0);
      needleCtx.lineTo(0,-outerR);
      needleCtx.stroke();
      needleCtx.restore();

      // UI throttle
      if (nowMs - lastUiUpdate > uiInterval) {
        [prev2,prev1,noteMain,next1,next2].forEach((el,i) => {
          const d = i-2, n = rounded + d;
          el.textContent = noteStrings[(n%12+12)%12] + Math.floor(n/12);
        });
        freqDisplay.textContent = Math.round(pitch) + ' Hz';
        lastUiUpdate = nowMs;
      }
    }
  }

  draw();
})();
