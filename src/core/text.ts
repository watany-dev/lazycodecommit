/**
 * Other people's text (titles, descriptions, rule names) with control
 * characters shown in caret notation, so an escape sequence in a title cannot
 * rewrite the user's screen or clipboard. Multiline text keeps \n and \t,
 * and CRLF becomes LF.
 */
export function printable(text: string, multiline = false): string {
  const s = multiline ? text.replaceAll("\r\n", "\n") : text;
  // oxlint-disable-next-line no-control-regex -- finding them is the point
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => {
    if (multiline && (c === "\n" || c === "\t")) return c;
    const code = c.charCodeAt(0);
    if (code === 0x7f) return "^?";
    // C1 controls are ESC + (code - 64): CSI (0x9b) reads as ^[[.
    return code < 0x20
      ? `^${String.fromCharCode(code + 64)}`
      : `^[${String.fromCharCode(code - 64)}`;
  });
}
