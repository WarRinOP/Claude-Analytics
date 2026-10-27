// The wording of a definition stays as the API gives it; only the backtick marks around code are turned into code styling.
// "a `user` record" to ["a ", <code>user</code>, " record"].
export function withCode(text: string): Array<string | { code: string }> {
  const out: Array<string | { code: string }> = [];
  text.split('`').forEach((piece, i) => {
    if (piece === '') return;
    out.push(i % 2 === 1 ? { code: piece } : piece);
  });
  return out;
}
