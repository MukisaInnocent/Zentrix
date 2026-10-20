import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

// Reads a secret from the terminal without echoing it, or from an environment variable in automation.
export async function promptSecret(question: string, envName: string): Promise<string> {
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;
  if (!stdin.isTTY) throw new Error(`Set ${envName} or run this command in an interactive terminal.`);
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          return reject(new Error('Cancelled'));
        }
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
