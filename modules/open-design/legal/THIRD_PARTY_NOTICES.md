# OpenDesign Runtime Third-Party Notices

This file inventories the native and WASM resources retained by the Simulator
Host-only OpenDesign runtime, plus a fail-closed audit for the excluded image
optimizer closure. It does not clear any resource whose decision remains
`review` or `pending` in `resource-decisions.json`.

## Cleared retained resources

| Package | Retained resource | License | Exact package LICENSE SHA-256 | Packaged license evidence | Official source |
| --- | --- | --- | --- | --- | --- |
| `better-sqlite3@12.10.0` | `better_sqlite3.node` | MIT | `09856b52897c91ab67e7456ef43067019f31dfd3b87fda72e655736b1ebdee55` | `legal/licenses/better-sqlite3-12.10.0.LICENSE` | https://github.com/WiseLibs/better-sqlite3/tree/v12.10.0 |
| `node-pty@1.1.0` | `pty.node`, `spawn-helper` | MIT | `a3d60eaf32d2fb09c9d82ef39f14bd6e2c0f3ca7de30daa827486c0d6f8b6e9f` | `legal/licenses/node-pty-1.1.0.LICENSE` | https://github.com/microsoft/node-pty/tree/v1.1.0 |
| `blake3-wasm@2.1.5` | `blake3_js_bg.wasm` | MIT | `6ae51be712bd278ca37cd2204a6e836d71aacea5b7b8210d5a95c0e02a15dc35` | `legal/licenses/blake3-wasm-2.1.5.LICENSE` | https://github.com/connor4312/blake3/tree/v2.1.5 |

The three MIT license files above are byte-for-byte copies of the corresponding
package LICENSE files from the pinned pnpm content-addressable store.

## Excluded image-optimizer closure

Host-only OpenDesign configures unoptimized images and the staging gate removes
`sharp@0.34.5`, `@img/colour@1.1.0`, `@img/sharp-darwin-arm64@0.34.5` and
`@img/sharp-libvips-darwin-arm64@1.2.4` in full. The final Artifact must contain
none of these package paths. The evidence below is retained only as the
fail-closed audit required if a future change reintroduces this closure.

The exact `@img/sharp-darwin-arm64@0.34.5` package LICENSE SHA-256 is
`73ba74dfaa520b49a401b5d21459a8523a146f3b7518a833eea5efa85130bf68`;
official source: https://github.com/lovell/sharp/tree/v0.34.5.

### sharp-libvips fallback audit

`@img/sharp-libvips-darwin-arm64@1.2.4` declares
`LGPL-3.0-or-later` and contains `libvips-cpp.8.17.3.dylib`. Its package has no
LICENSE file. The pinned package manifest SHA-256 is
`36961cede2dd16bfac3ba20dbd340162e5f06ff0a4c766fb640a3aad2241940b`.
The pinned package README (SHA-256
`47c37432ea30fcf5767611bca7c054d141f7584479ce8b58b5de6b88f9008d1d`)
lists libvips plus bundled dependencies under multiple LGPL, MIT, BSD, MPL,
ISC and other licenses; `versions.json` (SHA-256
`e823074bfa33ed7b1861b797dd3c60d7ef8c34cd2faa9a7d22ec32dd6d6ad8ad`)
pins libvips `8.17.3` and the dependency versions.

The five staged dylib paths are byte-identical (SHA-256
`ad39fe2d407fca7532326eb819af010725a1df9187ef26a6d4aba629b71f173d`).
They are five materialized paths for one binary payload, not five distinct
license decisions.

Official sources:

- https://github.com/lovell/sharp-libvips/tree/v1.2.4
- https://github.com/libvips/libvips/releases/tag/v8.17.3

The official tags resolve to sharp-libvips commit
`20b5e899954907a3039d6e3d4c200aaa0ec52c4c` and libvips commit
`0c9151a4f416d2f8ae20a755db218f6637050eec`. At those commits, the
sharp-libvips root LICENSE (SHA-256
`b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1`)
licenses its packaging scripts under Apache-2.0; it does not replace the
third-party bundle licenses. The libvips `8.17.3` LICENSE (SHA-256
`dc626520dcd53a22f727af3ee42c770e56c97a64fe3adb063799d8ab032fe551`)
contains LGPL-2.1 terms, while the binary package applies the documented
"any later version" path and declares `LGPL-3.0-or-later`.

If this dylib is ever reintroduced, redistribution remains blocked until that
Artifact includes and verifies all required license/copyright notices, exact
Corresponding Source or a durable source offer, and a verified
replacement/relinking path suitable for the exact dylib bundle. Because the
official module channel is hash-sealed, the product must also demonstrate that
its install and launch checks do not prevent the applicable user replacement
path. This notice records technical evidence and a future-change guard; it is
not a legal conclusion or rights clearance.
