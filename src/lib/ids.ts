import { nanoid } from "nanoid";

export type IdPrefix =
  | "man" // mandate
  | "bid"
  | "msg" // workroom message
  | "art" // workroom artifact
  | "sub" // submission
  | "evl" // evaluation
  | "dsp" // dispute
  | "rcp" // receipt
  | "crd"; // credential

/** Prefixed, URL-safe unique identifier, e.g. `man_V1StGXR8_Z5jdHi6B-myT`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${nanoid(21)}`;
}
