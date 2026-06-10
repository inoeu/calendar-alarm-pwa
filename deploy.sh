#!/bin/bash
set -e

REPO_NAME="calendar-alarm-pwa"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "================================================"
echo " Google Calendar Alarm PWA - デプロイ"
echo "================================================"
echo ""

# Check git
if ! command -v git &>/dev/null; then
  echo "❌ git がインストールされていません"
  exit 1
fi

# Check gh CLI
if ! command -v gh &>/dev/null; then
  echo "❌ GitHub CLI (gh) が必要です"
  echo "  brew install gh && gh auth login"
  exit 1
fi

cd "$SCRIPT_DIR"

# Init git if needed
if [ ! -d ".git" ]; then
  git init
  git checkout -b main
fi

# Create .gitignore
cat > .gitignore << 'GITEOF'
.DS_Store
*.log
GITEOF

git add -A
git commit -m "Initial deploy" --allow-empty 2>/dev/null || git commit -m "Update" 2>/dev/null || true

# Create or push GitHub repo
if gh repo view "$REPO_NAME" &>/dev/null 2>&1; then
  echo "既存のリポジトリにプッシュします..."
  REMOTE=$(gh repo view "$REPO_NAME" --json url -q .url)
  git remote remove origin 2>/dev/null || true
  git remote add origin "${REMOTE}.git"
  git push -u origin main --force
else
  echo "GitHubリポジトリを作成しています..."
  gh repo create "$REPO_NAME" --public --source=. --push
fi

# Enable GitHub Pages
echo "GitHub Pages を有効化しています..."
gh api "repos/$(gh api user -q .login)/${REPO_NAME}/pages" \
  --method POST \
  --field source='{"branch":"main","path":"/"}' 2>/dev/null || true

GITHUB_USER=$(gh api user -q .login)
PAGES_URL="https://${GITHUB_USER}.github.io/${REPO_NAME}/"

echo ""
echo "================================================"
echo "✅ デプロイ完了！"
echo ""
echo "📱 iPhoneでこのURLを開いてください:"
echo "   $PAGES_URL"
echo ""
echo "（Pages が有効になるまで1〜2分かかります）"
echo ""
echo "ホーム画面への追加方法:"
echo "  Safari で開く → 共有ボタン → ホーム画面に追加"
echo "================================================"
