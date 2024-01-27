@echo off

if exist node_modules\ (
  echo Modules already installed. Starting...
) else (
  echo Installing required modules.
  npm i
  echo Installed required modules. Starting...
)

call npm run start
pause