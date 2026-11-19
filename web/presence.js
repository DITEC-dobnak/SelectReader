// One connection per browser origin, even when many Reader tabs are open.
const presence = new EventSource('/api/presence');
self.onconnect = event => event.ports[0].start();
