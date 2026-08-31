import type { JSX } from "solid-js";
import { useTuiDimensions } from "../context/terminal";
import { COLOR } from "../theme";

export function inputFieldHeight(terminalHeight: number): number {
  return terminalHeight >= 20 ? 7 : 5;
}

export function InputField(props: { children: JSX.Element; marginTop?: number }): JSX.Element {
  const dims = useTuiDimensions();
  const height = () => inputFieldHeight(dims().height);
  const verticalInset = () => Math.floor((height() - 1) / 2);
  return (
    <box id="text-input-field" shouldFill style={{
      width: "100%",
      height: height(),
      minWidth: 0,
      flexShrink: 0,
      flexDirection: "row",
      marginTop: props.marginTop ?? 0,
      paddingTop: verticalInset(),
      paddingBottom: verticalInset(),
      paddingLeft: 3,
      paddingRight: 3,
      backgroundColor: COLOR.panelActive
    }}>
      {props.children}
    </box>
  );
}

export function InputFieldPrompt(): JSX.Element {
  return <text selectable={false} fg={COLOR.accent}>{"›  "}</text>;
}
