@echo off
rem Inicia la aplicación en http://localhost:3000 con el entorno psi4web de micromamba (Windows).
rem Requisitos: micromamba en %LOCALAPPDATA%\micromamba y el entorno creado con
rem   micromamba create -r %USERPROFILE%\micromamba -f environment.yml
cd /d "%~dp0"
set "MM=%LOCALAPPDATA%\micromamba\micromamba.exe"
if not exist "%MM%" (
  echo No se encontro micromamba en %MM%
  pause
  exit /b 1
)
if not exist node_modules (
  "%MM%" run -r "%USERPROFILE%\micromamba" -n psi4web npm install
)
echo Abra http://localhost:3000 en el navegador. Cierre esta ventana para detener el servidor.
"%MM%" run -r "%USERPROFILE%\micromamba" -n psi4web node servidor.js
pause
