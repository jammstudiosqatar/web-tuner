// tuner.js
(async function() {
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported.</p>';
    return;
  }

  // Autocorrelation pitch detector (ACF2+)
  function autoCorrelate(buf, sampleRate) {
    const SIZE = buf.length;
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;  // too quiet

    let r1 = 0, r2 = SIZE - 1, thres = 0.2;
    for (let i = 0; i < SIZE / 2; i++)
      if (Math.abs(buf[i]) < thres) { r1 = i; break; }
    for (let i = 1; i < SIZE / 2; i++)
      if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
    buf = buf.slice(r1, r2);

    const newSize = buf.length;
    const c = new Array(newSize).fill(0);
    for (let i = 0; i < newSize; i++)
      for (let j = 0; j < newSize - i; j++)
        c[i] += buf[j] * buf[j + i];

    let d = 0;
    while (c[d] > c[d + 1]) d++;
    let maxval = -1, maxpos = -1;
    for (let i = d; i < newSize; i++) {
      if (c[i] > maxval) { maxval = c[i]; maxpos = i; }
    }
    let T0 = maxpos;
    // parabolic interpolation for better accuracy
    const x1 = c[T0 - 1], x2 = c[T0], x3 = c[T0 + 1];
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    if (a) T0 = T0 - b / (2 * a);

    return sampleRate / T0;
  }

  // —— transient & smoothing state ——
  let prevRms = 0;
  let lastPluckTime = 0;
  let smoothedDetune = 0;

  try {
    // 1️⃣ Get mic audio
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    // 2️⃣ Build the UI
    tunerDiv.innerHTML = `
      <canvas id="waveform" width="300" height="100"></canvas>
      <div id="note" style="font-size:1.5em; margin:8px;">--</div>
      <canvas id="needle" width="300" height="100"></canvas>
    `;
    const waveCanvas   = document.getElementById('waveform');
    const waveCtx      = waveCanvas.getContext('2d');
    const needleCanvas = document.getElementById('needle');
    const needleCtx    = needleCanvas.getContext('2d');
    const noteElem     = document.getElementById('note');
    const bufferLen    = analyser.fftSize;
    const dataArray    = new Float32Array(bufferLen);
    const noteStrings  = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

    // 3️⃣ Animation & analysis loop
    function draw() {
      requestAnimationFrame(draw);
      analyser.getFloatTimeDomainData(dataArray);

      // — Waveform drawing
      waveCtx.fillStyle   = '#f5f5f5';
      waveCtx.fillRect(0, 0, waveCanvas.width, waveCanvas.height);
      waveCtx.lineWidth   = 2;
      waveCtx.strokeStyle = '#333';
      waveCtx.beginPath();
      const sliceW = waveCanvas.width / bufferLen;
      let x = 0;
      for (let i = 0; i < bufferLen; i++) {
        const v = dataArray[i] * 0.5 + 0.5;
        const y = v * waveCanvas.height;
        i === 0 ? waveCtx.moveTo(x, y) : waveCtx.lineTo(x, y);
        x += sliceW;
      }
      waveCtx.lineTo(waveCanvas.width, waveCanvas.height / 2);
      waveCtx.stroke();

      // — Pitch detection
      const pitch = autoCorrelate(dataArray, audioContext.sampleRate);
      if (pitch !== -1) {
        // map to fractional MIDI note
        const noteNum = 12 * (Math.log(pitch / 440) / Math.log(2)) + 69;
        const rounded = Math.round(noteNum);

        // —— INSERT: transient‐aware smoothing —— 
        // 1️⃣ Compute RMS energy
        let rms = 0;
        for (let i = 0; i < bufferLen; i++) rms += dataArray[i] * dataArray[i];
        rms = Math.sqrt(rms / bufferLen);

        // 2️⃣ Onset detection
        const onsetThreshold = 1.3;
        if (rms > prevRms * onsetThreshold) {
          lastPluckTime = audioContext.currentTime;
        }
        prevRms = rms;

        // 3️⃣ Adaptive smoothing α
        const delta = audioContext.currentTime - lastPluckTime;
        let alpha;
        if (delta < 0.05)         alpha = 0.02;  // heavy smoothing
        else if (delta < 0.2)     alpha = 0.1;   // medium smoothing
        else                      alpha = 0.2;   // normal smoothing

        // 4️⃣ Smooth detune
        const detuneRaw = noteNum - rounded;  // ±0.5 semitones
        smoothedDetune = alpha * detuneRaw + (1 - alpha) * smoothedDetune;
        const angle = smoothedDetune * (Math.PI / 4);
        // —— END INSERT —— 

        // — Display note text
        const octave = Math.floor(rounded / 12);
        noteElem.textContent = `${noteStrings[rounded % 12]}${octave} (${pitch.toFixed(2)} Hz)`;

        // — Draw the needle
        needleCtx.clearRect(0, 0, needleCanvas.width, needleCanvas.height);
        needleCtx.save();
        needleCtx.translate(needleCanvas.width / 2, needleCanvas.height);
        needleCtx.rotate(angle);
        needleCtx.lineWidth = 4;
        needleCtx.beginPath();
        needleCtx.moveTo(0, 0);
        needleCtx.lineTo(0, -80);
        needleCtx.stroke();
        needleCtx.restore();

      } else {
        // no pitch: clear display
        noteElem.textContent = '--';
        needleCtx.clearRect(0, 0, needleCanvas.width, needleCanvas.height);
      }
    }

    draw();
  } catch (err) {
    tunerDiv.innerHTML = `<p>Error accessing mic: ${err.message}</p>`;
  }
})();
