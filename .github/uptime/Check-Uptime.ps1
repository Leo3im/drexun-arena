# Drexun Arena uptime alert (owner, 2026-10-01: "it shows up when the server starts but it doesn't when it stops").
# The server cannot report its own crash, so this runs OUTSIDE it: on GitHub, every few minutes, from the website
# repository (.github/workflows/uptime.yml, copied there by tools\Build-Books.ps1). It asks the game server the same
# question the CS2 server browser asks (A2S_INFO over UDP) and posts to Discord (#command-log) when the server stops
# answering and again when it is back. Works on Windows PowerShell 5.1 and PowerShell 7 (GitHub's Linux machines),
# so it can be tested locally: .\Check-Uptime.ps1 -DryRun
#
# Not every missed answer is an outage: a normal restart takes a minute or two. An alert goes out only after
# -FailsBeforeAlert checks in a row got no answer (each check already retries 3 times), so short restarts stay quiet.
# The webhook link comes from the environment (DISCORD_WEBHOOK, a GitHub secret the owner sets); it is never printed.
param(
    [string]$Server = $(if ($env:SERVER) { $env:SERVER } else { 'drexun.ggwp.cc:25401' }),
    [string]$StateFile = '.uptime-state.json',
    [int]$FailsBeforeAlert = 2,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$hostName, $portText = $Server.Split(':')
$port = [int]$portText

# One A2S_INFO query. Returns @{ Map; Players; Bots; Max } or $null when the server does not answer.
function Get-ServerInfo {
    $udp = New-Object System.Net.Sockets.UdpClient
    $udp.Client.ReceiveTimeout = 3000
    try {
        $address = [System.Net.Dns]::GetHostAddresses($hostName) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
        $request = [byte[]](0xFF, 0xFF, 0xFF, 0xFF, 0x54) + [System.Text.Encoding]::ASCII.GetBytes('Source Engine Query') + [byte[]](0x00)
        [void]$udp.Send($request, $request.Length, $address.ToString(), $port)
        $from = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
        $data = $udp.Receive([ref]$from)
        if ($data[4] -eq 0x41) {   # challenge: repeat the request with the 4 challenge bytes
            $retry = $request + $data[5..8]
            [void]$udp.Send($retry, $retry.Length, $address.ToString(), $port)
            $data = $udp.Receive([ref]$from)
        }
        if ($data[4] -ne 0x49) { return $null }
        $index = 6
        $strings = @()
        for ($n = 0; $n -lt 4; $n++) {   # name, map, folder, game
            $end = [Array]::IndexOf($data, [byte]0, $index)
            $strings += [System.Text.Encoding]::UTF8.GetString($data, $index, $end - $index)
            $index = $end + 1
        }
        $index += 2   # app id
        return @{ Map = $strings[1]; Players = [int]$data[$index]; Max = [int]$data[$index + 1]; Bots = [int]$data[$index + 2] }
    } catch {
        return $null
    } finally {
        $udp.Close()
    }
}

function Send-Discord([string]$Title, [string]$Text, [int]$Color) {
    $body = @{ embeds = @(@{ title = $Title; description = $Text; color = $Color; timestamp = (Get-Date).ToUniversalTime().ToString('o') }) } | ConvertTo-Json -Depth 5
    if ($DryRun -or -not $env:DISCORD_WEBHOOK) {
        Write-Host "  (not sent: $(if ($DryRun) { 'dry run' } else { 'no DISCORD_WEBHOOK' })) $Title - $Text"
        return
    }
    Invoke-RestMethod -Method Post -Uri $env:DISCORD_WEBHOOK -ContentType 'application/json' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
    Write-Host "  sent to Discord: $Title"
}

# Previous state (kept between runs by the workflow's cache). Missing = assume it was up.
$state = @{ status = 'up'; fails = 0; firstFail = $null }
if (Test-Path -LiteralPath $StateFile) {
    try {
        $saved = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
        $state = @{ status = [string]$saved.status; fails = [int]$saved.fails; firstFail = $saved.firstFail }
    } catch { }
}

$info = $null
for ($attempt = 1; $attempt -le 3 -and -not $info; $attempt++) {
    $info = Get-ServerInfo
    if (-not $info -and $attempt -lt 3) { Start-Sleep -Seconds 10 }
}

$now = (Get-Date).ToUniversalTime()
if ($info) {
    $people = $info.Players - $info.Bots
    Write-Host "  UP: $($info.Map), $people player(s) of $($info.Max)"
    if ($state.status -eq 'down') {
        $since = if ($state.firstFail) { [DateTime]::Parse($state.firstFail).ToUniversalTime() } else { $now }
        $minutes = [Math]::Max(1, [int][Math]::Round(($now - $since).TotalMinutes))
        Send-Discord "Server back online" "drexun.ggwp.cc:25401 answers again after about $minutes min. Map $($info.Map), $people player(s) online." 0x2ECC71
    }
    $state = @{ status = 'up'; fails = 0; firstFail = $null }
} else {
    $state.fails++
    if (-not $state.firstFail) { $state.firstFail = $now.ToString('o') }
    Write-Host "  NO ANSWER (check $($state.fails) in a row)"
    if ($state.status -ne 'down' -and $state.fails -ge $FailsBeforeAlert) {
        $since = [DateTime]::Parse($state.firstFail).ToUniversalTime().ToString('HH:mm')
        Send-Discord "Server DOWN" "drexun.ggwp.cc:25401 has not answered since about $since UTC ($($state.fails) checks in a row). Open the DatHost panel: Console shows why, Start brings it back. Tell Claude what the Console says." 0xE74C3C
        $state.status = 'down'
    }
}

$state | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
