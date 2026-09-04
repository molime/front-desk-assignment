// Platform event bus stub (DESIGN.md §1/§4).
// Stage 2/4 will subscribe here and fan events out over the /ws WebSocket.
// broadcast() is safe to call with zero subscribers.
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(200);

/** Publish an event. payload is any JSON-serializable object. */
export function publish(event, payload) {
  const envelope = { event, payload, at: new Date().toISOString() };
  bus.emit(event, envelope);
  bus.emit('*', envelope);
  return envelope;
}

/** Subscribe to one event, or '*' for all. Returns an unsubscribe fn. */
export function subscribe(event, handler) {
  bus.on(event, handler);
  return () => bus.off(event, handler);
}

/**
 * No-op-safe broadcast used by mutating services. Never throws, even if a
 * subscriber blows up — the DB write already happened, events must not fail it.
 */
export function broadcast(event, payload) {
  try {
    publish(event, payload);
  } catch (err) {
    console.error(`[events] broadcast ${event} failed:`, err);
  }
}

export default { publish, subscribe, broadcast };
