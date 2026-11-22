// What the action of a log row is called, given what it would change on the lists. Kept
// apart from the page so that the same table can be checked without one: a label names
// exactly the entry that is added, moved or removed, the tooltip says it in a sentence,
// and the line that reports the result says the same.

import type { LogOffer } from "../core/logAction";

/** The labels of the buttons, as the codes of their messages ("logLabel_trust_domain"). */
export const LOG_LABELS = ["trust-address", "trust-domain", "unblock-address", "unblock-domain", "block-address", "block-domain", "move-inbox", "move-junk", "trusted-now"] as const;
/** The tooltips, as the codes of their messages ("logTitle_trust_move"). */
export const LOG_TITLES = ["trust", "trust-move", "unblock", "unblock-move", "block", "move-inbox", "move-junk", "trusted-now"] as const;
/** The lines that report the change on the lists, as the codes of their messages ("logResult_unblocked"). */
export const LOG_RESULTS = ["trusted", "blocked", "moved-white", "moved-black", "unblocked", "already-trusted", "already-blocked"] as const;

export interface LogLabel {
  /** The label of the button, or of the note when nothing is left to do. */
  label: (typeof LOG_LABELS)[number];
  /** The tooltip, with its substitutions. */
  title: (typeof LOG_TITLES)[number];
  titleArgs: string[];
  /** False when the row offers nothing but a note: the lists already say it and the message was never moved. */
  acts: boolean;
}

/** `moves` says whether the action also moves the message (see expectsMove). */
export function logLabel(offer: LogOffer, moves: boolean): LogLabel {
  const value = offer.target.value;
  const domain = offer.target.kind === "domain";
  if (offer.action === "trust") {
    if (offer.change === "none") {
      // Already trusted: only the message may still be where the decision put it.
      return moves ? { label: "move-inbox", title: "move-inbox", titleArgs: [value], acts: true } : { label: "trusted-now", title: "trusted-now", titleArgs: [value], acts: false };
    }
    if (offer.change === "remove") {
      return { label: domain ? "unblock-domain" : "unblock-address", title: moves ? "unblock-move" : "unblock", titleArgs: [value, offer.behind?.value ?? ""], acts: true };
    }
    return { label: domain ? "trust-domain" : "trust-address", title: moves ? "trust-move" : "trust", titleArgs: [value], acts: true };
  }
  if (offer.change === "none") {
    return { label: "move-junk", title: "move-junk", titleArgs: [value], acts: true };
  }
  return { label: domain ? "block-domain" : "block-address", title: "block", titleArgs: [value], acts: true };
}

/** The line that reports what the action changed on the lists, with its substitutions. */
export function logResult(outcome: Pick<LogOffer, "change" | "list" | "target"> & { behind: { value: string } | null }): { code: (typeof LOG_RESULTS)[number]; args: string[] } {
  const white = outcome.list === "white";
  const value = outcome.target.value;
  switch (outcome.change) {
    case "add":
      return { code: white ? "trusted" : "blocked", args: [value] };
    case "move":
      return { code: white ? "moved-white" : "moved-black", args: [value] };
    case "remove":
      return { code: "unblocked", args: [value, outcome.behind?.value ?? ""] };
    default:
      return { code: white ? "already-trusted" : "already-blocked", args: [value] };
  }
}
