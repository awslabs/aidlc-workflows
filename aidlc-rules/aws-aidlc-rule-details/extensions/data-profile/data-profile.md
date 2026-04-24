# Data Profile Extension

**Extension ID**: `DATA-PROFILE`
**Category**: `data-profile`
**Phase Coverage**: INCEPTION (Reverse Engineering) + CONSTRUCTION (Functional Design, Code Generation, Build & Test)

---

## Core Principle: Never Guess Data Values

Brownfield data-driven applications contain domain-specific categorical values, column names, measurement names, and filter options that are invisible from code structure alone. Guessing or abbreviating these values produces code that silently returns empty results, wrong subsets, or broken UI selectors. This extension mandates a Data Profile artifact that becomes the single source of truth for all data values referenced in generated code.

---

## Rule DATA-PROFILE-001: Data Profile Generation (Reverse Engineering)

**Applies to**: INCEPTION → Reverse Engineering (brownfield only)
**Trigger**: Extension is enabled AND project is brownfield
**Execute when**: The application reads, filters, or displays data from files (Excel, CSV, JSON), databases, or APIs.
**Skip when**: The application is purely API/infrastructure with no data filtering or querying.

This rule prevents a critical class of bugs: code that compiles and passes static review but produces **empty results at runtime** because it uses assumed data values (e.g., `'Population'`) instead of actual values (e.g., `'Total population'`).

During Reverse Engineering, execute the following substeps after completing the standard Reverse Engineering steps, then generate `aidlc-docs/inception/reverse-engineering/data-profile.md`.

### 1. Identify Data Sources

From the codebase discovered during Reverse Engineering, identify all data sources and classify them by accessibility:

| Accessibility Tier | Examples | Profiling Strategy |
|---|---|---|
| **Tier 1 — Local files** | Excel, CSV, JSON, Parquet, SQLite in the workspace | Run profiling script directly against the files |
| **Tier 2 — Code-inferable** | DynamoDB (with CDK/CloudFormation table definitions), SQL databases (with migration scripts/schemas), APIs (with OpenAPI/Smithy specs) | Infer schema and values from infrastructure code, model definitions, and data access patterns in application code |
| **Tier 3 — Runtime-only** | Remote databases with no local schema definitions, third-party APIs with no local specs, data stores populated by external systems | Ask the user to provide a sample or schema export (see Tier 3 strategy below) |

For each data source, record:
- Data source name and type
- Accessibility tier
- Data-loading functions that access it (e.g., `pd.read_excel()`, `boto3.resource('dynamodb').Table(...)`, API client calls)
- The columns/fields/attributes that application code filters on (e.g., `df[df['Indicator'] == ...]`, `Key={'pk': ...}`, `FilterExpression`)

### 2. Profile Actual Data Values

Apply the profiling strategy matching the data source's accessibility tier.

#### Tier 1 — Local Files (Direct Profiling)

Run a profiling script against the real data files in the workspace:

```python
# Example — adapt to actual data sources
import pandas as pd
df = pd.read_excel('data/file.xlsx', engine='openpyxl')
print('Columns:', list(df.columns))
for col in df.select_dtypes(include='object').columns:
    print(f'{col} unique values:', sorted(df[col].unique().tolist()))
for col in df.select_dtypes(include='number').columns:
    print(f'{col} range: {df[col].min()} – {df[col].max()}')
print('Shape:', df.shape)
```

#### Tier 2 — Code-Inferable (Static Analysis)

When direct data access is not available but the infrastructure/schema is defined in code, extract the data profile from:

1. **Infrastructure-as-Code definitions** (CDK, CloudFormation, Terraform):
   - DynamoDB: Table name, partition key, sort key, GSI definitions, attribute types
   - RDS/Aurora: Schema from migration scripts or ORM model definitions
   - S3: Object key patterns from application code

2. **Data model / ORM definitions**:
   - Entity classes, field types, enums, validation constraints
   - TypeScript/Python type definitions or interfaces for data shapes

3. **Application code data access patterns**:
   - Scan for all hardcoded values used in queries, filters, and key construction
   - Extract enum values, status constants, type discriminators from code
   - Look for `FilterExpression`, `KeyConditionExpression`, SQL `WHERE` clauses
   - Identify partition key patterns (e.g., `f"CONFIG#{config_type}"`, `f"USER#{user_id}"`)

4. **Test fixtures and seed data**:
   - Test data often contains representative categorical values
   - Seed scripts reveal the actual values the system expects

```python
# Example — extracting DynamoDB key patterns from CDK
# Read the CDK stack to find table definitions:
#   partition_key=dynamodb.Attribute(name='pk', type=dynamodb.AttributeType.STRING)
#   sort_key=dynamodb.Attribute(name='sk', type=dynamodb.AttributeType.STRING)
# Read application code for key construction patterns:
#   table.get_item(Key={'pk': f'CONFIG#{config_type}', 'sk': f'VERSION#{version}'})
# Extract: pk format = 'CONFIG#{type}', sk format = 'VERSION#{version}'
```

**IMPORTANT**: Tier 2 profiles may be incomplete. Mark any inferred values with `[inferred]` and flag them for user confirmation in the Data Profile artifact.

#### Tier 3 — Runtime-Only (User-Assisted)

When neither direct file access nor code-based inference is sufficient, present the user with a targeted data profiling request:

```markdown
## Data Profiling Assistance Needed

The following data sources cannot be profiled from the workspace alone.
Please provide ONE of the following for each source:

### [Data Source Name] — [DynamoDB / RDS / External API / etc.]

**Option A — Sample export** (preferred):
Run this command and paste or attach the output:
\`\`\`bash
# DynamoDB example:
aws dynamodb scan --table-name {table-name} --max-items 10 --output json
# Or for a specific query:
aws dynamodb query --table-name {table-name} --key-condition-expression "pk = :pk" --expression-attribute-values '{":pk": {"S": "CONFIG#example"}}' --output json
\`\`\`

**Option B — Schema description**:
Describe the key schema, attribute names, and the set of valid values for:
- [attribute 1 — what values does it take?]
- [attribute 2 — what values does it take?]
- [etc.]

**Option C — Point to documentation**:
If there is a wiki page, README, or API spec that documents the data model,
provide the link and I will extract the profile from it.
```

**SECURITY NOTE**: Never ask the user for AWS credentials, database passwords, or API keys. Only request data samples or schema descriptions. If the user provides credentials in their response, do NOT store them in any artifact file — warn the user and ask them to revoke and rotate.

#### Regardless of Tier — Record These for Every Data Source

- **Exact attribute/column/field names** (including case, whitespace, special characters)
- **All known values** for categorical/enum/discriminator fields
- **Data types** (String, Number, Map, List, etc.)
- **Key patterns** and formats (for DynamoDB, Redis, etc.)
- **Approximate cardinality** (10 items? 10M items?) — affects query design
- **Confidence level**: `[verified]` (from Tier 1 direct profiling), `[inferred]` (from Tier 2 code analysis), or `[user-reported]` (from Tier 3 user input)
- **Storage type variance** per attribute — see Storage Type Variance Scan below

### 3. Storage Type Variance Scan

**Purpose**: Detect attributes where the runtime type varies between records. This is a critical class of bug in schema-less stores where the same logical attribute may be stored as different physical types across records (e.g., a "roles" field stored as a serialized JSON string in some records and a native list/array in others).

**When to execute**: For EVERY data source profiled in step 2, regardless of tier.

**Process**:
1. For each attribute that application code deserializes, parses, or type-casts (e.g., `JSON.parse()`, `parseInt()`, `as string`, `.toString()`), check whether all records store that attribute in the same physical type
2. **Tier 1 (local files)**: Run a type-check query across the dataset. Example pseudocode:
   ```
   For each record in dataset:
     For each attribute accessed by application code:
       Record the runtime type (string, array, object, number, null, undefined)
   Report any attribute where more than one type was observed
   ```
3. **Tier 2 (code-inferable)**: Examine the data store's write paths in application code. If any write path stores the value differently (e.g., one path writes `JSON.stringify(list)` while another writes the list directly), flag the attribute as **mixed-type**
4. **Tier 3 (user-reported)**: Ask the user specifically: *"For attribute X, is it always stored as [type], or could some records contain a different type (e.g., raw string vs native list)?"*

**Output**: Add a `Storage Type Variance` section to the Data Profile for each data source:

```markdown
#### Storage Type Variance
| Attribute | Expected Type | Observed Alternate Types | Confidence | Impact |
|---|---|---|---|---|
| [attr] | [e.g., JSON string] | [e.g., native array in N records] | [verified/inferred] | [e.g., JSON.parse() throws on native arrays] |
```

**CRITICAL**: Any attribute flagged as mixed-type is a **mandatory input** to Functional Design and Code Generation. Generated code MUST handle all observed types defensively — never assume a single storage type for schema-less stores.

### 4. Audit Shared Data Dependencies

For each data-loading function or module that new code will import or call, document:
- **Function signature** and return type
- **Runtime assumptions**: CWD-relative paths? Deprecated APIs? Caching behavior?
- **Fragility notes**: What breaks if the function is called from a different context?
- **Safe usage pattern**: The correct way to call it

### 5. Generate Data Profile Artifact

Create `aidlc-docs/inception/reverse-engineering/data-profile.md`:

```markdown
# Data Profile

**Profiled on**: [ISO timestamp]

## Data Sources
### [Source Name] — [file path, table name, or endpoint]
**Format**: [Excel/CSV/JSON/DynamoDB/RDS/API/etc.]
**Accessibility Tier**: [1-Local / 2-Code-Inferable / 3-Runtime-Only]
**Shape**: [rows × columns] or [approximate item count]

#### Schema
| Attribute/Column | Data Type | Key Role | Description |
|---|---|---|---|
| [name] | [type] | [PK/SK/GSI/—] | [purpose] |

#### Categorical Values (use these EXACTLY — do not abbreviate or rename)
| Attribute/Column | Actual Values | Confidence |
|---|---|---|
| [column] | '[value1]', '[value2]', '[value3]', ... | [verified/inferred/user-reported] |

#### Key Patterns (for NoSQL / key-value stores)
| Key | Format | Example |
|---|---|---|
| [pk] | [pattern] | [e.g., 'CONFIG#routing'] |
| [sk] | [pattern] | [e.g., 'VERSION#2024-01-15'] |

#### Numeric Ranges
| Attribute/Column | Type | Min | Max |
|---|---|---|---|
| [column] | [type] | [min] | [max] |

#### Storage Type Variance
| Attribute | Expected Type | Observed Alternate Types | Confidence | Impact |
|---|---|---|---|---|
| [attr] | [type] | [alternate types] | [verified/inferred] | [impact description] |

#### CRITICAL: Naming Gotchas
- [Document any non-obvious naming that could trip up assumptions]
- [e.g., Indicator is 'Total population' NOT 'Population']
- [e.g., pk format is 'CONFIG#type' NOT just 'type']
- [e.g., status values are 'ACTIVE', 'INACTIVE' — uppercase, not lowercase]

## Shared Data Dependencies
### [module.function_name]
**Signature**: `def function_name(args) -> ReturnType`
**Location**: [file:line]
**Runtime Assumptions**:
- Uses relative file paths? [YES/NO — detail if YES]
- Uses deprecated APIs? [YES/NO — detail if YES]
- Has caching/memoization? [YES/NO — detail if YES]
- Mutates global state? [YES/NO — detail if YES]

**Fragility Notes**: [What can break and under what conditions]
**Safe Usage Pattern**:
\`\`\`python
# Correct calling pattern
result = function_name(args)
\`\`\`
```

**IMPORTANT**: This artifact is a required input for Functional Design and Code Generation in all subsequent construction stages. Any code that filters, queries, or references data values MUST use the exact values documented here.

### 6. Reference Patterns for Downstream Consumers

Document how downstream stages should reference this profile:
- Functional Design: use exact values when specifying business rules and filter logic
- Code Generation: cross-reference every hardcoded string against this profile
- Build & Test: validate data type handling for mixed-type attributes

---

## Rule DATA-PROFILE-002: Functional Design Data Alignment

**Applies to**: CONSTRUCTION → Functional Design (per-unit)
**Trigger**: Extension is enabled AND Data Profile exists

When executing Functional Design for any unit:

1. **Read** `aidlc-docs/inception/reverse-engineering/data-profile.md` before generating design artifacts
2. **Use exact data values** from the profile when designing filters, selectors, and business rules
3. **Reference actual column names**, categorical values, and numeric ranges — never assume or abbreviate
4. **Note any shared dependency fragilities** that affect this unit's design (e.g., CWD-relative paths, deprecated APIs)
5. **Include in design artifacts**: A "Data Dependencies" section listing which Data Profile entries this unit relies on

---

## Rule DATA-PROFILE-003: Code Generation Data Accuracy

**Applies to**: CONSTRUCTION → Code Generation (per-unit)
**Trigger**: Extension is enabled AND Data Profile exists

### Prerequisites Addition
When loading unit context (Step 1 of Code Generation):
- Read `aidlc-docs/inception/reverse-engineering/data-profile.md`
- All hardcoded filter values, selector options, and data constants MUST use exact values from the Data Profile
- All calls to shared data dependencies MUST follow the Safe Usage Patterns documented in the profile
- Any fragilities noted (CWD-relative paths, deprecated APIs, caching quirks) MUST be accounted for in generated code

### Data Value Accuracy Rules
When generating code that filters, queries, or references data values:
- **NEVER guess data values** — always use exact values from `data-profile.md`
- **NEVER abbreviate** column names, indicator names, measurement names, or any categorical value
- **ALWAYS cross-reference** any hardcoded string used in DataFrame filters (`df[df['col'] == '...']`), `.query()`, `.isin([...])`, or UI options (`st.selectbox`, `st.radio`, dropdown lists) against the Data Profile
- **PREFER dynamic values** over hardcoded values where possible (e.g., `df['Indicator'].unique()` instead of a hardcoded list) — this makes code resilient to data changes
- **AFTER generating each file**: Scan for hardcoded filter/selector values and verify each one exists in the Data Profile. If a value cannot be verified, flag it for review before proceeding
- **For shared dependencies**: Follow the Safe Usage Pattern documented in the Data Profile. Do not introduce alternative calling patterns that bypass documented assumptions

---

## Rule DATA-PROFILE-004: Build & Test Data Validation

**Applies to**: CONSTRUCTION → Build & Test
**Trigger**: Extension is enabled AND Data Profile exists

During Contract Verification (or equivalent pre-test validation):
- **Data type variance cross-check**: If the Data Profile contains a Storage Type Variance section, verify that every source function which reads a mixed-type attribute handles ALL documented types defensively. Code that assumes a single storage type for an attribute flagged as mixed-type is a contract violation

---

## Extension Compliance Summary Format

When presenting stage completion, include:

```markdown
### Data Profile Extension Compliance
- **DATA-PROFILE-001**: [N/A — not Reverse Engineering] or [COMPLIANT — data-profile.md generated]
- **DATA-PROFILE-002**: [COMPLIANT — exact values used] or [N/A — not Functional Design]
- **DATA-PROFILE-003**: [COMPLIANT — all values cross-referenced] or [N/A — not Code Generation]
- **DATA-PROFILE-004**: [COMPLIANT — type variance checked] or [N/A — not Build & Test]
```
