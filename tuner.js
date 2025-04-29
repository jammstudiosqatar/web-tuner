// tuner.js
(async function() {
  const tunerDiv = document.getElementById('tuner');
  if (!navigator.mediaDevices?.getUserMedia) {
    tunerDiv.innerHTML = '<p>Microphone access not supported.</p>';
    return;
  }

  // … all existing pitch-detection, smoothing, throttling logic unchanged …
  // (autocorrelate, transient smoothing, draw loop, etc.)

  // ────────────────────────────────────────────────
  // ↓↓↓ NEW: after your UI build, wire up settings ↓↓↓

  // 1️⃣ Settings button → open overlay
  const settingsBtn   = document.getElementById('settingsButton');
  const overlay       = document.getElementById('settingsOverlay');
  const closeSettings = document.getElementById('closeSettings');
  settingsBtn.addEventListener('click',   () => overlay.classList.add('open'));
  closeSettings.addEventListener('click', () => overlay.classList.remove('open'));

  // 2️⃣ Populate presetSelect & refFreqInput initial value
  const refFreqInput  = document.getElementById('refFreqInput');
  const presetSelect  = document.getElementById('presetSelect');
  refFreqInput.value  = referenceFrequency;
  Object.keys(window.tuningPresets).forEach(name => {
    const opt = document.createElement('option');
    opt.textContent = name;
    presetSelect.appendChild(opt);
  });
  presetSelect.value = Object.keys(window.tuningPresets)[0];
  currentStrings     = window.tuningPresets[presetSelect.value];

  // 3️⃣ Update globals on change
  refFreqInput.addEventListener('input', () => {
    referenceFrequency = parseFloat(refFreqInput.value) || 440;
  });
  presetSelect.addEventListener('change', () => {
    currentStrings = window.tuningPresets[presetSelect.value];
  });

  // 4️⃣ Inject individual string buttons at the bottom
  const stringButtons = document.getElementById('stringButtons');
  function renderStringButtons() {
    stringButtons.innerHTML = '';
    currentStrings.forEach(noteName => {
      const btn = document.createElement('button');
      btn.textContent = noteName;
      btn.addEventListener('click', () => {
        // e.g. force-tune detection to this string’s freq
        // (we can hook this up later)
      });
      stringButtons.appendChild(btn);
    });
  }
  renderStringButtons();
  // re-render whenever preset changes
  presetSelect.addEventListener('change', renderStringButtons);

  // ────────────────────────────────────────────────
  // Now start your draw() loop…
})();
