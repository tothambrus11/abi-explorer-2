// What a field's menu offers.
//
// In its own module rather than exported from the component, so the row that
// builds the items and the menu that shows them agree on the type without
// either importing the other's markup.

/** One row of a `ChipMenu`. */
export interface MenuItem {
  /** What choosing it means: a language id, a standard, a triple. */
  value: string;
  /** What the row reads as. */
  label: string;
  /** Dim text at the end of the row: the triple behind a target's name. */
  note?: string;
  /** The heading this row sits under, shown while nothing is being filtered. */
  group?: string;
}
