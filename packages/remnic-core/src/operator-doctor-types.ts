export interface OperatorDoctorCheck {
  key: string;
  status: "ok" | "warn" | "error";
  summary: string;
  remediation?: string;
  details?: unknown;
}
