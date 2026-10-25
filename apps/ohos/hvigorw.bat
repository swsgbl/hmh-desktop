@if "%DEBUG%" == "" @echo off
@rem ##########################################################################
@rem  Hvigor startup script for Windows
@rem ##########################################################################

if "%OS%"=="Windows_NT" setlocal

set DIRNAME=%~dp0
if "%DIRNAME%" == "" set DIRNAME=.
set APP_BASE_NAME=%~n0
set APP_HOME=%DIRNAME%

for %%i in ("%APP_HOME%") do set APP_HOME=%%~fi

set WRAPPER_MODULE_PATH=%DIRNAME%\hvigorw.cjs
set NODE_EXE=node.exe

goto start

:start
if not defined NODE_OPTS set NODE_OPTS="--"

%NODE_EXE% --version >NUL 2>&1
if "%ERRORLEVEL%" == "0" goto execute

echo ERROR: NODE_HOME is not set and no 'node' command could be found in your PATH.
goto fail

:execute
"%NODE_EXE%" "%NODE_OPTS%" "%WRAPPER_MODULE_PATH%" %*

if "%ERRORLEVEL%" == "0" goto hvigorwEnd

:fail
exit /b 1

:hvigorwEnd
if "%OS%" == "Windows_NT" endlocal

:end