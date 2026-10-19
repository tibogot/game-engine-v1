// Split-flap remote relay: phones <-> the split-flap lab page, over the local network.
// No dependencies: plain HTTP + server-sent events.
//
//   node tools/splitflapRemote.mjs [port]      (default 8787)
//
// Then in the lab (v3/splitflap-lab.html): 📱 Remote → Connect → scan the QR code with the phone
// (same Wi-Fi). Windows may ask once to let Node through the firewall: allow private networks.
//
// Rooms are keyed by the 4-digit code the lab shows. The lab (role=display) publishes its show
// ("state": steps + thumbnails) and playback ("status"); phones (role=phone) get them on connect
// and send commands, which go to every display in the room.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = +(process.argv[2] || process.env.PORT || 8787);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_PAGE = path.join(ROOT, "v3", "splitflap-remote.html");
const MAX_BODY = 4e6;

const rooms = new Map();
function room(id) {
  let r = rooms.get(id);
  if (!r) rooms.set(id, (r = { displays: new Set(), phones: new Set(), state: null, status: null }));
  return r;
}
const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a.address);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function presence(r) {
  const p = { displays: r.displays.size, phones: r.phones.size };
  for (const c of [...r.displays, ...r.phones]) sse(c, "presence", p);
}
function json(res, code, data) {
  res.writeHead(code, { ...CORS, "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://relay");
  const id = (url.searchParams.get("room") || "").replace(/\D/g, "").slice(0, 8);
  const role = url.searchParams.get("role") === "display" ? "display" : "phone";
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (url.pathname === "/info") return json(res, 200, { ips: lanIPs(), port: PORT });

  if (url.pathname === "/events" && id) {
    res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 1500\n\n");
    const r = room(id), set = role === "display" ? r.displays : r.phones;
    set.add(res);
    if (role === "phone") { if (r.state) sse(res, "state", r.state); if (r.status) sse(res, "status", r.status); }
    presence(r);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000); // keeps proxies and phones from dropping it
    req.on("close", () => { clearInterval(ping); set.delete(res); presence(r); });
    return;
  }

  if (url.pathname === "/send" && req.method === "POST" && id) {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch { return json(res, 400, { error: "bad json" }); }
      const r = room(id);
      if (role === "display") {
        if (msg.type === "state") r.state = msg.data;
        if (msg.type === "status") r.status = msg.data;
        for (const c of r.phones) sse(c, msg.type, msg.data);
      } else {
        for (const c of r.displays) sse(c, "cmd", msg);
      }
      json(res, 200, { displays: r.displays.size, phones: r.phones.size });
    });
    return;
  }

  if (url.pathname === "/" || url.pathname === "/remote") {
    fs.readFile(REMOTE_PAGE, (err, buf) => {
      if (err) { res.writeHead(500); return res.end("v3/splitflap-remote.html is missing"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404, CORS);
  res.end("not found");
});

server.on("error", (e) => {
  console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is busy: is the relay already running? (or pass another port)` : e);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Split-flap remote relay on port ${PORT}`);
  for (const ip of lanIPs()) console.log(`  phones: http://${ip}:${PORT}/   (the lab's 📱 Remote panel shows the QR code)`);
});
