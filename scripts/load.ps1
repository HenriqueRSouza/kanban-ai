# Versão Windows do scripts/load.sh: envia N pedidos ao Agente de IA (padrão 30).
# Uso: .\scripts\load.ps1 30   e acompanhe:  kubectl -n taskflow get hpa worker -w
param([int]$N = 30)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
kubectl -n taskflow delete job load --ignore-not-found | Out-Null
(Get-Content k8s/autoscaling/load-job.yaml -Raw) -replace 'value: "30"', "value: `"$N`"" | kubectl create -f -
if ($LASTEXITCODE -ne 0) { throw "Falha ao criar o Job de carga" }
kubectl -n taskflow wait --for=condition=complete job/load --timeout=5m
kubectl -n taskflow logs job/load | Select-Object -Last 1
Write-Host "Fila e HPA:  kubectl -n taskflow get hpa worker -w   |   kubectl -n taskflow get pods -l app=worker -w"
