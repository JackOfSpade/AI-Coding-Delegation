import { relative } from 'node:path';

// TAP is deliberately declaration-ordered, so a slow early file can hide the
// progress of other concurrent files. Dequeue events describe actual execution
// order. Keep this diagnostic stream separate from stdout's strict TAP audit.
export default async function* progressReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:dequeue') continue;
    const file = typeof event.data.file === 'string' ? relative(process.cwd(), event.data.file) : '(test runner)';
    yield `[test progress ${new Date().toISOString()}] ${file}: ${JSON.stringify(event.data.name)}\n`;
  }
}
