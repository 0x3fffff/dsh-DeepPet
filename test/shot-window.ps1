# Capture a normal (non-layered) top-level window owned by a process.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
# Uses PrintWindow(PW_RENDERFULLCONTENT), NOT CopyFromScreen: a background
# process cannot reliably raise a window to the foreground on Windows, so a
# screen grab may capture whatever happens to be on top of it -- including
# whatever the person at the keyboard has open. PrintWindow renders the target
# window alone, occluded or not.
# Args: -PetPid <pid> -Title <substring> -Shot <path>
param(
  [Parameter(Mandatory=$true)][int]$PetPid,
  [Parameter(Mandatory=$true)][string]$Title,
  [Parameter(Mandatory=$true)][string]$Shot
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public struct RC2 { public int L, T, R, B; }
public static class S {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC2 r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<IntPtr> Titled(uint want, string frag) {
    var found = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) {
        var sb = new StringBuilder(256);
        GetWindowTextW(h, sb, 256);
        if (sb.ToString().Contains(frag)) found.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
# Without this the capture is clipped on a scaled display.
[void][S]::SetProcessDPIAware()

$hits = [S]::Titled([uint32]$PetPid, $Title)
if ($hits.Count -eq 0) { '{"ok":false,"reason":"window not found"}'; exit }
$h = $hits[0]
$r = New-Object RC2
[void][S]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $ht = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][S]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
$bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)

# How much of the window is pure white: a blank WebView2 is ~100%, which is
# exactly the failure mode the settings window once had.
$white = 0; $total = 0
for ($x = 0; $x -lt $w; $x += 4) {
  for ($y = 0; $y -lt $ht; $y += 4) {
    $c = $bmp.GetPixel($x, $y)
    $total++
    if ($c.R -gt 248 -and $c.G -gt 248 -and $c.B -gt 248) { $white++ }
  }
}
$bmp.Dispose()
"{""ok"":true,""w"":$w,""h"":$ht,""whitePct"":$([math]::Round(100.0 * $white / $total, 1))}"
