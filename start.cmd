@echo off
chcp 65001 >nul
setlocal
title agy-proxy gateway

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node.exe，请先安装 Node.js 22+：https://nodejs.org
  pause
  exit /b 1
)

echo [检查] 重新构建 dist（保证最新）...
call npm run build
if errorlevel 1 (
  echo [错误] 构建失败，请检查上方 tsc 输出。
  pause
  exit /b 1
)

echo.
echo  启动 agy-proxy 网关 ...
echo  本机地址 : http://127.0.0.1:8045
echo  数据目录 : %USERPROFILE%\.agy-proxy
echo  API Key  : 见 %USERPROFILE%\.agy-proxy\config.json 的 apiKey 字段
echo  Ctrl+C 停止服务。
echo.
node dist\index.js serve %*

echo.
echo 服务已停止。
pause
