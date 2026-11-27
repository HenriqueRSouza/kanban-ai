# Versão Windows (PowerShell) do scripts/k8s-up.sh: sobe o TaskFlow no minikube.
# Uso: .\scripts\k8s-up.ps1   (pré-requisitos: Docker Desktop, minikube, kubectl e .env)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

$MkProfile = if ($env:MINIKUBE_PROFILE) { $env:MINIKUBE_PROFILE } else { "kanban-ai" }
$Memory = if ($env:MINIKUBE_MEMORY) { $env:MINIKUBE_MEMORY } else { "max" }
$Cpus = if ($env:MINIKUBE_CPUS) { $env:MINIKUBE_CPUS } else { "max" }
$Port = if ($env:K8S_PORT) { $env:K8S_PORT } else { "8090" }
$Ns = "taskflow"

function Step($text) { Write-Host "`n> $text" -ForegroundColor Cyan }
function Run { & $args[0] $args[1..($args.Length - 1)]; if ($LASTEXITCODE -ne 0) { throw "Falhou: $args" } }

foreach ($cmd in "docker", "minikube", "kubectl") {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Falta o comando '$cmd'. Veja o README (seção Kubernetes)." }
}
if (-not (Test-Path .env)) { throw "Crie o .env primeiro: copy .env.example .env" }
$envVars = @{}
Get-Content .env | Where-Object { $_ -match '^\s*([A-Z_]+)=(.*)$' } | ForEach-Object { $envVars[$Matches[1]] = $Matches[2] }

# Provedor de LLM: Ollama (padrão) roda como sidecar no pod do worker (k8s/base);
# LM Studio e OpenRouter ficam fora do cluster (overlay external-llm).
$Provider = if ($envVars.LLM_PROVIDER) { $envVars.LLM_PROVIDER } else { "ollama" }
$OverlayDir = "k8s/overlays/external-llm"
switch ($Provider) {
  "ollama" { $KustomizeDir = "k8s/base"; $Images = "api", "worker", "web", "ollama" }
  { $_ -in "lmstudio", "openrouter" } {
    $KustomizeDir = $OverlayDir; $Images = "api", "worker", "web"
    if ($Provider -eq "lmstudio") {
      # Dentro do minikube a máquina host é host.minikube.internal (não host.docker.internal).
      $BaseUrl = if ($envVars.LLM_BASE_URL) { $envVars.LLM_BASE_URL } else { "http://host.minikube.internal:1234/v1" }
      $BaseUrl = $BaseUrl -replace "host\.docker\.internal", "host.minikube.internal"
      $Model = if ($envVars.LLM_MODEL) { $envVars.LLM_MODEL } else { "qwen/qwen3-8b" }
    } else {
      if (-not $envVars.LLM_API_KEY) { throw "LLM_PROVIDER=openrouter exige LLM_API_KEY no .env." }
      if (-not $envVars.LLM_MODEL) { throw "LLM_PROVIDER=openrouter exige LLM_MODEL no .env." }
      $BaseUrl = if ($envVars.LLM_BASE_URL) { $envVars.LLM_BASE_URL } else { "https://openrouter.ai/api/v1" }
      $Model = $envVars.LLM_MODEL
    }
    # O token não entra aqui: vai para o Secret. Sem BOM, para o kustomize ler.
    $content = "LLM_PROVIDER=$Provider`nLLM_MODEL=$Model`nLLM_BASE_URL=$BaseUrl`n"
    [System.IO.File]::WriteAllText((Join-Path (Get-Location) "$OverlayDir/llm.env"), $content)
  }
  default { throw "LLM_PROVIDER inválido no .env: '$Provider' (use ollama, lmstudio ou openrouter)." }
}

Step "Cluster minikube (perfil $MkProfile, $Memory de RAM, $Cpus CPUs)"
$status = (minikube -p $MkProfile status --format '{{.Host}}' 2>$null)
if ($status -match "Running") { Write-Host "já está rodando" } else { Run minikube start -p $MkProfile --driver=docker --memory=$Memory --cpus=$Cpus }
Run kubectl config use-context $MkProfile

Step "Addons: NGINX Ingress Controller e metrics-server"
Run minikube -p $MkProfile addons enable ingress
Run minikube -p $MkProfile addons enable metrics-server
# Cookies grandes de outros apps em localhost: evita "400 Cookie Too Large" no Ingress.
Run kubectl -n ingress-nginx patch configmap ingress-nginx-controller --type merge -p "data: {large-client-header-buffers: '4 32k'}"

Step "Imagens: build no Docker local e cópia para o minikube"
if ($Provider -eq "ollama") { Run docker compose --profile ollama build } else { Run docker compose build nginx api worker }
foreach ($image in $Images) { Run minikube -p $MkProfile image load "kanban-ai/${image}:local" }

# Reexecução: as imagens novas têm a mesma tag (:local), então o rollout é forçado depois do apply.
# Lista todos (sem erro quando não existe), para não disparar o ErrorActionPreference.
$Existing = @(kubectl get namespaces -o name) -contains "namespace/$Ns"

Step "Namespace, Secret (a partir do .env) e migrations"
Run kubectl apply -f k8s/base/namespace.yaml
kubectl -n $Ns create secret generic taskflow-secrets `
  "--from-literal=POSTGRES_USER=$($envVars.POSTGRES_USER)" `
  "--from-literal=POSTGRES_PASSWORD=$($envVars.POSTGRES_PASSWORD)" `
  "--from-literal=RABBITMQ_USER=$($envVars.RABBITMQ_USER)" `
  "--from-literal=RABBITMQ_PASSWORD=$($envVars.RABBITMQ_PASSWORD)" `
  "--from-literal=LLM_API_KEY=$($envVars.LLM_API_KEY)" `
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n $Ns create configmap postgres-migrations --from-file=api/migrations --dry-run=client -o yaml | kubectl apply -f -

Step "Manifestos ($KustomizeDir, LLM: $Provider)"
Run kubectl apply -k $KustomizeDir

if ($Existing) { Run kubectl -n $Ns rollout restart deployment/api deployment/web deployment/worker }

Step "Esperando os componentes ficarem prontos"
foreach ($r in "statefulset/postgres", "statefulset/rabbitmq", "deployment/api", "deployment/web", "deployment/worker") {
  Run kubectl -n $Ns rollout status $r --timeout=10m
}
Run kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=5m

Step "Pronto"
kubectl -n $Ns get pods -o wide
Write-Host "`nAcesse pelo Ingress (deixe rodando em outro terminal):"
Write-Host "  kubectl -n ingress-nginx port-forward svc/ingress-nginx-controller ${Port}:80"
Write-Host "  -> http://localhost:$Port"
Write-Host "`nExperimentos (passo a passo em docs/EXPERIMENTOS.md):"
Write-Host "  self-healing:  kubectl -n $Ns get pods -l app=worker  e depois  kubectl -n $Ns delete pod <nome-de-um-worker>"
Write-Host "  escala manual: kubectl -n $Ns scale deployment/worker --replicas=1   (e depois --replicas=2)"
Write-Host "  elasticidade:  kubectl apply -f k8s/autoscaling/hpa.yaml; .\scripts\load.ps1 30; kubectl -n $Ns get hpa worker -w"
if ($Provider -ne "ollama") {
  Write-Host "`nAtenção: com $Provider a inferência roda fora do pod e o HPA por CPU não reage."
  Write-Host "Para a demonstração de elasticidade, use LLM_PROVIDER=ollama."
}
