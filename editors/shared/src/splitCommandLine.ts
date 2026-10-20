// Splitting a command line into arguments, as a compile_commands.json reader
// must (its `command` form) and as CMake Tools' flag fragments need.

export type PathStyle = 'posix' | 'win32';

/**
 * Splits a `command` string from compile_commands.json into arguments.
 *
 * Two grammars, as clang's JSONCompilationDatabase has: a POSIX shell's quoting
 * and backslash escapes, or Windows' `CommandLineToArgvW` rules, where a
 * backslash is a path separator unless it precedes a quote.
 */
export function splitCommandLine(command: string, style: PathStyle): string[] {
  return style === 'win32' ? splitWindows(command) : splitPosix(command);
}

function splitPosix(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else current += c;
    } else if (c === '\\' && i + 1 < command.length) {
      const next = command[++i]!;
      if (quote === '"' && !'"\\$`'.includes(next)) current += '\\';
      current += next;
      inArg = true;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) args.push(current);
      current = '';
      inArg = false;
    } else {
      current += c;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}

function splitWindows(command: string): string[] {
  const args: string[] = [];
  let current = '';
  let inArg = false;
  let quoted = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === '\\') {
      let backslashes = 0;
      while (command[i] === '\\') {
        backslashes++;
        i++;
      }
      if (command[i] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) current += '"';
        else quoted = !quoted;
      } else {
        current += '\\'.repeat(backslashes);
        i--;
      }
      inArg = true;
    } else if (c === '"') {
      quoted = !quoted;
      inArg = true;
    } else if (!quoted && /\s/.test(c)) {
      if (inArg) args.push(current);
      current = '';
      inArg = false;
    } else {
      current += c;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}
