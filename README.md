# 点云叶片标注

在浏览器中查看本地点云，并把同一片叶子在不同日期文件中对应成同一个编号。标注结果写在点云 txt 末尾的 `leaf_id` 列，以及 `leaf_labels.json`。

完整操作、快捷键与保存说明见 [使用说明书.md](使用说明书.md)。

## 启动

Windows 下双击 `start.bat`。首次运行会在项目目录创建 conda 环境 `PC_label` 并安装依赖，然后打开 `http://127.0.0.1:8765`。

也可手动启动：

```bash
conda create -p ./PC_label python=3.11 numpy -y
./PC_label/python -m pip install -r requirements.txt
./PC_label/python app.py
```

## 功能概要

- 导入文件夹（系统选目录 / 本机路径 / 拖入），按日期排序
- 三维查看：旋转、缩放、平移；WASD 屏幕平移
- 按实例着色，单击实例做跨文件叶片对应
- 已对应实例半透明；M 新增叶片；Delete 取消当前文件对应
- 保存写回原文件夹；另存为可选其他目录

## 不纳入版本库的内容

本地 conda 环境 `PC_label/`、解析缓存 `cache/`、导出目录 `exports/` 已在 `.gitignore` 中忽略，不会上传。
