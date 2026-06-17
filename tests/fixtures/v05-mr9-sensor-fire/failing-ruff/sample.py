# failing-ruff fixture sample — exactly one ruff violation.
#
# `import os` is unused → ruff F401 (unused-import), a default-enabled
# pyflakes rule. ruff emits a single diagnostic, so the linter sensor's
# errorCount aggregation == 1 and the dispatcher records FAILED with
# Findings count=1.
import os
