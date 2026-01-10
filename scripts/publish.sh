#!/bin/bash

# AI-DLC CLI 发布脚本

set -e

echo "🚀 AI-DLC CLI 发布流程开始..."

# 检查是否在正确的分支
current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ] && [ "$current_branch" != "master" ]; then
    echo "⚠️  警告: 当前不在 main/master 分支 (当前: $current_branch)"
    read -p "是否继续? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ 发布已取消"
        exit 1
    fi
fi

# 检查工作目录是否干净
if [ -n "$(git status --porcelain)" ]; then
    echo "❌ 工作目录不干净，请先提交所有更改"
    git status --short
    exit 1
fi

# 运行测试
echo "🧪 运行测试..."
npm test

# 运行 lint
echo "🔍 运行代码检查..."
npm run lint

# 构建项目
echo "🔨 构建项目..."
npm run build

# 检查构建产物
if [ ! -f "dist/index.js" ]; then
    echo "❌ 构建失败，找不到 dist/index.js"
    exit 1
fi

# 测试 CLI 命令
echo "✅ 测试 CLI 命令..."
node dist/index.js --version > /dev/null
if [ $? -ne 0 ]; then
    echo "❌ CLI 命令测试失败"
    exit 1
fi

# 询问版本类型
echo "📦 选择版本更新类型:"
echo "1) patch (1.0.0 -> 1.0.1)"
echo "2) minor (1.0.0 -> 1.1.0)"
echo "3) major (1.0.0 -> 2.0.0)"
echo "4) 自定义版本"
echo "5) 跳过版本更新"

read -p "请选择 (1-5): " version_choice

case $version_choice in
    1)
        echo "🔢 更新 patch 版本..."
        npm version patch
        ;;
    2)
        echo "🔢 更新 minor 版本..."
        npm version minor
        ;;
    3)
        echo "🔢 更新 major 版本..."
        npm version major
        ;;
    4)
        read -p "请输入版本号 (例如: 1.2.3): " custom_version
        echo "🔢 更新到版本 $custom_version..."
        npm version $custom_version
        ;;
    5)
        echo "⏭️  跳过版本更新"
        ;;
    *)
        echo "❌ 无效选择"
        exit 1
        ;;
esac

# 获取当前版本
current_version=$(node -p "require('./package.json').version")
echo "📋 当前版本: $current_version"

# 确认发布
echo "🚀 准备发布到 npm..."
echo "包名: aidlc"
echo "版本: $current_version"
echo "注册表: $(npm config get registry)"

read -p "确认发布? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 发布已取消"
    exit 1
fi

# 发布到 npm
echo "📤 发布到 npm..."
npm publish

# 推送 git 标签
if [ $version_choice -ne 5 ]; then
    echo "🏷️  推送 git 标签..."
    git push origin --tags
    git push origin $current_branch
fi

echo "✅ 发布完成!"
echo "📦 包已发布: https://www.npmjs.com/package/aidlc"
echo "🔗 安装命令: npm install -g aidlc@$current_version"