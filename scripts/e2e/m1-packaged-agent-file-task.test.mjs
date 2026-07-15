import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalPath, pathContains } from './m1-packaged-agent-file-task.mjs'

test('canonical containment rejects a symlink escape from the disposable root', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'simulator-m1-agent-path-test-'))
  try {
    const disposableRoot = join(temporary, 'disposable')
    const realUserWorkspace = join(temporary, 'real-user-workspace')
    const alias = join(disposableRoot, 'workspace-alias')
    await mkdir(disposableRoot)
    await mkdir(realUserWorkspace)
    await symlink(realUserWorkspace, alias, 'dir')

    const canonicalDisposableRoot = await canonicalPath(disposableRoot)
    const canonicalAlias = await canonicalPath(alias)
    assert.equal(pathContains(canonicalDisposableRoot, canonicalAlias), false)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('canonical containment preserves a not-yet-created child inside the disposable root', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'simulator-m1-agent-path-test-'))
  try {
    const disposableRoot = join(temporary, 'disposable')
    await mkdir(disposableRoot)
    const canonicalDisposableRoot = await canonicalPath(disposableRoot)
    const canonicalChild = await canonicalPath(join(disposableRoot, 'future', 'workspace'))
    assert.equal(pathContains(canonicalDisposableRoot, canonicalChild), true)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
