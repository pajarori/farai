import { createContext, createSignal, useContext, type Accessor, type JSX } from "solid-js";

export type ExitHandler = () => Promise<void> | void;

type ExitContextValue = {
  exit: ExitHandler;
  exiting: Accessor<boolean>;
};

const ExitContext = createContext<ExitContextValue>();

type ExitProviderProps = {
  handler: ExitHandler;
  children: JSX.Element;
};

export function ExitProvider(props: ExitProviderProps): JSX.Element {
  const [exiting, setExiting] = createSignal(false);
  let pending: Promise<void> | undefined;
  const exit = (): Promise<void> => {
    if (pending) return pending;
    setExiting(true);
    pending = Promise.resolve().then(() => props.handler());
    return pending;
  };
  return <ExitContext.Provider value={{ exit, exiting }}>{props.children}</ExitContext.Provider>;
}

export function useExit(): ExitHandler {
  const context = useContext(ExitContext);
  if (!context) throw new Error("ExitProvider missing");
  return context.exit;
}

export function useExiting(): Accessor<boolean> {
  const context = useContext(ExitContext);
  if (!context) throw new Error("ExitProvider missing");
  return context.exiting;
}
