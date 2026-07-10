'use strict';

// A minimal horizontally-scaled chat server.
//
//   Browser ──WebSocket──▶ THIS instance ──publish──▶ Redis channel "chat"
//                                                          │
//        every instance is subscribed to that channel ◀────┘
//                          │
//        …and broadcasts each message it hears to ITS OWN sockets.
//
// The key move: a client message is NEVER broadcast locally on the spot.
// It is published to Redis, and it reaches every socket — on this instance
// AND the other one — only when it comes back over the subscription. That is
// why the same channel fans a message out across both replicas.

const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000;
const CHANNEL = 'chat';
const INSTANCE = process.env.INSTANCE_ID || os.hostname();
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

// ---------------------------------------------------------------------------
// The tiny chat client this server hands out at GET / — plain HTML + the
// browser WebSocket API, connecting back to ws://<host>/ (i.e. through nginx).
// ---------------------------------------------------------------------------
const CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebSocket Chat · Redis Fan-out</title>
<style>
  :root{color-scheme:light dark;--bg:#f4f6f9;--surface:#fff;--text:#18202c;--muted:#576374;--hue:#7048e8;--border:#e3e7ee;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  @media (prefers-color-scheme:dark){:root{--bg:#0e131a;--surface:#161d27;--text:#d8e0ea;--muted:#95a4b6;--hue:#9a7bff;--border:#242e3b}}
  *{box-sizing:border-box}
  body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--text);display:flex;flex-direction:column;height:100vh}
  header{padding:14px 18px;border-bottom:1px solid var(--border);background:var(--surface)}
  header b{font-size:15px}
  #who{font-family:var(--mono);font-size:12px;color:var(--hue);margin-top:3px}
  #log{flex:1;overflow-y:auto;padding:16px 18px;display:flex;flex-direction:column;gap:8px}
  .msg{max-width:80%;padding:8px 12px;border-radius:10px;background:var(--surface);border:1px solid var(--border);font-size:14px;line-height:1.4;word-break:break-word}
  .msg .tag{font-family:var(--mono);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--hue);display:block;margin-bottom:2px}
  .msg.system{align-self:center;background:transparent;border-style:dashed;color:var(--muted);font-family:var(--mono);font-size:12px}
  form{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--border);background:var(--surface)}
  input{flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:9px;background:var(--bg);color:var(--text);font-size:14px;font-family:var(--sans)}
  button{padding:10px 18px;border:0;border-radius:9px;background:var(--hue);color:#fff;font-size:14px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:not-allowed}
</style>
</head>
<body>
  <header>
    <b>WebSocket Chat · Redis Fan-out</b>
    <div id="who">connecting…</div>
  </header>
  <div id="log"></div>
  <form id="f">
    <input id="m" autocomplete="off" placeholder="Type a message and hit Send…" autofocus>
    <button id="b" type="submit" disabled>Send</button>
  </form>
  <script>
    var log = document.getElementById('log');
    var who = document.getElementById('who');
    var form = document.getElementById('f');
    var input = document.getElementById('m');
    var btn = document.getElementById('b');
    var myInstance = null;

    function add(text, instance, system){
      var el = document.createElement('div');
      el.className = 'msg' + (system ? ' system' : '');
      if (!system){
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'handled by ' + instance + (instance === myInstance ? ' (this tab)' : '');
        el.appendChild(tag);
      }
      el.appendChild(document.createTextNode(text));
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    // Connect back to whichever instance nginx routed this page load to.
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/');

    ws.onopen = function(){ btn.disabled = false; };
    ws.onclose = function(){ who.textContent = 'disconnected — is the stack up?'; btn.disabled = true; };
    ws.onmessage = function(ev){
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.system){
        if (msg.instance){ myInstance = msg.instance; who.textContent = 'you are connected to ' + msg.instance; }
        add(msg.text, msg.instance, true);
      } else {
        add(msg.text, msg.instance, false);
      }
    };

    form.onsubmit = function(e){
      e.preventDefault();
      var v = input.value.trim();
      if (!v || ws.readyState !== WebSocket.OPEN) return;
      ws.send(v);
      input.value = '';
    };
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server: serves the chat client. The WebSocket server rides the SAME
// port, so a browser can load the page and open the socket over one origin.
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CLIENT_HTML);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server });

// Broadcast one payload to every open socket on THIS instance.
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

// node-redis v4 requires SEPARATE connections for pub and sub: a client in
// subscriber mode can't issue normal commands. `duplicate()` clones config.
const publisher = createClient({ url: REDIS_URL });
const subscriber = publisher.duplicate();

publisher.on('error', (err) => console.error(`[${INSTANCE}] redis publisher error:`, err.message));
subscriber.on('error', (err) => console.error(`[${INSTANCE}] redis subscriber error:`, err.message));

async function start() {
  await publisher.connect();
  await subscriber.connect();

  // Every instance subscribes to the shared channel and re-broadcasts whatever
  // arrives to its own connected sockets. This is the fan-out across replicas.
  await subscriber.subscribe(CHANNEL, (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    console.log(`[${INSTANCE}] fan-out from redis <- ${msg.instance}: ${msg.text}`);
    broadcast(msg);
  });

  wss.on('connection', (ws) => {
    console.log(`[${INSTANCE}] client connected (${wss.clients.size} on this instance)`);
    // Greet only this socket, and tell it which instance it landed on.
    ws.send(JSON.stringify({ system: true, instance: INSTANCE, text: `connected to ${INSTANCE}` }));

    ws.on('message', (data) => {
      const text = data.toString().slice(0, 500);
      if (!text) return;
      const msg = { text, instance: INSTANCE, ts: Date.now() };
      console.log(`[${INSTANCE}] recv from client -> publish: ${text}`);
      // Publish to Redis only. The message returns to EVERY instance (including
      // this one) via the subscription above, so it is broadcast exactly once.
      publisher.publish(CHANNEL, JSON.stringify(msg));
    });

    ws.on('close', () => {
      console.log(`[${INSTANCE}] client disconnected`);
    });
  });

  server.listen(PORT, () => {
    console.log(`[${INSTANCE}] chat server listening on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error(`[${INSTANCE}] fatal startup error:`, err);
  process.exit(1);
});
