export const TSX_LOADER_FIX = 'replace npx tsx / tsx with node --import tsx (for example: node --import tsx ./check.ts)';

// Detection only: do not rewrite shell syntax or translate tsx-only options
// (watch, --tsconfig, etc.) into Node options. Quoted executables, escaped
// spaces and environment assignments are common in caller test commands.
function commandWords(command) {
  const words = [];
  let word = '',
    quote = '',
    started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === '\\' && quote !== "'") {
      if (index + 1 >= command.length) return [];
      word += command[++index];
      started = true;
    } else if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = '';
        started = false;
      }
    } else if (/[;&|<>()`$]/.test(char)) {
      if (started) words.push(word);
      return words;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return [];
  if (started) words.push(word);
  return words;
}

export function isTsxCliCommand(command) {
  if (typeof command !== 'string') return false;
  const words = commandWords(command);
  while (words[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  if (words[0] === 'env') {
    words.shift();
    while (words[0] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['-i', '--ignore-environment', '--'].includes(words[0])))
      words.shift();
  }
  const executable = (word) =>
    String(word ?? '')
      .replaceAll('\\', '/')
      .split('/')
      .at(-1);
  if (executable(words[0]) === 'tsx') return true;
  if (executable(words[0]) !== 'npx') return false;
  words.shift();
  while (['--no-install', '--yes', '-y', '--', '--offline'].includes(words[0])) words.shift();
  return words[0] === 'tsx' || /^tsx@[^\s]+$/.test(words[0] ?? '');
}

export function assertVerifierCommand(command) {
  if (!isTsxCliCommand(command)) return;
  const error = new Error(
    `testCommand uses the tsx CLI, which opens a Unix IPC listener; ${TSX_LOADER_FIX}. Review CLI-only flags rather than copying them to Node.`,
  );
  error.code = 'E_VERIFIER_TSX_CLI';
  throw error;
}
