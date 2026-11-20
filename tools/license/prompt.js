'use strict';

const readline = require('readline');

/** Ask a question on the terminal. `hidden` masks what is typed (passphrases). */
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(s);
        else if (s.includes('\n') || s.includes('\r')) process.stdout.write('\n');
      };
    }
    let answered = false;
    // Input ended without an answer (no keyboard attached, piped/closed stdin): stop with a clear
    // error and a non-zero exit code instead of exiting "successfully" with nothing issued.
    rl.on('close', () => {
      if (answered) return;
      process.stderr.write('\nNo answer was given (input is closed). Pass the value as an option, e.g. --tier premium. Nothing was issued.\n');
      process.exit(1);
    });
    rl.question(question, (answer) => {
      answered = true;
      rl.close();
      resolve(answer);
    });
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

module.exports = { ask, parseArgs };
