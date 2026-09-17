@echo off
bun "%~dp0gh.ts" %*
exit /b %ERRORLEVEL%
