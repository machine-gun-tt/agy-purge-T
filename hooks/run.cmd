@echo off
rem agy-purge hook 启动器（Windows）
rem 用法：hooks\run.cmd pre-invocation.mjs
rem 说明：安装器默认会把解释器的绝对路径直接写进 hooks.json；这个垫片是给
rem       手写 hooks.json、或者换机器后临时救急用的。
setlocal EnableExtensions
set "HERE=%~dp0"
set "NAME=%~1"
if "%NAME%"=="" goto empty

where node >nul 2>nul
if not errorlevel 1 goto usenode

if not exist "%APPDATA%\Antigravity\bin\agy-node.cmd" goto tryelectron
call "%APPDATA%\Antigravity\bin\agy-node.cmd" "%HERE%%NAME%"
exit /b %ERRORLEVEL%

:tryelectron
if not exist "%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" goto empty
set "ELECTRON_RUN_AS_NODE=1"
"%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe" "%HERE%%NAME%"
exit /b %ERRORLEVEL%

:usenode
node "%HERE%%NAME%"
exit /b %ERRORLEVEL%

:empty
echo {}
exit /b 0
