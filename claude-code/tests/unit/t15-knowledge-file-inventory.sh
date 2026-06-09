#!/bin/bash
# t15: Validates knowledge file inventory and non-emptiness (~80 tests)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/tap.sh"
source "$SCRIPT_DIR/../lib/fixtures.sh"

KNOWLEDGE_DIR="$AIDLC_SRC/knowledge"

AGENT_NAMES="aidlc-architect-agent aidlc-aws-platform-agent aidlc-compliance-agent aidlc-delivery-agent aidlc-design-agent aidlc-developer-agent aidlc-devsecops-agent aidlc-operations-agent aidlc-pipeline-deploy-agent aidlc-product-agent aidlc-quality-agent"
TOTAL_FILES=$(find "$KNOWLEDGE_DIR" -name "*.md" -type f | wc -l)

# plan = 11 (existence) + 11 (counts) + 7 (shared specific) + TOTAL_FILES (non-empty)
plan $((11 + 11 + 7 + TOTAL_FILES))

# ============================================================
# Part 1: Each of 11 agent dirs has at least 1 .md file
# ============================================================

for agent_dir in $AGENT_NAMES; do
  count=$(find "$KNOWLEDGE_DIR/$agent_dir" -name "*.md" -type f | wc -l)
  assert_gt "$count" 0 "$agent_dir has knowledge files"
done

# ============================================================
# Part 2: Expected file counts per agent
# ============================================================

assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-architect-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "6" "aidlc-architect-agent has 6 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-aws-platform-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "4" "aidlc-aws-platform-agent has 4 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-compliance-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "1" "aidlc-compliance-agent has 1 knowledge file"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-delivery-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "3" "aidlc-delivery-agent has 3 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-design-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "5" "aidlc-design-agent has 5 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-developer-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "6" "aidlc-developer-agent has 6 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-devsecops-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "4" "aidlc-devsecops-agent has 4 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-operations-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "4" "aidlc-operations-agent has 4 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-pipeline-deploy-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "3" "aidlc-pipeline-deploy-agent has 3 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-product-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "7" "aidlc-product-agent has 7 knowledge files"
assert_eq "$(find "$KNOWLEDGE_DIR/aidlc-quality-agent" -name "*.md" -type f | wc -l | tr -d ' ')" "4" "aidlc-quality-agent has 4 knowledge files"

# ============================================================
# Part 3: aidlc-shared/ has 6 specific files
# ============================================================

for f in ai-dlc-principles.md audit-format.md brownfield.md knowledge-readme-template.md rules-reading.md state-template.md verification.md; do
  assert_file_exists "$KNOWLEDGE_DIR/aidlc-shared/$f" "aidlc-shared/$f exists"
done

# ============================================================
# Part 4: All knowledge files are non-empty
# ============================================================

while IFS= read -r kf; do
  name=$(echo "$kf" | sed "s|$KNOWLEDGE_DIR/||")
  size=$(wc -c < "$kf")
  assert_gt "$size" 0 "$name is non-empty"
done < <(find "$KNOWLEDGE_DIR" -name "*.md" -type f | sort)

finish
