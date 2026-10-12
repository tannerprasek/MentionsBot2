// Writes the package's "Siri Shortcuts" folder: each shortcut asks for CastBot's address when added.
// Run with: npm run build:shortcuts
import fs from 'node:fs'
import path from 'node:path'
import { SHORTCUTS, buildShortcut } from '../src/shortcuts.js'

const dir = path.resolve('Siri Shortcuts')
fs.mkdirSync(dir, { recursive: true })
for (const name of Object.keys(SHORTCUTS)) {
  fs.writeFileSync(path.join(dir, `${name}.shortcut`), buildShortcut(name))
  console.log('wrote', name)
}
