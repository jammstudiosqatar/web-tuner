// tuner.js
(async function() {
  const tunerDiv = document.getElementById('tuner');
  // 1️⃣ Check browser support
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported in this browser.</p>';
    return;
  }

  try {
    // 2️⃣ Ask user for microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 3️⃣ Create an AudioContext to process the audio
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);

    // 4️⃣ Create an AnalyserNode for visualizing the waveform
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048; // resolution of the waveform data
    source.connect(analyser);

    // 5️⃣ Inject a <canvas> into the page so we can draw the waveform
    tunerDiv.innerHTML = '<canvas id="waveform" width="300" height="100"></canvas>';
    const canvas = document.getElementById('waveform');
    const ctx = canvas.getContext('2d');

    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);

    // 6️⃣ Animation loop: grab the time-domain data and draw it
    function draw() {
      requestAnimationFrame(draw);
      analyser.getFloatTimeDomainData(dataArray);

      // clear
      ctx.fillStyle = '#f5f5f5';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // draw the waveform
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#333';
      ctx.beginPath();
      const sliceWidth = canvas.width / bufferLength;
      let x = 0;
      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] * 0.5 + 0.5;
        const y = v * canvas.height;
        if (i === 0) ctx.moveTo(x, y);
        else        ctx.lineTo(x, y);
        x += sliceWidth;
      }
      ctx.lineTo(canvas.width, canvas.height / 2);
      ctx.stroke();
    }
    draw();

  } catch (err) {
    // If the user blocks mic or an error occurs
    tunerDiv.innerHTML = '<p>Error accessing microphone: ' + err.message + '</p>';
  }
})();
