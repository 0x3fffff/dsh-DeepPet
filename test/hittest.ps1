# Win32 probe for click-through, driven by test/clickthrough.mjs.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
# Args: pid of the pet process. Emits one line of JSON.
param([Parameter(Mandatory=$true)][int]$PetPid, [switch]$FarOnly)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct PT { public int X; public int Y; }
public struct RC { public int L, T, R, B; }
public static class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(PT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<IntPtr> TopLevel(uint want) {
    var found = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

# Largest visible top-level window owned by the pet process.
$hwnds = [W]::TopLevel([uint32]$PetPid)
$pet = $null; $rect = New-Object RC; $best = -1
foreach ($h in $hwnds) {
  $r = New-Object RC
  if ([W]::GetWindowRect($h, [ref]$r)) {
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    if ($area -gt $best) { $best = $area; $pet = $h; $rect = $r }
  }
}
if (-not $pet) { '{"ok":false,"reason":"no pet window found"}'; exit }

$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
$cx = $rect.L + [int]($w / 2)

# -FarOnly: park the cursor well outside the window and report only whether the
# window went click-through. This is the drag scenario: while dragging, the
# window trails the cursor and the cursor leaves the window entirely.
if ($FarOnly) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $farX = $rect.L - 300
  if ($farX -lt ($screen.Left + 10)) { $farX = $rect.R + 300 }
  if ($farX -gt ($screen.Right - 10)) { $farX = $screen.Left + 10 }
  $farY = $rect.T + [int](($rect.B - $rect.T) / 2)
  $o = New-Object PT
  [void][W]::GetCursorPos([ref]$o)
  [void][W]::SetCursorPos($farX, $farY)
  Start-Sleep -Milliseconds 250
  $exf = [int64][W]::GetWindowLongPtr($pet, -20)
  $tr = (($exf -band 0x20) -ne 0)
  [void][W]::SetCursorPos($o.X, $o.Y)
  '{"ok":true,"far":"' + $farX + ',' + $farY + '","farTransparent":' + $tr.ToString().ToLower() + '}'
  exit
}

# Sprite occupies the bottom of the window, 3:4 aspect, horizontally centred.
# Aim at its centre, not its bottom edge: the PNG has transparent margins and
# a layered window can hit-test per-pixel alpha, which would confound the probe.
$spriteH = [int](($rect.B - $rect.T) - 150)
$spriteMidY = $rect.B - [int]($spriteH / 2)

$probes = @(
  @{ name = 'dead';   x = $cx; y = $rect.T + 20 },
  @{ name = 'sprite'; x = $cx; y = $spriteMidY }
)

$origin = New-Object PT
[void][W]::GetCursorPos([ref]$origin)
$res = @{}
foreach ($p in $probes) {
  [void][W]::SetCursorPos($p.x, $p.y)
  Start-Sleep -Milliseconds 200   # let the 30ms Rust poll flip the flag
  $pt = New-Object PT; $pt.X = $p.x; $pt.Y = $p.y
  $hit = [W]::WindowFromPoint($pt)
  $root = [W]::GetAncestor($hit, 2)   # GA_ROOT: the webview is a child HWND
  $res[$p.name] = ($root -eq $pet)
  # WS_EX_TRANSPARENT (0x20) is the only bit our code touches; read it back so
  # a failure tells us whether the toggle misfired or the probe point was bad.
  $ex = [int64][W]::GetWindowLongPtr($pet, -20)
  $res[$p.name + 'Transparent'] = (($ex -band 0x20) -ne 0)
}
[void][W]::SetCursorPos($origin.X, $origin.Y)

'{"ok":true,"rect":"' + $w + 'x' + $h + ' @' + $rect.L + ',' + $rect.T +
  '","probe":"dead=' + $cx + ',' + ($rect.T + 20) + ' sprite=' + $cx + ',' + $spriteMidY +
  '","deadIsPet":' + $res['dead'].ToString().ToLower() +
  ',"spriteIsPet":' + $res['sprite'].ToString().ToLower() +
  ',"deadTransparent":' + $res['deadTransparent'].ToString().ToLower() +
  ',"spriteTransparent":' + $res['spriteTransparent'].ToString().ToLower() + '}'
