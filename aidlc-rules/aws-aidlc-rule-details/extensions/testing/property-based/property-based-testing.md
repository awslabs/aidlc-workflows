# Property-Based Testing Rules

## Overview

These property-based testing (PBT) rules are cross-cutting constraints that apply across applicable AI-DLC phases. They ensure that code with identifiable properties is tested using property-based techniques, complementing (not replacing) traditional example-based tests.

Property-based testing defines invariants that must hold for all valid inputs, then uses a framework to generate random inputs and search for counterexamples. When a failure is found, the framework shrinks the input to a minimal reproducing case. This approach uncovers edge cases and subtle bugs that example-based testing routinely misses.

**Enforcement**: At each applicable stage, the model MUST verify compliance with these rules before presenting the stage completion message to the user.

### Blocking PBT Finding Behavior

A **blocking PBT finding** means:
1. The finding MUST be listed in the stage completion message under a "PBT Findings" section with the PBT rule ID and description
2. The stage MUST NOT present the "Continue to Next Stage" option until all blocking findings are resolved
3. The model MUST present only the "Request Changes" option with a clear explanation of what needs to change
4. The finding MUST be logged in `aidlc-docs/audit.md` with the PBT rule ID, description, and stage context

If a PBT rule is not applicable to the current project or unit (e.g., PBT-06 when no stateful components exist), mark it as **N/A** in the compliance summary — this is not a blocking finding.

### Default Enforcement

All rules in this document are **blocking** by default. If any rule's verification criteria are not met, it is a blocking PBT finding — follow the blocking finding behavior defined above.

### Partial Enforcement Mode

If the user selected **Partial** enforcement during opt-in, only rules PBT-02, PBT-03, PBT-07, PBT-08, and PBT-09 are enforced. All other rules are treated as advisory (non-blocking). Log the enforcement mode in `aidlc-docs/aidlc-state.md` under `## Extension Configuration`.

### Verification Criteria Format

Verification items in this document are plain bullet points describing compliance checks. Each item should be evaluated as compliant or non-compliant during review.

---

## Rule PBT-01: Property Identification During Design

**Rule**: Every unit containing business logic, data transformations, or algorithmic operations MUST be analyzed for testable properties during the Functional Design stage. The analysis MUST identify which of the following property categories apply:

| Category | Description | Example |
|---|---|---|
| Round-trip | An operation paired with its inverse yields the original value | serialize → deserialize = identity |
| Invariant | A transformation preserves some measurable characteristic | sort preserves collection size and elements |
| Idempotence | Applying an operation twice yields the same result as once | dedup(dedup(list)) = dedup(list) |
| Commutativity | Different operation orderings produce the same result | add(a, b) = add(b, a) |
| Oracle | A reference implementation or simplified model can verify results | optimized algorithm vs brute-force |
| Induction | A property proven for smaller inputs extends to larger ones | recursive structures, divide-and-conquer |
| Easy verification | The result is hard to compute but easy to check | maze solver output can be walked to verify |

The identified properties MUST be documented in the functional design artifacts for the unit, and carried forward into code generation as PBT test requirements.

**Verification**:
- Functional design artifacts include a "Testable Properties" section listing identified properties per component
- Each identified property references one of the categories above
- Components with no identifiable properties are explicitly marked as "No PBT properties identified" with a brief rationale
- The property list is referenced during code generation planning

---

## Rule PBT-02: Round-Trip Properties

**Rule**: Any operation that has a logical inverse MUST have a property-based test verifying the round-trip. This includes but is not limited to:
- Serialization / deserialization (JSON, XML, Protobuf, binary formats)
- Encoding / decoding (Base64, URL encoding, compression)
- Parsing / formatting (date parsing, number formatting, template rendering with structured input)
- Encryption / decryption (where key is available)
- Database write / read (for the data transformation layer, not the I/O itself)
- Any pair of functions where `f_inverse(f(x)) = x` for all valid `x`

The property-based test MUST generate random valid inputs using a domain-appropriate generator (see PBT-07) and assert that the round-trip produces a value equal to the original input.

**Verification**:
- Every serialization/deserialization pair has a round-trip property test
- Every encoding/decoding pair has a round-trip property test
- Every parsing/formatting pair has a round-trip property test (or documents why the transformation is lossy)
- Round-trip tests use generated inputs, not hardcoded examples
- Lossy transformations (e.g., float formatting with precision loss) document the acceptable deviation and test within tolerance

---

## Rule PBT-03: Invariant Properties

**Rule**: Functions with documented invariants MUST have property-based tests verifying those invariants hold across generated inputs. Common invariants include:
- **Size preservation**: output collection has the same size as input (e.g., map, sort)
- **Element preservation**: output contains exactly the same elements as input, possibly reordered (e.g., sort, shuffle)
- **Ordering guarantees**: output satisfies an ordering constraint (e.g., sort produces non-decreasing order)
- **Range constraints**: output values fall within a defined range (e.g., normalize produces values in [0, 1])
- **Type preservation**: output type matches expected type for all valid inputs
- **Business rule invariants**: domain-specific rules that must always hold (e.g., "account balance never goes negative after a valid transaction", "discount never exceeds item price")

**Verification**:
- Each documented invariant has a corresponding property-based test
- Invariant tests generate a wide range of inputs including boundary values
- Business rule invariants identified in functional design are covered by PBT
- Invariant tests do not duplicate exact assertions from example-based tests — they test the general rule, not specific cases

---

## Rule PBT-04: Idempotency Properties

**Rule**: Any operation that claims or requires idempotency MUST have a property-based test proving it. The test MUST verify that `f(f(x)) = f(x)` for all valid generated inputs. This applies to:
- API endpoints documented as idempotent (PUT, DELETE)
- Data normalization or sanitization functions
- Cache population operations
- Deduplication logic
- Configuration application (applying config twice should not change state)
- Message processing in at-least-once delivery systems

**Verification**:
- Every operation documented as idempotent has a PBT asserting `f(f(x)) = f(x)`
- Idempotency tests use domain-appropriate generators (not just primitives)
- For stateful operations, the test verifies observable state equivalence after single vs repeated application

---

## Rule PBT-05: Oracle and Model-Based Testing

**Rule**: When a reference implementation, simplified model, or known-correct algorithm exists, property-based tests MUST compare the system under test against the oracle. This applies to:
- Optimized algorithms replacing a known brute-force version
- Refactored code replacing legacy implementations
- Parallel/concurrent implementations compared against sequential versions
- Custom implementations of well-known algorithms (sorting, searching, graph traversal)
- New query engines compared against a reference database

The property-based test MUST generate random valid inputs and assert that the system under test produces equivalent results to the oracle for all generated inputs.

**Verification**:
- When a reference implementation exists (or can be trivially written), an oracle PBT is present
- Oracle tests generate diverse inputs covering normal, boundary, and adversarial cases
- Equivalence is defined precisely (exact equality, structural equality, or documented tolerance)
- If no oracle exists, this rule is marked N/A with rationale

---

## Rule PBT-06: Stateful Property Testing

**Rule**: Components that manage mutable state MUST be evaluated for stateful property testing. Stateful PBT generates random sequences of commands (operations) against the system and verifies that invariants hold after each step. This applies to:
- In-memory caches and data stores
- State machines and workflow engines
- Queue and buffer implementations
- Session management systems
- Shopping carts, order pipelines, and similar stateful business objects
- Any component where the result of an operation depends on prior operations

Stateful PBT MUST:
- Define a simplified model (reference state) that mirrors the system under test
- Generate random sequences of valid commands (add, remove, update, query, etc.)
- Execute each command against both the real system and the model
- Assert that observable state or query results match between system and model after each command
- Test sequences of varying lengths, including empty sequences

**Verification**:
- Stateful components identified in functional design have stateful PBT or document why it is not applicable
- A simplified model is defined for comparison
- Command generators produce valid operation sequences with realistic parameter distributions
- Invariants are checked after each command in the sequence, not just at the end
- If no stateful components exist, this rule is marked N/A

---

## Rule PBT-07: Generator Quality

**Rule**: Property-based tests MUST use domain-specific generators that produce realistic, structured inputs — not just primitive types. Poor generators (e.g., random strings for email fields, unbounded integers for age fields) produce meaningless test cases and miss real bugs.

Generator requirements:
- **Domain types**: Custom generators MUST be created for domain objects (e.g., User, Order, Transaction) that respect business constraints (valid email format, positive amounts, valid date ranges)
- **Constrained primitives**: Numeric generators MUST be constrained to realistic ranges where the domain requires it
- **Structured data**: Generators for complex inputs (nested objects, lists of domain objects) MUST produce structurally valid data
- **Edge case inclusion**: Generators SHOULD be configured to include boundary values (empty collections, zero, maximum values, Unicode strings) alongside normal values
- **Reusability**: Domain generators SHOULD be defined as reusable test utilities, not duplicated across test files

**Verification**:
- No PBT uses only raw primitive generators (e.g., `st.integers()` alone) for domain-typed parameters
- Custom generators exist for domain objects used in PBT
- Generators respect documented business constraints (e.g., positive amounts, valid formats)
- Generator definitions are centralized and reusable where multiple tests share the same domain types

---

## Rule PBT-08: Shrinking and Reproducibility

**Rule**: All property-based tests MUST support shrinking and deterministic reproducibility.

- **Shrinking**: When a property fails, the PBT framework MUST automatically reduce the failing input to a minimal reproducing case. Tests MUST NOT disable or bypass the framework's shrinking mechanism unless there is a documented technical reason (e.g., shrinking is incompatible with external service calls in integration tests).
- **Reproducibility**: Every PBT run MUST be reproducible via a seed value. The seed MUST be logged on failure so that the exact failing scenario can be replayed. CI configurations MUST either use a fixed seed for deterministic runs or log the random seed on every run for post-failure reproduction.
- **CI integration**: PBT MUST be included in the project's CI pipeline. Flaky PBT failures (tests that pass on retry without code changes) MUST be investigated, not suppressed.

**Verification**:
- PBT framework's shrinking is enabled (not overridden or disabled)
- Test output on failure includes the seed value and the shrunk minimal failing input
- CI configuration logs the seed for every PBT run or uses a fixed seed
- No PBT is excluded from CI without documented justification
- Flaky PBT failures are tracked and investigated, not silently retried

---

## Rule PBT-09: Framework Selection

**Rule**: The project MUST select and configure an appropriate property-based testing framework for its primary language(s). The framework MUST support:
- Custom generators / strategies for domain types
- Automatic shrinking of failing cases
- Seed-based reproducibility
- Integration with the project's existing test runner

Recommended frameworks by language (non-exhaustive):

| Language | Framework | Notes |
|---|---|---|
| Python | Hypothesis | Mature, excellent shrinking, Django integration |
| JavaScript / TypeScript | fast-check | Integrates with Jest, Vitest, Mocha |
| Java | jqwik | JUnit 5 integration, stateful testing support |
| Kotlin | Kotest Property Testing | Kotest framework integration |
| Scala | ScalaCheck | SBT integration, widely adopted |
| Rust | proptest | Macro-based, good shrinking |
| Go | rapid | Lightweight, idiomatic Go |
| Haskell | QuickCheck | The original PBT framework |
| C# / .NET | FsCheck | Works with xUnit, NUnit |
| Erlang / Elixir | PropEr / StreamData | OTP-aware, stateful testing |

The selected framework MUST be documented in the tech stack decisions and included as a project dependency.

**Verification**:
- A PBT framework is selected and documented in tech stack decisions
- The framework is included in project dependencies (package.json, pom.xml, requirements.txt, etc.)
- The framework supports custom generators, shrinking, and seed-based reproducibility
- If the project uses multiple languages, each language with PBT-applicable code has a framework selected

---

## Rule PBT-10: Complementary Testing Strategy

**Rule**: Property-based tests MUST complement, not replace, example-based tests. The two approaches serve different purposes:

- **Example-based tests**: Document specific known scenarios, regression cases, and business-critical edge cases with explicit expected values. They serve as executable documentation of concrete behavior.
- **Property-based tests**: Verify general invariants across a wide input space. They find unknown edge cases and validate that properties hold universally.

Requirements:
- Critical business scenarios identified in user stories or requirements MUST have explicit example-based tests, even if a PBT covers the same property
- PBT MUST NOT be the sole test for any business-critical path — at least one example-based test must pin the expected behavior for key scenarios
- When a PBT discovers a failing case, the shrunk minimal example SHOULD be added as a permanent example-based regression test
- Test documentation MUST clearly distinguish between example-based and property-based tests (separate test files, test classes, or clearly named test functions)

**Verification**:
- Business-critical paths have both example-based and property-based tests
- PBT is not used as the only test coverage for any critical feature
- Test files or test classes clearly separate or label PBT vs example-based tests
- Regression tests from PBT-discovered failures are captured as permanent example-based tests

---

## Enforcement Integration

These rules are cross-cutting constraints that apply to the following AI-DLC stages:

| Stage | Applicable Rules | Enforcement |
|---|---|---|
| Functional Design | PBT-01 | Property identification must appear in design artifacts |
| NFR Requirements | PBT-09 | Framework selection must be included in tech stack decisions |
| Code Generation (Planning) | PBT-01 through PBT-10 | Code generation plan must include PBT test steps for identified properties |
| Code Generation (Generation) | PBT-02 through PBT-08, PBT-10 | Generated tests must include PBT alongside example-based tests |
| Build and Test | PBT-08 | Test execution instructions must include PBT with seed logging and CI integration |

At each applicable stage:
- Evaluate all PBT rule verification criteria against the artifacts produced
- Include a "PBT Compliance" section in the stage completion summary listing each rule as compliant, non-compliant, or N/A
- If any rule is non-compliant, this is a blocking PBT finding — follow the blocking finding behavior defined in the Overview
- Include PBT rule references in design documentation and test instructions

---

## Appendix: Property Category Quick Reference

For developers and AI models identifying properties during Functional Design (PBT-01):

| Pattern Name | Formal Term | Test Shape | When to Use |
|---|---|---|---|
| There and back again | Invertible function | `f_inv(f(x)) == x` | Serialization, encoding, parsing |
| Some things never change | Invariant | `measure(f(x)) == measure(x)` | Sort, map, filter, transform |
| The more things change, the more they stay the same | Idempotence | `f(f(x)) == f(x)` | Normalization, dedup, cache writes |
| Different paths, same destination | Commutativity | `f(g(x)) == g(f(x))` | Arithmetic, set operations, independent transforms |
| Solve a smaller problem first | Structural induction | Property on `x` implies property on `x + element` | Recursive structures, lists, trees |
| Hard to prove, easy to verify | Verification | `verify(solve(x)) == true` | Solvers, optimizers, search algorithms |
| The test oracle | Reference comparison | `f(x) == oracle(x)` | Optimized vs brute-force, refactored vs legacy |

Source: Property category taxonomy adapted from Scott Wlaschin's "Choosing properties for property-based testing" ([fsharpforfunandprofit.com](https://fsharpforfunandprofit.com/posts/property-based-testing-2/)).
