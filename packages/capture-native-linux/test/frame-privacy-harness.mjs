import { spawn } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { HELPER } from "./harness.mjs";
import { client, fakeDesktop } from "./screen-harness.mjs";

export const CANARY = "TRANSIENT VAULT COVER CANARY 4826";
export const EDITOR = client();

export async function transientDesktop(t, mode) {
  const d = fakeDesktop({ active: EDITOR, clients: [EDITOR], without: ["compositor"] });
  const socketPath = path.join(d.env.XDG_RUNTIME_DIR, "hypr", d.env.HYPRLAND_INSTANCE_SIGNATURE, ".socket2.sock");
  let observer;
  const sockets = new Set();
  const timers = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (!observer) {
      observer = socket;
      socket.on("end", () => { if (mode !== "late") socket.end(); });
      return;
    }
    socket.on("data", () => {
      const ack = () => socket.end("ack");
      if (mode === "partial") {
        observer.write("openwindow>>0xc3,1,pinentry,Vault");
        ack();
      } else if (mode === "late") {
        timers.add(setTimeout(() => observer.end("openwindow>>0xc3,1,pinentry,Vault\n"), 220));
        ack();
      } else if (mode === "title") {
        observer.write("windowtitle>>0xa1\nwindowtitlev2>>0xa1,Vault\nwindowtitle>>0xa1\nwindowtitlev2>>0xa1,Notes - Editor\n", ack);
      } else ack();
    });
    socket.on("end", () => socket.end());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    d.stop();
    rmSync(d.dir, { recursive: true, force: true });
  });
  const changed = mode === "title"
    ? [{ ...EDITOR, title: "Vault" }]
    : [EDITOR, client({ address: "0xc3", class: "pinentry", title: "Vault" })];
  writeFileSync(path.join(d.dir, "bin/grim"), String.raw`#!${process.execPath}
const fs=require("node:fs"),net=require("node:net");
fs.appendFileSync(process.env.FAKE_DIR+"/grim.log",JSON.stringify(process.argv.slice(2))+"\n");
const original=fs.readFileSync(process.env.FAKE_DIR+"/clients.json");
fs.writeFileSync(process.env.FAKE_DIR+"/clients.json",${JSON.stringify(JSON.stringify(changed))});
const s=net.createConnection(${JSON.stringify(socketPath)});
s.on("error",()=>process.exit(4));
s.on("connect",()=>s.write("fire\n"));
s.once("data",()=>{fs.writeFileSync(process.env.FAKE_DIR+"/clients.json",original);s.end();${mode === "grim-failed" ? "process.exitCode=23;" : `process.stdout.write(${JSON.stringify(JSON.stringify({ text: CANARY }))});`}});
`);
  writeFileSync(path.join(d.dir, "bin/tesseract"), String.raw`#!${process.execPath}
const fs=require("node:fs");let input="";
process.stdin.on("data",d=>input+=d);
process.stdin.on("end",()=>{fs.appendFileSync(process.env.FAKE_DIR+"/tesseract.log",input+"\n");console.log(JSON.parse(input).text)});
`);
  const wrapper = path.join(d.dir, "launch-helper");
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(HELPER)} "$@"\n`);
  chmodSync(wrapper, 0o755);
  return { ...d, wrapper };
}

export async function runOcr(desktop) {
  const child = spawn(process.execPath, [HELPER, "ocr-window", "--window", EDITOR.address, "--title", EDITOR.title], {
    env: { ...process.env, ...desktop.env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 2000);
  const code = await new Promise((resolve) => child.once("close", resolve));
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
}
