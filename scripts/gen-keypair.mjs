import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function insideRepo(target) {
  return within(repoRoot, target) || within(realpathSync(repoRoot), target);
}

function refuse() {
  console.error('Refusing to write a keypair inside the plugin repo. Choose a directory outside it.');
  process.exit(2);
}

function main() {
  const [outDirArg] = process.argv.slice(2);
  if (!outDirArg) {
    console.error('Usage: node scripts/gen-keypair.mjs <directory outside this repo>');
    process.exit(2);
  }
  if (insideRepo(path.resolve(outDirArg))) refuse();
  mkdirSync(outDirArg, { recursive: true });
  const outDir = realpathSync(path.resolve(outDirArg));
  if (insideRepo(outDir)) refuse();

  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privatePath = path.join(outDir, 'mwds-release-private.pem');
  const publicPath = path.join(outDir, 'mwds-release-public.pem');

  try {
    writeFileSync(privatePath, privatePem, { flag: 'wx', mode: 0o600 });
    writeFileSync(publicPath, publicPem, { flag: 'wx', mode: 0o644 });
  } catch (err) {
    if (err?.code === 'EEXIST') {
      console.error('A keypair already exists in that directory. Not overwriting it.');
      process.exit(2);
    }
    throw err;
  }

  console.log(`Private key written to ${privatePath}. Keep it offline, never commit it, never put it in CI.`);
  console.log(`Public key written to ${publicPath}. Paste it into RELEASE_PUBLIC_KEY_PEM in mywardogsstats.js:`);
  console.log(publicPem.trim());
}

main();
