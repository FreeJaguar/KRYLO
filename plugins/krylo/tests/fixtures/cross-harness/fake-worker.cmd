@echo off
node "%~dp0fake-worker.mjs" %*
exit /b %ERRORLEVEL%
