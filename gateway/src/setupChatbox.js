/**
 * One-command Chatbox setup (desktop): installs Chatbox if it is missing and hands it this
 * gateway's API Host + the customer's key, so the customer only clicks Save and starts chatting.
 *
 * How the config reaches Chatbox (verified in Chatbox's source, v1.24.x):
 *  - Windows / Linux: Chatbox reads `chatbox://provider/import?config=<base64 JSON>` from its
 *    command line (cold start and second instance). The script starts Chatbox.exe with that
 *    argument directly, so it works even before the chatbox:// protocol is registered (which
 *    Chatbox only does on its first launch). Chatbox then shows "Import Provider Configuration";
 *    the customer clicks Save.
 *  - macOS: the official build does not declare the chatbox:// scheme in Info.plist, so deep
 *    links cannot reach it. The config is put on the clipboard instead and the customer uses
 *    Settings > Model Provider > Add > "Import from clipboard" > Save.
 *  - Everywhere, the config is also copied to the clipboard as a fallback.
 * The config uses Chatbox's built-in Claude provider (id "claude"), which appends /messages
 * to the API Host - the same setup as the manual guide.
 */

const FALLBACK_HOST = 'https://agentshop.id.vn/api/proxy'
const RELEASES = 'https://download.chatboxai.app/releases'
/** Publisher of the official Windows installer (Authenticode subject), checked before running a download. */
const WINDOWS_PUBLISHER = 'Mediocre, LLC'
/** First Chatbox version with provider import (docs.chatboxai.app/en/guides/providers/import-config). */
const MIN_VERSION = '1.15.1'

/** The provider config Chatbox imports, its deep link, both for one key. */
export function chatboxConfig({ apiHost, key }) {
  const host = (apiHost && apiHost.trim().replace(/\/+$/, '')) || FALLBACK_HOST
  const json = JSON.stringify({ id: 'claude', settings: { apiKey: key, apiHost: host } })
  // URL-safe base64 without padding: nothing in it needs escaping; Chatbox's js-base64 decodes it.
  const link = `chatbox://provider/import?config=${Buffer.from(json, 'utf8').toString('base64url')}`
  return { host, json, link }
}

export function buildChatboxPowerShellScript({ apiHost, key }) {
  const { host, json, link } = chatboxConfig({ apiHost, key })
  // Single-quoted PowerShell strings: nothing inside is expanded ($, backtick); ' is doubled.
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`

  // Same rules as the Claude Code script (setup.js): ASCII only, `return` not `exit`,
  // no `2>$null` on native commands, a transcript log that never contains the key.
  return `# Agentshop quick setup for Chatbox (Windows): installs Chatbox if needed and opens it with
# this gateway's settings filled in - click Save in Chatbox and start chatting.
$ApiHost = ${ps(host)}
$ChatboxConfig = ${ps(json)}
$ChatboxLink = ${ps(link)}
$MinVersion = [version]${ps(MIN_VERSION)}

function Say([string]$m) { Write-Host ""; Write-Host ("== " + $m) -ForegroundColor Cyan }

function Find-ChatboxExe {
  $cands = @()
  $roots = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
    'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
  foreach ($root in $roots) {
    Get-ItemProperty $root -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like 'Chatbox*' -and $_.DisplayName -notmatch 'CE|Community' } |
      ForEach-Object {
        if ($_.InstallLocation) { $cands += (Join-Path $_.InstallLocation 'Chatbox.exe') }
        if ($_.UninstallString) {
          $u = $_.UninstallString -replace '^"([^"]+)".*$', '$1'
          $cands += (Join-Path (Split-Path $u -Parent) 'Chatbox.exe')
        }
      }
  }
  foreach ($k in 'Registry::HKEY_CURRENT_USER\\Software\\Classes\\chatbox\\shell\\open\\command', 'Registry::HKEY_CLASSES_ROOT\\chatbox\\shell\\open\\command') {
    $cmd = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'(default)'
    if ($cmd -match '^"([^"]+)"') { $cands += $Matches[1] }
  }
  $cands += (Join-Path $env:LOCALAPPDATA 'Programs\\Chatbox\\Chatbox.exe')
  $cands += (Join-Path $env:ProgramFiles 'Chatbox\\Chatbox.exe')
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}

function Chatbox-Version([string]$exe) {
  try { return [version](((Get-Item $exe).VersionInfo.ProductVersion) -replace '[^0-9.].*$', '') } catch { return [version]'0.0' }
}

# Official installer from download.chatboxai.app, run silently - only if it carries Chatbox's signature.
function Install-ChatboxDirect {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    $yml = Invoke-RestMethod -UseBasicParsing '${RELEASES}/latest.yml'
    $name = ([regex]::Match([string]$yml, '(?m)^path:\\s*(\\S+)')).Groups[1].Value
    if (-not $name) { Write-Host "Could not read the latest Chatbox version." -ForegroundColor Yellow; return }
    $file = Join-Path $env:TEMP $name
    Say ("Downloading " + $name + " from chatboxai.app (about 240 MB).")
    Invoke-WebRequest -UseBasicParsing ('${RELEASES}/' + $name) -OutFile $file
    $sig = Get-AuthenticodeSignature $file
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch '${WINDOWS_PUBLISHER}') {
      Write-Host "The downloaded installer is not signed by Chatbox's publisher - not running it." -ForegroundColor Red
      Remove-Item $file -Force -ErrorAction SilentlyContinue
      return
    }
    Say "Installing Chatbox."
    Start-Process -FilePath $file -ArgumentList '/S' -Wait
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  } catch {
    Write-Host ("Could not download Chatbox: " + $_.Exception.Message) -ForegroundColor Yellow
  }
}

function Install-Chatbox {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say "Installing Chatbox with winget."
    # --source winget: skip the Microsoft Store source, which fails on some machines.
    winget install -e --id Bin-Huang.Chatbox --source winget --silent --accept-source-agreements --accept-package-agreements
    $found = Find-ChatboxExe
    if ($found -and (Chatbox-Version $found) -ge $MinVersion) { return }
  }
  Install-ChatboxDirect
}

function Setup-AgentshopChatbox {
  $exe = Find-ChatboxExe
  if ($exe -and (Chatbox-Version $exe) -ge $MinVersion) {
    Say ("Chatbox " + (Chatbox-Version $exe) + " found.")
  } else {
    if ($exe) { Say ("Chatbox " + (Chatbox-Version $exe) + " is too old - updating.") } else { Say "Chatbox not found - installing it." }
    Install-Chatbox
    $exe = Find-ChatboxExe
    if (-not $exe) {
      Write-Host ""
      Write-Host "Could not install Chatbox automatically. Download it from https://chatboxai.app," -ForegroundColor Yellow
      Write-Host "install it, then run this command again." -ForegroundColor Yellow
      return
    }
  }

  # Fallback: the same settings on the clipboard (Chatbox: Settings > Model Provider > Add > Import from clipboard).
  try { Set-Clipboard -Value $ChatboxConfig } catch {}

  Say "Opening Chatbox with your settings."
  Start-Process -FilePath $exe -ArgumentList $ChatboxLink

  Say "Almost done - in Chatbox:"
  Write-Host "  1. In the 'Import Provider Configuration' window, click Save."
  Write-Host "     (If it does not appear: Settings > Model Provider > Add > Import from clipboard > Save.)"
  Write-Host "  2. Close Settings, pick a Claude model at the bottom right of the chat box, and chat."
  Write-Host ("  - API host: " + $ApiHost)
}

$AgentshopLog = Join-Path $env:TEMP 'agentshop-chatbox-setup.log'
try { Start-Transcript -Path $AgentshopLog -Force | Out-Null } catch {}
try {
  Setup-AgentshopChatbox
} catch {
  Write-Host ("Setup stopped with an error: " + $_.Exception.Message) -ForegroundColor Red
} finally {
  try { Stop-Transcript | Out-Null } catch {}
  Write-Host ("  - Log: " + $AgentshopLog)
  $cl = [Environment]::CommandLine
  if ($cl -match '\\s[-/](c|co|com|comm|comma|comman|command|e|ec|en|enc|encodedcommand|f|file)\\b' -and $cl -notmatch '\\s[-/](noexit|noni|noninteractive)\\b') {
    try { Write-Host ""; Read-Host 'Press Enter to close this window' | Out-Null } catch {}
  }
}
`
}

export function buildChatboxBashScript({ apiHost, key }) {
  const { host, json, link } = chatboxConfig({ apiHost, key })
  const quote = (s) => `'${String(s).split("'").join("'\"'\"'")}'`

  return `#!/usr/bin/env bash
# Agentshop quick setup for Chatbox (macOS / Linux): installs Chatbox if needed and hands it this
# gateway's settings - click Save in Chatbox and start chatting.
set -e

API_HOST=${quote(host)}
CHATBOX_CONFIG=${quote(json)}
CHATBOX_LINK=${quote(link)}
RELEASES=${quote(RELEASES)}

say() { echo; echo "== $*"; }

copy_config() {
  if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$CHATBOX_CONFIG" | pbcopy && return 0; fi
  if command -v wl-copy >/dev/null 2>&1; then printf '%s' "$CHATBOX_CONFIG" | wl-copy && return 0; fi
  if command -v xclip >/dev/null 2>&1; then printf '%s' "$CHATBOX_CONFIG" | xclip -selection clipboard && return 0; fi
  return 1
}

case "$(uname -s)" in
  Darwin)
    find_app() { for d in /Applications "$HOME/Applications"; do [ -d "$d/Chatbox.app" ] && { echo "$d/Chatbox.app"; return; }; done; }
    APP=$(find_app)
    if [ -n "$APP" ]; then
      say "Chatbox found: $APP"
    else
      say "Chatbox not found - installing it."
      if command -v brew >/dev/null 2>&1; then brew install --cask chatbox || true; fi
      APP=$(find_app)
      if [ -z "$APP" ]; then
        if [ "$(uname -m)" = "arm64" ]; then PAT='arm64\\.dmg$'; else PAT='[0-9]\\.dmg$'; fi
        DMG=$(curl -fsSL "$RELEASES/latest-mac.yml" | sed -n 's/^ *- url: *//p' | grep -E "$PAT" | head -n1)
        [ -n "$DMG" ] || { echo "Could not find the Chatbox download. Install it from https://chatboxai.app and run this again."; exit 1; }
        say "Downloading $DMG from chatboxai.app."
        TMP_DMG="$(mktemp -d)/chatbox.dmg"
        curl -fL -o "$TMP_DMG" "$RELEASES/$DMG"
        MNT=$(hdiutil attach -nobrowse -readonly "$TMP_DMG" | awk -F'\\t' '/\\/Volumes\\//{print $NF; exit}')
        DEST=/Applications
        [ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
        cp -R "$MNT/Chatbox.app" "$DEST/"
        hdiutil detach "$MNT" -quiet || true
        rm -f "$TMP_DMG"
        APP="$DEST/Chatbox.app"
      fi
    fi
    copy_config || true
    say "Opening Chatbox."
    open "$APP"
    say "Almost done - in Chatbox (your settings are already on the clipboard):"
    echo "  1. Open Settings > Model Provider, click Add, choose 'Import from clipboard', then click Save."
    echo "  2. Close Settings, pick a Claude model at the bottom right of the chat box, and chat."
    ;;
  *)
    BIN=""
    if command -v chatbox >/dev/null 2>&1; then BIN=$(command -v chatbox)
    elif [ -x "$HOME/Applications/Chatbox.AppImage" ]; then BIN="$HOME/Applications/Chatbox.AppImage"; fi
    if [ -n "$BIN" ]; then
      say "Chatbox found: $BIN"
    else
      say "Chatbox not found - downloading the AppImage."
      case "$(uname -m)" in aarch64|arm64) PAT='arm64\\.AppImage$';; *) PAT='x86_64\\.AppImage$';; esac
      FEED="$RELEASES/latest-linux.yml"
      case "$(uname -m)" in aarch64|arm64) FEED="$RELEASES/latest-linux-arm64.yml";; esac
      IMG=$(curl -fsSL "$FEED" | sed -n 's/^ *- url: *//p' | grep -E "$PAT" | head -n1)
      [ -n "$IMG" ] || { echo "Could not find the Chatbox download. Install it from https://chatboxai.app and run this again."; exit 1; }
      mkdir -p "$HOME/Applications"
      BIN="$HOME/Applications/Chatbox.AppImage"
      curl -fL -o "$BIN" "$RELEASES/$IMG"
      chmod +x "$BIN"
    fi
    copy_config || true
    say "Opening Chatbox with your settings."
    nohup "$BIN" "$CHATBOX_LINK" >/dev/null 2>&1 &
    say "Almost done - in Chatbox:"
    echo "  1. In the 'Import Provider Configuration' window, click Save."
    echo "     (If it does not appear: Settings > Model Provider > Add > Import from clipboard > Save.)"
    echo "  2. Pick a Claude model at the bottom right of the chat box, and chat."
    ;;
esac
echo "  - API host: $API_HOST"
`
}
