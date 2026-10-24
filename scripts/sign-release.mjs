import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const EMBEDDED_KEY = /export const RELEASE_PUBLIC_KEY_PEM = `([^`]+)`;/;
const EMBEDDED_VERSION = /^export const PLUGIN_VERSION = '(\d+\.\d+\.\d+)';$/m;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function main() {
  const [pluginPath, privateKeyPath] = process.argv.slice(2);
  if (!pluginPath || !privateKeyPath) {
    fail('Usage: node scripts/sign-release.mjs <mywardogsstats.js> <private key path>');
  }

  const file = readFileSync(pluginPath);
  const text = file.toString('utf8');
  if (text.includes('\r')) fail('The plugin file has CR line endings. Sign the LF bytes that are committed.');
  if (file.length > 512 * 1024) fail('The plugin file is over 512 KB and would be refused by the updater.');
  const version = EMBEDDED_VERSION.exec(text)?.[1];
  if (!version) fail('No PLUGIN_VERSION constant found in the plugin file.');

  const embedded = EMBEDDED_KEY.exec(text)?.[1];
  if (!embedded || !embedded.includes('BEGIN PUBLIC KEY')) fail('RELEASE_PUBLIC_KEY_PEM is still the placeholder. Paste the public key first.');

  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(privateKeyPath));
  } catch {
    fail('Could not read the private key.');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('The private key is not ed25519.');

  const signature = sign(null, file, privateKey);
  if (!verify(null, file, createPublicKey(embedded), signature)) {
    fail('The private key does not match RELEASE_PUBLIC_KEY_PEM in the plugin file.');
  }

  const sigPath = `${pluginPath}.sig`;
  writeFileSync(sigPath, `${signature.toString('base64')}\n`);
  console.log(`Signed ${pluginPath} version ${version}, wrote ${sigPath}.`);
}

main();
