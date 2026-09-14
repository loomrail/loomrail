export type BoundedActivityText = {
  text: string | null;
  truncated: boolean;
};

/**
 * Trims a provider-reported string to its contract bound.
 *
 * Cutting by code points rather than by UTF-16 units: slicing a string in the middle of a
 * surrogate pair produces a replacement character, which is a corruption the reader cannot tell
 * from the provider's own output. `truncated` is returned rather than an ellipsis appended,
 * because the marker belongs to the record, not to the text -- appending to the text would make
 * the fragment indistinguishable from a provider that really ended its line with an ellipsis.
 */
export const boundActivityText = (value: string, maxChars: number): BoundedActivityText => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { text: null, truncated: false };
  const points = [...trimmed];
  if (points.length <= maxChars) return { text: trimmed, truncated: false };
  return { text: points.slice(0, maxChars).join(""), truncated: true };
};
