import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { fmtElapsed } from '../lib/format.js';

// Browser WebRTC call to the OpenAI Realtime API (DESIGN.md §3 web-call
// fallback). Ephemeral key comes from POST /api/realtime-token; the SDP offer
// is posted to the Realtime WebRTC endpoint with that key as Bearer.
const REALTIME_URL = 'https://api.openai.com/v1/realtime?model=gpt-realtime';

export default function CallMarinaButton() {
  const [state, setState] = useState('idle'); // idle | connecting | live | error
  const [muted, setMuted] = useState(false);
  const [toast, setToast] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const pcRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    if (state !== 'live') return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const hangUp = () => {
    pcRef.current?.close();
    pcRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState('idle');
    setMuted(false);
    setStartedAt(null);
  };

  const start = async () => {
    setState('connecting');
    let token;
    try {
      token = await api.realtimeToken();
    } catch (err) {
      setState('idle');
      setToast(
        err.status === 503
          ? 'Telephony keys not configured — Marina can’t take browser calls yet.'
          : `Could not start call: ${err.message}`
      );
      return;
    }
    const ephemeralKey = token?.value ?? token?.client_secret?.value;
    if (!ephemeralKey) {
      setState('idle');
      setToast('Realtime token response was malformed.');
      return;
    }

    try {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      pc.ontrack = (e) => {
        if (audioRef.current) audioRef.current.srcObject = e.streams[0];
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) hangUp();
      };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      pc.addTrack(stream.getAudioTracks()[0]);

      // Data channel kept open for future tool/event wiring.
      pc.createDataChannel('oai-events');

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdpRes = await fetch(REALTIME_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ephemeralKey}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!sdpRes.ok) throw new Error(`Realtime endpoint rejected the call (${sdpRes.status})`);
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdpRes.text() });

      setStartedAt(new Date().toISOString());
      setState('live');
    } catch (err) {
      hangUp();
      setToast(err.name === 'NotAllowedError'
        ? 'Microphone access was denied.'
        : `Call failed: ${err.message}`);
    }
  };

  const toggleMute = () => {
    const track = streamRef.current?.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      setMuted(!track.enabled);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <audio ref={audioRef} autoPlay className="hidden" />
      {state === 'idle' && (
        <button
          onClick={start}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-brand-700"
        >
          <PhoneIcon /> Call Marina
        </button>
      )}
      {state === 'connecting' && (
        <span className="inline-flex items-center gap-2 rounded-lg bg-brand-50 px-3 py-1.5 text-[13px] font-medium text-brand-800 ring-1 ring-inset ring-brand-200">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand-300 border-t-brand-700" />
          Connecting…
        </span>
      )}
      {state === 'live' && (
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-1.5 text-[13px] font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            On call · {fmtElapsed(startedAt, now)}
          </span>
          <button
            onClick={toggleMute}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button
            onClick={hangUp}
            className="rounded-lg bg-rose-600 px-2.5 py-1.5 text-[13px] font-medium text-white hover:bg-rose-700"
          >
            Hang up
          </button>
        </span>
      )}
      {toast && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}
