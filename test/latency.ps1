# Hit-test responsiveness probe.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
#
# Moves the cursor onto the sprite and samples WS_EX_TRANSPARENT until it
# clears, reporting how long the pet took to become clickable. That delay is
# exactly the window in which a click lands on whatever is behind the pet --
# which is what "have to click twice" feels like.
#
# Doubles as a stress test: each round drives one on/off transition, which is
# the code path that used to hold the hit-state mutex while blocking on the
# main event loop. IsHungAppWindow is sampled around every round, so a stalled
# main thread shows up as a count rather than as a vague "feels laggy".
# Args: -PetPid <pid> -X <screen x> -Y <screen y> [-Away]
param(
  [Parameter(Mandatory=$true)][int]$PetPid,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y,
  [int]$Rounds = 8
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct PT3 { public int X; public int Y; }
public struct RC3 { public int L, T, R, B; }
public static class L3 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC3 r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT3 p);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
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
[void][L3]::SetProcessDPIAware()

$hwnds = [L3]::TopLevel([uint32]$PetPid)
$pet = $null; $best = -1
foreach ($h in $hwnds) {
  $r = New-Object RC3
  if ([L3]::GetWindowRect($h, [ref]$r)) {
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    if ($area -gt $best) { $best = $area; $pet = $h }
  }
}
if (-not $pet) { '{"ok":false,"reason":"no pet window"}'; exit }

$GWL_EXSTYLE = -20
$WS_EX_TRANSPARENT = 0x20

$orig = New-Object PT3
[void][L3]::GetCursorPos([ref]$orig)

function Transparent { (([int][L3]::GetWindowLongPtr($pet, $GWL_EXSTYLE)) -band $WS_EX_TRANSPARENT) -ne 0 }

# All rounds run inside one process: spawning PowerShell costs a few seconds of
# Add-Type compilation, which would dwarf what we are trying to measure.
$samples = @()
$hungCount = 0
$interferedCount = 0
for ($i = 0; $i -lt $Rounds; $i++) {
  if ([L3]::IsHungAppWindow($pet)) { $hungCount++ }
  # Park the cursor far away and wait for the pet to go transparent again.
  [void][L3]::SetCursorPos(20, 20)
  $deadline = [Environment]::TickCount + 1500
  while (-not (Transparent) -and [Environment]::TickCount -lt $deadline) { Start-Sleep -Milliseconds 5 }
  if (-not (Transparent)) { continue }

  # Now jump onto the sprite and time how long until it accepts the cursor.
  #
  # The cursor is checked every iteration: if a human touches the mouse, the
  # injected position is gone and the pet is right to go transparent again.
  # Counting that as a failure produced hours of chasing a bug that was not
  # there -- so such a round is discarded, not recorded.
  $sw = [Diagnostics.Stopwatch]::StartNew()
  [void][L3]::SetCursorPos($X, $Y)
  $ms = -1
  $interfered = $false
  while ($sw.ElapsedMilliseconds -lt 2000) {
    if (-not (Transparent)) { $ms = $sw.ElapsedMilliseconds; break }
    $now = New-Object PT3
    [void][L3]::GetCursorPos([ref]$now)
    if ($now.X -ne $X -or $now.Y -ne $Y) { $interfered = $true; break }
    Start-Sleep -Milliseconds 1
  }
  $sw.Stop()
  if ($interfered) { $interferedCount++; continue }
  $samples += $ms
  if ([L3]::IsHungAppWindow($pet)) { $hungCount++ }
}

[void][L3]::SetCursorPos($orig.X, $orig.Y)

$asMs = @($samples | ForEach-Object { if ($_ -lt 0) { 2000 } else { $_ } })
$o = [ordered]@{
  ok = $true
  samples = $samples
  median = if ($asMs.Count) { ($asMs | Sort-Object)[[int]($asMs.Count / 2)] } else { -1 }
  worst = if ($asMs.Count) { ($asMs | Measure-Object -Maximum).Maximum } else { -1 }
  timedOut = @($samples | Where-Object { $_ -lt 0 }).Count
  interfered = $interferedCount
  hungSamples = $hungCount
  totalSamples = $Rounds * 2
}
$o | ConvertTo-Json -Compress
