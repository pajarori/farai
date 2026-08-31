import { BoxRenderable, type BoxOptions, type RenderContext } from "@opentui/core";
import { extend, type ExtendedComponentProps } from "@opentui/solid";
import type { JSX } from "solid-js";

export interface SurfaceLayerOptions extends BoxOptions {
  renderChildren?: boolean;
}

export class SurfaceLayerRenderable extends BoxRenderable {
  private _renderChildren = true;

  constructor(ctx: RenderContext, options: SurfaceLayerOptions) {
    super(ctx, options);
    this._renderChildren = options.renderChildren ?? true;
  }

  get renderChildren(): boolean {
    return this._renderChildren;
  }

  set renderChildren(value: boolean) {
    if (this._renderChildren === value) return;
    this._renderChildren = value;
    this.requestRender();
  }

  protected override _hasVisibleChildFilter(): boolean {
    return !this._renderChildren;
  }

  protected override _getVisibleChildren(): number[] {
    return this._renderChildren ? super._getVisibleChildren() : [];
  }
}

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    surface_layer: typeof SurfaceLayerRenderable;
  }
}

extend({ surface_layer: SurfaceLayerRenderable });

type SurfaceLayerProps = ExtendedComponentProps<typeof SurfaceLayerRenderable>;

export function SurfaceLayer(props: SurfaceLayerProps): JSX.Element {
  return <surface_layer {...props} />;
}
