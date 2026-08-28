import type { JSX } from "solid-js";
import { COLOR } from "../../theme";

type ExpandedPanelProps = {
  children: JSX.Element;
  marginBottom?: number;
  id?: string;
};

export function ExpandedPanel(props: ExpandedPanelProps): JSX.Element {
  return (
    <box {...(props.id ? { id: props.id } : {})} style={{
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
