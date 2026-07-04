export function commandAvailable(tool: string): { ok: boolean; reason?: string };
export function skipUnlessCommand(tool: string, installHint?: string): false | string;
export function cleanWorkingTreeProbe(): { ok: boolean; reason?: string };
export function skipUnlessCleanWorkingTree(): false | string;