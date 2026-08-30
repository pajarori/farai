import { useTerminalDimensions } from "@opentui/solid";
import { createContext, useContext, type JSX } from "solid-js";

type TerminalDimensions = ReturnType<typeof useTerminalDimensions>;

const TerminalDimensionsContext = createContext<TerminalDimensions>();

export function TerminalDimensionsProvider(props: { value?: TerminalDimensions; children: JSX.Element }): JSX.Element {
  const dimensions = props.value ?? useContext(TerminalDimensionsContext) ?? useTerminalDimensions();
  return (
    <TerminalDimensionsContext.Provider value={dimensions}>
      {props.children}
    </TerminalDimensionsContext.Provider>
  );
}

export function useTuiDimensions(): TerminalDimensions {
  return useContext(TerminalDimensionsContext) ?? useTerminalDimensions();
}
