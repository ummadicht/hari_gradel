// Stand-in for GradeIQ behind Caddy, for scripts/release-test/run.sh.
// Answers the health probes of deploy/release-lib.sh from the stand-in pm2's
// state: the page carries the BUILD_ID pm2 last "started" (like a real Next
// page), unless the test has taken the app down.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [stateDir, portFile] = process.argv.slice(2);
const read = (f, d = "") => { try { return fs.readFileSync(path.join(stateDir, f), "utf8").trim(); } catch { return d; } };

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  if (read("mode", "up") === "down") { res.writeHead(502); return res.end("bad gateway"); }
  if (url === "/apps/gradeiq") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(`<html><script>self.__next_f.push([1,"0:{\\"b\\":\\"${read("serving")}\\"}"])</script></html>`);
  }
  if (url === "/apps/gradeiq/") { res.writeHead(308, { location: "/apps/gradeiq" }); return res.end(); }
  if (url.startsWith("/apps/gradeiq/api/imei/")) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
  res.writeHead(404); res.end("not found");
});
server.listen(0, "127.0.0.1", () => fs.writeFileSync(portFile, String(server.address().port)));
