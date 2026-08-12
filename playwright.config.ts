import { defineConfig } from "@playwright/test";

const widths = [375, 768, 1024, 1440] as const;

export default defineConfig({
  testDir: "./tests",
  testMatch: "support-passport-ui.spec.ts",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: true,
  reporter: "line",
  outputDir: "output/playwright/what-helps-me",
  use: {
    browserName: "chromium",
    colorScheme: "light",
    locale: "en-US",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: widths.map((width) => ({
    name: `chromium-${width}`,
    use: { viewport: { width, height: width === 375 ? 812 : 900 } },
  })),
});
