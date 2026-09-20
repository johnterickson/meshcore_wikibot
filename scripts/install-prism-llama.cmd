@echo off
setlocal

set "TAG=prism-b10709-9a9394a"
set "ROOT=D:\prism-bonsai\%TAG%"
set "DOWNLOADS=%ROOT%\downloads"
set "CUDA=%ROOT%\cuda"
set "CPU=%ROOT%\cpu"
set "BASE=https://github.com/PrismML-Eng/llama.cpp/releases/download/%TAG%"

if not exist "%DOWNLOADS%" mkdir "%DOWNLOADS%"
if not exist "%CUDA%" mkdir "%CUDA%"
if not exist "%CPU%" mkdir "%CPU%"

call :download "llama-%TAG%-bin-win-cuda-12.4-x64.zip" || exit /b 1
call :download "cudart-llama-bin-win-cuda-12.4-x64.zip" || exit /b 1
call :download "llama-%TAG%-bin-win-cpu-x64.zip" || exit /b 1

tar.exe -xf "%DOWNLOADS%\llama-%TAG%-bin-win-cuda-12.4-x64.zip" -C "%CUDA%" || exit /b 1
tar.exe -xf "%DOWNLOADS%\cudart-llama-bin-win-cuda-12.4-x64.zip" -C "%CUDA%" || exit /b 1
tar.exe -xf "%DOWNLOADS%\llama-%TAG%-bin-win-cpu-x64.zip" -C "%CPU%" || exit /b 1

where /r "%CUDA%" llama-cli.exe
where /r "%CPU%" llama-cli.exe
exit /b 0

:download
if exist "%DOWNLOADS%\%~1" exit /b 0
echo Downloading %~1
curl.exe -fL "%BASE%/%~1" -o "%DOWNLOADS%\%~1"
exit /b %ERRORLEVEL%