// Minimal glob -> RegExp for scoping find_def results by path. Supports `**`
// (across path segments), `*` (within a segment) and `?`. Paths are posix-style.
// Intentionally NOT a full glob (no brace/extglob expansion) — sufficient for
// find_def's optional path scoping. A fuller matcher can replace this in P2 when
// vocabulary path-locators need richer semantics.

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches across segments; consume a following slash so `**/x`
        // matches `x` at the root too.
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(REGEX_SPECIAL, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

export function matchGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}
