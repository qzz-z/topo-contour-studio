@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Topo Contour Studio
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未找到 Node.js。请先安装 Node.js 18 或更高版本：
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo.
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
echo 正在启动海拔等高线生成器，浏览器会自动打开...
node server.js
pause
