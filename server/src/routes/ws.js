// Platform event-bus WebSocket (DESIGN.md §4). The office dashboard connects
// here and receives every bus event as {event, payload, at}.
import { subscribe } from '../lib/events.js';

export default async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    const unsubscribe = subscribe('*', (envelope) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(envelope));
    });
    socket.on('close', unsubscribe);
    socket.on('error', unsubscribe);
    req.log.info('dashboard WS client connected');
  });
}
