@echo off
setlocal enabledelayedexpansion

set PORTS=5173 5174 5175 5176 5177 5178 5179 8787 8788 8789 8790 8791 8792 8793
echo Stopping Custom GPT Web dev servers on common local ports...

for %%P in (%PORTS%) do (
  for /f "tokens=5" %%A in ('netstat -ano ^| findstr /R /C:":%%P .*LISTENING"') do (
    if not "%%A"=="0" (
      echo Port %%P uses PID %%A
      taskkill /PID %%A /F >nul 2>nul
    )
  )
)

echo Done.
