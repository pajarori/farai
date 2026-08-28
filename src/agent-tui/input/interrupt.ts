export type CtrlCDecision = "clear" | "arm" | "exit";

export function ctrlCDecision(text: string, armedUntil: number, now = Date.now()): CtrlCDecision {
  if (text.length > 0) return "clear";
  if (armedUntil >= now) return "exit";
  return "arm";
}
