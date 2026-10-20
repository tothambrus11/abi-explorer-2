#!/usr/bin/env node
// Runs a language server and writes every message between it and the editor to
// a file, one JSON object a line: `{ "from": "editor" | "server", "message": … }`.
// The smoke tests start editors with this in front of the server, then read the
// file to see what the editor asked and what it was told.
//
//   node lsp-recorder.mjs <trace.jsonl> <server command…>

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [trace, program, ...args] = process.argv.slice(2);
if (!trace || !program) {
  console.error('usage: lsp-recorder.mjs <trace.jsonl> <server command…>');
  process.exit(2);
}

const out = fs.openSync(trace, 'a');
const server = spawn(program, args, { stdio: ['pipe', 'pipe', 'inherit'] });

/** Passes bytes through untouched, and records each complete message as it goes by. */
function relay(from, input, output) {
  let pending = Buffer.alloc(0);
  input.on('data', (chunk) => {
    output.write(chunk);
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const headerEnd = pending.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(
        /Content-Length:\s*(\d+)/i.exec(pending.subarray(0, headerEnd).toString())?.[1],
      );
      const start = headerEnd + 4;
      if (pending.length < start + length) return;
      const body = pending.subarray(start, start + length).toString('utf8');
      pending = pending.subarray(start + length);
      fs.writeSync(out, JSON.stringify({ from, message: JSON.parse(body) }) + '\n');
    }
  });
}

relay('editor', process.stdin, server.stdin);
relay('server', server.stdout, process.stdout);
process.stdin.on('end', () => server.stdin.end());
server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
