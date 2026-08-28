import { createContext, useContext, type JSX } from "solid-js";
import type { TuiRuntimePort, TuiCapabilities } from "../runtime-port";

export type TuiRuntimeContextValue = {
  port: TuiRuntimePort;
  workspace: string;
  capabilities: TuiCapabilities;
};

const RuntimeContext = createContext<TuiRuntimeContextValue>();

type TuiRuntimeProviderProps = {
  value: TuiRuntimeContextValue;
  children: JSX.Element;
};

export function TuiRuntimeProvider(props: TuiRuntimeProviderProps): JSX.Element {
  return (
    <RuntimeContext.Provider value={props.value}>
      {props.children}
    </RuntimeContext.Provider>
  );
}

export function useTuiRuntime(): TuiRuntimeContextValue {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error("TuiRuntimeProvider missing");
  return ctx;
}
