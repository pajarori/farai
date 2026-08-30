import { createSignal, onCleanup } from "solid-js";
import { subscribeCommands } from "./command-registry";

export function useCommandRegistryRevision(): () => number {
  const [revision, setRevision] = createSignal(0);
  const dispose = subscribeCommands(() => setRevision((value) => value + 1));
  onCleanup(dispose);
  return revision;
}
