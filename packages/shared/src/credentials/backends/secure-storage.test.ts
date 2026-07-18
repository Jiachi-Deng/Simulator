import { afterEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { SecureStorageBackend } from './secure-storage.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

const temporaryRoots: string[] = [];
const originalConfigDir = process.env.CRAFT_CONFIG_DIR;
const credentialId: CredentialId = { type: 'llm_api_key', connectionSlug: 'acceptance' };

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'secure-storage-')));
  temporaryRoots.push(root);
  return root;
}

function credential(value: string): StoredCredential {
  return { value };
}

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
  else process.env.CRAFT_CONFIG_DIR = originalConfigDir;

  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('SecureStorageBackend config-root isolation', () => {
  it('keeps explicit stores isolated from one another', async () => {
    const root = fixture();
    const defaultRoot = join(root, 'default');
    const configRootA = join(root, 'config-a');
    const configRootB = join(root, 'config-b');
    const defaultStore = new SecureStorageBackend(defaultRoot);
    const storeA = new SecureStorageBackend(configRootA);
    const storeB = new SecureStorageBackend(configRootB);

    await defaultStore.set(credentialId, credential('default-value'));
    expect(await storeA.get(credentialId)).toBeNull();
    expect(await storeB.get(credentialId)).toBeNull();

    await storeA.set(credentialId, credential('value-a'));
    await storeB.set(credentialId, credential('value-b'));

    expect(await defaultStore.get(credentialId)).toEqual(credential('default-value'));
    expect(await storeA.get(credentialId)).toEqual(credential('value-a'));
    expect(await storeB.get(credentialId)).toEqual(credential('value-b'));
  });

  it('uses CRAFT_CONFIG_DIR without falling back to the default store', async () => {
    const root = fixture();
    const defaultRoot = join(root, 'default');
    const isolatedRoot = join(root, 'isolated');
    const defaultStore = new SecureStorageBackend(defaultRoot);
    await defaultStore.set(credentialId, credential('default-only'));

    process.env.CRAFT_CONFIG_DIR = isolatedRoot;
    const isolatedStore = new SecureStorageBackend();
    expect(await isolatedStore.get(credentialId)).toBeNull();

    await isolatedStore.set(credentialId, credential('isolated-only'));
    expect(await new SecureStorageBackend(defaultRoot).get(credentialId)).toEqual(
      credential('default-only'),
    );
    expect(await new SecureStorageBackend(isolatedRoot).get(credentialId)).toEqual(
      credential('isolated-only'),
    );
  });

  it('preserves ~/.craft-agent as the no-env default', () => {
    const home = fixture();
    const moduleUrl = pathToFileURL(join(import.meta.dir, 'secure-storage.ts')).href;
    const childEnv: Record<string, string | undefined> = { ...process.env, HOME: home };
    delete childEnv.CRAFT_CONFIG_DIR;

    const result = Bun.spawnSync(
      [
        process.execPath,
        '--eval',
        `
          import { SecureStorageBackend } from ${JSON.stringify(moduleUrl)};
          const backend = new SecureStorageBackend();
          await backend.set(
            { type: 'llm_api_key', connectionSlug: 'default-home' },
            { value: 'default-home-value' },
          );
        `,
      ],
      { env: childEnv, stdout: 'pipe', stderr: 'pipe' },
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(join(home, '.craft-agent', 'credentials.enc'))).toBe(true);
  });

  it('creates and repairs owner-only directory and file modes', async () => {
    if (process.platform === 'win32') return;
    const root = fixture();
    const configRoot = join(root, 'config');
    const credentialsFile = join(configRoot, 'credentials.enc');
    const backend = new SecureStorageBackend(configRoot);

    await backend.set(credentialId, credential('mode-value'));
    expect(lstatSync(configRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(credentialsFile).mode & 0o777).toBe(0o600);

    chmodSync(configRoot, 0o755);
    chmodSync(credentialsFile, 0o644);
    expect(await new SecureStorageBackend(configRoot).get(credentialId)).toEqual(
      credential('mode-value'),
    );
    expect(lstatSync(configRoot).mode & 0o777).toBe(0o700);
    expect(lstatSync(credentialsFile).mode & 0o777).toBe(0o600);
  });

  it('fails closed for symlinked directories and credential files', async () => {
    if (process.platform === 'win32') return;
    const root = fixture();
    const targetDirectory = join(root, 'target-directory');
    const directoryAlias = join(root, 'directory-alias');
    mkdirSync(targetDirectory, { mode: 0o700 });
    symlinkSync(targetDirectory, directoryAlias, 'dir');

    await expect(
      new SecureStorageBackend(directoryAlias).set(credentialId, credential('must-not-write')),
    ).rejects.toThrow('must be a real directory');
    expect(existsSync(join(targetDirectory, 'credentials.enc'))).toBe(false);

    const configRoot = join(root, 'config');
    const outsideFile = join(root, 'outside');
    mkdirSync(configRoot, { mode: 0o700 });
    writeFileSync(outsideFile, 'outside-data', { mode: 0o600 });
    symlinkSync(outsideFile, join(configRoot, 'credentials.enc'));

    await expect(new SecureStorageBackend(configRoot).get(credentialId)).rejects.toThrow(
      'must be a unique regular file',
    );
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside-data');
  });

  it('fails closed when a parent component aliases the credential directory', async () => {
    if (process.platform === 'win32') return;
    const root = fixture();
    const actualParent = join(root, 'actual-parent');
    const parentAlias = join(root, 'parent-alias');
    const configRoot = join(actualParent, 'config');
    mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    symlinkSync(actualParent, parentAlias, 'dir');

    await expect(
      new SecureStorageBackend(join(parentAlias, 'config')).set(
        credentialId,
        credential('must-not-write'),
      ),
    ).rejects.toThrow('must be canonical');
    expect(existsSync(join(configRoot, 'credentials.enc'))).toBe(false);
  });

  it('fails closed for hard-linked credential files', async () => {
    if (process.platform === 'win32') return;
    const root = fixture();
    const configRoot = join(root, 'config');
    const outsideFile = join(root, 'outside');
    mkdirSync(configRoot, { mode: 0o700 });
    writeFileSync(outsideFile, 'outside-data', { mode: 0o600 });
    linkSync(outsideFile, join(configRoot, 'credentials.enc'));

    await expect(new SecureStorageBackend(configRoot).get(credentialId)).rejects.toThrow(
      'must be a unique regular file',
    );
    expect(readFileSync(outsideFile, 'utf8')).toBe('outside-data');
  });
});
