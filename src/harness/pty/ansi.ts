// CSI (colors, cursor), OSC (titles, hyperlinks), and single-char escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()#][A-Za-z0-9]|\u001b[=>NOMDEHc78]/g

/** Plain text from terminal output: drops escape codes and resolves carriage-return overwrites. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.replace(/\r+$/, '').split('\r').pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .map((l) => l.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''))
    .join('\n')
}
