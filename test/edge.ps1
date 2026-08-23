# Edge-snap probe: reports where the pet window sits relative to its monitor,
# and grabs a PrintWindow capture so the alignment can be checked by eye.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
# Args: -PetPid <pid> [-Shot <path>]. Emits one line of JSON.
param([Parameter(Mandatory=$true)][int]$PetPid, [string]$Shot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct RC { public int L, T, R, B; }
public static class E {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
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

# Without this the capture is clipped on a scaled display.
[void][E]::SetProcessDPIAware()

$hwnds = [E]::TopLevel([uint32]$PetPid)
$pet = $null; $rect = New-Object RC; $best = -1
foreach ($h in $hwnds) {
  $r = New-Object RC
  if ([E]::GetWindowRect($h, [ref]$r)) {
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    if ($area -gt $best) { $best = $area; $pet = $h; $rect = $r }
  }
}
if (-not $pet) { '{"ok":false,"reason":"no pet window found"}'; exit }

$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
# Monitor that contains the window centre.
$cx = $rect.L + [int]($w / 2)
$cy = $rect.T + [int]($h / 2)
$scr = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($cx, $cy)))
$b = $scr.Bounds

# The pet is a layered window: only PrintWindow with PW_RENDERFULLCONTENT
# captures it; CopyFromScreen would grab whatever is composited underneath.
# Leftmost / rightmost column that actually has artwork in it.
#
# NOTE: the alpha channel of a PrintWindow capture is NOT usable here (it comes
# back opaque), so this scans luminance instead -- transparent areas render as
# black. That is a quirk of the capture, but a stable one, and it is the only
# way to see where the drawing really starts. A pure-black pixel in the artwork
# would be missed; the character has none.
$inkL = -1; $inkR = -1
if ($Shot) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  # The pet is a layered window: only PrintWindow with PW_RENDERFULLCONTENT
  # captures it; CopyFromScreen would grab what is composited underneath.
  [void][E]::PrintWindow($pet, $dc, 2)
  $g.ReleaseHdc($dc)
  $g.Dispose()
  $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
  for ($x = 0; $x -lt $w; $x++) {
    for ($y = 0; $y -lt $h; $y++) {
      $c = $bmp.GetPixel($x, $y)
      if (($c.R + $c.G + $c.B) -gt 24) {
        if ($inkL -lt 0) { $inkL = $x }
        if ($x -gt $inkR) { $inkR = $x }
        break
      }
    }
  }
  $bmp.Dispose()
}

$o = [ordered]@{
  ok = $true
  win = [ordered]@{ x = $rect.L; y = $rect.T; w = $w; h = $h }
  mon = [ordered]@{ x = $b.X; y = $b.Y; w = $b.Width; h = $b.Height }
  gapLeft = $rect.L - $b.X
  gapRight = ($b.X + $b.Width) - $rect.R
  inkL = $inkL
  inkR = $inkR
}
$o | ConvertTo-Json -Compress
