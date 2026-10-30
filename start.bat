@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 高校邦 本地刷课台

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 没有找到 Node.js。请先去 https://nodejs.org 安装 LTS 版本，再双击本文件。
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
  if errorlevel 1 (
    echo.
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo 启动中... 浏览器会自动打开 http://127.0.0.1:18800
echo 关闭这个窗口即可停止服务。
echo.
node webapp.js
pause