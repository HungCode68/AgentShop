import { sendJson } from './http.js'

// Models agentshop supports, verified live — pinned into the generated scripts so a fresh
// install can never fall back to an unsupported default (fable, dated haiku, …) and stall
// in 400/retry loops.
const DEFAULT_MODEL = 'claude-sonnet-5-5'
const DEFAULT_SMALL_MODEL = 'claude-haiku-4-5'
const FALLBACK_HOST = 'https://agentshop.id.vn/api/proxy'

const REASON_STATUS = { invalid: 401, revoked: 403, expired: 403, unassigned: 403 }
const REASON_MESSAGE = {
  invalid: 'API key not found or unassigned.',
  revoked: 'API key has been revoked.',
  expired: 'API key has expired.',
  unassigned: 'API key has no plan yet. Please contact the administrator.',
}

/**
 * GET /api/setup/<os>/<ak_...>          (preferred: nothing in the URL needs quoting)
 * GET /api/setup?os=<os>&key=<ak_...>   (older form, still accepted)
 * os = windows | mac | linux
 *
 * Returns a one-liner install script (text/plain, attachment) that installs the Claude Code
 * CLI and the VS Code extension and writes this gateway's base URL + key into both
 * `~/.claude/settings.json` and the VS Code user settings. The script merges, never
 * clobbers existing settings.
 *
 * Auth is the caller's own client key (same pattern as /api/proxy/check-usage); it must be
 * active and linked to an upstream account.
 *
 * Runners:
 *   Windows (PowerShell): irm https://<host>/api/setup/windows/<key> | iex
 *   macOS/Linux:          curl -fsSL https://<host>/api/setup/mac/<key> | bash
 * The path form exists because "?" and "&" plus nested quotes broke the one-liner on some
 * Windows shells. Request logs mask the key segment (see maskSetupPath).
 */
const SETUP_PATH = /^\/api\/setup\/([^/]+)\/([^/]+)\/?$/

/** True for /api/setup and /api/setup/<os>/<key>. */
export const isSetupPath = (path) => path === '/api/setup' || path === '/api/setup/' || path.startsWith('/api/setup/')

/** The request path with the key segment hidden, for logs. */
export const maskSetupPath = (path) => path.replace(/^(\/api\/setup\/[^/]+\/)[^/]+/, '$1***')

export function handleSetup(req, res, url, { store, config }) {
  if (req.method !== 'GET') return sendJson(res, 405, { success: false, message: 'Method not allowed', data: null })

  const [, pathOs, pathKey] = SETUP_PATH.exec(url.pathname) ?? []
  const key = (pathKey ?? url.searchParams.get('key') ?? '').trim()
  if (!key) return sendJson(res, 400, { success: false, message: 'API key is missing.', data: null })

  const os = (pathOs ?? url.searchParams.get('os') ?? '').toLowerCase()
  if (!['windows', 'mac', 'linux'].includes(os)) {
    return sendJson(res, 400, { success: false, message: 'os must be one of: windows, mac, linux.', data: null })
  }

  const resolved = store.resolve(key)
  if (!resolved.ok) {
    return sendJson(res, REASON_STATUS[resolved.reason] ?? 401, {
      success: false,
      message: REASON_MESSAGE[resolved.reason] ?? REASON_MESSAGE.invalid,
      data: null,
    })
  }

  // Let the request log carry the key id (path-only logging; the key itself is never logged).
  res.keyId = resolved.record.id
  const script =
    os === 'windows'
      ? buildPowerShellScript({ apiHost: config.publicApiHost, key })
      : buildBashScript({ apiHost: config.publicApiHost, key })

  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="agentshop-setup.${os === 'windows' ? 'ps1' : 'sh'}"`,
  })
  res.end(script)
}

/**
 * Runs on the customer's machine (embedded into both scripts via toString, so it must be
 * self-contained CommonJS-safe code). Merges the gateway config into ~/.claude/settings.json
 * and the VS Code user settings without touching anything else:
 *  - VS Code settings are JSONC (comments, trailing commas): parsed leniently; a file that
 *    still can't be parsed is left untouched rather than overwritten.
 *  - The original file is backed up once to <file>.agentshop-backup before the first change.
 *  - ANTHROPIC_API_KEY is removed: it is sent as x-api-key, which the gateway prefers, so a
 *    stale key there would silently win over the new ANTHROPIC_AUTH_TOKEN.
 * Exported for tests.
 */
export function mergeSettingsMain(argv = process.argv) {
  const fs = require('fs')
  const path = require('path')
  // With `node - a b` argv[1] is "-" (script read from stdin); skip it so arguments line up.
  const [claudeFile, vscodeFile, host, key, model, smallModel] = argv.slice(argv[1] === '-' ? 2 : 1)
  const ENV = {
    ANTHROPIC_BASE_URL: host,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: smallModel,
    // Claude Code assumes a ~1M-token window for the 5.x models and only auto-compacts near it.
    // agentshop's backends get slow (and fail) long before that, so use the 200k window: the
    // conversation is then compacted around 170k tokens and every turn stays light.
    CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
  }

  function stripJsonc(s) {
    let out = ''
    let inStr = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      const n = s[i + 1]
      if (inStr) {
        out += c
        if (c === '\\') out += s[++i] ?? ''
        else if (c === '"') inStr = false
      } else if (c === '"') {
        inStr = true
        out += c
      } else if (c === '/' && n === '/') {
        while (i < s.length && s[i] !== '\n') i++
        out += '\n'
      } else if (c === '/' && n === '*') {
        i += 2
        while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++
        i++
      } else {
        out += c
      }
    }
    return out.replace(/,(\s*[}\]])/g, '$1')
  }

  /** {} for a missing/empty file, the parsed object, or null when it can't be parsed safely. */
  function load(p) {
    if (!fs.existsSync(p)) return {}
    let raw = fs.readFileSync(p, 'utf8')
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1) // BOM
    if (!raw.trim()) return {}
    for (const text of [raw, stripJsonc(raw)]) {
      try {
        const v = JSON.parse(text)
        if (v && typeof v === 'object' && !Array.isArray(v)) return v
      } catch {
        /* try the next form */
      }
    }
    return null
  }

  function save(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const backup = p + '.agentshop-backup'
    if (fs.existsSync(p) && !fs.existsSync(backup)) fs.copyFileSync(p, backup)
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
    console.log('   updated ' + p)
  }

  function skip(p) {
    console.log('   ! could not read ' + p + ' (invalid JSON) - left unchanged.')
    console.log('     Add these manually: ' + Object.keys(ENV).join(', '))
  }

  // ~/.claude/settings.json: Claude Code reads this env on every surface (terminal + extension).
  const claude = load(claudeFile)
  if (claude) {
    const env = Object.assign({}, claude.env, ENV)
    delete env.ANTHROPIC_API_KEY
    claude.env = env
    save(claudeFile, claude)
  } else skip(claudeFile)

  // VS Code user settings: the extension does not inherit terminal env, so it needs
  // claudeCode.environmentVariables + claudeCode.disableLoginPrompt (flat keys, VS Code style).
  const vscode = load(vscodeFile)
  if (vscode) {
    const nested = vscode.claudeCode && typeof vscode.claudeCode === 'object' ? vscode.claudeCode : null
    let vars = vscode['claudeCode.environmentVariables']
    if (!Array.isArray(vars)) vars = nested && Array.isArray(nested.environmentVariables) ? nested.environmentVariables : []
    vars = vars.filter((e) => e && e.name !== 'ANTHROPIC_API_KEY' && !(e.name in ENV))
    for (const [name, value] of Object.entries(ENV)) vars.push({ name, value })
    vscode['claudeCode.environmentVariables'] = vars
    vscode['claudeCode.disableLoginPrompt'] = true
    if (nested) {
      delete nested.environmentVariables
      delete nested.disableLoginPrompt
      if (!Object.keys(nested).length) delete vscode.claudeCode
    }
    save(vscodeFile, vscode)
  } else skip(vscodeFile)
}

// Shared Node code embedded in both scripts, so they stay in sync.
function nodeMergeBlock() {
  return `${mergeSettingsMain.toString().replace(/^export /, '')}\nmergeSettingsMain()`
}

export function buildBashScript({ apiHost, key }) {
  const host = (apiHost && apiHost.trim().replace(/\/+$/, '')) || FALLBACK_HOST
  const quote = (s) => `'${String(s).split("'").join("'\"'\"'")}'`

  return `#!/usr/bin/env bash
# Agentshop quick setup: installs Claude Code (CLI + VS Code extension) and points both at
# this gateway. Idempotent - re-running merges into any existing settings files.
set -e

API_HOST=${quote(host)}
API_KEY=${quote(key)}
ANTHROPIC_MODEL=${quote(DEFAULT_MODEL)}
ANTHROPIC_SMALL_FAST_MODEL=${quote(DEFAULT_SMALL_MODEL)}

say() { echo; echo "== $*"; }

# 1) Node 18+
have_node=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
  [ "$NODE_MAJOR" -ge 18 ] && have_node=1
fi

if [ "$have_node" -eq 1 ]; then
  say "Node $(node -v) found."
else
  say "Node 18+ not found - installing."
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then brew install node
      else echo "Install Node 18+ from https://nodejs.org and re-run."; exit 1; fi ;;
    *)
      echo "Install Node 18+ from https://nodejs.org (or your package manager) and re-run."
      exit 1 ;;
  esac
fi

# 2) Claude Code CLI
say "Installing / updating Claude Code CLI."
if ! npm install -g @anthropic-ai/claude-code; then
  echo
  echo "npm install failed. If it says EACCES (permission denied), either run:"
  echo "  sudo npm install -g @anthropic-ai/claude-code"
  echo "and then run this command again, or install Node with nvm (https://github.com/nvm-sh/nvm)."
  exit 1
fi
if command -v claude >/dev/null 2>&1; then
  say "Claude Code $(claude --version 2>/dev/null | head -n1)"
else
  say "Claude Code installed; it may not be on PATH until you restart your shell."
fi

# 3) VS Code extension
if command -v code >/dev/null 2>&1; then
  say "Installing / updating the VS Code extension."
  code --install-extension anthropic.claude-code --force >/dev/null 2>&1 || true
else
  say "The 'code' CLI was not found. Install the extension manually: search 'Claude Code' (Anthropic) in the VS Code Marketplace."
fi

# 4) Write config, merging into existing files with Node so nothing is clobbered.
say "Writing config (safe merge - your existing settings are kept)."
if [ -n "$HOME" ]; then HOME_DIR="$HOME"; else HOME_DIR="$USERPROFILE"; fi
CLAUDE_DIR="$HOME_DIR/.claude"
mkdir -p "$CLAUDE_DIR"

VSCODE_SETTINGS=""
if [ -n "$APPDATA" ] && [ -d "$APPDATA/Code/User" ]; then
  VSCODE_SETTINGS="$APPDATA/Code/User/settings.json"
elif [ -d "$HOME_DIR/Library/Application Support/Code/User" ]; then
  VSCODE_SETTINGS="$HOME_DIR/Library/Application Support/Code/User/settings.json"
elif [ -d "$HOME_DIR/.config/Code/User" ]; then
  VSCODE_SETTINGS="$HOME_DIR/.config/Code/User/settings.json"
else
  VSCODE_SETTINGS="$HOME_DIR/.config/Code/User/settings.json"
fi

node - "$CLAUDE_DIR/settings.json" "$VSCODE_SETTINGS" "$API_HOST" "$API_KEY" "$ANTHROPIC_MODEL" "$ANTHROPIC_SMALL_FAST_MODEL" <<'NODE'
${nodeMergeBlock()}
NODE

# An exported ANTHROPIC_API_KEY would be sent as x-api-key and win over the new key.
if [ -n "\${ANTHROPIC_API_KEY:-}" ]; then
  echo
  echo "Warning: ANTHROPIC_API_KEY is exported in your shell and overrides the new key."
  echo "Remove the 'export ANTHROPIC_API_KEY=...' line from ~/.zshrc / ~/.bashrc and open a new terminal."
fi

say "All done."
echo "  - VS Code: run 'Developer: Reload Window' (or restart VS Code), then open Claude Code and chat."
echo "  - Terminal: open a new terminal and run 'claude'."
echo "  - API host: $API_HOST"
`
}

export function buildPowerShellScript({ apiHost, key }) {
  const host = (apiHost && apiHost.trim().replace(/\/+$/, '')) || FALLBACK_HOST
  const js = nodeMergeBlock()
  // Single-quoted PowerShell strings: nothing inside is expanded ($, backtick); ' is doubled.
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`

  // Notes for Windows PowerShell 5.1 (the default on Windows 10/11):
  //  - npm.cmd / claude.cmd, not npm / claude: those resolve to .ps1 shims, which the default
  //    "Restricted" execution policy blocks. (irm | iex itself is not affected by the policy.)
  //  - No `2>$null` on native commands: in 5.1 that turns stderr lines into errors.
  //  - `return`, not `exit`: under `irm | iex` exit would close the user's window.
  return `# Agentshop quick setup (Windows): installs Claude Code (CLI + VS Code extension)
# and points both at this gateway. Idempotent - re-running merges into existing settings.
$ApiHost = ${ps(host)}
$ApiKey = ${ps(key)}
$Model = ${ps(DEFAULT_MODEL)}
$SmallModel = ${ps(DEFAULT_SMALL_MODEL)}

function Say([string]$m) { Write-Host ""; Write-Host ("== " + $m) -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Node-Major {
  if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return 0 }
  $v = (& node.exe -p "process.versions.node.split('.')[0]") | Select-Object -First 1
  if ($v -match '^[0-9]+$') { return [int]$v } else { return 0 }
}

function Add-UserPath([string]$dir) {
  if (-not $dir) { return }
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($user) { $parts = @($user -split ';' | Where-Object { $_ }) }
  if ($parts -notcontains $dir) { [Environment]::SetEnvironmentVariable('Path', (($parts + $dir) -join ';'), 'User') }
  if (($env:Path -split ';') -notcontains $dir) { $env:Path = $env:Path + ';' + $dir }
}

# Fallback when winget is missing or broken: the official zip from nodejs.org, unpacked
# per-user (no admin rights, no installer) and put on the user PATH.
function Install-NodePortable {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $arch = 'arm64' }
    $index = Invoke-RestMethod -UseBasicParsing 'https://nodejs.org/dist/index.json'
    $rel = $index | Where-Object { $_.lts -and ($_.files -contains ('win-' + $arch + '-zip')) } | Select-Object -First 1
    if (-not $rel) { return $false }
    $name = 'node-' + $rel.version + '-win-' + $arch
    $zip = Join-Path $env:TEMP ($name + '.zip')
    Say ("Downloading Node " + $rel.version + " from nodejs.org (no admin rights needed).")
    Invoke-WebRequest -UseBasicParsing ('https://nodejs.org/dist/' + $rel.version + '/' + $name + '.zip') -OutFile $zip
    $root = Join-Path $env:LOCALAPPDATA 'Programs'
    New-Item -ItemType Directory -Force $root | Out-Null
    $dest = Join-Path $root $name
    # Leftovers from an interrupted run would make extraction fail.
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    # ZipFile instead of Expand-Archive: much faster, and a failure is one message instead of
    # thousands of red rollback errors.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $root)
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Add-UserPath (Join-Path $root $name)
    return $true
  } catch {
    Write-Host ("Could not download Node from nodejs.org: " + $_.Exception.Message) -ForegroundColor Yellow
    return $false
  }
}

function Install-AgentshopClaude {
  # 1) Node 18+
  if ((Node-Major) -lt 18) {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Say "Node 18+ not found - installing Node LTS via winget."
      # --source winget: skip the Microsoft Store source, which fails on some machines
      # (certificate errors behind antivirus/proxy) and then blocks the whole install.
      winget install -e --id OpenJS.NodeJS.LTS --source winget --accept-source-agreements --accept-package-agreements
      Refresh-Path
      $pf = Join-Path $env:ProgramFiles 'nodejs'
      if ((Node-Major) -lt 18 -and (Test-Path (Join-Path $pf 'node.exe'))) { $env:Path = $env:Path + ';' + $pf }
    }
    if ((Node-Major) -lt 18) {
      Say "winget could not install Node - installing it directly instead."
      Install-NodePortable | Out-Null
    }
    if ((Node-Major) -lt 18) {
      Write-Host ""
      Write-Host "Could not install Node automatically. Install 'Node.js LTS' (Windows Installer) from https://nodejs.org," -ForegroundColor Yellow
      Write-Host "then open a new PowerShell window and run this command again." -ForegroundColor Yellow
      return
    }
  }
  Say ("Node " + ((& node.exe -v) | Select-Object -First 1) + " found.")

  # 2) Claude Code CLI
  Say "Installing / updating Claude Code CLI (npm)."
  & npm.cmd install -g @anthropic-ai/claude-code
  if ($LASTEXITCODE -ne 0) {
    Write-Host "npm install failed (exit $LASTEXITCODE). Fix the error above and run this command again."
    return
  }
  # Where npm put the claude command (usually %APPDATA%\\npm); keep it on the user PATH so
  # 'claude' also works in new terminals, e.g. after the portable Node fallback.
  $npmBin = (& npm.cmd prefix -g) | Select-Object -First 1
  if (-not $npmBin) { $npmBin = Join-Path $env:APPDATA 'npm' }
  Add-UserPath $npmBin
  if (Get-Command claude.cmd -ErrorAction SilentlyContinue) {
    Say ("Claude Code " + ((& claude.cmd --version) | Select-Object -First 1))
  } else {
    Say "Claude Code installed; open a new terminal if 'claude' is not found yet."
  }

  # 3) VS Code extension
  if (Get-Command code.cmd -ErrorAction SilentlyContinue) {
    Say "Installing / updating the Claude Code extension for VS Code."
    & code.cmd --install-extension anthropic.claude-code --force
  } else {
    Say "VS Code 'code' command not found. In VS Code, open Extensions and install 'Claude Code' (Anthropic)."
  }

  # 4) Write config, merging into existing files (other settings kept, originals backed up).
  Say "Writing config."
  # Forward slashes: valid on Windows, and no backslash escaping inside this JS template.
  $claudeFile = Join-Path $HOME '.claude/settings.json'
  $vscodeFile = Join-Path $env:APPDATA 'Code/User/settings.json'
  $nodeScript = @'
${js}
'@
  $nodeScript | & node.exe - $claudeFile $vscodeFile $ApiHost $ApiKey $Model $SmallModel

  # A user-level ANTHROPIC_API_KEY would be sent as x-api-key and win over the new key.
  foreach ($scope in 'User', 'Process') {
    if ([Environment]::GetEnvironmentVariable('ANTHROPIC_API_KEY', $scope)) {
      Write-Host ""
      Write-Host ("Warning: environment variable ANTHROPIC_API_KEY is set (" + $scope + " scope) and overrides the new key.") -ForegroundColor Yellow
      Write-Host 'Remove it with:  [Environment]::SetEnvironmentVariable(''ANTHROPIC_API_KEY'', $null, ''User'')' -ForegroundColor Yellow
      break
    }
  }

  Say "All done."
  Write-Host "  - VS Code: run 'Developer: Reload Window' (or restart VS Code), then open Claude Code and chat."
  Write-Host "  - Terminal: open a new terminal and run 'claude'."
  Write-Host ("  - API host: " + $ApiHost)
}

Install-AgentshopClaude
`
}
