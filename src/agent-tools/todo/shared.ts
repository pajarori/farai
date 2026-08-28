import type { TodoPriority, TodoStatus } from "../../types";

export function priority(value: unknown): TodoPriority {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

export function todoStatus(value: unknown): TodoStatus {
  if (value === "pending" || value === "in_progress" || value === "done" || value === "blocked" || value === "cancelled") return value;
  throw new Error("status must be pending, in_progress, done, blocked, or cancelled");
}
