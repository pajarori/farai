import type { JSX } from "solid-js";
import { createPrimaryClickGesture } from "../../input/mouse";
import { COLOR } from "../../theme";

type ExpandedPanelProps = {
  children: JSX.Element;
  marginBottom?: number;
  id?: string;
  onClick?: () => void;
};

export function ExpandedPanel(props: ExpandedPanelProps): JSX.Element {
  const click = createPrimaryClickGesture(() => props.onClick?.());
  return (
    <box {...(props.id ? { id: props.id } : {})} {...(props.onClick ? click : {})} style={{
      width: "100%",
      flexDirection: "column",
      marginTop: 1,
      marginBottom: props.marginBottom ?? 0,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
      backgroundColor: COLOR.panelActive
    }}>
      {props.children}
    </box>
  );
}
