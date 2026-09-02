@echo off
cd /d "%~dp0"
set "ENV_PY=%~dp0PC_label\python.exe"
if not exist "%ENV_PY%" (
  echo 未找到 conda 环境 PC_label，正在创建...
  call conda create -p "%~dp0PC_label" python=3.11 numpy -y
  if errorlevel 1 (
    echo 创建环境失败，请确认已安装 Anaconda/Miniconda。
    pause
    exit /b 1
  )
  "%ENV_PY%" -m pip install fastapi uvicorn python-multipart
)
echo 启动点云标注网页...
"%ENV_PY%" app.py
pause
