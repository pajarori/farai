import { MouseButton, type MouseEvent } from "@opentui/core";

export function isPrimaryClick(event: Pick<MouseEvent, "button" | "isDragging">): boolean {
  return event.button === MouseButton.LEFT && event.isDragging !== true;
}

export function createPrimaryClickGesture(onActivate: () => void): {
  onMouseDown: (event: MouseEvent) => void;
  onMouseUp: (event: MouseEvent) => void;
} {
  let start: { x: number; y: number } | undefined;
  return {
    onMouseDown(event) {
      start = event.button === MouseButton.LEFT ? { x: event.x, y: event.y } : undefined;
    },
    onMouseUp(event) {
      const down = start;
      start = undefined;
      if (event.button === MouseButton.LEFT && down?.x === event.x && down.y === event.y) onActivate();
    }
  };
}
