import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { captureAssets } from "./capture-assets.mjs";
import { startSupportPassportReplayServer } from "./replay-server.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.join(repositoryRoot, "docs/hackathons/assets/what-helps-me");
const assetNames = ["owner-approved.png", "owner-share.png", "helper-answer.png", "helper-locked.png", "demo.webm"];
const narrationDir = path.join(repositoryRoot, "scripts/support-passport/narration");

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`));
    });
  });
}

async function probeDuration(filePath) {
  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.pipe(process.stderr);
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffprobe failed with exit code ${code}.`))
    );
  });
  const duration = Number.parseFloat(output);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Invalid narration duration for ${filePath}.`);
  return duration;
}

async function loadNarration() {
  const script = JSON.parse(await readFile(path.join(narrationDir, "script.json"), "utf8"));
  const narration = new Map();
  for (const segment of script) {
    const filePath = path.join(narrationDir, `${segment.id}.mp3`);
    narration.set(segment.id, {
      filePath,
      text: segment.text,
      durationMs: Math.ceil((await probeDuration(filePath)) * 1_000),
    });
  }
  return narration;
}

async function muxNarration(videoPath, outputPath, cues, narration) {
  const inputs = [];
  const filters = [];
  const labels = [];
  for (const [index, cue] of cues.entries()) {
    const segment = narration.get(cue.id);
    inputs.push("-i", segment.filePath);
    const label = `voice${index}`;
    filters.push(`[${index + 1}:a]adelay=${cue.offsetMs}:all=1[${label}]`);
    labels.push(`[${label}]`);
  }
  filters.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0,alimiter=limit=0.95[voice]`
  );
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[voice]",
    "-c:v",
    "copy",
    "-c:a",
    "libopus",
    "-b:a",
    "112k",
    "-shortest",
    outputPath,
  ]);
}

async function launchBrowser() {
  try {
    return await chromium.launch();
  } catch (error) {
    try {
      return await chromium.launch({ channel: "chrome" });
    } catch {
      throw error;
    }
  }
}

function showFrame(page, name) {
  return page.evaluate((selected) => {
    const owner = document.getElementById("ownerFrame");
    const helper = document.getElementById("helperFrame");
    owner.hidden = selected !== "owner";
    helper.hidden = selected !== "helper";
  }, name);
}

async function pause(page, milliseconds = 1_200) {
  await page.waitForTimeout(milliseconds);
}

async function showFilmCard(page, { kicker, title, copy, badges }) {
  await page.evaluate(
    ({ kicker: nextKicker, title: nextTitle, copy: nextCopy, badges: nextBadges }) => {
      const card = document.getElementById("filmCard");
      document.getElementById("filmKicker").textContent = nextKicker;
      document.getElementById("filmTitle").textContent = nextTitle;
      document.getElementById("filmCopy").textContent = nextCopy;
      document
        .getElementById("filmBadges")
        .replaceChildren(
          ...nextBadges.map((badge) => Object.assign(document.createElement("span"), { textContent: badge }))
        );
      card.hidden = false;
      requestAnimationFrame(() => card.classList.add("visible"));
    },
    { kicker, title, copy, badges }
  );
  await pause(page, 450);
}

async function hideFilmCard(page) {
  await page.evaluate(() => document.getElementById("filmCard").classList.remove("visible"));
  await pause(page, 500);
  await page.evaluate(() => {
    document.getElementById("filmCard").hidden = true;
    document.getElementById("demoData").hidden = false;
  });
}

async function showLowerThird(page, kicker, headline, detail) {
  await page.evaluate(
    ({ nextKicker, nextHeadline, nextDetail }) => {
      const lowerThird = document.getElementById("lowerThird");
      document.getElementById("lowerKicker").textContent = nextKicker;
      document.getElementById("lowerHeadline").textContent = nextHeadline;
      document.getElementById("lowerDetail").textContent = nextDetail;
      lowerThird.hidden = false;
      requestAnimationFrame(() => lowerThird.classList.add("visible"));
    },
    { nextKicker: kicker, nextHeadline: headline, nextDetail: detail }
  );
  await pause(page, 350);
}

async function hideLowerThird(page) {
  await page.evaluate(() => document.getElementById("lowerThird").classList.remove("visible"));
  await pause(page, 350);
  await page.evaluate(() => {
    document.getElementById("lowerThird").hidden = true;
  });
}

async function capture() {
  const narration = await loadNarration();
  await captureAssets(outputDir, assetNames, async (stagingDir) => {
    let server;
    let videoDir;
    let browser;
    let context;
    try {
      server = await startSupportPassportReplayServer();
      videoDir = await mkdtemp(path.join(os.tmpdir(), "what-helps-me-video-"));
      browser = await launchBrowser();
      context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
        colorScheme: "light",
        locale: "en-US",
      });
      const page = await context.newPage();
      const video = page.video();
      const videoStartedAt = Date.now();
      const narrationCues = [];
      const clearCaption = () =>
        page.evaluate(() => {
          document.getElementById("narrationCaption").hidden = true;
        });
      const cue = async (id) => {
        narrationCues.push({ id, offsetMs: Date.now() - videoStartedAt });
        await page.evaluate((text) => {
          const caption = document.getElementById("narrationCaption");
          caption.textContent = text;
          caption.hidden = false;
        }, narration.get(id).text);
      };
      const hold = async (id, paddingMs = 1_200) => {
        await pause(page, narration.get(id).durationMs + paddingMs);
        await clearCaption();
      };
      await page.goto(`${server.origin}/demo-stage.html`);
      const owner = page.frameLocator("#ownerFrame");
      await owner.getByText("Synthetic replay").waitFor();
      await cue("intro");
      await hold("intro");

      await hideFilmCard(page);
      await showLowerThird(
        page,
        "1 · Choose",
        "The person is the author.",
        "They choose the source notes. Nothing leaves Remnic without clear consent."
      );
      await cue("choose");
      await hold("choose");

      await owner.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
      await owner.getByRole("button", { name: "Draft my support cards" }).click();
      await owner.locator(".support-card").first().waitFor();
      await hideLowerThird(page);
      await showFilmCard(page, {
        kicker: "One Remnic flow · Your model",
        title: "Use the model you already trust.",
        copy: "Local LLM. OpenClaw gateway. OpenAI-compatible endpoint. Or direct OpenAI. What Helps Me uses Remnic's existing routing.",
        badges: ["Local LLM", "OpenClaw gateway", "Compatible endpoint", "Direct OpenAI"],
      });
      await cue("model");
      await hold("model");
      await hideFilmCard(page);

      await showLowerThird(
        page,
        "2 · Review",
        "Nothing publishes itself.",
        "The model drafts. The person edits and approves every card."
      );
      await cue("review");
      await hold("review");

      await owner.getByRole("button", { name: "Edit" }).first().click();
      await owner.getByLabel("Card title").fill("Softer lighting");
      await owner.getByRole("button", { name: "Save draft" }).click();
      await owner.getByRole("heading", { name: "Softer lighting" }).waitFor();
      const planCard = owner.locator(".support-card").filter({ hasText: "Plan changes" });
      await planCard.getByRole("button", { name: "Approve" }).click();
      await planCard.locator(".status-pill.approved").waitFor();
      await pause(page, 2_000);
      await hideLowerThird(page);
      await page.screenshot({ path: path.join(stagingDir, "owner-approved.png") });

      await owner
        .locator(".card-choice")
        .filter({ hasText: "Plan changes" })
        .locator('input[name="shareCard"]')
        .check();
      await owner.getByRole("button", { name: "Create share link" }).click();
      await owner.getByText("Share link ready").waitFor();
      const shareUrl = await owner.locator("#shareLinkInput").inputValue();
      await page.screenshot({ path: path.join(stagingDir, "owner-share.png") });
      await showLowerThird(
        page,
        "3 · Share",
        "Share only what helps.",
        "Each link pins exact approved words. It ends on the person's schedule."
      );
      await cue("share");
      await hold("share");
      await hideLowerThird(page);

      await page.locator("#helperFrame").evaluate((frame, url) => {
        frame.src = url;
      }, shareUrl);
      await showFrame(page, "helper");
      const helper = page.frameLocator("#helperFrame");
      await helper.getByRole("heading", { name: "What helps me" }).waitFor();
      await helper.locator(".public-card").waitFor();
      await helper.locator(".public-card").getByRole("heading", { name: "Plan changes" }).waitFor();
      await showLowerThird(
        page,
        "Helper view",
        "A helper sees only the chosen cards.",
        "No source notes. No memory search. No Remnic account."
      );
      await cue("helper");
      await hold("helper");
      await hideLowerThird(page);
      await helper.getByLabel("Your question").fill("What should I do when plans change?");
      await helper.getByRole("button", { name: "Ask from this guide" }).click();
      await helper.locator("#answerCopy").getByText("Tell me before plans change.", { exact: true }).waitFor();
      await page.screenshot({ path: path.join(stagingDir, "helper-answer.png") });
      await showLowerThird(
        page,
        "Grounded help",
        "Answers stay inside the guide.",
        "Every answer uses the shared cards only and cites the exact card."
      );
      await cue("answer");
      await hold("answer");
      await hideLowerThird(page);

      await showFrame(page, "owner");
      await showLowerThird(
        page,
        "Owner control",
        "Consent can change.",
        "Stop sharing once. The next helper request locks immediately."
      );
      await cue("revoke");
      await pause(page, 2_800);
      await owner.getByRole("button", { name: "Stop sharing" }).click();
      await owner.getByText("Sharing stopped", { exact: true }).waitFor();
      await pause(page, Math.max(2_000, narration.get("revoke").durationMs - 1_600));
      await clearCaption();
      await hideLowerThird(page);

      await showFrame(page, "helper");
      await helper.getByRole("heading", { name: "This support passport is locked." }).waitFor();
      await page.screenshot({ path: path.join(stagingDir, "helper-locked.png") });
      await cue("locked");
      await hold("locked");

      await showFilmCard(page, {
        kicker: "What Helps Me · Built with Remnic",
        title: "Support that travels. Control that stays with the person.",
        copy: "A modern health and care passport. Private by default. Revocable by design. Provider neutral.",
        badges: ["The model is the scribe", "The person is the author"],
      });
      await cue("close");
      await hold("close", 2_000);

      await page.close();
      await context.close();
      context = undefined;
      const silentVideoPath = path.join(stagingDir, "demo-silent.webm");
      await video.saveAs(silentVideoPath);
      await muxNarration(silentVideoPath, path.join(stagingDir, "demo.webm"), narrationCues, narration);
      await rm(silentVideoPath, { force: true });
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      await server?.stop().catch(() => undefined);
      if (videoDir) await rm(videoDir, { recursive: true, force: true });
    }
  });
}

capture().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
