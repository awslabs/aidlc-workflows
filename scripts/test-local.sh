#!/bin/bash

# 本地测试脚本

set -e

echo "🧪 AI-DLC CLI 本地测试..."

# 构建项目
echo "🔨 构建项目..."
npm run build

# 创建测试目录
test_dir="test-project"
if [ -d "$test_dir" ]; then
    rm -rf "$test_dir"
fi

mkdir "$test_dir"
cd "$test_dir"

echo "📁 创建测试项目: $test_dir"

# 初始化测试项目
npm init -y > /dev/null

# 测试 CLI 命令
echo "✅ 测试 CLI 命令..."

# 测试 version 命令
echo "📋 测试 version 命令..."
node ../dist/index.js version --json > version.json
if [ $? -eq 0 ]; then
    echo "✅ version 命令成功"
else
    echo "❌ version 命令失败"
    exit 1
fi

# 测试 help 命令
echo "📋 测试 help 命令..."
node ../dist/index.js --help > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ help 命令成功"
else
    echo "❌ help 命令失败"
    exit 1
fi

# 测试 status 命令
echo "📋 测试 status 命令..."
node ../dist/index.js status > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ status 命令成功"
else
    echo "❌ status 命令失败"
    exit 1
fi

# 测试 validate 命令
echo "📋 测试 validate 命令..."
node ../dist/index.js validate > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ validate 命令成功"
else
    echo "❌ validate 命令失败"
    exit 1
fi

# 测试 init 命令 (非交互模式)
echo "📋 测试 init 命令..."
node ../dist/index.js init --no-interactive --platform kiro > /dev/null
if [ $? -eq 0 ]; then
    echo "✅ init 命令成功"
else
    echo "❌ init 命令失败"
    exit 1
fi

# 检查生成的文件
if [ -d ".kiro" ]; then
    echo "✅ Kiro 目录已创建"
else
    echo "❌ Kiro 目录未创建"
    exit 1
fi

# 清理测试目录
cd ..
rm -rf "$test_dir"

echo "🎉 所有测试通过!"