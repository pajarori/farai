import { createContext, useContext, type JSX } from "solid-js";

export type ExitHandler = () => Promise<void> | void;

const ExitContext = createContext<ExitHandler>();

type ExitProviderProps = {
  handler: ExitHandler;
  children: JSX.Element;
};

export function ExitProvider(props: ExitProviderProps): JSX.Element {
  return <ExitContext.Provider value={props.handler}>{props.children}</ExitContext.Provider>;
}

export function useExit(): ExitHandler {
  const handler = useContext(ExitContext);
  if (!handler) throw new Error("ExitProvider missing");
  return handler;
}
