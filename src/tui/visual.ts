// ANSI-aware string helpers for the TUI.
// These functions correctly measure and manipulate strings that may contain
// ANSI escape sequences and CJK (fullwidth) characters.

export function charDisplayWidth(codePoint: number): number {
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ffff) ||
    (codePoint >= 0x30000 && codePoint <= 0x3ffff)
  ) {
    return 2;
  }
  return 1;
}

/** Visible length of a string — ANSI escape sequences are ignored, CJK chars count as 2. */
export function vlen(s: string): number {
  let width = 0;
  let inEsc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\x1b" && s[i + 1] === "[") {
      inEsc = true;
      continue;
    }
    if (inEsc) {
      if (ch === "m") inEsc = false;
      continue;
    }
    const cp = s.codePointAt(i)!;
    width += charDisplayWidth(cp);
    if (cp > 0xffff) i++;
  }
  return width;
}

/** Pad a string to the given visible width with spaces. */
export function vpad(s: string, width: number): string {
  const vl = vlen(s);
  if (vl >= width) return s;
  return s + " ".repeat(width - vl);
}

/** Truncate a string to maxWidth visible columns, appending "…" if cut. */
export function vtrunc(s: string, maxWidth: number): string {
  let width = 0;
  let out = "";
  let inEsc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\x1b" && s[i + 1] === "[") {
      inEsc = true;
      out += ch;
      continue;
    }
    if (inEsc) {
      out += ch;
      if (ch === "m") inEsc = false;
      continue;
    }
    const cp = s.codePointAt(i)!;
    const cw = charDisplayWidth(cp);
    if (width + cw > maxWidth - 1) {
      out += "\x1b[0m…";
      break;
    }
    width += cw;
    out += cp > 0xffff ? String.fromCodePoint(cp) : ch;
    if (cp > 0xffff) i++;
  }
  return out;
}

/** Build a bordered panel with ANSI red borders. */
export function buildPanel(title: string, content: string[], width: number, maxH: number): string[] {
  const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
  const result: string[] = [];
  const innerW = width - 2;
  const titleStr = ` ${title} `;
  const dashCount = width - 2 - vlen(titleStr);
  result.push(red(`╭${titleStr}${"─".repeat(Math.max(0, dashCount))}╮`));
  const contentH = maxH - 2;
  for (let i = 0; i < contentH; i++) {
    const line = content[i] ?? "";
    result.push(red("│") + vpad(vtrunc(line, innerW), innerW) + red("│"));
  }
  result.push(red(`╰${"─".repeat(width - 2)}╯`));
  return result;
}
