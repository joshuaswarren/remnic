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
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; margin: 0; overflow: hidden; background: #f4f1e8; }
      iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #f4f1e8; }
      [hidden] { display: none; }
      .demo-data {
        position: absolute;
        z-index: 12;
        top: 0;
        left: 0;
        right: 0;
        height: 42px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 14px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.2);
        background: #123b45;
        color: #fffdf7;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .demo-data span { color: #f2c14e; }
      .lower-third {
        position: absolute;
        z-index: 5;
        left: 34px;
        bottom: 76px;
        width: min(600px, calc(100% - 68px));
        padding: 20px 24px 22px;
        border: 1px solid rgba(255, 255, 255, 0.42);
        border-radius: 18px;
        background: rgba(12, 45, 53, 0.94);
        box-shadow: 0 20px 60px rgba(14, 40, 45, 0.28);
        color: #fffdf7;
        opacity: 0;
        transform: translateY(18px);
        transition: opacity 300ms ease, transform 300ms ease;
        pointer-events: none;
      }
      .lower-third.visible { opacity: 1; transform: translateY(0); }
      .lower-third p { margin: 0; }
      .lower-third .kicker {
        margin-bottom: 7px;
        color: #f2c14e;
        font-size: 12px;
        font-weight: 850;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .lower-third .headline { font-family: Georgia, serif; font-size: 28px; line-height: 1.12; }
      .lower-third .detail { margin-top: 8px; color: #d9e8e5; font-size: 16px; line-height: 1.42; }
      .film-card {
        position: absolute;
        z-index: 10;
        inset: 0;
        display: grid;
        place-items: center;
        overflow: hidden;
        padding: 70px;
        background:
          radial-gradient(circle at 15% 18%, rgba(242, 193, 78, 0.22), transparent 25%),
          radial-gradient(circle at 88% 82%, rgba(93, 178, 164, 0.2), transparent 28%),
          linear-gradient(135deg, #0c2f38 0%, #123f48 52%, #0b2932 100%);
        color: #fffdf7;
        opacity: 0;
        transition: opacity 450ms ease;
        pointer-events: none;
      }
      .film-card[hidden] { display: none; }
      .film-card.visible { opacity: 1; }
      .film-card::before,
      .film-card::after {
        position: absolute;
        content: "";
        width: 330px;
        height: 330px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 50%;
      }
      .film-card::before { top: -150px; right: -70px; }
      .film-card::after { bottom: -190px; left: -80px; width: 430px; height: 430px; }
      .film-content { position: relative; width: min(1040px, 100%); }
      .film-rule { width: 82px; height: 5px; margin-bottom: 25px; border-radius: 9px; background: #f2c14e; }
      .film-kicker {
        margin: 0 0 15px;
        color: #86d1c2;
        font-size: 15px;
        font-weight: 850;
        letter-spacing: 0.18em;
        text-transform: uppercase;
      }
      .film-title {
        max-width: 980px;
        margin: 0;
        font-family: Georgia, serif;
        font-size: clamp(48px, 6vw, 76px);
        font-weight: 500;
        letter-spacing: -0.035em;
        line-height: 1.03;
      }
      .film-copy {
        max-width: 900px;
        margin: 25px 0 0;
        color: #d8ebe7;
        font-size: 22px;
        line-height: 1.45;
      }
      .film-badges { display: flex; flex-wrap: wrap; gap: 11px; margin-top: 32px; }
      .film-badges span {
        padding: 9px 14px;
        border: 1px solid rgba(255, 255, 255, 0.28);
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.07);
        color: #fffdf7;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .film-footer {
        position: absolute;
        right: 38px;
        bottom: 30px;
        color: rgba(255, 255, 255, 0.6);
        font-size: 13px;
        letter-spacing: 0.08em;
      }
      .narration-caption {
        position: absolute;
        z-index: 14;
        left: 50%;
        bottom: 16px;
        width: min(920px, calc(100% - 80px));
        margin: 0;
        padding: 9px 15px 10px;
        border-radius: 9px;
        background: rgba(7, 24, 29, 0.9);
        box-shadow: 0 6px 24px rgba(7, 24, 29, 0.25);
        color: #fff;
        font-size: 16px;
        font-weight: 650;
        line-height: 1.35;
        text-align: center;
        transform: translateX(-50%);
      }
    </style>
  </head>
  <body>
    <iframe id="ownerFrame" title="What Helps Me owner replay" src="/remnic/ui/what-helps-me/?mode=replay"></iframe>
    <iframe id="helperFrame" title="What Helps Me helper replay" src="about:blank" hidden></iframe>
    <div class="demo-data" id="demoData">Demo data <span>no private information</span> provider neutral</div>
    <p class="narration-caption" id="narrationCaption" hidden></p>
    <aside class="lower-third" id="lowerThird" hidden>
      <p class="kicker" id="lowerKicker"></p>
      <p class="headline" id="lowerHeadline"></p>
      <p class="detail" id="lowerDetail"></p>
    </aside>
    <section class="film-card visible" id="filmCard">
      <div class="film-content">
        <div class="film-rule"></div>
        <p class="film-kicker" id="filmKicker">What Helps Me</p>
        <h1 class="film-title" id="filmTitle">The person receiving care should control the guide.</h1>
        <p class="film-copy" id="filmCopy">An owner-controlled support passport, inspired by NHS health and care passport guidance.</p>
        <div class="film-badges" id="filmBadges">
          <span>Private by default</span><span>Revocable by design</span><span>Built with Remnic</span>
        </div>
      </div>
      <div class="film-footer">WHAT HELPS ME · REMNIC</div>
    </section>
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
