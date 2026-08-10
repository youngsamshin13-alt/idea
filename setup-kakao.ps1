$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$envPath = Join-Path $projectRoot ".env"

$restApiKey = Read-Host "카카오 REST API 키"
if ([string]::IsNullOrWhiteSpace($restApiKey)) {
  throw "REST API 키가 필요합니다."
}

$secureSecret = Read-Host "카카오 Client secret" -AsSecureString
$clientSecret = [System.Net.NetworkCredential]::new("", $secureSecret).Password
if ([string]::IsNullOrWhiteSpace($clientSecret)) {
  throw "Client secret이 필요합니다."
}

$originInput = Read-Host "서비스 주소 (Enter: http://localhost:3000)"
$appOrigin = if ([string]::IsNullOrWhiteSpace($originInput)) {
  "http://localhost:3000"
} else {
  $originInput.TrimEnd("/")
}

$originUri = [System.Uri]$appOrigin
if ($originUri.Scheme -notin @("http", "https")) {
  throw "서비스 주소는 http 또는 https여야 합니다."
}

$port = if ($originUri.Port -gt 0) { $originUri.Port } else { 3000 }
$lines = @(
  "KAKAO_REST_API_KEY=$restApiKey",
  "KAKAO_CLIENT_SECRET=$clientSecret",
  "APP_ORIGIN=$appOrigin",
  "PORT=$port"
)

[System.IO.File]::WriteAllLines($envPath, $lines, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host ".env 설정을 저장했습니다."
Write-Host "카카오 개발자 콘솔에 아래 Redirect URI를 등록하세요:"
Write-Host "$appOrigin/auth/kakao/callback"
Write-Host "설정 후 이 폴더에서 npm start를 실행하세요."
