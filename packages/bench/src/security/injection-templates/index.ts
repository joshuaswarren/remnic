import { CROSS_SESSION_TEMPLATES } from "./cross-session.js";
import { MINJA_TEMPLATES } from "./minja.js";
import { SLEEPER_TEMPLATES } from "./sleeper.js";
import { TOOL_HIJACK_TEMPLATES } from "./tool-hijack.js";
import type { InjectionPayloadTemplate } from "./types.js";

export const INJECTION_PAYLOAD_TEMPLATES: readonly InjectionPayloadTemplate[] = [
  ...MINJA_TEMPLATES,
  ...SLEEPER_TEMPLATES,
  ...CROSS_SESSION_TEMPLATES,
  ...TOOL_HIJACK_TEMPLATES,
];

export {
  CROSS_SESSION_TEMPLATES,
  MINJA_TEMPLATES,
  SLEEPER_TEMPLATES,
  TOOL_HIJACK_TEMPLATES,
};
export type {
  InjectionPayloadTemplate,
  InjectionTemplateParams,
  InjectionTemplateScenario,
} from "./types.js";
