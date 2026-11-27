// English-only heuristic fallback for harnesses without question tools. The question
// tools (inputToolSignal) stay the primary path.
const ASK_OPENER = /^(?:which|would you|do you|did you|can you|could you|should|shall|want me|ready to|ok to|okay (?:if|to)|is it ok)\b/i;
const ADDRESSED = /\b(?:you|your|me)\b/i;
const PLEASE = /^please (?:choose|confirm|provide|select|approve|tell me)\b/i;

const asksHuman = s => PLEASE.test(s) || (/\?$/.test(s) && (ASK_OPENER.test(s) || ADDRESSED.test(s)));

// Only final replies use this fallback; commentary is never treated as a wait.
// A reply asks when any sentence of its final paragraph is a question to the human,
// so "Should I bump it? I can do it separately." still waits for an answer.
export function finalTurnSignal(text, harness, ts, signalId) {
  const last = String(text || '').trim().split(/\n\s*\n/).at(-1) || '';
  const sentences = last.split(/\n|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const asks = sentences.some(asksHuman);
  return {
    kind: asks ? 'input_required' : 'turn_complete', harness, ts,
    signal_id: signalId || undefined,
    reason: asks ? 'final_question' : 'end_turn',
  };
}

export function inputToolSignal(tool, id, harness, ts) {
  if (!/(?:^|[._])request_user_input(?:_async)?$/.test(tool)
    && !['AskUserQuestion', 'ExitPlanMode'].includes(tool)) return null;
  return { kind: 'input_required', harness, ts, signal_id: id || undefined,
    reason: tool === 'ExitPlanMode' ? 'approval' : 'question_tool' };
}
