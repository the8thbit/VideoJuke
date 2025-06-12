@echo off
REM VideoJuke WebOS App Packaging Script for Windows

echo === VideoJuke WebOS App Packager ===

REM Check if webOS CLI tools are installed
where ares-package >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: webOS CLI tools not found!
    echo Please install the webOS SDK from: https://webostv.developer.lge.com/sdk/installation/
    exit /b 1
)

REM Set up paths
set SCRIPT_DIR=%~dp0
set PROJECT_ROOT=%SCRIPT_DIR%..
set WEBOS_SRC=%PROJECT_ROOT%\src\client\webos
set BUILD_DIR=%PROJECT_ROOT%\build\webos
set PACKAGE_DIR=%BUILD_DIR%\package
set OUTPUT_DIR=%PROJECT_ROOT%\dist\webos

echo Building WebOS app...

REM Clean build directory
if exist "%BUILD_DIR%" rmdir /s /q "%BUILD_DIR%"
mkdir "%PACKAGE_DIR%"
if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

REM Copy WebOS app files
echo Copying WebOS app files...
copy /Y "%WEBOS_SRC%\appinfo.json" "%PACKAGE_DIR%\"
copy /Y "%WEBOS_SRC%\index.html" "%PACKAGE_DIR%\"
copy /Y "%WEBOS_SRC%\icon.png" "%PACKAGE_DIR%\" 2>nul
copy /Y "%WEBOS_SRC%\largeIcon.png" "%PACKAGE_DIR%\" 2>nul
xcopy /E /I /Y "%WEBOS_SRC%\webOSTVjs-1.2.12" "%PACKAGE_DIR%\webOSTVjs-1.2.12\" 2>nul

REM Convert ES6 modules to WebOS format
echo Converting ES6 modules to WebOS format...
node "%SCRIPT_DIR%\build-webos-modules.js"

if %ERRORLEVEL% NEQ 0 (
    echo Error: Module conversion failed!
    echo Check the conversion output above for syntax errors.
    echo Debug files may be available in build\webos\package\debug\
    exit /b 1
)

REM Download webOS TV library if not present
set WEBOS_LIB_DIR=%PACKAGE_DIR%\webOSTVjs-1.2.12
if not exist "%WEBOS_LIB_DIR%" (
    echo Downloading webOS TV library...
    mkdir "%WEBOS_LIB_DIR%"
    echo Please manually download webOS TV library from:
    echo https://webostv.developer.lge.com/develop/tools/webos-tv-library
    echo And extract to: %WEBOS_LIB_DIR%
    echo.
)

REM Check for icons
if not exist "%PACKAGE_DIR%\icon.png" (
    echo Warning: icon.png not found.
    echo Please add icon.png ^(80x80^) to %WEBOS_SRC%\
)

if not exist "%PACKAGE_DIR%\largeIcon.png" (
    echo Warning: largeIcon.png not found.
    echo Please add largeIcon.png ^(130x130^) to %WEBOS_SRC%\
)

REM Package the app with better error handling
echo Packaging WebOS app...
cd /d "%PACKAGE_DIR%"

REM Try packaging with minification first
echo Attempting to package with minification...
call ares-package . -o "%OUTPUT_DIR%" >packaging_output.log 2>&1

if %ERRORLEVEL% EQU 0 (
    echo Package created successfully with minification
    goto :success
)

REM If minification fails, try without minification
echo Minification failed, trying without minification...
call ares-package . -o "%OUTPUT_DIR%" --no-minify >packaging_output_no_minify.log 2>&1

if %ERRORLEVEL% EQU 0 (
    echo Package created successfully without minification
    goto :success
)

REM If both fail, show error details
echo.
echo Error: Both packaging attempts failed.
echo.
echo === Minification Attempt Log ===
type packaging_output.log
echo.
echo === No-Minify Attempt Log ===
type packaging_output_no_minify.log
echo.
echo === Debugging Information ===
echo Check the following files for issues:
dir /b "%PACKAGE_DIR%\*.js"
echo.
echo You can manually inspect the JavaScript files in:
echo %PACKAGE_DIR%
echo.
echo Common issues:
echo - Syntax errors in converted JavaScript
echo - Missing dependencies between modules
echo - ES6 features not properly converted
echo.
exit /b 1

:success
REM Find the generated IPK file
for %%f in ("%OUTPUT_DIR%\*.ipk") do set IPK_FILE=%%f

if exist "%IPK_FILE%" (
    echo.
    echo === Build Complete ===
    echo Package created: %IPK_FILE%
    echo.
    echo To install on your TV:
    echo 1. Enable Developer Mode on your TV
    echo 2. Set up device: ares-setup-device
    echo 3. Install: ares-install "%IPK_FILE%"
    echo.
    echo For testing: ares-launch com.videojuke.player -d [device-name]
    echo.
) else (
    echo Error: IPK file not found in output directory
    exit /b 1
)

REM Clean up log files
del /q packaging_output.log 2>nul
del /q packaging_output_no_minify.log 2>nul

cd /d "%SCRIPT_DIR%"