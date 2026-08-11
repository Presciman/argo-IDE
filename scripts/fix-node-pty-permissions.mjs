import { chmodSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// node-pty 1.1.0 ships macOS prebuilt spawn-helper binaries without the
// executable bit. The native addon then fails with the opaque
// "posix_spawnp failed" error. Fix every bundled macOS architecture so both
// development and packaged arm64/x64 builds work after a clean npm install.
const prebuilds = resolve('node_modules', 'node-pty', 'prebuilds')

if (existsSync(prebuilds)) {
  for (const directory of readdirSync(prebuilds)) {
    if (!directory.startsWith('darwin-')) continue
    const helper = join(prebuilds, directory, 'spawn-helper')
    if (existsSync(helper)) {
      chmodSync(helper, 0o755)
      console.log(`Made node-pty spawn-helper executable: ${helper}`)
    }
  }
}
