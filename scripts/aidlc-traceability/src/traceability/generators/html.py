# SPDX-License-Identifier: MIT
# Copyright (c) 2026 AIDLC Traceability Tool Contributors
"""Generate HTML traceability report with embedded CSS."""

from __future__ import annotations

import html
import json

import networkx as nx

from traceability.models import ArtifactType, TraceabilityReport
from traceability.graph import get_nodes_by_type

CSS = """
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --bg-tertiary: #e9ecef;
  --bg-header: #16213e;
  --text-primary: #333;
  --text-secondary: #6c757d;
  --text-tertiary: #495057;
  --border-color: #dee2e6;
  --border-color-light: #e9ecef;
  --hover-bg: #e8f4f8;
  --selected-bg: #cce5ff;
  --selected-border: #0056b3;
  --related-bg: #fff3cd;
  --trace-item-bg: #fff;
  --trace-item-hover-shadow: rgba(0,0,0,0.1);
  --link-color: #0056b3;
}

body.dark-mode {
  --bg-primary: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-tertiary: #3a3a3a;
  --bg-header: #0a0e1a;
  --text-primary: #e0e0e0;
  --text-secondary: #a0a0a0;
  --text-tertiary: #b0b0b0;
  --border-color: #444;
  --border-color-light: #555;
  --hover-bg: #353535;
  --selected-bg: #2a4a6a;
  --selected-border: #4a90e2;
  --related-bg: #4a4020;
  --trace-item-bg: #2d2d2d;
  --trace-item-hover-shadow: rgba(255,255,255,0.1);
  --link-color: #4a90e2;
}

* { box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; color: var(--text-primary); background: var(--bg-primary); transition: background 0.3s, color 0.3s; }
.container { display: flex; height: 100vh; }
.sidebar { width: 300px; min-width: 200px; max-width: 600px; background: var(--bg-secondary); border-right: 1px solid var(--border-color); overflow-y: auto; flex-shrink: 0; }
.resizer { width: 5px; cursor: col-resize; background: transparent; flex-shrink: 0; z-index: 100; }
.resizer:hover, .resizer.resizing { background: var(--selected-border); }
.main { flex: 1; overflow-y: auto; padding: 20px; background: var(--bg-primary); }
.header { background: var(--bg-header); color: white; padding: 20px; position: sticky; top: 0; z-index: 10; display: flex; justify-content: space-between; align-items: center; }
.header-content { flex: 1; }
.header h1 { margin: 0 0 5px 0; font-size: 1.5em; }
.header .subtitle { opacity: 0.8; font-size: 0.9em; }
.dark-mode-toggle { background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: white; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 0.9em; transition: all 0.2s; white-space: nowrap; }
.dark-mode-toggle:hover { background: rgba(255,255,255,0.2); }
.search-box { padding: 15px; border-bottom: 1px solid var(--border-color); position: sticky; top: 0; background: var(--bg-secondary); z-index: 5; }
.search-box input { width: 100%; padding: 8px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 14px; background: var(--bg-primary); color: var(--text-primary); }
.artifact-group { margin-bottom: 10px; }
.group-header { padding: 10px 15px; background: var(--bg-tertiary); font-weight: bold; font-size: 0.85em; text-transform: uppercase; color: var(--text-tertiary); cursor: pointer; user-select: none; }
.group-header:hover { background: var(--border-color); }
.group-header.collapsed::before { content: '▶ '; }
.group-header.expanded::before { content: '▼ '; }
.artifact-list { display: none; }
.artifact-list.expanded { display: block; }
.artifact-item { padding: 8px 15px 8px 30px; cursor: pointer; font-size: 0.9em; border-left: 3px solid transparent; }
.artifact-item:hover { background: var(--hover-bg); }
.artifact-item.selected { background: var(--selected-bg); border-left-color: var(--selected-border); font-weight: 500; }
.artifact-item.related { background: var(--related-bg); }
.artifact-item.boilerplate { opacity: 0.6; }
.artifact-item.boilerplate .artifact-title::after { content: " 🔧"; }
.artifact-id { font-weight: 600; color: var(--text-tertiary); }
.artifact-title { color: var(--text-secondary); font-size: 0.85em; display: block; margin-top: 2px; }
.detail-panel { display: none; }
.detail-panel.active { display: block; }
.welcome-panel { text-align: center; padding: 60px 20px; color: var(--text-secondary); }
.welcome-panel h2 { color: var(--text-primary); }
.detail-header { background: var(--bg-secondary); padding: 20px; border-radius: 8px; margin-bottom: 20px; }
.detail-title { font-size: 1.8em; color: var(--text-primary); margin: 0 0 10px 0; }
.detail-meta { color: var(--text-secondary); font-size: 0.9em; }
.trace-section { margin-bottom: 30px; }
.trace-section h3 { color: var(--text-primary); border-bottom: 2px solid var(--border-color-light); padding-bottom: 10px; }
.trace-list { list-style: none; padding: 0; }
.trace-item { background: var(--trace-item-bg); border: 1px solid var(--border-color); border-radius: 6px; padding: 15px; margin-bottom: 10px; cursor: pointer; transition: all 0.2s; }
.trace-item:hover { border-color: var(--link-color); box-shadow: 0 2px 8px var(--trace-item-hover-shadow); }
.trace-item-id { font-weight: 600; color: var(--link-color); margin-bottom: 5px; }
.trace-item-title { color: var(--text-primary); }
.trace-item-source { color: var(--text-secondary); font-size: 0.85em; margin-top: 5px; }
.badge { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 0.8em; font-weight: 600; margin-right: 5px; }
.badge-requirement { background: #d4edda; color: #155724; }
.badge-story { background: #cce5ff; color: #004085; }
.badge-unit { background: #e2d5f1; color: #4a235a; }
.badge-component { background: #f8d7da; color: #721c24; }
.badge-code_plan { background: #d1ecf1; color: #0c5460; }
.badge-test { background: #fff3cd; color: #856404; }
.badge-code { background: #e7f3ff; color: #0066cc; }
.none { color: var(--text-secondary); font-style: italic; }
.metrics { display: flex; gap: 15px; margin: 20px 0; flex-wrap: wrap; }
.metric { background: var(--bg-secondary); border-radius: 8px; padding: 15px 20px; text-align: center; min-width: 140px; border: 1px solid var(--border-color); }
.metric-value { font-size: 2em; font-weight: bold; color: var(--text-primary); }
.metric-label { font-size: 0.85em; color: var(--text-secondary); margin-top: 5px; }
@media print { .sidebar { display: none; } .main { width: 100%; } }
"""


def _esc(text: str, quote: bool = False) -> str:
    return html.escape(str(text), quote=quote)


def generate_html(report: TraceabilityReport, G: nx.DiGraph) -> str:
    """Generate an interactive HTML report with embedded CSS and JavaScript."""
    m = report.metrics

    # Build artifact data for JavaScript
    artifacts_by_type = {}
    artifact_data = {}

    for artifact in report.artifacts:
        art_type = artifact.artifact_type
        if art_type not in artifacts_by_type:
            artifacts_by_type[art_type] = []
        artifacts_by_type[art_type].append(artifact)

        # Get forward and backward traces
        forward = list(G.successors(artifact.id)) if artifact.id in G else []
        backward = list(G.predecessors(artifact.id)) if artifact.id in G else []

        artifact_data[artifact.id] = {
            "id": artifact.id,
            "title": artifact.title,
            "type": artifact.artifact_type,
            "source_file": artifact.source_file,
            "source_line": artifact.source_line,
            "description": artifact.description or "",
            "forward": forward,
            "backward": backward,
        }

    # Order types for display
    type_order = [
        ArtifactType.REQUIREMENT,
        ArtifactType.STORY,
        ArtifactType.UNIT,
        ArtifactType.COMPONENT,
        ArtifactType.CODE,
        ArtifactType.CODE_PLAN,
        ArtifactType.TEST,
    ]

    type_labels = {
        ArtifactType.REQUIREMENT: "Requirements",
        ArtifactType.STORY: "User Stories",
        ArtifactType.UNIT: "Units of Work",
        ArtifactType.COMPONENT: "Components",
        ArtifactType.CODE: "Source Code",
        ArtifactType.CODE_PLAN: "Code Plans",
        ArtifactType.TEST: "Tests",
    }

    html_parts = []

    # HTML Head
    html_parts.append(f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Traceability Matrix - {_esc(report.project_name)}</title>
<style>{CSS}</style>
</head>
<body>
<div class="container">
  <div class="sidebar">
    <div class="header">
      <div class="header-content">
        <h1>Traceability Matrix</h1>
        <div class="subtitle">{_esc(report.project_name)}</div>
        <div class="subtitle">{_esc(report.generated_at)}</div>
      </div>
      <button class="dark-mode-toggle" onclick="toggleDarkMode()">🌓 Toggle Dark Mode</button>
    </div>

    <div class="search-box">
      <input type="text" id="searchInput" placeholder="Search artifacts..." />
    </div>

    <div id="artifactGroups">""")

    # Sidebar artifact groups
    for art_type in type_order:
        if art_type in artifacts_by_type:
            artifacts = sorted(artifacts_by_type[art_type], key=lambda a: a.id)
            label = type_labels.get(art_type, art_type)
            html_parts.append(f"""
      <div class="artifact-group">
        <div class="group-header expanded" onclick="toggleGroup(this)">{_esc(label)} ({len(artifacts)})</div>
        <div class="artifact-list expanded">""")

            for artifact in artifacts:
                # Add boilerplate indicator for code files
                boilerplate_class = " boilerplate" if artifact.metadata.get("boilerplate", False) else ""
                html_parts.append(f"""
          <div class="artifact-item{boilerplate_class}" data-id="{_esc(artifact.id)}" onclick="selectArtifact('{_esc(artifact.id, quote=True)}')">
            <span class="artifact-id">{_esc(artifact.id)}</span>
            <span class="artifact-title">{_esc(artifact.title[:60] + '...' if len(artifact.title) > 60 else artifact.title)}</span>
          </div>""")

            html_parts.append("""
        </div>
      </div>""")

    html_parts.append("""
    </div>
  </div>

  <div class="resizer"></div>

  <div class="main">
    <div id="welcomePanel" class="welcome-panel">
      <h2>Interactive Traceability Explorer</h2>
      <p>Select an artifact from the sidebar to view its traceability.</p>

      <div style="max-width: 800px; margin: 20px auto; text-align: left; background: var(--bg-secondary); padding: 20px; border-radius: 8px; border: 1px solid var(--border-color);">
        <h3 style="color: var(--text-primary); margin-top: 0;">AIDLC Traceability Coverage</h3>
        <p style="color: var(--text-secondary); font-size: 0.9em;">Complete traceability across all AI-DLC development layers:</p>""")

    # Layer 1: Requirements → Stories
    if m.total_requirements > 0:
        pct = m.requirements_with_stories / m.total_requirements * 100
        status = "✓" if pct == 100 else "⚠"
        color = "#28a745" if pct == 100 else "#ffc107"
        html_parts.append(f"""
        <div style="margin: 15px 0; padding: 12px; background: var(--bg-primary); border-radius: 6px; border-left: 4px solid {color};">
          <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 5px;">{status} Layer 1: Requirements → Stories</div>
          <div style="color: var(--text-secondary); font-size: 0.9em;">{m.requirements_with_stories}/{m.total_requirements} requirements traced to user stories ({pct:.0f}%)</div>
        </div>""")

    # Layer 2: Stories → Units
    if m.total_stories > 0:
        pct = m.stories_with_units / m.total_stories * 100
        status = "✓" if pct == 100 else "⚠"
        color = "#28a745" if pct == 100 else "#ffc107"
        html_parts.append(f"""
        <div style="margin: 15px 0; padding: 12px; background: var(--bg-primary); border-radius: 6px; border-left: 4px solid {color};">
          <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 5px;">{status} Layer 2: Stories → Units</div>
          <div style="color: var(--text-secondary); font-size: 0.9em;">{m.stories_with_units}/{m.total_stories} stories traced to units of work ({pct:.0f}%)</div>
        </div>""")

    # Layer 3: Units → Components
    units = get_nodes_by_type(G, ArtifactType.UNIT)
    units_with_components = 0
    for unit in units:
        connected = set(G.successors(unit.id)) | set(G.predecessors(unit.id))
        has_component = any(
            G.nodes[n].get("artifact", None) and
            G.nodes[n]["artifact"].artifact_type == ArtifactType.COMPONENT
            for n in connected
        )
        if has_component:
            units_with_components += 1

    if len(units) > 0:
        pct = units_with_components / len(units) * 100
        status = "✓" if pct == 100 else "⚠"
        color = "#28a745" if pct == 100 else "#ffc107"
        html_parts.append(f"""
        <div style="margin: 15px 0; padding: 12px; background: var(--bg-primary); border-radius: 6px; border-left: 4px solid {color};">
          <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 5px;">{status} Layer 3: Units → Components</div>
          <div style="color: var(--text-secondary); font-size: 0.9em;">{units_with_components}/{len(units)} units traced to logical components ({pct:.0f}%)</div>
        </div>""")

    # Layer 4: Components → Code (excluding boilerplate and design patterns)
    components = get_nodes_by_type(G, ArtifactType.COMPONENT)
    code_files = get_nodes_by_type(G, ArtifactType.CODE)

    # Separate implementation components from design patterns
    impl_components = [c for c in components if not c.metadata.get("design_pattern", False)]
    design_patterns = [c for c in components if c.metadata.get("design_pattern", False)]

    # Count non-boilerplate code files
    non_boilerplate_code = [c for c in code_files if not c.metadata.get("boilerplate", False)]
    boilerplate_count = len(code_files) - len(non_boilerplate_code)

    components_with_code = 0
    for component in impl_components:
        connected = set(G.successors(component.id)) | set(G.predecessors(component.id))
        has_code = any(
            G.nodes[n].get("artifact", None) and
            G.nodes[n]["artifact"].artifact_type == ArtifactType.CODE and
            not G.nodes[n]["artifact"].metadata.get("boilerplate", False)
            for n in connected
        )
        if has_code:
            components_with_code += 1

    if len(impl_components) > 0:
        pct = components_with_code / len(impl_components) * 100
        status = "✓" if pct == 100 else "⚠"
        color = "#28a745" if pct == 100 else "#ffc107"
        boilerplate_note = f"<br><span style='font-size: 0.85em; color: #999;'>{len(non_boilerplate_code)} implementation files, {boilerplate_count} boilerplate files</span>" if boilerplate_count > 0 else ""
        pattern_note = f"<br><span style='font-size: 0.85em; color: #999;'>{len(design_patterns)} design patterns/cross-cutting concerns (traced via host components)</span>" if design_patterns else ""
        html_parts.append(f"""
        <div style="margin: 15px 0; padding: 12px; background: var(--bg-primary); border-radius: 6px; border-left: 4px solid {color};">
          <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 5px;">{status} Layer 4: Components → Code</div>
          <div style="color: var(--text-secondary); font-size: 0.9em;">{components_with_code}/{len(impl_components)} implementation components traced to source code ({pct:.0f}%){boilerplate_note}{pattern_note}</div>
        </div>""")

    # Layer 5: Code → Components (reverse trace)
    if non_boilerplate_code:
        code_with_component = 0
        for code_file in non_boilerplate_code:
            connected = set(G.successors(code_file.id)) | set(G.predecessors(code_file.id))
            has_component = any(
                G.nodes[n].get("artifact", None) and
                G.nodes[n]["artifact"].artifact_type == ArtifactType.COMPONENT
                for n in connected
            )
            if has_component:
                code_with_component += 1

        pct = code_with_component / len(non_boilerplate_code) * 100
        status = "✓" if pct == 100 else "⚠"
        color = "#28a745" if pct == 100 else "#ffc107"
        untraced = len(non_boilerplate_code) - code_with_component
        orphan_note = f"<br><span style='font-size: 0.85em; color: #999;'>{untraced} orphaned implementation files</span>" if untraced > 0 else ""
        html_parts.append(f"""
        <div style="margin: 15px 0; padding: 12px; background: var(--bg-primary); border-radius: 6px; border-left: 4px solid {color};">
          <div style="font-weight: bold; color: var(--text-primary); margin-bottom: 5px;">{status} Layer 5: Code → Components</div>
          <div style="color: var(--text-secondary); font-size: 0.9em;">{code_with_component}/{len(non_boilerplate_code)} implementation files traced back to components ({pct:.0f}%){orphan_note}</div>
        </div>""")

    html_parts.append("""
      </div>

      <div class="metrics">""")

    # Metrics
    html_parts.append(f"""
        <div class="metric">
          <div class="metric-value">{m.total_requirements}</div>
          <div class="metric-label">Requirements</div>
        </div>
        <div class="metric">
          <div class="metric-value">{m.total_stories}</div>
          <div class="metric-label">Stories</div>
        </div>
        <div class="metric">
          <div class="metric-value">{m.total_units}</div>
          <div class="metric-label">Units</div>
        </div>
        <div class="metric">
          <div class="metric-value">{m.total_code_files}</div>
          <div class="metric-label">Code Files</div>
        </div>
        <div class="metric">
          <div class="metric-value">{G.number_of_edges()}</div>
          <div class="metric-label">Relationships</div>
        </div>
      </div>""")

    html_parts.append("""
    </div>

    <div id="detailPanel" class="detail-panel">
      <!-- Dynamic content loaded here -->
    </div>
  </div>
</div>

<script>
// Artifact data
const artifacts = """ + json.dumps(artifact_data, indent=2) + """;

let currentArtifact = null;

function selectArtifact(artifactId) {
  if (!artifacts[artifactId]) return;

  currentArtifact = artifactId;
  const artifact = artifacts[artifactId];

  // Update UI
  document.getElementById('welcomePanel').classList.remove('active');
  document.getElementById('detailPanel').classList.add('active');

  // Update selected state in sidebar
  document.querySelectorAll('.artifact-item').forEach(item => {
    item.classList.remove('selected', 'related');
  });

  const selectedItem = document.querySelector(`[data-id="${artifactId}"]`);
  if (selectedItem) {
    selectedItem.classList.add('selected');
    selectedItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // Highlight related artifacts
  const related = new Set([...artifact.forward, ...artifact.backward]);
  related.forEach(id => {
    const item = document.querySelector(`[data-id="${id}"]`);
    if (item) item.classList.add('related');
  });

  // Render detail panel
  renderDetailPanel(artifact);
}

function renderDetailPanel(artifact) {
  const panel = document.getElementById('detailPanel');

  let html = `
    <div class="detail-header">
      <span class="badge badge-${artifact.type}">${escapeHtml(artifact.type)}</span>
      <div class="detail-title">${escapeHtml(artifact.id)}: ${escapeHtml(artifact.title)}</div>
      <div class="detail-meta">
        Source: ${escapeHtml(artifact.source_file)} (line ${artifact.source_line})
      </div>
    </div>
  `;

  if (artifact.description) {
    html += `
      <div class="trace-section">
        <h3>Description</h3>
        <p>${escapeHtml(artifact.description).replace(/\\n/g, '<br>')}</p>
      </div>
    `;
  }

  // Forward trace (what this implements/uses)
  if (artifact.forward.length > 0) {
    html += `
      <div class="trace-section">
        <h3>Forward Trace (Implemented By / Uses)</h3>
        <ul class="trace-list">
    `;

    artifact.forward.forEach(targetId => {
      const target = artifacts[targetId];
      if (target) {
        html += `
          <li class="trace-item" onclick="selectArtifact('${escapeHtml(target.id, true)}')">
            <span class="badge badge-${target.type}">${escapeHtml(target.type)}</span>
            <div class="trace-item-id">${escapeHtml(target.id)}</div>
            <div class="trace-item-title">${escapeHtml(target.title)}</div>
            <div class="trace-item-source">${escapeHtml(target.source_file)}</div>
          </li>
        `;
      }
    });

    html += `
        </ul>
      </div>
    `;
  }

  // Backward trace (what implements this)
  if (artifact.backward.length > 0) {
    html += `
      <div class="trace-section">
        <h3>Backward Trace (Implements / Used By)</h3>
        <ul class="trace-list">
    `;

    artifact.backward.forEach(sourceId => {
      const source = artifacts[sourceId];
      if (source) {
        html += `
          <li class="trace-item" onclick="selectArtifact('${escapeHtml(source.id, true)}')">
            <span class="badge badge-${source.type}">${escapeHtml(source.type)}</span>
            <div class="trace-item-id">${escapeHtml(source.id)}</div>
            <div class="trace-item-title">${escapeHtml(source.title)}</div>
            <div class="trace-item-source">${escapeHtml(source.source_file)}</div>
          </li>
        `;
      }
    });

    html += `
        </ul>
      </div>
    `;
  }

  if (artifact.forward.length === 0 && artifact.backward.length === 0) {
    html += `
      <div class="trace-section">
        <p class="none">⚠️ This artifact has no traceability links.</p>
      </div>
    `;
  }

  panel.innerHTML = html;
}

function toggleGroup(header) {
  header.classList.toggle('expanded');
  header.classList.toggle('collapsed');
  const list = header.nextElementSibling;
  list.classList.toggle('expanded');
}

function escapeHtml(text, forAttr = false) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  let result = String(text).replace(/[&<>"']/g, m => map[m]);
  if (forAttr) {
    result = result.replace(/'/g, "\\\\'");
  }
  return result;
}

// Search functionality
document.getElementById('searchInput').addEventListener('input', function(e) {
  const query = e.target.value.toLowerCase();

  document.querySelectorAll('.artifact-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    if (text.includes(query)) {
      item.style.display = 'block';
    } else {
      item.style.display = 'none';
    }
  });
});

// Dark mode toggle
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark ? 'enabled' : 'disabled');
}

// Sidebar resizing
let isResizing = false;
const resizer = document.querySelector('.resizer');
const sidebar = document.querySelector('.sidebar');

resizer.addEventListener('mousedown', function(e) {
  isResizing = true;
  resizer.classList.add('resizing');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
});

document.addEventListener('mousemove', function(e) {
  if (!isResizing) return;

  const newWidth = e.clientX;
  if (newWidth >= 200 && newWidth <= 600) {
    sidebar.style.width = newWidth + 'px';
  }
});

document.addEventListener('mouseup', function() {
  if (isResizing) {
    isResizing = false;
    resizer.classList.remove('resizing');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Save width to localStorage
    localStorage.setItem('sidebarWidth', sidebar.style.width);
  }
});

// Initialize: expand all groups by default, restore preferences
document.addEventListener('DOMContentLoaded', function() {
  console.log('Loaded', Object.keys(artifacts).length, 'artifacts');

  // Restore dark mode
  const darkMode = localStorage.getItem('darkMode');
  if (darkMode === 'enabled') {
    document.body.classList.add('dark-mode');
  }

  // Restore sidebar width
  const savedWidth = localStorage.getItem('sidebarWidth');
  if (savedWidth) {
    sidebar.style.width = savedWidth;
  }
});
</script>
</body>
</html>""")

    return "\n".join(html_parts)
