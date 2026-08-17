import { EVENT_ORDER_CUES, containsRecallCue } from "./recall-planner-i18n.js";

function isTimelineSummaryQuery(normalized: string): boolean {
  return (
    /\b(?:summarize|summary|major progress|what happened|develop(?:ed|ment)?|approached)\b/.test(
      normalized,
    ) &&
    (/\b(?:over time|throughout|between|project|progress|timeline|journey|sessions?|along the way)\b/.test(
      normalized,
    ) ||
      /\bfrom\b.+\bthrough\b/.test(normalized))
  );
}

export function shouldRecallEventOrderEvidence(query: string): boolean {
  const normalized = query.toLowerCase();

  if (containsRecallCue(normalized, EVENT_ORDER_CUES)) {
    return true;
  }

  if (
    /\border in which\b/.test(normalized) ||
    /\bsequence in which\b/.test(normalized) ||
    /\breconstruct\b.*\btimeline\b/.test(normalized) ||
    /\btimeline\b.*\bin order\b/.test(normalized) ||
    /\bsequence\b.*\bin order\b/.test(normalized) ||
    /\bintroduced\b.*\bin order\b/.test(normalized) ||
    (/\bwalk me through\b/.test(normalized) && /\bin order\b/.test(normalized)) ||
    (/\bin order\b/.test(normalized) &&
      /\b(?:develop(?:ed|ment)?|evolv(?:e|ed|ing)?|progress|throughout|conversations?|sessions?)\b/.test(
        normalized,
      )) ||
    /\bprogress\b.*\bin order\b/.test(normalized) ||
    /\bchronological(?:ly| order)?\b/.test(normalized) ||
    isTimelineSummaryQuery(normalized)
  ) {
    return true;
  }

  if (/\bwhich\b.*\bfirst\b/.test(normalized) || /\bwhat was the first\b/.test(normalized)) {
    return true;
  }
  if (/\bhappened first\b/.test(normalized) || /\bwhich\b.*\bhappened\b/.test(normalized)) {
    return true;
  }
  if (/\bhow many days\b/.test(normalized)) {
    return true;
  }
  if (/\bwhen did\b/.test(normalized)) {
    return true;
  }
  if (/\bwhich\b.*\blast\b/.test(normalized) || /\bthe last\b.*\bi\b/.test(normalized)) {
    return true;
  }
  if (/\bwho\b.*\bfirst\b/.test(normalized)) {
    return true;
  }
  if (/\bmost recent(?:ly)?\b/.test(normalized)) {
    return true;
  }
  if (/\border of\b/.test(normalized) || /\bfrom earliest to latest\b/.test(normalized)) {
    return true;
  }
  if (/\bhow long\b/.test(normalized)) {
    return true;
  }
  if (/\bhow many (months|weeks|years)\b/.test(normalized)) {
    return true;
  }
  if (/\bhow many\b.*\bbefore\b/.test(normalized)) {
    return true;
  }
  if (/\bhow old\b.*\bwhen\b/.test(normalized)) {
    return true;
  }
  return false;
}
