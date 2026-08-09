import { searchHarmonicRetrieval, type HarmonicRetrievalResult } from "../harmonic-retrieval.js";

export async function runHarmonicSearchCliCommand(options: {
  memoryDir: string;
  abstractionNodeStoreDir?: string;
  harmonicRetrievalEnabled: boolean;
  abstractionAnchorsEnabled: boolean;
  temporalExpiredInInjection: boolean;
  query: string;
  maxResults?: number;
  sessionKey?: string;
}): Promise<HarmonicRetrievalResult[]> {
  if (!options.harmonicRetrievalEnabled) return [];
  return searchHarmonicRetrieval({
    memoryDir: options.memoryDir,
    abstractionNodeStoreDir: options.abstractionNodeStoreDir,
    query: options.query,
    maxResults: Math.max(1, Math.floor(options.maxResults ?? 3)),
    sessionKey: options.sessionKey,
    anchorsEnabled: options.abstractionAnchorsEnabled,
    temporalExpiredInInjection: options.temporalExpiredInInjection,
  });
}
