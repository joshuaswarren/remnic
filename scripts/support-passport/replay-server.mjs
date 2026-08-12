import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(scriptDir, "../../admin-console/public/what-helps-me");

const assets = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["what-helps-me.css", "text/css; charset=utf-8"],
  ["model.js", "application/javascript; charset=utf-8"],
  ["app.js", "application/javascript; charset=utf-8"],
]);

const stageHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>What Helps Me synthetic walkthrough</title>
    <style>
      html, body { height: 100%; margin: 0; background: #f4f1e8; }
      iframe { width: 100%; height: 100%; border: 0; background: #f4f1e8; }
      [hidden] { display: none; }
    </style>
  </head>
  <body>
    <iframe id="ownerFrame" title="What Helps Me owner replay" src="/remnic/ui/what-helps-me/?mode=replay"></iframe>
    <iframe id="helperFrame" title="What Helps Me helper replay" src="about:blank" hidden></iframe>
  </body>
</html>`;

function send(response, status, type, body) {
  response.writeHead(status, {
    "cache-control": "private, no-store",
    "content-security-policy":
      "default-src 'self'; frame-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'",
    "content-type": type,
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

export async function startSupportPassportReplayServer(options = {}) {
  const port = options.port ?? 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://placeholder");
    if (url.pathname === "/") {
      response.writeHead(302, { location: "/remnic/ui/what-helps-me/?mode=replay" });
      response.end();
      return;
    }
    if (url.pathname === "/demo-stage.html") {
      send(response, 200, "text/html; charset=utf-8", stageHtml);
      return;
    }
    const match = /^\/(?:remnic|engram)\/ui\/what-helps-me\/(index\.html|what-helps-me\.css|model\.js|app\.js)?$/.exec(
      url.pathname
    );
    if (!match) {
      send(response, 404, "text/plain; charset=utf-8", "Not found\n");
      return;
    }
    const name = match[1] ?? "index.html";
    const type = assets.get(name);
    if (!type) {
      send(response, 404, "text/plain; charset=utf-8", "Not found\n");
      return;
    }
    try {
      send(response, 200, type, await readFile(path.join(publicDir, name)));
    } catch {
      send(response, 500, "text/plain; charset=utf-8", "Asset unavailable\n");
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The replay server did not bind a TCP port.");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
