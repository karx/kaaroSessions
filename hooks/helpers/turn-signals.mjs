// Only final replies use this fallback; commentary is never treated as a wait.
export function finalTurnSignal(text, harness, ts, signalId) {
  const last = String(text || '').trim().split(/\n\s*\n/).at(-1) || '';
  const asks = /(?:^|[.!]\s+)(?:which\b|would you\b|do you\b|can you\b|could you\b|shall I\b)[\s\S]*\?\s*$/i.test(last)
    || /(?:^|\n)please (?:choose|confirm|provide|select|approve|tell me)\b/i.test(last);
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
