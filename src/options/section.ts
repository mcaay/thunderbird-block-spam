import type { Model } from "./model";

/** One part of the settings page. It builds its fixed elements once and fills them on render. */
export interface Section {
  render(model: Model): void;
}
