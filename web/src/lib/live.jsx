// Live event store: one auto-reconnecting /ws connection for the whole app.
// Pages subscribe per-event for cross-page live invalidation (DESIGN.md §4).
import { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';

const LiveContext = createContext(null);
const MAX_EVENTS = 200;

export function LiveProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState([]);
  const handlers = useRef(new Map()); // event|' * ' -> Set<cb>

  const dispatch = useCallback((envelope) => {
    setEvents((prev) => [envelope, ...prev].slice(0, MAX_EVENTS));
    const cbs = [
      ...(handlers.current.get(envelope.event) ?? []),
      ...(handlers.current.get('*') ?? []),
    ];
    for (const cb of cbs) {
      try { cb(envelope); } catch (e) { console.error('[live] handler error', e); }
    }
  }, []);

  useEffect(() => {
    let ws;
    let closed = false;
    let retry = 0;
    let timer;

    const connect = () => {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws`);
      ws.onopen = () => { retry = 0; setConnected(true); };
      ws.onmessage = (msg) => {
        try { dispatch(JSON.parse(msg.data)); } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(1000 * 2 ** retry++, 15000);
        timer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [dispatch]);

  const subscribe = useCallback((event, cb) => {
    if (!handlers.current.has(event)) handlers.current.set(event, new Set());
    handlers.current.get(event).add(cb);
    return () => handlers.current.get(event)?.delete(cb);
  }, []);

  const value = useMemo(() => ({ connected, events, subscribe }), [connected, events, subscribe]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}

/** Subscribe to one WS event for the component's lifetime. */
export function useLiveEvent(event, cb) {
  const { subscribe } = useLive();
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => subscribe(event, (e) => cbRef.current(e)), [event, subscribe]);
}
