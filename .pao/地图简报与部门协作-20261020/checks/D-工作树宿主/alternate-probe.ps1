$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('pao-alt-root-' + [guid]::NewGuid().ToString('N'))
$scratch = Join-Path $env:TEMP ('pao-index-' + [guid]::NewGuid().ToString('N'))
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  git init -q $root
  git -C $root config user.email test@example.com
  git -C $root config user.name Test
  [System.IO.File]::WriteAllText((Join-Path $root 'a.txt'), 'head')
  git -C $root add a.txt
  git -C $root commit -qm seed
  git init -q --bare (Join-Path $root 'snapshot.git')
  [System.IO.File]::WriteAllText((Join-Path $root 'a.txt'), 'dirty')
  [System.IO.File]::WriteAllText((Join-Path $root 'u.txt'), 'untracked')
  git -C $root add -N u.txt
  $tree = (git -C $root write-tree).Trim()
  git -C $root rm --cached -q u.txt
  git -C $root checkout -- a.txt
  git -C $root read-tree HEAD
  $env:GIT_INDEX_FILE = $scratch
  $env:GIT_ALTERNATE_OBJECT_DIRECTORIES = Join-Path $root 'snapshot.git\objects'
  git -C $root read-tree $tree
  $readExit = $LASTEXITCODE
  git -C $root checkout-index --all --force
  $checkoutExit = $LASTEXITCODE
  [pscustomobject]@{ readExit = $readExit; checkoutExit = $checkoutExit; a = [System.IO.File]::ReadAllText((Join-Path $root 'a.txt')); u = [System.IO.File]::ReadAllText((Join-Path $root 'u.txt')) } | ConvertTo-Json -Compress
} finally {
  Remove-Item Env:GIT_INDEX_FILE,Env:GIT_ALTERNATE_OBJECT_DIRECTORIES -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $scratch -Force -ErrorAction SilentlyContinue
}
