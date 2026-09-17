@echo off
rem dsh 用量总览 —— 启动后浏览器打开 http://localhost:7900 ，Ctrl+C 停止
echo [dsh-usage-dashboard] http://localhost:7900  (Ctrl+C 停止)
wsl.exe -e /home/ggbond/.nvm/versions/node/v24.19.0/bin/node /mnt/c/Users/GGBOND/.zcode/workspace/default/dsh-usage-dashboard/server.js
pause
