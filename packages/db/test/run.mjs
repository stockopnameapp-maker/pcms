// Creates the throw-away second Group, runs the given test files, removes the fixture again.
import { spawnSync } from 'node:child_process';
import { up, down } from './foreign-tenant.mjs';

await up();
let status = 1;
try {
  status = spawnSync(process.execPath, process.argv.slice(2), { stdio: 'inherit' }).status ?? 1;
} finally {
  await down();
}
process.exit(status);
