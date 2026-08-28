export function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const min = minutes % 60;
  return `${hours}h ${String(min).padStart(2, "0")}m ${String(rest).padStart(2, "0")}s`;
}
