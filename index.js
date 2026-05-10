/*
 * ST-Hands-Free-Voice — patched build
 * ----------------------------------------------------------------------
 * Drop-in replacement for:
 *   SillyTavern\public\scripts\extensions\third-party\ST-Hands-Free-Voice\index.js
 *
 * Original: https://github.com/Flaxify/ST-Hands-Free-Voice  (v2.8)
 *
 * Bugs fixed in this version (and why each one mattered):
 *
 *  1. AudioContext leak.
 *     The original set audioContext = null without ever calling .close().
 *     Browsers cap the number of live AudioContexts (~6 in Chrome).  After
 *     enough listen cycles, new ones came up dead and the mic detection
 *     silently broke.  Symptom: it worked for a while, then the mic would
 *     turn on but never trigger recording, until the page was refreshed.
 *
 *  2. AudioContext starting suspended.
 *     Some browser/autoplay states create the context in 'suspended' state.
 *     The analyser then reads zero forever.  Now we explicitly resume() it.
 *
 *  3. Mic stayed on through the AI's reply.
 *     Resources were only released after transcription + AI generation.
 *     Now mediaStream + AudioContext are released the moment recording
 *     stops, so the mic icon goes off immediately.
 *
 *  4. Pending timers / pollers leaking on stop.
 *     silenceTimer and the recording's setInterval poller were not being
 *     cleared in stopListening().  They could fire on a torn-down session.
 *
 *  5. requestAnimationFrame loop kept running during recording.
 *     Once speech was detected the rAF loop kept polling redundantly.
 *     It now exits as soon as recording starts.
 *
 *  6. isListening was never reset after recording ended.
 *     If a new TTS-ended event fired while transcription was still in
 *     flight, the next startVoiceDetection bailed early.  Now isListening
 *     is cleared the instant recording stops.
 *
 *  7. Hard-coded volume threshold (25) — couldn't be tuned without editing
 *     code.  Now exposed as a "Mic Sensitivity" setting in the panel.
 *
 *  8. Defensive: stopListening() ignores re-entrant calls; close() is
 *     wrapped in try/catch in case the context is already closed.
 *
 *  9. Floating On/Off toggle button.
 *     A fixed-position button mirrors the "Enable Hands-Free Mode" checkbox.
 *     Clicking Off immediately calls stopListening() (the old checkbox only
 *     gated future cycles — an in-progress mic session kept running).
 *     Clicking On starts listening immediately if no TTS is playing; if TTS
 *     is mid-playback, the existing 'ended' hook picks up so the mic doesn't
 *     capture TTS audio.
 *
 * 10. Force Off on chat change.
 *     CHAT_CHANGED resets enabled → false and stops any active session, so
 *     a fresh conversation always starts silent.
 *
 * Behavior NOT changed: provider list, endpoint format, message sending,
 * settings names (so your existing saved settings still load).
 */

import { eventSource, event_types, sendMessageAsUser } from '../../../../script.js';

const MODULE_NAME = "HandsFreeVoice";

const PROVIDERS = {
    openrouter: {
        label: "OpenRouter",
        endpoint: "https://openrouter.ai/api/v1",
        defaultModel: "openai/whisper-large-v3-turbo",
        format: "json_base64"
    },
    groq: {
        label: "Groq",
        endpoint: "https://api.groq.com/openai/v1",
        defaultModel: "whisper-large-v3-turbo",
        format: "multipart"
    },
    local: {
        label: "Local / Custom",
        endpoint: "",
        defaultModel: "whisper-1",
        format: "multipart"
    }
};

const defaultSettings = Object.freeze({
    enabled: false,
    provider: "openrouter",
    api_key: "",
    model: "openai/whisper-large-v3-turbo",
    custom_endpoint: "",
    delay: 5,
    speech_pause: 1.5,
    max_recording: 120,
    volume_threshold: 25,   // tunable now
    quote_speech: false
});

let settings = {};
let mediaStream = null;
let audioContext = null;
let analyserNode = null;
let recorder = null;
let silenceTimer = null;
let volumePoller = null;
let isListening = false;
let isStopping = false;     // re-entrancy guard

let ttsEndTimer = null;

// ─────────────────────────────────────────────────────────────
// TTS playback hook
// ─────────────────────────────────────────────────────────────
function hookAudioElement() {
    const audio = document.getElementById('tts_audio');
    if (!audio) {
        setTimeout(hookAudioElement, 500);
        return;
    }

    audio.addEventListener('play', () => {
        if (ttsEndTimer) {
            clearTimeout(ttsEndTimer);
            ttsEndTimer = null;
        }
    });

    audio.addEventListener('ended', () => {
        if (ttsEndTimer) clearTimeout(ttsEndTimer);
        ttsEndTimer = setTimeout(() => {
            ttsEndTimer = null;
            if (settings.enabled && !isListening) {
                console.log("🎤 TTS playback fully ended – starting hands-free listening");
                onTTSPlaybackEnded();
            }
        }, 500);
    });

    console.log("🔊 Hands-Free Voice: hooked into #tts_audio element");
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
function getEffectiveEndpoint() {
    const provider = PROVIDERS[settings.provider];
    if (!provider) return settings.custom_endpoint || '';
    return settings.provider === 'local'
        ? (settings.custom_endpoint || '').replace(/\/$/, '')
        : provider.endpoint;
}

function getCurrentVolume() {
    if (!analyserNode) return 0;
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    analyserNode.getByteFrequencyData(data);
    return data.reduce((a, b) => a + b, 0) / data.length;
}

function isTTSPlaying() {
    const audio = document.getElementById('tts_audio');
    return !!(audio && !audio.paused && !audio.ended && audio.currentTime > 0);
}

function syncToggleUI() {
    $('#hf_enabled').prop('checked', settings.enabled);
    const $btn = $('#hf_toggle_btn');
    if ($btn.length) {
        $btn.toggleClass('hf-on', !!settings.enabled);
        $btn.toggleClass('hf-off', !settings.enabled);
        $btn.attr('title', settings.enabled ? 'Voice: ON (click to turn off)' : 'Voice: OFF (click to turn on)');
        $btn.find('.hf-toggle-label').text(settings.enabled ? 'ON' : 'OFF');
        $btn.find('i').attr('class', settings.enabled ? 'fa-solid fa-microphone' : 'fa-solid fa-microphone-slash');
    }
}

async function setEnabled(enabled) {
    const wasEnabled = !!settings.enabled;
    settings.enabled = !!enabled;
    try { SillyTavern.getContext().saveSettingsDebounced(); } catch (e) { /* ignore */ }
    syncToggleUI();

    if (!enabled) {
        // Turning OFF — kill any in-progress session immediately.
        await stopListening();
        return;
    }

    // Turning ON — start listening now unless TTS is mid-playback,
    // in which case the existing 'ended' handler will start it.
    if (!wasEnabled && !isListening && !isTTSPlaying()) {
        await startVoiceDetection();
    }
}

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────
console.log("🚀 Hands-Free Voice (patched) loaded");

jQuery(() => {
    eventSource.on(event_types.APP_READY, () => {
        console.log("✅ Hands-Free Voice: APP_READY → initializing");

        const context = SillyTavern.getContext();

        if (!context.extensionSettings[MODULE_NAME]) {
            context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        }
        settings = context.extensionSettings[MODULE_NAME];

        // Migrate old "endpoint" field → provider (kept for back-compat).
        if (settings.endpoint !== undefined && settings.provider === undefined) {
            const ep = settings.endpoint || '';
            if (ep.includes('openrouter.ai')) settings.provider = 'openrouter';
            else if (ep.includes('groq.com'))  settings.provider = 'groq';
            else { settings.provider = 'local'; settings.custom_endpoint = ep; }
            delete settings.endpoint;
        }

        Object.keys(defaultSettings).forEach(key => {
            if (settings[key] === undefined) settings[key] = defaultSettings[key];
        });

        // Always start a session with voice OFF — fresh chats shouldn't
        // come up with the mic hot.
        settings.enabled = false;

        addSettingsPanel();
        console.log("✅ Settings panel added");

        addFloatingToggle();

        hookAudioElement();

        // Whenever the user switches to a different chat, force OFF and
        // tear down any active listening session.
        eventSource.on(event_types.CHAT_CHANGED, () => {
            if (settings.enabled || isListening) {
                console.log("💤 Chat changed — forcing voice OFF");
                setEnabled(false);
            }
        });

        console.log("🎤 Hands-Free Voice (patched) ready");
    });
});

function addFloatingToggle() {
    if ($('#hf_toggle_btn').length) return;

    const css = `
        <style id="hf_toggle_style">
            #hf_toggle_btn {
                position: fixed;
                right: 16px;
                bottom: 80px;
                z-index: 9999;
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 8px 12px;
                border-radius: 999px;
                border: 1px solid rgba(255,255,255,0.15);
                background: rgba(40,40,40,0.85);
                color: #ddd;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: 0 2px 8px rgba(0,0,0,0.4);
                user-select: none;
                backdrop-filter: blur(4px);
                transition: background 0.15s ease, color 0.15s ease;
            }
            #hf_toggle_btn:hover { filter: brightness(1.1); }
            #hf_toggle_btn.hf-on  { background: rgba(40,140,60,0.9); color: #fff; }
            #hf_toggle_btn.hf-off { background: rgba(80,80,80,0.85); color: #ccc; }
            #hf_toggle_btn i { font-size: 14px; }
        </style>`;
    $('head').append(css);

    const html = `
        <div id="hf_toggle_btn" role="button" tabindex="0">
            <i class="fa-solid fa-microphone-slash"></i>
            <span class="hf-toggle-label">OFF</span>
        </div>`;
    $('body').append(html);

    $('#hf_toggle_btn').on('click', () => setEnabled(!settings.enabled));
    $('#hf_toggle_btn').on('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setEnabled(!settings.enabled);
        }
    });

    syncToggleUI();
}

// ─────────────────────────────────────────────────────────────
// Settings UI
// ─────────────────────────────────────────────────────────────
function addSettingsPanel() {
    const providerOptions = Object.entries(PROVIDERS)
        .map(([key, p]) => `<option value="${key}">${p.label}</option>`)
        .join('');

    const html = `
    <div class="handsfree-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Hands-Free Voice (patched)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label><input type="checkbox" id="hf_enabled"> Enable Hands-Free Mode</label>

                <hr>
                <b>API Settings</b>

                <label>API Provider</label>
                <select id="hf_provider" class="text_pole">
                    ${providerOptions}
                </select>

                <label>API Key</label>
                <input type="password" id="hf_api_key" class="text_pole" placeholder="sk-or-... / gsk_... / 'local' for a local server">

                <label>Whisper Model</label>
                <input type="text" id="hf_model" class="text_pole" placeholder="openai/whisper-large-v3-turbo">

                <div id="hf_custom_endpoint_row" style="display:none">
                    <label>Custom Endpoint URL</label>
                    <input type="text" id="hf_custom_endpoint" class="text_pole" placeholder="http://127.0.0.1:8001/v1">
                </div>

                <hr>
                <b>Timing</b>

                <label>Silence Timeout (seconds)</label>
                <input type="number" id="hf_delay" class="text_pole" min="1" max="3600">
                <small>After TTS ends, how long to wait for you to start speaking before the character auto-continues.</small>

                <label>Speech Pause Tolerance (seconds)</label>
                <input type="number" id="hf_speech_pause" class="text_pole" min="0.1" max="10" step="0.1">
                <small>How long a pause mid-speech before recording stops and is sent for transcription.</small>

                <label>Max Recording Length (seconds)</label>
                <input type="number" id="hf_max_recording" class="text_pole" min="5" max="600">
                <small>Safety cap on recording length.</small>

                <label>Mic Sensitivity (volume threshold, 1–100)</label>
                <input type="number" id="hf_volume_threshold" class="text_pole" min="1" max="100">
                <small>Lower number = mic triggers on quieter sound. Default 25. Try 10 if your mic is quiet, 40 if room noise keeps falsely triggering it.</small>

                <hr>
                <b>Formatting</b>

                <label><input type="checkbox" id="hf_quote_speech"> Wrap speech in quotation marks</label>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    bindSettingsUI();
}

function bindSettingsUI() {
    const context = SillyTavern.getContext();

    $('#hf_enabled').prop('checked', settings.enabled).on('change', function () {
        setEnabled(this.checked);
    });

    $('#hf_provider').val(settings.provider).on('change', function () {
        settings.provider = this.value;
        const provider = PROVIDERS[settings.provider];
        if (provider) {
            settings.model = provider.defaultModel;
            $('#hf_model').val(settings.model);
        }
        updateCustomEndpointVisibility();
        context.saveSettingsDebounced();
    });

    $('#hf_api_key').val(settings.api_key).on('input', function () {
        settings.api_key = this.value.trim();
        context.saveSettingsDebounced();
    });

    $('#hf_model').val(settings.model).on('input', function () {
        settings.model = this.value.trim();
        context.saveSettingsDebounced();
    });

    $('#hf_custom_endpoint').val(settings.custom_endpoint).on('input', function () {
        settings.custom_endpoint = this.value.trim();
        context.saveSettingsDebounced();
    });

    $('#hf_delay').val(settings.delay).on('input', function () {
        settings.delay = parseFloat(this.value) || defaultSettings.delay;
        context.saveSettingsDebounced();
    });

    $('#hf_speech_pause').val(settings.speech_pause).on('input', function () {
        settings.speech_pause = parseFloat(this.value) || defaultSettings.speech_pause;
        context.saveSettingsDebounced();
    });

    $('#hf_max_recording').val(settings.max_recording).on('input', function () {
        settings.max_recording = parseFloat(this.value) || defaultSettings.max_recording;
        context.saveSettingsDebounced();
    });

    $('#hf_volume_threshold').val(settings.volume_threshold).on('input', function () {
        settings.volume_threshold = parseFloat(this.value) || defaultSettings.volume_threshold;
        context.saveSettingsDebounced();
    });

    $('#hf_quote_speech').prop('checked', settings.quote_speech).on('change', function () {
        settings.quote_speech = this.checked;
        context.saveSettingsDebounced();
    });

    updateCustomEndpointVisibility();
}

function updateCustomEndpointVisibility() {
    $('#hf_custom_endpoint_row').toggle(settings.provider === 'local');
}

// ─────────────────────────────────────────────────────────────
// Core listen → record → transcribe → send loop
// ─────────────────────────────────────────────────────────────
async function onTTSPlaybackEnded() {
    await startVoiceDetection();

    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
    silenceTimer = setTimeout(() => {
        silenceTimer = null;
        if (!isListening) return;
        console.log("⏰ No speech detected – auto-continuing");
        autoContinue();
        stopListening();
    }, (settings.delay || defaultSettings.delay) * 1000);
}

async function startVoiceDetection() {
    if (isListening) return;
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Some browsers create the context suspended (autoplay policy).
        // Without this, the analyser reads zero forever.
        if (audioContext.state === 'suspended') {
            try { await audioContext.resume(); } catch (e) { /* ignore */ }
        }

        const source = audioContext.createMediaStreamSource(mediaStream);
        analyserNode = audioContext.createAnalyser();
        analyserNode.fftSize = 512;
        source.connect(analyserNode);

        isListening = true;
        let speechDetected = false;
        const threshold = Number(settings.volume_threshold) || defaultSettings.volume_threshold;

        const checkLevel = () => {
            if (!isListening || speechDetected) return;
            const volume = getCurrentVolume();
            if (volume > threshold) {
                speechDetected = true;
                console.log(`🗣️ Speech detected (vol=${volume.toFixed(1)} > ${threshold}) – recording`);
                if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
                startRecording();
                return;     // exit rAF loop — recording's own poller takes over
            }
            requestAnimationFrame(checkLevel);
        };
        requestAnimationFrame(checkLevel);
    } catch (err) {
        console.error("❌ Mic access failed:", err);
        await stopListening();
    }
}

async function startRecording() {
    if (!mediaStream) return;
    recorder = new MediaRecorder(mediaStream);
    const chunks = [];

    recorder.ondataavailable = e => chunks.push(e.data);
    recorder.onstop = async () => {
        // Flag listening as done immediately so a new TTS-ended event
        // can start a fresh session even before transcription returns.
        isListening = false;

        const blob = new Blob(chunks, { type: 'audio/webm' });

        // Release mic + audio engine NOW.  No reason to keep the mic
        // icon lit through the whole AI reply.
        await releaseAudioResources();

        await transcribeAndSend(blob);
    };

    recorder.start();

    const speechPauseMs = (settings.speech_pause || defaultSettings.speech_pause) * 1000;
    const maxRecordingMs = (settings.max_recording || defaultSettings.max_recording) * 1000;
    const pollIntervalMs = 100;
    const threshold = Number(settings.volume_threshold) || defaultSettings.volume_threshold;

    let silentFor = 0;
    const startTime = Date.now();

    if (volumePoller) clearInterval(volumePoller);
    volumePoller = setInterval(() => {
        if (!recorder || recorder.state !== "recording") {
            clearInterval(volumePoller);
            volumePoller = null;
            return;
        }

        if (Date.now() - startTime >= maxRecordingMs) {
            console.log(`⏱️ Max recording length (${settings.max_recording}s) reached – stopping`);
            clearInterval(volumePoller);
            volumePoller = null;
            recorder.stop();
            return;
        }

        const volume = getCurrentVolume();
        if (volume <= threshold) {
            silentFor += pollIntervalMs;
            if (silentFor >= speechPauseMs) {
                console.log(`🤫 Speech pause (${settings.speech_pause}s) reached – stopping recording`);
                clearInterval(volumePoller);
                volumePoller = null;
                recorder.stop();
            }
        } else {
            silentFor = 0;
        }
    }, pollIntervalMs);
}

async function releaseAudioResources() {
    if (mediaStream) {
        try { mediaStream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        mediaStream = null;
    }
    if (audioContext) {
        try {
            if (audioContext.state !== 'closed') {
                await audioContext.close();
            }
        } catch (e) { /* ignore */ }
        audioContext = null;
    }
    analyserNode = null;
}

async function stopListening() {
    if (isStopping) return;     // ignore re-entrant calls
    isStopping = true;
    try {
        isListening = false;

        if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
        if (volumePoller) { clearInterval(volumePoller); volumePoller = null; }

        if (recorder && recorder.state === "recording") {
            // Detach onstop so we don't accidentally trigger a transcribe/send
            // when stopListening is called for cleanup (vs. for sending audio).
            recorder.onstop = null;
            try { recorder.stop(); } catch (e) { /* ignore */ }
        }
        recorder = null;

        await releaseAudioResources();
    } finally {
        isStopping = false;
    }
}

async function transcribeAndSend(audioBlob) {
    if (!settings.api_key) {
        console.error("❌ No API key set in Hands-Free Voice settings (use 'local' for local servers)");
        return;
    }

    const endpoint = getEffectiveEndpoint();
    if (!endpoint) {
        console.error("❌ No endpoint configured. Set a custom endpoint URL in settings.");
        return;
    }

    const providerFormat = PROVIDERS[settings.provider]?.format ?? 'multipart';
    console.log(`🎙️ Transcribing via ${settings.provider} (${providerFormat}), blob: ${audioBlob.size} bytes`);

    let res;
    try {
        if (providerFormat === 'json_base64') {
            // OpenRouter: JSON body with base64-encoded audio
            const arrayBuffer = await audioBlob.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            const chunkSize = 8192;
            for (let i = 0; i < bytes.length; i += chunkSize) {
                binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
            }
            const base64 = btoa(binary);

            const mimeType = audioBlob.type || 'audio/webm';
            const format = mimeType.includes('ogg') ? 'ogg'
                         : mimeType.includes('mp4') ? 'mp4'
                         : mimeType.includes('wav') ? 'wav'
                         : 'webm';

            res = await fetch(`${endpoint}/audio/transcriptions`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${settings.api_key}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    input_audio: { data: base64, format },
                    model: settings.model
                })
            });
        } else {
            // Groq / Local / OpenAI-compatible: multipart FormData
            const formData = new FormData();
            formData.append("file", audioBlob, "recording.webm");
            formData.append("model", settings.model);

            res = await fetch(`${endpoint}/audio/transcriptions`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${settings.api_key}` },
                body: formData
            });
        }

        if (!res.ok) {
            const errorBody = await res.text();
            console.error(`❌ Whisper API error ${res.status}:`, errorBody);
            return;
        }

        const data = await res.json();
        let transcribed = (data.text || data.transcript || '').trim();

        if (transcribed) {
            if (settings.quote_speech) {
                transcribed = `"${transcribed}"`;
            }
            console.log("📝 Whisper transcribed:", transcribed);
            await sendMessageAsUser(transcribed);
            await SillyTavern.getContext().generate('normal');
        } else {
            console.log("🔇 No speech recognized in audio");
        }
    } catch (err) {
        console.error("❌ Whisper API error:", err);
    }
}

async function autoContinue() {
    const context = SillyTavern.getContext();
    await context.generate('normal');
}
