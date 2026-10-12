// Builds the Siri Shortcuts (.shortcut files, XML plist) for this CastBot.
// Each shortcut starts with a Text step holding CastBot's address; when that address isn't
// baked in, Shortcuts asks for it when the shortcut is added (an "import question").
import crypto from 'node:crypto'

const OBJ = '￼' // placeholder character that a variable occupies in a text field

// --- Minimal XML plist writer ---
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function plistValue (v, ind) {
  const pad = '\t'.repeat(ind)
  if (Array.isArray(v)) return v.length ? `<array>\n${v.map((x) => pad + '\t' + plistValue(x, ind + 1)).join('\n')}\n${pad}</array>` : '<array/>'
  if (typeof v === 'boolean') return v ? '<true/>' : '<false/>'
  if (typeof v === 'number') return Number.isInteger(v) ? `<integer>${v}</integer>` : `<real>${v}</real>`
  if (v && typeof v === 'object') {
    const keys = Object.keys(v)
    return keys.length ? `<dict>\n${keys.map((k) => `${pad}\t<key>${esc(k)}</key>\n${pad}\t${plistValue(v[k], ind + 1)}`).join('\n')}\n${pad}</dict>` : '<dict/>'
  }
  return `<string>${esc(v)}</string>`
}
const plist = (root) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(root, 0)}\n</plist>\n`

// --- Shortcut building blocks ---
const id = () => crypto.randomUUID().toUpperCase()
const out = (uid, name) => ({ Type: 'ActionOutput', OutputUUID: uid, OutputName: name })
const attach = (uid, name) => ({ Value: out(uid, name), WFSerializationType: 'WFTextTokenAttachment' })
function text (s, refs = []) {
  const attachmentsByRange = {}
  let i = 0
  ;[...s].forEach((ch, pos) => { if (ch === OBJ) attachmentsByRange[`{${pos}, 1}`] = out(...refs[i++]) })
  return { Value: refs.length ? { string: s, attachmentsByRange } : { string: s }, WFSerializationType: 'WFTextTokenString' }
}
const act = (ident, params) => ({ WFWorkflowActionIdentifier: `is.workflow.actions.${ident}`, WFWorkflowActionParameters: params })

function wrap (actions, base, color, glyph) {
  return {
    WFWorkflowClientVersion: '2607.0.1',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: color, WFWorkflowIconGlyphNumber: glyph },
    WFWorkflowImportQuestions: base
      ? []
      : [{ ActionIndex: 0, Category: 'Parameter', ParameterKey: 'WFTextActionText', DefaultValue: 'http://192.168.1.10:8787', Text: "CastBot's address (the \"from your phone\" line in the CastBot window)" }],
    WFWorkflowInputContentItemClasses: ['WFStringContentItem'],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowTypes: ['Watch'],
    WFWorkflowHasShortcutInputVariables: false,
    WFQuickActionSurfaces: [],
    WFWorkflowActions: actions
  }
}

// The address step every shortcut starts with.
const addressStep = (uid, base) => act('gettext', { UUID: uid, CustomOutputName: 'CastBot', WFTextActionText: text(base || 'http://192.168.1.10:8787') })

// GET or POST one CastBot endpoint, then have Siri read its "speak" reply.
function simple (base, path, method) {
  const b = id(); const r = id(); const msg = id()
  return [
    addressStep(b, base),
    act('downloadurl', { UUID: r, CustomOutputName: 'CastBot Reply', WFURL: text(OBJ + path, [[b, 'CastBot']]), WFHTTPMethod: method }),
    act('getvalueforkey', { UUID: msg, CustomOutputName: 'Message', WFInput: attach(r, 'CastBot Reply'), WFDictionaryKey: 'speak' }),
    act('speaktext', { WFText: text(OBJ, [[msg, 'Message']]) })
  ]
}

function main (base) {
  const b = id(); const ask = id(); const tvs = id(); const tv = id(); const play = id(); const msg = id(); const link = id(); const group = id()
  return [
    addressStep(b, base),
    act('ask', { UUID: ask, CustomOutputName: 'Title', WFInputType: 'Text', WFAskActionPrompt: 'What do you want to watch?' }),
    act('downloadurl', { UUID: tvs, CustomOutputName: 'TV List', WFURL: text(OBJ + '/tvs', [[b, 'CastBot']]), WFHTTPMethod: 'GET' }),
    act('choosefromlist', { UUID: tv, CustomOutputName: 'TV', WFInput: attach(tvs, 'TV List'), WFChooseFromListActionPrompt: 'Which TV?' }),
    act('downloadurl', {
      UUID: play,
      CustomOutputName: 'CastBot Reply',
      WFURL: text(OBJ + '/play', [[b, 'CastBot']]),
      WFHTTPMethod: 'POST',
      WFHTTPBodyType: 'JSON',
      ShowHeaders: false,
      WFJSONValues: {
        Value: {
          WFDictionaryFieldValueItems: [
            { WFItemType: 0, WFKey: text('title'), WFValue: text(OBJ, [[ask, 'Title']]) },
            { WFItemType: 0, WFKey: text('tv'), WFValue: text(OBJ, [[tv, 'TV']]) }
          ]
        },
        WFSerializationType: 'WFDictionaryFieldValue'
      }
    }),
    act('getvalueforkey', { UUID: msg, CustomOutputName: 'Message', WFInput: attach(play, 'CastBot Reply'), WFDictionaryKey: 'speak' }),
    act('speaktext', { WFText: text(OBJ, [[msg, 'Message']]) }),
    act('getvalueforkey', { UUID: link, CustomOutputName: 'Guide Link', WFInput: attach(play, 'CastBot Reply'), WFDictionaryKey: 'url' }),
    // Only when CastBot sent an episode-guide link (just a show's name was asked for).
    act('conditional', { GroupingIdentifier: group, WFControlFlowMode: 0, WFCondition: 100, WFInput: { Type: 'Variable', Variable: attach(link, 'Guide Link') } }),
    act('openurl', { WFInput: attach(link, 'Guide Link') }),
    act('conditional', { GroupingIdentifier: group, WFControlFlowMode: 2 })
  ]
}

// name → [description, builder, icon color, icon glyph]
export const SHORTCUTS = {
  CastBot: ['Ask what to watch and which TV, then play it', main, 4282601983, 59446],
  'CastBot Next': ['Play the next episode', (b) => simple(b, '/next', 'POST'), 4282601983, 61449],
  "What's Playing": ["Hear what's on and how much is left", (b) => simple(b, '/now', 'GET'), 4292093695, 59511],
  'CastBot Pause': ['Pause', (b) => simple(b, '/control/pause', 'POST'), 4294955520, 61444],
  'CastBot Resume': ['Resume', (b) => simple(b, '/control/resume', 'POST'), 4292093695, 61440],
  'CastBot Stop': ['Stop and delete the download', (b) => simple(b, '/stop', 'POST'), 4282664004, 61448]
}

// .shortcut file contents. With base (e.g. "http://10.0.0.5:8787") the address is filled in;
// without it, Shortcuts asks for the address when the shortcut is added.
export function buildShortcut (name, base) {
  const s = SHORTCUTS[name]
  if (!s) return null
  return plist(wrap(s[1](base), base, s[2], s[3]))
}


// URL-friendly ids: "What's Playing" → "whats-playing".
export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
export const bySlug = (s) => Object.keys(SHORTCUTS).find((n) => slug(n) === s)

// Mac script for `curl … | bash`: downloads every shortcut with this CastBot's address, signs
// them (iPhones only accept signed shortcuts, and only a Mac can sign), and opens them to add.
export function macInstaller (base) {
  const steps = Object.keys(SHORTCUTS).map((n) => [
    `curl -fsS "${base}/shortcuts/${slug(n)}" -o "unsigned-${slug(n)}.shortcut" \\`,
    `  && shortcuts sign --mode anyone --input "unsigned-${slug(n)}.shortcut" --output "${n}.shortcut" 2>/dev/null`,
    `if [ -f "${n}.shortcut" ]; then ok=$((ok+1)); echo "  signed: ${n}"; else echo "  FAILED: ${n}"; fi`
  ].join('\n'))
  return [
    '#!/bin/bash',
    '# CastBot: install the Siri Shortcuts. Signing needs a Mac signed in to iCloud.',
    'DIR="$HOME/Downloads/CastBot Shortcuts"',
    'mkdir -p "$DIR" && cd "$DIR" || exit 1',
    `echo "Getting the CastBot shortcuts from ${base} ..."`,
    'ok=0',
    ...steps,
    'rm -f unsigned-*.shortcut',
    'if [ "$ok" -eq 0 ]; then',
    '  echo "Nothing was signed. Make sure this Mac is signed in to iCloud (System Settings > your name), then try again."',
    '  exit 1',
    'fi',
    'echo ""',
    'echo "Opening them in Shortcuts. Click \\"Add Shortcut\\" for each one; they sync to your iPhone."',
    'for f in *.shortcut; do open "$f"; sleep 2; done',
    ''
  ].join('\n')
}
