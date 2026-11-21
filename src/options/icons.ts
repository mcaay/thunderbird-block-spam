// Small outline icons for buttons and message bars, drawn for this add-on in the
// style of Thunderbird's own: a 16 pixel grid, a stroke in the text color, round
// caps and joins. The category icons of the settings page are in options.html.

const SVG = "http://www.w3.org/2000/svg";

/** Path data per icon. A leading "fill:" marks a closed shape that gets the faint fill. */
const PATHS = {
  close: ["M4 4l8 8M12 4l-8 8"],
  up: ["M8 12.5v-9M4.2 7.2 8 3.4l3.8 3.8"],
  down: ["M8 3.5v9M4.2 8.8 8 12.6l3.8-3.8"],
  trash: ["fill:M4.2 5h7.6l-.6 7.4c-.1.9-.7 1.4-1.5 1.4H6.3c-.8 0-1.4-.5-1.5-1.4z", "M2.8 5h10.4M6.2 5V3.6c0-.6.4-1 1-1h1.6c.6 0 1 .4 1 1V5M6.8 7.6v3.6M9.2 7.6v3.6"],
  check: ["M3.5 8.4 6.6 11.5 12.6 4.8"],
  copy: ["fill:M6 5.5h6.5v8H6z", "M10 5.5v-3H3.5v8H6"],
  search: ["fill:M7 2.8a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4z", "M10.2 10.2 13.4 13.4"],
  off: ["fill:M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z", "M5.4 8h5.2"],
  info: ["fill:M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z", "M8 7.2v4M8 4.8v.2"],
  success: ["fill:M8 1.8a6.2 6.2 0 1 1 0 12.4A6.2 6.2 0 0 1 8 1.8z", "M5.2 8.2 7.2 10.2 10.9 6"],
  warning: ["fill:M8 2.2 14.3 13.2H1.7z", "M8 6.4v3.2M8 11.4v.2"],
  critical: ["fill:M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4l-3.6-3.6V5.4z", "M8 4.8v3.8M8 10.8v.2"],
  external: ["M6.5 3.5h-3v9h9v-3M9 3h4v4M13 3 7.5 8.5"],
} as const;

export type IconName = keyof typeof PATHS;

/** An inline SVG icon. It is decoration: the control that carries it has the accessible name. */
export function icon(name: IconName, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `icon icon-${name}`);
  for (const data of PATHS[name]) {
    const path = document.createElementNS(SVG, "path");
    const filled = data.startsWith("fill:");
    path.setAttribute("d", filled ? data.slice(5) : data);
    if (filled) {
      path.setAttribute("class", "fill");
    }
    svg.appendChild(path);
  }
  return svg;
}
