// Why: kept beside the POSIX tombstone so the generated wrapper text for every platform lives
// in one place, and so the shim-dir module stays under the max-lines limit.
//
// Keep percent signs out of every emitted `rem` line. cmd expands variables inside rem, so a
// comment mentioning %CD% substitutes the working directory into itself. That is harmless at top
// level -- verified on Windows 11 that rem does not re-parse the result, so a cwd of
// `C:\x&pwned&rem` did not execute anything -- but rem handles separators differently inside a
// parenthesized block, and this script now has some.
//
// Keep both templates ASCII-only, comments included. cmd.exe tracks its position in a batch file
// in bytes but advances by decoded character count, so every extra UTF-8 byte shifts the whole
// file: two em dashes in comments made cmd drop the first four characters of every line and the
// script died with "The syntax of the command is incorrect."

const WIN32_PASSTHROUGH_WRAPPER = String.raw`@echo off
rem Why explicit: bare setlocal inherits the caller's delayed-expansion state, and a parent shell
rem started with /V:ON made every PATH entry undergo ! expansion inside the loops below. A literal
rem !CD! entry then became the current directory and a planted git.cmd ran (exit 66), and a
rem legitimate directory whose name contains ! stopped resolving (exit 127). Both proven on
rem Windows 11; both disappear when the wrapper pins its own state.
setlocal DisableDelayedExpansion
set "kingu_real=%KINGU_REAL___KINGU_UPPER_COMMAND__%"
set "kingu_wrapper_dir=%~dp0"
set "kingu_legacy_wrapper_dir=%KINGU_ATTRIBUTION_SHIM_DIR%"
set "kingu_clean_path="
rem Why: holds a single separator so the trailing-separator tests below need neither a literal
rem backslash before a quote (which breaks cmd parsing) nor a sentinel character (which would
rem corrupt any path containing it). Comparisons append a dot so the separator is never
rem adjacent to a closing quote, which would break the parser exactly as a literal would.
set "kingu_sep=\"
rem Why a subroutine, not an "if defined ... " one-liner: cmd expands a whole line before it
rem evaluates the condition, so the substring syntax below still runs against an unset variable
rem and leaves the line mangled. A CALL body is only parsed once it is reached.
rem Why here: the value cannot change mid-run, so normalize once rather than per PATH entry.
set "kingu_legacy_norm="
if defined kingu_legacy_wrapper_dir call :kingu_normalize_legacy_dir
rem Why: an empty PATH leaves the substitution below with an unbalanced quote, which
rem desynchronizes cmd parsing for the rest of the file. Skip the line entirely instead.
if not defined PATH goto :kingu_path_walked
rem Why the variable: CALL re-expands its own command line, so a PATH entry naming the current
rem directory through a percent expression would become that directory before the rooted check
rem below ever saw it, and the cwd would then be searched for __KINGU_COMMAND__. Proven on
rem Windows 11. The expression is spelled out only in the TypeScript comment above: cmd expands
rem percent signs inside rem, so writing one here would substitute a path into the comment.
for %%P in ("%PATH:;=" "%") do (
  set "kingu_entry=%%~P"
  call :kingu_append_path
)
:kingu_path_walked
set "PATH=%kingu_clean_path%"
set "KINGU_ENABLE_GIT_ATTRIBUTION="
set "KINGU_GIT_COMMIT_TRAILER="
set "KINGU_GH_PR_FOOTER="
set "KINGU_GH_ISSUE_FOOTER="
set "KINGU_ATTRIBUTION_SHIM_DIR="
set "KINGU_ATTRIBUTION_BYPASS="
set "KINGU_REAL_GIT="
set "KINGU_REAL_GH="
if defined kingu_real for %%G in ("%kingu_real%") do if /I "%%~dpG"=="%~dp0" set "kingu_real="
rem Why: a captured path may be relative, and both "if exist" and the invocation resolve it
rem against the current directory, so an inherited .\__KINGU_COMMAND__.exe would run from the repo.
set "kingu_probe=%kingu_real%"
if defined kingu_real call :kingu_check_rooted
if defined kingu_real if not defined kingu_rooted set "kingu_real="
rem Why: clear a captured path that no longer exists, or the PATH walk below is skipped.
if defined kingu_real if not exist "%kingu_real%" set "kingu_real="
if defined kingu_real goto run
rem Why: an unqualified Windows command lookup searches the current directory before PATH, so a
rem repository-local __KINGU_COMMAND__.exe would win. Walk the cleaned PATH ourselves instead.
if not defined kingu_clean_path goto :kingu_candidates_walked
for %%P in ("%kingu_clean_path:;=" "%") do (
  set "kingu_entry=%%~P"
  call :kingu_try_candidate
)
:kingu_candidates_walked
if not defined kingu_real (
  echo Kingu compatibility wrapper could not locate __KINGU_COMMAND__ on PATH. 1>&2
  exit /b 127
)
:run
"%kingu_real%" %*
exit /b %ERRORLEVEL%

:kingu_normalize_legacy_dir
rem Why the rooted test first: full-path expansion resolves a relative value against the current
rem directory, so a
rem relative KINGU_ATTRIBUTION_SHIM_DIR would let the cwd decide which PATH entry counts as the
rem legacy directory and get a legitimate one skipped. Leaving the normalized value unset makes
rem the reject subroutine below a no-op, which is the safe outcome.
set "kingu_probe=%kingu_legacy_wrapper_dir%"
call :kingu_check_rooted
if not defined kingu_rooted exit /b
for %%G in ("%kingu_legacy_wrapper_dir%") do set "kingu_legacy_norm=%%~fG"
rem Why: full-path expansion preserves a trailing separator; normalize before comparing.
if "%kingu_legacy_norm:~-1%."=="%kingu_sep%." set "kingu_legacy_norm=%kingu_legacy_norm:~0,-1%"
exit /b

:kingu_check_rooted
rem Why: tested in pure batch on purpose. An external tool invoked here would itself be resolved
rem from the current directory, reintroducing the very hijack this guard exists to prevent.
rem Why kingu_probe rather than an argument: see the CALL re-expansion note above.
set "kingu_rooted="
rem Why: an unset probe would leave the substring syntax below unexpanded and mangle the line.
if not defined kingu_probe exit /b
if "%kingu_probe:~0,2%"=="\\" set "kingu_rooted=1"
if "%kingu_probe:~1,2%"==":\" set "kingu_rooted=1"
if "%kingu_probe:~1,2%"==":/" set "kingu_rooted=1"
exit /b

:kingu_try_candidate
if defined kingu_real exit /b
if not defined kingu_entry exit /b
rem Why: a relative entry resolves against the current directory, same exposure as an empty one.
set "kingu_probe=%kingu_entry%"
call :kingu_check_rooted
if not defined kingu_rooted exit /b
for %%G in ("%kingu_entry%") do set "kingu_candidate_dir=%%~fG"
rem Why: full-path expansion preserves a trailing separator, so without normalizing, the
rem self-exclusion below misses a wrapper-dir entry spelled with one and the wrapper resolves
rem to itself, looping forever.
if "%kingu_candidate_dir:~-1%."=="%kingu_sep%." set "kingu_candidate_dir=%kingu_candidate_dir:~0,-1%"
rem Why: the script-dir operator is rebound to this label inside CALL, so compare against the
rem cached wrapper dir captured at top level.
if /I "%kingu_candidate_dir%\"=="%kingu_wrapper_dir%" exit /b
if exist "%kingu_candidate_dir%\__KINGU_COMMAND__.exe" set "kingu_real=%kingu_candidate_dir%\__KINGU_COMMAND__.exe"
if not defined kingu_real if exist "%kingu_candidate_dir%\__KINGU_COMMAND__.cmd" set "kingu_real=%kingu_candidate_dir%\__KINGU_COMMAND__.cmd"
if not defined kingu_real if exist "%kingu_candidate_dir%\__KINGU_COMMAND__.bat" set "kingu_real=%kingu_candidate_dir%\__KINGU_COMMAND__.bat"
exit /b

:kingu_append_path
if not defined kingu_entry exit /b
rem Why: the exported PATH is inherited by the real git and anything it spawns, so a relative
rem entry left here lets the current directory select those tools instead.
set "kingu_probe=%kingu_entry%"
call :kingu_check_rooted
if not defined kingu_rooted exit /b
for %%G in ("%kingu_entry%") do set "kingu_path_entry_dir=%%~fG"
rem Why: full-path expansion preserves a trailing separator; normalize before comparing.
if "%kingu_path_entry_dir:~-1%."=="%kingu_sep%." set "kingu_path_entry_dir=%kingu_path_entry_dir:~0,-1%"
set "kingu_path_entry_dir=%kingu_path_entry_dir%\"
if /I "%kingu_path_entry_dir%"=="%kingu_wrapper_dir%" exit /b
set "kingu_skip_entry="
if defined kingu_legacy_wrapper_dir call :kingu_reject_legacy_dir
if defined kingu_skip_entry exit /b
if defined kingu_clean_path (set "kingu_clean_path=%kingu_clean_path%;%kingu_entry%") else set "kingu_clean_path=%kingu_entry%"
exit /b

:kingu_reject_legacy_dir
rem Why: an unrooted legacy dir leaves this unset, and comparing against a bare separator could
rem only ever misfire.
if not defined kingu_legacy_norm exit /b
if /I "%kingu_path_entry_dir%"=="%kingu_legacy_norm%\" set "kingu_skip_entry=1"
exit /b
`

const POWERSHELL_PASSTHROUGH_WRAPPER = String.raw`$ErrorActionPreference = 'Stop'
$commandName = '__KINGU_COMMAND__'
$realCommand = [Environment]::GetEnvironmentVariable('KINGU_REAL___KINGU_UPPER_COMMAND__')
$wrapperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$legacyWrapperDir = $env:KINGU_ATTRIBUTION_SHIM_DIR
# Why both separators: the rooted-path test below accepts forward slashes, so a directory
# spelled with a trailing / would miss this lexical exclusion and the wrapper could recurse.
$wrapperDirs = @($wrapperDir, $legacyWrapperDir) | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') }
$env:PATH = (($env:PATH -split ';') | Where-Object {
  $pathEntry = $_
  # Why: the exported PATH is inherited by the real command and anything it spawns.
  $pathEntry -and ($pathEntry -match '^([A-Za-z]:[\\/]|\\\\)') -and -not ($wrapperDirs | Where-Object {
    [string]::Equals($_, $pathEntry.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)
  })
}) -join ';'
'KINGU_ENABLE_GIT_ATTRIBUTION', 'KINGU_GIT_COMMIT_TRAILER', 'KINGU_GH_PR_FOOTER', 'KINGU_GH_ISSUE_FOOTER', 'KINGU_ATTRIBUTION_SHIM_DIR', 'KINGU_REAL_GIT', 'KINGU_REAL_GH', 'KINGU_ATTRIBUTION_BYPASS' | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
# Why: a captured value may be relative, and Test-Path plus invocation resolve it against the cwd.
if ($realCommand -and $realCommand -notmatch '^([A-Za-z]:[\\/]|\\\\)') { $realCommand = $null }
if ($realCommand) {
  try {
    $capturedDir = Split-Path -Parent ([IO.Path]::GetFullPath($realCommand))
    if ([string]::Equals($capturedDir.TrimEnd('\', '/'), $wrapperDir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
      $realCommand = $null
    }
  } catch {
    $realCommand = $null
  }
}
if (-not $realCommand -or -not (Test-Path -LiteralPath $realCommand)) {
  # Why: resolve only against the cleaned PATH directories. Ambient lookup could pick up a
  # repository-local git.exe/gh.exe from the current directory.
  $realCommand = $null
  foreach ($dir in ($env:PATH -split ';')) {
    if (-not $dir) { continue }
    # Why: a relative entry resolves against the current directory, same exposure as an empty one.
    # IsPathRooted is not enough: it accepts drive-relative 'C:foo', which resolves against the
    # current directory on that drive. IsPathFullyQualified is absent on Windows PowerShell 5.1,
    # so match the same prefixes the cmd wrapper accepts.
    if ($dir -notmatch '^([A-Za-z]:[\\/]|\\\\)') { continue }
    if ($wrapperDirs | Where-Object { [string]::Equals($_, $dir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase) }) { continue }
    foreach ($ext in @('.exe', '.cmd', '.bat')) {
      $candidate = Join-Path $dir "$commandName$ext"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $realCommand = $candidate; break }
    }
    if ($realCommand) { break }
  }
}
if (-not $realCommand) {
  [Console]::Error.WriteLine("Kingu compatibility wrapper could not locate $commandName on PATH.")
  exit 127
}
& $realCommand @args
exit $LASTEXITCODE
`

function renderWindowsWrapper(template: string, command: string, upperCommand: string): string {
  return template
    .replaceAll('__KINGU_UPPER_COMMAND__', upperCommand)
    .replaceAll('__KINGU_COMMAND__', command)
}

// Why: cmd locates `call :label` targets by byte offset and that lookup is unreliable in
// LF-only files — the same script worked at 2.4 KB and failed with "cannot find the batch label"
// once it grew. Emit CRLF, which is what cmd expects.
function toCrlf(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
}

export function renderLegacyTerminalWindowsCmdTombstone(command: 'git' | 'gh'): string {
  return toCrlf(renderWindowsWrapper(WIN32_PASSTHROUGH_WRAPPER, command, command.toUpperCase()))
}

export function renderLegacyTerminalWindowsPowerShellTombstone(command: 'git' | 'gh'): string {
  return toCrlf(
    renderWindowsWrapper(POWERSHELL_PASSTHROUGH_WRAPPER, command, command.toUpperCase())
  )
}
