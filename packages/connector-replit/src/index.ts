// Public entry point for @remnic/replit. Re-exports the installer helpers so
// consumers can `import { generateReplitInstructions } from "@remnic/replit"`.

export {
  generateReplitInstructions,
  type ReplitInstallResult,
} from "./installer.js";
