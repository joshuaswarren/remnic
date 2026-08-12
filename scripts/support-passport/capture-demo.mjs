import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startSupportPassportReplayServer } from "./replay-server.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.join(repositoryRoot, "docs/hackathons/assets/what-helps-me");

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

async function capture() {
  let server;
  let videoDir;
  let browser;
  let context;
  try {
    server = await startSupportPassportReplayServer();
    videoDir = await mkdtemp(path.join(os.tmpdir(), "what-helps-me-video-"));
    browser = await launchBrowser();
    await mkdir(outputDir, { recursive: true });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
      colorScheme: "light",
      locale: "en-US",
    });
    const page = await context.newPage();
    const video = page.video();
    await page.goto(`${server.origin}/demo-stage.html`);
    const owner = page.frameLocator("#ownerFrame");
    await owner.getByText("Synthetic replay").waitFor();
    await pause(page);

    await owner.getByLabel("Send these selected notes to my configured model to draft my cards.").check();
    await owner.getByRole("button", { name: "Draft my support cards" }).click();
    await owner.locator(".support-card").first().waitFor();
    await pause(page);

    await owner.getByRole("button", { name: "Edit" }).first().click();
    await owner.getByLabel("Card title").fill("Softer lighting");
    await owner.getByRole("button", { name: "Save draft" }).click();
    await owner.getByRole("heading", { name: "Softer lighting" }).waitFor();
    const planCard = owner.locator(".support-card").filter({ hasText: "Plan changes" });
    await planCard.getByRole("button", { name: "Approve" }).click();
    await planCard.locator(".status-pill.approved").waitFor();
    await page.screenshot({ path: path.join(outputDir, "owner-approved.png") });
    await pause(page);

    await owner.locator(".card-choice").filter({ hasText: "Plan changes" }).locator('input[name="shareCard"]').check();
    await owner.getByRole("button", { name: "Create share link" }).click();
    await owner.getByText("Share link ready").waitFor();
    const shareUrl = await owner.locator("#shareLinkInput").inputValue();
    await page.screenshot({ path: path.join(outputDir, "owner-share.png") });
    await pause(page);

    await page.locator("#helperFrame").evaluate((frame, url) => {
      frame.src = url;
    }, shareUrl);
    await showFrame(page, "helper");
    const helper = page.frameLocator("#helperFrame");
    await helper.getByRole("heading", { name: "What helps me" }).waitFor();
    await helper.locator(".public-card").waitFor();
    await helper.locator(".public-card").getByRole("heading", { name: "Plan changes" }).waitFor();
    await pause(page);
    await helper.getByLabel("Your question").fill("What should I do when plans change?");
    await helper.getByRole("button", { name: "Ask from this guide" }).click();
    await helper.locator("#answerCopy").getByText("Tell me before plans change.", { exact: true }).waitFor();
    await page.screenshot({ path: path.join(outputDir, "helper-answer.png") });
    await pause(page, 1_800);

    await showFrame(page, "owner");
    await owner.getByRole("button", { name: "Stop sharing" }).click();
    await owner.getByText("Sharing stopped", { exact: true }).waitFor();
    await pause(page);

    await showFrame(page, "helper");
    await helper.getByRole("heading", { name: "This support passport is locked." }).waitFor();
    await page.screenshot({ path: path.join(outputDir, "helper-locked.png") });
    await pause(page, 2_000);

    await page.close();
    const videoPath = await video.path();
    await copyFile(videoPath, path.join(outputDir, "demo.webm"));
  } finally {
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
    await server?.stop().catch(() => undefined);
    if (videoDir) await rm(videoDir, { recursive: true, force: true });
  }
}

capture().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
