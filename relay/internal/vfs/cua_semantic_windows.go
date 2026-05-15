//go:build windows

package vfs

import "github.com/PekingSpades/Synapse/relay/internal/relaypaths"

func newCUASemanticProvider(paths relaypaths.ResolvedPaths) cuaSemanticProvider {
	return &scriptCUASemanticProvider{
		backend:     "uia",
		interpreter: "powershell.exe",
		extension:   ".ps1",
		tempRoot:    semanticProviderTempRoot(paths),
		args:        []string{"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"},
		script: `$ErrorActionPreference = 'Stop'

function Clip([string]$Text, [int]$Limit = 240) {
  if ($null -eq $Text) { return '' }
  $clean = ($Text -replace '\s+', ' ').Trim()
  if ([string]::IsNullOrWhiteSpace($clean)) { return '' }
  if ($clean.Length -le $Limit) { return $clean }
  return $clean.Substring(0, $Limit) + '…'
}

function Emit($Payload) {
  $Payload | ConvertTo-Json -Depth 10 -Compress
}

try {
  Add-Type -AssemblyName UIAutomationClient
} catch {
  Emit @{
    supported = $false
    backend = 'uia'
    message = 'UIAutomationClient assembly is unavailable: ' + (Clip $_.Exception.Message 200)
    rootIds = @()
    nodes = @()
  }
  exit 0
}

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$focused = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $focused) {
  Emit @{
    supported = $false
    backend = 'uia'
    message = 'UI Automation did not return a focused element.'
    rootIds = @()
    nodes = @()
  }
  exit 0
}

$root = $focused
while ($true) {
  $parent = $walker.GetParent($root)
  if ($null -eq $parent) { break }
  if ($parent -eq [System.Windows.Automation.AutomationElement]::RootElement) { break }
  $root = $parent
}

$nodes = New-Object System.Collections.Generic.List[object]
$focusedId = ''
$maxNodes = 800

function RectObject($Rect) {
  @{
    x = [int][Math]::Round($Rect.X)
    y = [int][Math]::Round($Rect.Y)
    w = [int][Math]::Round($Rect.Width)
    h = [int][Math]::Round($Rect.Height)
  }
}

function CurrentValue($Element) {
  try {
    $pattern = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $pattern) {
      return Clip $pattern.Current.Value 200
    }
  } catch {}
  return ''
}

function CurrentStates($Element) {
  $states = New-Object System.Collections.Generic.List[string]
  try {
    if ($Element.Current.HasKeyboardFocus) { $states.Add('focused') }
    if ($Element.Current.IsEnabled) { $states.Add('enabled') } else { $states.Add('disabled') }
    if ($Element.Current.IsKeyboardFocusable) { $states.Add('focusable') }
    if ($Element.Current.IsOffscreen) { $states.Add('offscreen') }
  } catch {}
  return $states
}

function SerializeElement($Element, [string]$ParentId, [string]$Id, [int]$Depth) {
  if ($nodes.Count -ge $maxNodes) { return $null }

  $role = ''
  $name = ''
  $description = ''
  $value = ''
  $processId = 0
  $windowTitle = ''
  $appName = ''
  $state = @()
  $bounds = @{ x = 0; y = 0; w = 0; h = 0 }

  try {
    $role = Clip ($Element.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '') 120
    $name = Clip $Element.Current.Name 200
    $description = Clip $Element.Current.HelpText 200
    $value = CurrentValue $Element
    $processId = [int]$Element.Current.ProcessId
    $state = CurrentStates $Element
    $bounds = RectObject $Element.Current.BoundingRectangle
    if ($Element.Current.HasKeyboardFocus -and [string]::IsNullOrWhiteSpace($focusedId)) {
      $script:focusedId = $Id
    }
    try {
      $proc = Get-Process -Id $processId -ErrorAction Stop
      $appName = Clip $proc.ProcessName 120
      $windowTitle = Clip $proc.MainWindowTitle 200
    } catch {}
  } catch {}

  $childIds = New-Object System.Collections.Generic.List[string]
  $child = $walker.GetFirstChild($Element)
  $index = 0
  while ($null -ne $child) {
    $childId = if ($Id -eq 'root') { "$index" } else { "$Id.$index" }
    $serializedChild = SerializeElement $child $Id $childId ($Depth + 1)
    if ($null -ne $serializedChild) {
      $childIds.Add($serializedChild)
    }
    $child = $walker.GetNextSibling($child)
    $index += 1
  }

  $summaryParts = New-Object System.Collections.Generic.List[string]
  if (-not [string]::IsNullOrWhiteSpace($role)) { $summaryParts.Add("[$role]") }
  if (-not [string]::IsNullOrWhiteSpace($name)) { $summaryParts.Add(('"' + $name + '"')) }
  if (-not [string]::IsNullOrWhiteSpace($value) -and $value -ne $name) { $summaryParts.Add(('"' + $value + '"')) }

  $nodes.Add([ordered]@{
    id = $Id
    parentId = $ParentId
    depth = $Depth
    role = $role
    name = $name
    description = $description
    value = $value
    text = $value
    bounds = $bounds
    state = $state
    attributes = @{}
    appName = $appName
    windowTitle = $windowTitle
    processId = $processId
    summary = Clip ($summaryParts -join ' ') 240
    childIds = $childIds
    actions = @()
  }) | Out-Null

  return $Id
}

$null = SerializeElement $root '' 'root' 0

$rootProcessId = 0
$rootAppName = ''
$rootWindowTitle = ''
try {
  $rootProcessId = [int]$root.Current.ProcessId
  $rootProcess = Get-Process -Id $rootProcessId -ErrorAction Stop
  $rootAppName = Clip $rootProcess.ProcessName 120
  $rootWindowTitle = Clip $rootProcess.MainWindowTitle 200
} catch {}

Emit @{
  supported = $true
  backend = 'uia'
  message = if ($nodes.Count -ge $maxNodes) { 'UIA tree was truncated at 800 nodes.' } else { '' }
  appName = $rootAppName
  windowTitle = $rootWindowTitle
  processId = $rootProcessId
  rootIds = @('root')
  focusedId = $focusedId
  nodes = $nodes
}
`,
	}
}
