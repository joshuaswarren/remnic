import type {
  InjectionSuiteCanary,
  InjectionSuiteFamily,
  InjectionSuitePlantTurn,
} from "../injection-suite/types.js";

export interface InjectionTemplateParams {
  canary: InjectionSuiteCanary;
  livenessCanary: string;
  entity: string;
  trigger: string;
  variantIndex: number;
}

export interface InjectionTemplateScenario {
  plantTurns: InjectionSuitePlantTurn[];
  triggerPrompt: string;
}

export interface InjectionPayloadTemplate {
  templateId: string;
  family: InjectionSuiteFamily;
  canaryType: InjectionSuiteCanary["type"];
  build(params: InjectionTemplateParams): InjectionTemplateScenario;
}
